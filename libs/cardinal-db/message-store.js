const crypto = require('node:crypto');
const { cloneJson } = require('./json');

const METADATA_KEY = '_metadata';

class CardinalMessageStore {
    constructor({ database, collection = 'messages', pageSize = 50 } = {}) {
        if (!database || typeof database.transaction !== 'function') {
            throw new TypeError('CardinalMessageStore requires a Cardinal DB instance.');
        }
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
            throw new RangeError('CardinalMessageStore page size must be an integer between 1 and 1000.');
        }
        this.database = database;
        this.collection = collection;
        this.pageSize = pageSize;
    }

    emptyMetadata() {
        return { totalEntries: 0, currentPage: 1, indexMap: Object.create(null) };
    }

    readMetadata(transaction) {
        const metadata = transaction.get(METADATA_KEY);
        if (metadata === undefined) return this.emptyMetadata();
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
            !Number.isInteger(metadata.currentPage) || metadata.currentPage < 1 ||
            !Number.isInteger(metadata.totalEntries) || metadata.totalEntries < 0 ||
            !metadata.indexMap || typeof metadata.indexMap !== 'object' ||
            Array.isArray(metadata.indexMap)) {
            throw new Error('Cardinal message history metadata is invalid; run the Cardinal DB doctor.');
        }
        return metadata;
    }

    readPage(transaction, pageNumber) {
        const page = transaction.get(`page_${pageNumber}`);
        if (page === undefined) return [];
        if (!Array.isArray(page)) {
            throw new Error(`Cardinal message history page ${pageNumber} is invalid; run the Cardinal DB doctor.`);
        }
        return page;
    }

    async insert(messageData) {
        if (!messageData || typeof messageData !== 'object' || Array.isArray(messageData)) {
            throw new TypeError('CardinalMessageStore insert requires a message object.');
        }
        const input = cloneJson(messageData);
        const entry = {
            ...input,
            id: `card_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            timestamp: new Date().toISOString(),
            reactions: input.reactions && typeof input.reactions === 'object' && !Array.isArray(input.reactions)
                ? input.reactions
                : {}
        };
        return this.database.transaction(this.collection, transaction => {
            const metadata = this.readMetadata(transaction);
            let pageNumber = metadata.currentPage;
            let page = this.readPage(transaction, pageNumber);
            if (page.length >= this.pageSize) {
                pageNumber += 1;
                page = this.readPage(transaction, pageNumber);
            }
            page.push(entry);
            metadata.indexMap[entry.id] = pageNumber;
            metadata.totalEntries += 1;
            metadata.currentPage = pageNumber;
            transaction.set(`page_${pageNumber}`, page);
            transaction.set(METADATA_KEY, metadata);
            return entry;
        });
    }

    async getRecentHistory(limit = this.pageSize) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
            throw new RangeError('CardinalMessageStore history limit must be an integer between 1 and 1000.');
        }
        return this.database.transaction(this.collection, transaction => {
            const metadata = this.readMetadata(transaction);
            const pages = [];
            let remaining = limit;
            for (let pageNumber = metadata.currentPage; pageNumber >= 1 && remaining > 0; pageNumber -= 1) {
                const page = this.readPage(transaction, pageNumber);
                pages.unshift(page);
                remaining -= page.length;
            }
            return pages.flat().slice(-limit);
        });
    }

    async getOlderHistory(oldestId) {
        if (typeof oldestId !== 'string' || oldestId.length === 0) {
            throw new TypeError('CardinalMessageStore older history requires a message ID.');
        }
        return this.database.transaction(this.collection, transaction => {
            const metadata = this.readMetadata(transaction);
            const pageNumber = Object.hasOwn(metadata.indexMap, oldestId)
                ? metadata.indexMap[oldestId]
                : undefined;
            if (!Number.isInteger(pageNumber) || pageNumber <= 1) return [];
            return this.readPage(transaction, pageNumber - 1);
        });
    }

    async findById(id) {
        if (typeof id !== 'string' || id.length === 0) {
            throw new TypeError('CardinalMessageStore findById requires a message ID.');
        }
        return this.database.transaction(this.collection, transaction => {
            const metadata = this.readMetadata(transaction);
            const pageNumber = Object.hasOwn(metadata.indexMap, id)
                ? metadata.indexMap[id]
                : undefined;
            if (!Number.isInteger(pageNumber)) return null;
            return this.readPage(transaction, pageNumber).find(message => message.id === id) || null;
        });
    }

    async update(id, newText) {
        if (typeof id !== 'string' || id.length === 0 || typeof newText !== 'string') {
            throw new TypeError('CardinalMessageStore update requires a message ID and text.');
        }
        return this.database.transaction(this.collection, transaction => {
            const metadata = this.readMetadata(transaction);
            const pageNumber = Object.hasOwn(metadata.indexMap, id)
                ? metadata.indexMap[id]
                : undefined;
            if (!Number.isInteger(pageNumber)) return false;
            const page = this.readPage(transaction, pageNumber);
            const message = page.find(entry => entry.id === id);
            if (!message) return false;
            message.text = newText;
            transaction.set(`page_${pageNumber}`, page);
            return true;
        });
    }

    async toggleReaction(id, emoji, username) {
        if (typeof id !== 'string' || !id || typeof emoji !== 'string' || !emoji ||
            typeof username !== 'string' || !username) {
            throw new TypeError('CardinalMessageStore reactions require a message ID, emoji, and username.');
        }
        return this.database.transaction(this.collection, transaction => {
            const metadata = this.readMetadata(transaction);
            const pageNumber = metadata.indexMap[id];
            if (!Number.isInteger(pageNumber)) return false;
            const page = this.readPage(transaction, pageNumber);
            const message = page.find(entry => entry.id === id);
            if (!message) return false;
            const reactions = Object.assign(
                Object.create(null),
                message.reactions && typeof message.reactions === 'object' && !Array.isArray(message.reactions)
                    ? message.reactions
                    : {}
            );
            if (!Object.hasOwn(reactions, emoji) || !Array.isArray(reactions[emoji])) {
                reactions[emoji] = [];
            }
            message.reactions = reactions;
            const users = message.reactions[emoji];
            const userIndex = users.indexOf(username);
            if (userIndex >= 0) users.splice(userIndex, 1);
            else users.push(username);
            if (users.length === 0) delete message.reactions[emoji];
            transaction.set(`page_${pageNumber}`, page);
            return true;
        });
    }

    async delete(id) {
        if (typeof id !== 'string' || !id) {
            throw new TypeError('CardinalMessageStore delete requires a message ID.');
        }
        return this.database.transaction(this.collection, transaction => {
            const metadata = this.readMetadata(transaction);
            const pageNumber = Object.hasOwn(metadata.indexMap, id)
                ? metadata.indexMap[id]
                : undefined;
            if (!Number.isInteger(pageNumber)) return false;
            const page = this.readPage(transaction, pageNumber);
            const messageIndex = page.findIndex(entry => entry.id === id);
            if (messageIndex < 0) return false;
            page.splice(messageIndex, 1);
            delete metadata.indexMap[id];
            metadata.totalEntries -= 1;
            transaction.set(`page_${pageNumber}`, page);
            transaction.set(METADATA_KEY, metadata);
            return true;
        });
    }

    async count() {
        return this.database.transaction(this.collection, transaction =>
            this.readMetadata(transaction).totalEntries
        );
    }

    async clear() {
        return this.database.transaction(this.collection, transaction => {
            for (const { key } of transaction.list()) transaction.delete(key);
            transaction.set(METADATA_KEY, this.emptyMetadata());
        });
    }
}

module.exports = { CardinalMessageStore };
