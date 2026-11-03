const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { cloneJson } = require('./json');

const FORMAT_VERSION = 1;
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_MAX_LENGTH = 256;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const collectionQueues = new Map();
const transactionContext = new AsyncLocalStorage();

function validateCollection(collection) {
    if (typeof collection !== 'string' || !COLLECTION_PATTERN.test(collection)) {
        throw new TypeError('Collection names must start with a lowercase letter or number and contain only lowercase letters, numbers, "_" or "-".');
    }
}

function validateKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX_LENGTH) {
        throw new TypeError(`Record keys must be strings between 1 and ${KEY_MAX_LENGTH} characters.`);
    }
}

function inspectCollectionDocument(contents) {
    let document;
    try {
        document = JSON.parse(contents);
    } catch (error) {
        return { valid: false, code: 'invalid-json', records: null, error };
    }

    if (!document || typeof document !== 'object' || Array.isArray(document) ||
        !document.records || typeof document.records !== 'object' ||
        Array.isArray(document.records)) {
        return { valid: false, code: 'invalid-format', records: null };
    }

    const records = Object.create(null);
    let invalidRecords = 0;
    for (const [key, value] of Object.entries(document.records)) {
        try {
            validateKey(key);
            records[key] = cloneJson(value);
        } catch {
            invalidRecords += 1;
        }
    }

    if (document.version !== FORMAT_VERSION) {
        return { valid: false, code: 'unsupported-version', records, invalidRecords };
    }
    if (invalidRecords > 0) {
        return { valid: false, code: 'invalid-records', records, invalidRecords };
    }
    return { valid: true, records, invalidRecords: 0 };
}

class CardinalDB {
    constructor({ directory } = {}) {
        const appDataDirectory = process.env.CARDINAL_APP_DATA_DIR;
        const selectedDirectory = directory ||
            (appDataDirectory ? path.join(appDataDirectory, 'database') : null);
        if (typeof selectedDirectory !== 'string' || !selectedDirectory.trim()) {
            throw new Error('Cardinal DB requires a directory or CARDINAL_APP_DATA_DIR; it will not create data in the project or system root.');
        }
        this.directory = path.resolve(selectedDirectory);
        this.collections = new Map();
        this.pendingOperations = new Map();
    }

    collectionPath(collection) {
        validateCollection(collection);
        return path.join(this.directory, `${collection}.json`);
    }

