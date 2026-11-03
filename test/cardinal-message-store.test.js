const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CardinalDB, CardinalMessageStore } = require('../libs/cardinal-db/cardinal-db');

async function createStore(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cardinal-message-store-'));
    t.after(async () => fs.rm(directory, { recursive: true, force: true }));
    const database = new CardinalDB({ directory });
    return {
        database,
        store: new CardinalMessageStore({ database, pageSize: 2, ...options })
    };
}

test('Cardinal message store pages history and supports lookup, editing, reactions, and deletion', async t => {
    const { database, store } = await createStore(t);
    const messages = [];
    for (let index = 1; index <= 5; index += 1) {
        messages.push(await store.insert({ text: `message ${index}`, username: 'Villy' }));
    }

    assert.equal(await store.count(), 5);
    assert.deepEqual((await store.getRecentHistory()).map(message => message.text), [
        'message 4',
        'message 5'
    ]);
    assert.deepEqual((await store.getOlderHistory(messages[2].id)).map(message => message.text), [
        'message 1',
        'message 2'
    ]);
    assert.equal((await store.findById(messages[0].id)).text, 'message 1');
    assert.equal(await store.update(messages[0].id, 'edited'), true);
    assert.equal(await store.toggleReaction(messages[0].id, '👍', 'Ari'), true);
    assert.deepEqual((await store.findById(messages[0].id)).reactions, { '👍': ['Ari'] });
    assert.equal(await store.toggleReaction(messages[0].id, '👍', 'Ari'), true);
    assert.deepEqual((await store.findById(messages[0].id)).reactions, {});
    assert.equal(await store.delete(messages[0].id), true);
    assert.equal(await store.delete(messages[0].id), false);
    assert.equal(await store.count(), 4);

    const reopened = new CardinalMessageStore({ database: new CardinalDB({ directory: database.directory }), pageSize: 2 });
    assert.equal((await reopened.findById(messages[0].id)), null);
    assert.equal((await reopened.findById(messages[4].id)).text, 'message 5');
});

test('Cardinal message store serializes concurrent inserts and clears only its history collection', async t => {
    const { database, store } = await createStore(t);
    await database.set('settings', 'theme', 'dark');
    const inserted = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        store.insert({ text: `message ${index}` })
    ));

    assert.equal(new Set(inserted.map(message => message.id)).size, 20);
    assert.equal(await store.count(), 20);
    assert.equal((await store.getRecentHistory(20)).length, 20);
    await store.clear();
    assert.equal(await store.count(), 0);
    assert.deepEqual(await store.getRecentHistory(), []);
    assert.equal(await database.get('settings', 'theme'), 'dark');
});

test('Cardinal message store rejects invalid inputs and constructor options', async t => {
    const { store } = await createStore(t);
    await assert.rejects(store.insert(null), /message object/);
    await assert.rejects(store.update('', 'text'), /message ID and text/);
    await assert.rejects(store.toggleReaction('id', '', 'Ari'), /message ID, emoji, and username/);
    await assert.rejects(store.getRecentHistory(0), /between 1 and 1000/);
    assert.throws(() => new CardinalMessageStore({ database: {}, pageSize: 0 }), /Cardinal DB instance/);
});
