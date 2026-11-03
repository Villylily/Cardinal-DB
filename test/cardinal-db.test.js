const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CardinalDB } = require('../libs/cardinal-db/cardinal-db');

async function createDatabase(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cardinal-db-test-'));
    t.after(async () => fs.rm(directory, { recursive: true, force: true }));
    return new CardinalDB({ directory });
}

test('Cardinal DB stores isolated JSON collections and persists them across instances', async t => {
    const db = await createDatabase(t);
    const input = { name: 'Villy', roles: ['admin'] };
    await db.set('users', 'user-1', input);
    input.roles.push('mutated');
    const loaded = await db.get('users', 'user-1');
    loaded.roles.push('also-mutated');

    assert.deepEqual(await db.get('users', 'user-1'), { name: 'Villy', roles: ['admin'] });
    assert.deepEqual(await db.list('users'), [
        { key: 'user-1', value: { name: 'Villy', roles: ['admin'] } }
    ]);
    assert.equal(await db.has('users', 'user-1'), true);

    const reopened = new CardinalDB({ directory: db.directory });
    assert.deepEqual(await reopened.get('users', 'user-1'), { name: 'Villy', roles: ['admin'] });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(db.directory, 'users.json'), 'utf8')), {
        version: 1,
        records: { 'user-1': { name: 'Villy', roles: ['admin'] } }
    });
});

test('Cardinal DB serializes concurrent updates and atomically persists mutations', async t => {
    const db = await createDatabase(t);
    await db.set('counters', 'visits', 0);

    await Promise.all(Array.from({ length: 30 }, () =>
        db.update('counters', 'visits', value => value + 1)
    ));

    assert.equal(await db.get('counters', 'visits'), 30);
    assert.equal(await db.delete('counters', 'visits'), true);
    assert.equal(await db.delete('counters', 'visits'), false);
    assert.equal(await db.get('counters', 'visits'), undefined);
    await db.set('counters', 'visits', 4);
    await db.clear('counters');
    assert.deepEqual(await db.list('counters'), []);
});

test('Cardinal DB commits multi-record transactions once and rolls back callback failures', async t => {
    const db = await createDatabase(t);
    await db.transaction('settings', transaction => {
        transaction.set('theme', 'dark');
        transaction.set('port', 6868);
    });
    assert.deepEqual(await db.list('settings'), [
        { key: 'theme', value: 'dark' },
        { key: 'port', value: 6868 }
    ]);

    await assert.rejects(db.transaction('settings', transaction => {
        transaction.set('theme', 'light');
        throw new Error('rollback');
    }), /rollback/);
    assert.equal(await db.get('settings', 'theme'), 'dark');

    await assert.rejects(db.transaction('settings', async transaction => {
        transaction.set('theme', 'light');
        await db.get('settings', 'theme');
    }), /Use the transaction methods/);
    assert.equal(await db.get('settings', 'theme'), 'dark');
});

test('Cardinal DB coordinates instances sharing a data directory', async t => {
    const first = await createDatabase(t);
    const second = new CardinalDB({ directory: first.directory });
    await first.set('counter', 'value', 0);

    await Promise.all(Array.from({ length: 20 }, (_, index) => {
        const db = index % 2 === 0 ? first : second;
        return db.update('counter', 'value', value => value + 1);
    }));

    assert.equal(await first.get('counter', 'value'), 20);
    assert.equal(await second.get('counter', 'value'), 20);
    assert.deepEqual(await first.listCollections(), ['counter']);
    assert.equal(await second.deleteCollection('counter'), true);
    assert.equal(await first.deleteCollection('counter'), false);
    assert.deepEqual(await first.listCollections(), []);
});

test('Cardinal DB supports atomic bulk operations, count, and cursor pagination', async t => {
    const db = await createDatabase(t);
    assert.equal(await db.setMany('records', [
        { key: 'one', value: { count: 1 } },
        { key: 'two', value: { count: 2 } },
        { key: 'three', value: { count: 3 } }
    ]), 3);
    assert.equal(await db.count('records'), 3);
    assert.deepEqual(await db.getMany('records', ['three', 'missing']), [
        { key: 'three', value: { count: 3 } },
        { key: 'missing', value: undefined }
    ]);
    assert.deepEqual(await db.list('records', { limit: 2 }), [
        { key: 'one', value: { count: 1 } },
        { key: 'two', value: { count: 2 } }
    ]);
    assert.deepEqual(await db.list('records', { after: 'two' }), [
        { key: 'three', value: { count: 3 } }
    ]);
    assert.equal(await db.deleteMany('records', ['one', 'one', 'missing', 'three']), 2);
    assert.equal(await db.count('records'), 1);
    await assert.rejects(db.list('records', { limit: 1001 }), /between 1 and 1000/);
    await assert.rejects(db.list('records', { after: 'missing' }), /cursor was not found/);
});