    async loadCollection(collection) {
        const collectionPath = this.collectionPath(collection);
        let contents;
        try {
            contents = await fs.readFile(collectionPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return Object.create(null);
            throw error;
        }

        let document;
        try {
            document = JSON.parse(contents);
        } catch (error) {
            throw new Error(`Cardinal DB collection "${collection}" contains invalid JSON: ${error.message}`, { cause: error });
        }
        if (!document || document.version !== FORMAT_VERSION ||
            !document.records || typeof document.records !== 'object' ||
            Array.isArray(document.records)) {
            throw new Error(`Cardinal DB collection "${collection}" has an unsupported or invalid format.`);
        }

        const records = Object.create(null);
        for (const [key, value] of Object.entries(document.records)) {
            validateKey(key);
            records[key] = cloneJson(value);
        }
        return records;
    }

    async persistCollection(collection, records) {
        await fs.mkdir(this.directory, { recursive: true });
        const collectionPath = this.collectionPath(collection);
        const temporaryPath = `${collectionPath}.${crypto.randomUUID()}.tmp`;
        const document = `${JSON.stringify({ version: FORMAT_VERSION, records }, null, 2)}\n`;
        let handle;
        try {
            handle = await fs.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(document, 'utf8');
            await handle.close();
            handle = null;
            await fs.rename(temporaryPath, collectionPath);
        } catch (error) {
            if (handle) await handle.close();
            await fs.rm(temporaryPath, { force: true });
            throw error;
        }
    }

    async withCollection(collection, operation) {
        if (transactionContext.getStore()) {
            throw new Error('Use the transaction methods inside a Cardinal DB transaction callback.');
        }
        validateCollection(collection);
        return this.withCollectionLock(collection, async () => {
            const records = await this.loadCollection(collection);
            this.collections.set(collection, records);
            return operation(records);
        });
    }

    async withCollectionLock(collection, operation) {
        const collectionPath = this.collectionPath(collection);
        const queueKey = process.platform === 'win32' ? collectionPath.toLowerCase() : collectionPath;
        const previous = collectionQueues.get(queueKey) || Promise.resolve();
        const operationResult = previous.then(operation);
        const settled = operationResult.then(() => undefined, () => undefined);
        collectionQueues.set(queueKey, settled);
        this.pendingOperations.set(queueKey, settled);
        try {
            return await operationResult;
        } finally {
            if (collectionQueues.get(queueKey) === settled) {
                collectionQueues.delete(queueKey);
            }
            if (this.pendingOperations.get(queueKey) === settled) {
                this.pendingOperations.delete(queueKey);
            }
        }
    }

    async doctor({ repair = false } = {}) {
        if (transactionContext.getStore()) {
            throw new Error('Cardinal DB doctor cannot run inside a transaction callback.');
        }
        if (typeof repair !== 'boolean') {
            throw new TypeError('Cardinal DB doctor repair option must be a boolean.');
        }

        const report = {
            checkedAt: new Date().toISOString(),
            repairMode: repair,
            collectionsChecked: 0,
            issues: []
        };
        let directoryStats;
        try {
            directoryStats = await fs.lstat(this.directory);
        } catch (error) {
            if (error.code === 'ENOENT') return this.finishDoctorReport(report);
            throw error;
        }
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
            report.issues.push({
                code: 'unsafe-database-directory',
                severity: 'error',
                repaired: false,
                message: 'The database directory is not a regular directory; no files were inspected.'
            });
            return this.finishDoctorReport(report);
        }

        const entries = await fs.readdir(this.directory, { withFileTypes: true });
        const collectionNames = new Set();
        const temporaryFiles = new Map();
        for (const entry of entries) {
            if (entry.name.endsWith('.json')) {
                const collection = entry.name.slice(0, -'.json'.length);
                if (!COLLECTION_PATTERN.test(collection)) {
                    if (entry.isFile() || entry.isSymbolicLink()) {
                        report.issues.push({
                            code: 'invalid-collection-filename',
                            severity: 'warning',
                            repaired: false,
                            message: 'A JSON file has a name Cardinal DB will not load.'
                        });
                    }
                    continue;
                }
                collectionNames.add(collection);
                continue;
            }

            const temporaryMatch = entry.name.match(/^([a-z0-9][a-z0-9_-]{0,63})\.json\.[^.]+\.tmp$/);
            if (temporaryMatch && COLLECTION_PATTERN.test(temporaryMatch[1])) {
                collectionNames.add(temporaryMatch[1]);
                if (!temporaryFiles.has(temporaryMatch[1])) temporaryFiles.set(temporaryMatch[1], []);
                temporaryFiles.get(temporaryMatch[1]).push(entry);
            }
        }

        for (const collection of [...collectionNames].sort()) {
            await this.withCollectionLock(collection, async () => {
                report.collectionsChecked += 1;
                const collectionPath = this.collectionPath(collection);
                const issues = [];
                let targetExists = false;
                let targetIsSafe = true;
                let targetContents = null;
                let targetBytes = null;
                try {
                    const stats = await fs.lstat(collectionPath);
                    targetExists = true;
                    if (!stats.isFile() || stats.isSymbolicLink()) {
                        targetIsSafe = false;
                        issues.push({
                            code: 'unsafe-collection-file',
                            severity: 'error',
                            repaired: false,
                            message: `Collection "${collection}" is not a regular file.`
                        });
                    } else {
                        targetBytes = await fs.readFile(collectionPath);
                        targetContents = targetBytes.toString('utf8');
                    }
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }

                let inspected = targetContents === null
                    ? { valid: false, code: 'missing-collection', records: null }
                    : inspectCollectionDocument(targetContents);
                if (!targetIsSafe) {
                    report.issues.push(...issues);
                    return;
                }
                let targetIssue;

                const candidates = [];
                for (const entry of temporaryFiles.get(collection) || []) {
                    const temporaryPath = path.join(this.directory, entry.name);
                    if (!entry.isFile() || entry.isSymbolicLink()) {
                        issues.push({
                            code: 'unsafe-temporary-file',
                            severity: 'warning',
                            repaired: false,
                            message: `A temporary file for "${collection}" is not a regular file.`
                        });
                        continue;
                    }
                    try {
                        const bytes = await fs.readFile(temporaryPath);
                        const contents = bytes.toString('utf8');
                        const candidate = inspectCollectionDocument(contents);
                        if (candidate.valid) {
                            const stats = await fs.stat(temporaryPath);
                            candidates.push({
                                entry,
                                temporaryPath,
                                bytes,
                                records: candidate.records,
                                mtimeMs: stats.mtimeMs
                            });
                        } else {
                            issues.push({
                                code: 'invalid-temporary-file',
                                severity: 'warning',
                                repaired: false,
                                message: `A temporary file for "${collection}" is incomplete or invalid.`
                            });
                        }
                    } catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                    }
                }

                if (!inspected.valid && inspected.code !== 'missing-collection') {
                    targetIssue = {
                        code: inspected.code,
                        severity: 'error',
                        repaired: false,
                        message: `Collection "${collection}" needs recovery.`
                    };
                    issues.push(targetIssue);
                }
                if (inspected.code === 'missing-collection' && candidates.length === 0) {
                    issues.push({
                        code: 'missing-collection',
                        severity: 'warning',
                        repaired: false,
                        message: `Collection "${collection}" has a temporary file but no committed collection file.`
                    });
                } else if (inspected.code === 'missing-collection' && candidates.length > 0 && !repair) {
                    issues.push({
                        code: 'pending-write-recovery',
                        severity: 'warning',
                        repaired: false,
                        message: `Collection "${collection}" has a valid interrupted write that can be restored.`
                    });
                }

                let recovered = false;
                if (repair && candidates.length > 0 && !inspected.valid) {
                    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
                    const candidate = candidates[0];
                    if (targetExists && targetContents !== null) {
                        await this.backupRecoveryFile(collection, targetBytes, 'before-recovery');
                    }
                    await this.persistCollection(collection, candidate.records);
                    this.collections.set(collection, candidate.records);
                    await fs.rm(candidate.temporaryPath, { force: true });
                    inspected = { valid: true, records: candidate.records };
                    recovered = true;
                    if (targetIssue) {
                        targetIssue.severity = 'info';
                        targetIssue.repaired = true;
                    }
                    issues.push({
                        code: 'temporary-recovered',
                        severity: 'info',
                        repaired: true,
                        message: `Recovered collection "${collection}" from a valid interrupted write.`
                    });
                } else if (repair && !inspected.valid && inspected.records &&
                    inspected.code !== 'unsupported-version') {
                    if (targetContents !== null) {
                        await this.backupRecoveryFile(collection, targetBytes, 'before-salvage');
                    }
                    await this.persistCollection(collection, inspected.records);
                    this.collections.set(collection, inspected.records);
                    inspected = { valid: true, records: inspected.records };
                    recovered = true;
                    if (targetIssue) {
                        targetIssue.severity = 'info';
                        targetIssue.repaired = true;
                    }
                    issues.push({
                        code: 'records-salvaged',
                        severity: 'warning',
                        repaired: true,
                        message: `Recovered valid records from collection "${collection}"; the original was preserved.`
                    });
                }

                for (const candidate of candidates) {
                    if (recovered && candidate === candidates[0]) continue;
                    if (repair) {
                        await this.backupRecoveryFile(collection, candidate.bytes, 'orphaned-write');
                        await fs.rm(candidate.temporaryPath, { force: true });
                    }
                    issues.push({
                        code: 'orphaned-temporary-file',
                        severity: repair ? 'info' : 'warning',
                        repaired: repair,
                        message: `An interrupted-write file for "${collection}" was preserved in recovery storage.`
                    });
                }

                report.issues.push(...issues);
            });
        }

        return this.finishDoctorReport(report);
    }

    async backupRecoveryFile(collection, contents, reason) {
        const recoveryDirectory = path.join(this.directory, 'recovery');
        await fs.mkdir(recoveryDirectory, { recursive: true });
        const stats = await fs.lstat(recoveryDirectory);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('Cardinal DB recovery storage is not a regular directory.');
        }
        const filename = `${collection}-${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
        await fs.writeFile(path.join(recoveryDirectory, filename), contents, { flag: 'wx', mode: 0o600 });
    }

    finishDoctorReport(report) {
        const unresolvedIssues = report.issues.filter(issue => !issue.repaired);
        report.summary = {
            errors: unresolvedIssues.filter(issue => issue.severity === 'error').length,
            warnings: unresolvedIssues.filter(issue => issue.severity === 'warning').length,
            repaired: report.issues.filter(issue => issue.repaired).length
        };
        report.healthy = report.summary.errors === 0 && report.summary.warnings === 0;
        return report;
    }

    async get(collection, key) {
        validateKey(key);
        return this.withCollection(collection, records =>
            Object.hasOwn(records, key) ? cloneJson(records[key]) : undefined
        );
    }

    async has(collection, key) {
        validateKey(key);
        return this.withCollection(collection, records => Object.hasOwn(records, key));
    }

    async list(collection, { limit, after } = {}) {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
            throw new RangeError('Cardinal DB list limit must be an integer between 1 and 1000.');
        }
        if (after !== undefined) validateKey(after);
        return this.withCollection(collection, records => {
            let entries = Object.entries(records);
            if (after !== undefined) {
                const cursorIndex = entries.findIndex(([key]) => key === after);
                if (cursorIndex < 0) throw new Error(`Cardinal DB list cursor was not found: ${after}`);
                entries = entries.slice(cursorIndex + 1);
            }
            if (limit !== undefined) entries = entries.slice(0, limit);
            return entries.map(([key, value]) => ({ key, value: cloneJson(value) }));
        });
    }

    async find(collection, predicate, { limit, after } = {}) {
        if (typeof predicate !== 'function') {
            throw new TypeError('Cardinal DB find requires a predicate function.');
        }
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
            throw new RangeError('Cardinal DB find limit must be an integer between 1 and 1000.');
        }
        if (after !== undefined) validateKey(after);
        return this.withCollection(collection, async records => {
            const entries = Object.entries(records);
            let startIndex = 0;
            if (after !== undefined) {
                const cursorIndex = entries.findIndex(([key]) => key === after);
                if (cursorIndex < 0) throw new Error(`Cardinal DB find cursor was not found: ${after}`);
                startIndex = cursorIndex + 1;
            }
            const matches = [];
            for (const [key, value] of entries.slice(startIndex)) {
                const clonedValue = cloneJson(value);
                const matchesPredicate = await transactionContext.run(
                    this.collectionPath(collection),
                    () => predicate(clonedValue, key)
                );
                if (matchesPredicate) {
                    matches.push({ key, value: clonedValue });
                    if (limit !== undefined && matches.length >= limit) break;
                }
            }
            return matches;
        });
    }

    async findOne(collection, predicate) {
        const [match] = await this.find(collection, predicate, { limit: 1 });
        return match;
    }

    async getMany(collection, keys) {
        if (!Array.isArray(keys)) throw new TypeError('Cardinal DB getMany requires an array of keys.');
        keys.forEach(validateKey);
        return this.withCollection(collection, records => keys.map(key => ({
            key,
            value: Object.hasOwn(records, key) ? cloneJson(records[key]) : undefined
        })));
    }

    async set(collection, key, value) {
        validateKey(key);
        const storedValue = cloneJson(value);
        await this.transaction(collection, transaction => {
            transaction.set(key, storedValue);
        });
        return cloneJson(storedValue);
    }

    async setMany(collection, entries) {
        if (!Array.isArray(entries)) throw new TypeError('Cardinal DB setMany requires an array of key/value records.');
        const prepared = entries.map(entry => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError('Each Cardinal DB setMany item must contain a key and value.');
            }
            validateKey(entry.key);
            return [entry.key, cloneJson(entry.value)];
        });
        await this.transaction(collection, transaction => {
            for (const [key, value] of prepared) transaction.set(key, value);
        });
        return prepared.length;
    }

    async delete(collection, key) {
        validateKey(key);
        return this.transaction(collection, transaction => transaction.delete(key));
    }

    async deleteMany(collection, keys) {
        if (!Array.isArray(keys)) throw new TypeError('Cardinal DB deleteMany requires an array of keys.');
        keys.forEach(validateKey);
        return this.transaction(collection, transaction => {
            let deletedCount = 0;
            for (const key of new Set(keys)) {
                if (transaction.delete(key)) deletedCount += 1;
            }
            return deletedCount;
        });
    }

    async count(collection) {
        return this.withCollection(collection, records => Object.keys(records).length);
    }

    async update(collection, key, updater) {
        validateKey(key);
        if (typeof updater !== 'function') {
            throw new TypeError('Cardinal DB update requires an updater function.');
        }
        return this.transaction(collection, transaction =>
            transaction.update(key, updater)
        );
    }

    async updateWhere(collection, predicate, updater, { limit } = {}) {
        if (typeof predicate !== 'function' || typeof updater !== 'function') {
            throw new TypeError('Cardinal DB updateWhere requires predicate and updater functions.');
        }
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
            throw new RangeError('Cardinal DB updateWhere limit must be an integer between 1 and 1000.');
        }
        return this.transaction(collection, async transaction => {
            let updatedCount = 0;
            for (const { key, value } of transaction.list()) {
                if (limit !== undefined && updatedCount >= limit) break;
                if (await predicate(value, key)) {
                    await transaction.update(key, updater);
                    updatedCount += 1;
                }
            }
            return updatedCount;
        });
    }

    async transaction(collection, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('Cardinal DB transaction requires a callback.');
        }
        return this.withCollection(collection, async records => {
            const staged = Object.assign(Object.create(null), records);
            let changed = false;
            let active = true;
            const assertActive = () => {
                if (!active) throw new Error('Cardinal DB transaction is no longer active.');
            };
            const transaction = {
                get: key => {
                    assertActive();
                    validateKey(key);
                    return Object.hasOwn(staged, key) ? cloneJson(staged[key]) : undefined;
                },
                has: key => {
                    assertActive();
                    validateKey(key);
                    return Object.hasOwn(staged, key);
                },
                list: () => {
                    assertActive();
                    return Object.entries(staged).map(([key, value]) => ({
                        key,
                        value: cloneJson(value)
                    }));
                },
                set: (key, value) => {
                    assertActive();
                    validateKey(key);
                    staged[key] = cloneJson(value);
                    changed = true;
                },
                delete: key => {
                    assertActive();
                    validateKey(key);
                    if (!Object.hasOwn(staged, key)) return false;
                    delete staged[key];
                    changed = true;
                    return true;
                },
                update: async (key, updater) => {
                    assertActive();
                    validateKey(key);
                    if (typeof updater !== 'function') {
                        throw new TypeError('Cardinal DB update requires an updater function.');
                    }
                    const current = Object.hasOwn(staged, key) ? cloneJson(staged[key]) : undefined;
                    const updated = await updater(current);
                    assertActive();
                    if (updated === undefined) {
                        if (Object.hasOwn(staged, key)) {
                            delete staged[key];
                            changed = true;
                        }
                        return undefined;
                    }
                    staged[key] = cloneJson(updated);
                    changed = true;
                    return cloneJson(updated);
                }
            };
            let result;
            try {
                result = await transactionContext.run(
                    this.collectionPath(collection),
                    () => callback(transaction)
                );
            } finally {
                active = false;
            }
            if (changed) {
                await this.persistCollection(collection, staged);
                this.collections.set(collection, staged);
            }
            return result === undefined ? undefined : cloneJson(result);
        });
    }

    async clear(collection) {
        return this.transaction(collection, transaction => {
            for (const { key } of transaction.list()) transaction.delete(key);
        });
    }

    async listCollections() {
        let entries;
        try {
            entries = await fs.readdir(this.directory, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        return entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => entry.name.slice(0, -'.json'.length))
            .filter(name => COLLECTION_PATTERN.test(name))
            .sort();
    }

    async exportCollection(collection) {
        return this.withCollection(collection, records => ({
            version: FORMAT_VERSION,
            collection,
            exportedAt: new Date().toISOString(),
            records: cloneJson(records)
        }));
    }

    async exportAll() {
        const collections = [];
        for (const collection of await this.listCollections()) {
            const exported = await this.exportCollection(collection);
            collections.push({ collection, records: exported.records });
        }
        const backup = {
            format: 'cardinal-db-backup',
            version: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            collections
        };
        const serialized = JSON.stringify(backup);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES) {
            throw new RangeError('Cardinal DB backups cannot exceed 64 MB.');
        }
        return backup;
    }

    async importCollection(collection, document, { replace = false } = {}) {
        validateCollection(collection);
        if (typeof replace !== 'boolean') {
            throw new TypeError('Cardinal DB import replace option must be a boolean.');
        }
        const serialized = JSON.stringify(document);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_IMPORT_BYTES) {
            throw new RangeError('Cardinal DB imports cannot exceed 16 MB.');
        }
        if (!document || document.version !== FORMAT_VERSION ||
            !document.records || typeof document.records !== 'object' ||
            Array.isArray(document.records)) {
            throw new TypeError('Cardinal DB import must contain a supported version and records object.');
        }
        const incoming = Object.entries(document.records).map(([key, value]) => {
            validateKey(key);
            return [key, cloneJson(value)];
        });
        return this.transaction(collection, transaction => {
            if (replace) {
                for (const { key } of transaction.list()) transaction.delete(key);
            }
            for (const [key, value] of incoming) transaction.set(key, value);
            return incoming.length;
        });
    }

    async deleteCollection(collection) {
        return this.withCollection(collection, async () => {
            try {
                await fs.unlink(this.collectionPath(collection));
                this.collections.delete(collection);
                return true;
            } catch (error) {
                if (error.code === 'ENOENT') return false;
                throw error;
            }
        });
    }

    async close() {
        if (transactionContext.getStore()) {
            throw new Error('A Cardinal DB instance cannot be closed from inside a transaction callback.');
        }
        await Promise.all(this.pendingOperations.values());
    }
}

const { CardinalMessageStore } = require('./message-store');

module.exports = { CardinalDB, CardinalMessageStore };