test('Cardinal DB finds records and atomically updates only predicate matches', async t => {
    const db = await createDatabase(t);
    await db.setMany('players', [
        { key: 'player-1', value: { name: 'Ari', active: true, visits: 2 } },
        { key: 'player-2', value: { name: 'Bo', active: false, visits: 4 } },
        { key: 'player-3', value: { name: 'Cy', active: true, visits: 7 } }
    ]);

    assert.deepEqual(await db.find('players', player => player.active, { limit: 1 }), [
        { key: 'player-1', value: { name: 'Ari', active: true, visits: 2 } }
    ]);
    assert.deepEqual(await db.find('players', player => player.visits >= 4, { after: 'player-1' }), [
        { key: 'player-2', value: { name: 'Bo', active: false, visits: 4 } },
        { key: 'player-3', value: { name: 'Cy', active: true, visits: 7 } }
    ]);
    assert.deepEqual(await db.findOne('players', player => player.name === 'Bo'), {
        key: 'player-2',
        value: { name: 'Bo', active: false, visits: 4 }
    });
    assert.equal(await db.findOne('players', player => player.name === 'missing'), undefined);

    assert.equal(await db.updateWhere(
        'players',
        player => player.active,
        player => ({ ...player, visits: player.visits + 1 })
    ), 2);
    assert.equal((await db.get('players', 'player-1')).visits, 3);
    assert.equal((await db.get('players', 'player-2')).visits, 4);
    assert.equal((await db.get('players', 'player-3')).visits, 8);

    await assert.rejects(db.find('players', null), /predicate function/);
    await assert.rejects(db.find('players', () => true, { limit: 1001 }), /between 1 and 1000/);
    await assert.rejects(db.find('players', () => db.get('players', 'player-1')), /Use the transaction methods/);
    await assert.rejects(db.updateWhere('players', () => true, null), /predicate and updater functions/);
    await assert.rejects(db.updateWhere('players', () => true, value => value, { limit: 1001 }), /between 1 and 1000/);
    await assert.rejects(db.updateWhere('players', player => {
        if (player.active) throw new Error('predicate failed');
        return false;
    }, player => player), /predicate failed/);
    assert.equal((await db.get('players', 'player-1')).visits, 3);
});

test('Cardinal DB exports and imports collections with merge or replace semantics', async t => {
    const db = await createDatabase(t);
    await db.setMany('preferences', [
        { key: 'theme', value: 'dark' },
        { key: 'locale', value: 'en' }
    ]);
    const exported = await db.exportCollection('preferences');
    assert.equal(exported.version, 1);
    assert.equal(exported.collection, 'preferences');
    assert.deepEqual(exported.records, { theme: 'dark', locale: 'en' });

    await db.importCollection('preferences', {
        version: 1,
        records: { theme: 'purple', density: 'compact' }
    });
    assert.deepEqual(await db.exportCollection('preferences').then(result => result.records), {
        theme: 'purple',
        locale: 'en',
        density: 'compact'
    });
    await db.importCollection('preferences', {
        version: 1,
        records: { theme: 'red' }
    }, { replace: true });
    assert.deepEqual(await db.exportCollection('preferences').then(result => result.records), {
        theme: 'red'
    });
    await assert.rejects(
        db.importCollection('preferences', { version: 2, records: {} }),
        /supported version/
    );
});

test('Cardinal DB exports a versioned backup of every collection', async t => {
    const db = await createDatabase(t);
    await db.setMany('settings', [
        { key: 'theme', value: 'dark' },
        { key: 'language', value: 'en' }
    ]);
    await db.set('players', 'player-1', { name: 'Ari' });

    const backup = await db.exportAll();
    assert.equal(backup.format, 'cardinal-db-backup');
    assert.equal(backup.version, 1);
    assert.match(backup.exportedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(backup.collections, [
        {
            collection: 'players',
            records: { 'player-1': { name: 'Ari' } }
        },
        {
            collection: 'settings',
            records: { theme: 'dark', language: 'en' }
        }
    ]);
    assert.doesNotMatch(JSON.stringify(backup), /CARDINAL_APP_DATA_DIR|directory/);
});

test('Cardinal DB rejects unsafe names, invalid values, and corrupt collection files', async t => {
    const db = await createDatabase(t);
    await assert.rejects(db.get('../outside', 'key'), /Collection names/);
    await assert.rejects(db.set('users', '', 'value'), /Record keys/);
    await assert.rejects(db.set('users', 'invalid', undefined), /JSON serializable/);
    await assert.rejects(db.set('users', 'circular', (() => {
        const value = {};
        value.self = value;
        return value;
    })()), /JSON serializable/);

    let escapedTransaction;
    await db.transaction('users', transaction => {
        escapedTransaction = transaction;
        transaction.set('safe', true);
    });
    assert.throws(() => escapedTransaction.get('safe'), /no longer active/);

    await fs.mkdir(db.directory, { recursive: true });
    await fs.writeFile(path.join(db.directory, 'broken.json'), '{not json');
    await assert.rejects(db.get('broken', 'key'), /contains invalid JSON/);
});

test('Cardinal DB requires an app-scoped or explicit data directory', () => {
    const originalDirectory = process.env.CARDINAL_APP_DATA_DIR;
    delete process.env.CARDINAL_APP_DATA_DIR;
    try {
        assert.throws(() => new CardinalDB(), /requires a directory or CARDINAL_APP_DATA_DIR/);
    } finally {
        if (originalDirectory === undefined) delete process.env.CARDINAL_APP_DATA_DIR;
        else process.env.CARDINAL_APP_DATA_DIR = originalDirectory;
    }
});

test('Cardinal DB doctor detects corruption and safely restores an interrupted atomic write', async t => {
    const db = await createDatabase(t);
    const collectionPath = path.join(db.directory, 'users.json');
    const temporaryPath = `${collectionPath}.interrupted.tmp`;
    await fs.mkdir(db.directory, { recursive: true });
    await fs.writeFile(collectionPath, '{broken json');
    await fs.writeFile(temporaryPath, JSON.stringify({
        version: 1,
        records: { 'user-1': { name: 'Ari' } }
    }));

    const diagnosis = await db.doctor();
    assert.equal(diagnosis.healthy, false);
    assert.ok(diagnosis.issues.some(issue => issue.code === 'invalid-json'));
    assert.equal(await fs.readFile(collectionPath, 'utf8'), '{broken json');

    const repair = await db.doctor({ repair: true });
    assert.equal(repair.repairMode, true);
    assert.equal(repair.healthy, true);
    assert.equal((await db.get('users', 'user-1')).name, 'Ari');
    await assert.rejects(fs.access(temporaryPath), { code: 'ENOENT' });
    const recoveryFiles = await fs.readdir(path.join(db.directory, 'recovery'));
    assert.equal(recoveryFiles.length, 1);
    assert.equal(await fs.readFile(path.join(db.directory, 'recovery', recoveryFiles[0]), 'utf8'), '{broken json');
});

test('Cardinal DB doctor salvages valid records while preserving the original collection', async t => {
    const db = await createDatabase(t);
    await fs.mkdir(db.directory, { recursive: true });
    await fs.writeFile(path.join(db.directory, 'players.json'), JSON.stringify({
        version: 1,
        records: {
            'player-1': { name: 'Ari' },
            '': { name: 'invalid key' }
        }
    }));

    const report = await db.doctor({ repair: true });
    assert.equal(report.healthy, true);
    assert.equal(report.summary.repaired, 2);
    assert.deepEqual(await db.list('players'), [
        { key: 'player-1', value: { name: 'Ari' } }
    ]);
    const recoveryFiles = await fs.readdir(path.join(db.directory, 'recovery'));
    assert.equal(recoveryFiles.length, 1);
    const original = JSON.parse(await fs.readFile(path.join(db.directory, 'recovery', recoveryFiles[0]), 'utf8'));
    assert.equal(original.records[''].name, 'invalid key');
});

test('Cardinal DB doctor preserves orphaned writes and refuses unsafe repair guesses', async t => {
    const db = await createDatabase(t);
    await db.set('settings', 'theme', 'dark');
    const staleWritePath = path.join(db.directory, 'settings.json.orphan.tmp');
    await fs.writeFile(staleWritePath, JSON.stringify({
        version: 1,
        records: { theme: 'light' }
    }));
    await fs.writeFile(path.join(db.directory, 'broken.json'), '{not recoverable');

    const report = await db.doctor({ repair: true });
    assert.equal(report.healthy, false);
    assert.ok(report.issues.some(issue => issue.code === 'invalid-json' && !issue.repaired));
    assert.equal(await db.get('settings', 'theme'), 'dark');
    await assert.rejects(fs.access(staleWritePath), { code: 'ENOENT' });
    assert.ok((await fs.readdir(path.join(db.directory, 'recovery'))).length >= 1);
});
