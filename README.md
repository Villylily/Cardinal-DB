<img width="1200" height="360" alt="cardinal-db-wordmark" src="https://github.com/user-attachments/assets/44cfc54e-b19b-40c3-9074-07143f492fd3" />
# Cardinal-DB
Cardinals Built in DataBase cus why use SQ lite

Cardinal DB is a small, dependency-free JSON database for Node.js. It stores records in named collections, writes changes atomically, and includes transactions, backups, repair checks, and an optional paged message-history store.

This repository contains Cardinal DB alongside the Cardinal app manager. The separate Cardinal DB export script makes a standalone GitHub-ready source folder and ZIP when you choose to run it.

## Requirements

- Node.js 20 or newer.
- No npm dependencies are required by Cardinal DB.

## Install or use from source

In the Cardinal repository, import the database from its source folder:

```js
const { CardinalDB } = require('./libs/cardinal-db');

async function main() {
    const database = new CardinalDB({ directory: './data/my-app/database' });
    await database.set('players', 'player-123', {
        name: 'Alex',
        visits: 1
    });

    console.log(await database.get('players', 'player-123'));
}

main().catch(error => {
    console.error('Database operation failed:', error);
    process.exitCode = 1;
});
```

In a Cardinal-managed app, Cardinal provides `CARDINAL_APP_DATA_DIR`. The no-argument constructor stores the database in its `database` subfolder:

```js
const { CardinalDB } = require('../../libs/cardinal-db');
const database = new CardinalDB();
```

Outside Cardinal, pass `{ directory }` or set `CARDINAL_APP_DATA_DIR`. Cardinal DB deliberately throws if it cannot determine a safe data folder; it will not silently create a database in the project or system root.

## Basic use

All database methods are asynchronous. Values must be JSON-serializable. Values passed in or returned are copied through JSON serialization, so editing an object returned by `get` does not update the stored record.

```js
await database.set('players', 'player-123', { name: 'Alex', visits: 1 });

const player = await database.get('players', 'player-123');
const exists = await database.has('players', 'player-123');
const count = await database.count('players');

await database.update('players', 'player-123', current => ({
    ...current,
    visits: (current?.visits || 0) + 1
}));

await database.delete('players', 'player-123');
```

Collection names must start with a lowercase letter or number and contain only lowercase letters, numbers, `_`, or `-` (up to 64 characters). Record keys must be strings from 1 to 256 characters.

## API

| Method | Description |
|---|---|
| `get(collection, key)` | Return the value, or `undefined` if the key does not exist. |
| `has(collection, key)` | Check whether a record exists. |
| `list(collection, { limit, after })` | Return `{ key, value }` records with optional cursor pagination. `limit` is 1-1000; `after` must be a key in the collection. |
| `find(collection, predicate, { limit, after })` | Find records using `predicate(value, key)` with the same paging options. |
| `findOne(collection, predicate)` | Return the first matching `{ key, value }`, or `undefined`. |
| `getMany(collection, keys)` | Return requested keys and values in input order. Missing values are `undefined`. |
| `set(collection, key, value)` | Save one record. |
| `setMany(collection, entries)` | Save an array of `{ key, value }` records in one transaction; return the number written. |
| `delete(collection, key)` | Delete one record and return whether it existed. |
| `deleteMany(collection, keys)` | Delete the requested keys and return the number removed. |
| `count(collection)` | Count records in a collection. |
| `update(collection, key, updater)` | Update one value. Returning `undefined` deletes the key. |
| `updateWhere(collection, predicate, updater, { limit })` | Update matching values in one transaction and return the number updated; optional limit is 1-1000. |
| `transaction(collection, callback)` | Group collection reads and changes into one atomic write. |
| `clear(collection)` | Remove all records from one collection. |
| `listCollections()` | Return the names of stored collections. |
| `exportCollection(collection)` | Export one versioned collection document. |
| `exportAll()` | Return a versioned backup of every collection. |
| `importCollection(collection, document, { replace })` | Import records, merging by default or replacing when requested. |
| `deleteCollection(collection)` | Delete a collection file. |
| `doctor({ repair })` | Inspect collection files, or attempt supported repairs. |
| `close()` | Wait for pending operations to finish. |

### Transactions

Transactions are scoped to one collection:

```js
await database.transaction('settings', transaction => {
    transaction.set('theme', 'dark');
    transaction.set('language', 'en');
});
```

The callback receives `get`, `has`, `list`, `set`, `delete`, and `update`. Use those methods inside the callback rather than calling regular database methods from there. Throwing from the callback aborts its staged changes.

## Files and durability

Each collection is a JSON file named `<collection>.json` in the database directory. Its document has a version and a `records` object:

```json
{
  "version": 1,
  "records": {
    "player-123": {
      "name": "Alex"
    }
  }
}
```

Writes are serialized for database instances in the same Node.js process that share a directory. Mutations use temporary files and atomic replacement where supported. This is a local file database; do not have multiple independent processes write to the same database directory.

## Backup, import, and repair

Make a backup and save it outside the live database directory:

```js
const backup = await database.exportAll();
await require('node:fs/promises').writeFile(
    './backups/cardinal-db.json',
    JSON.stringify(backup, null, 2)
);
```

Import a collection from its exported document:

```js
await database.importCollection('settings', importedDocument); // Merge records
await database.importCollection('settings', importedDocument, { replace: true });
```

Imports are limited to 16 MB; full database exports are limited to 64 MB.

Check database files without changing them:

```js
const report = await database.doctor();
console.log(report);
```

`database.doctor({ repair: true })` attempts supported repairs and keeps replaced originals in a `recovery` directory. Unsupported formats and data that cannot be safely repaired are reported and left untouched. Save a backup before repair whenever possible.

## Paged message history

`CardinalMessageStore` is an optional helper built on Cardinal DB. It adds generated message IDs, timestamps, reactions, paging, editing, lookup, deletion, and counting:

```js
const { CardinalDB, CardinalMessageStore } = require('./libs/cardinal-db');

const database = new CardinalDB({ directory: './data/chat/database' });
const messages = new CardinalMessageStore({ database, pageSize: 50 });

const message = await messages.insert({ username: 'Alex', text: 'Hello!' });
const latest = await messages.getRecentHistory();
await messages.toggleReaction(message.id, 'ðŸ‘', 'Sam');
```

Methods: `insert`, `getRecentHistory`, `getOlderHistory`, `findById`, `update`, `toggleReaction`, `delete`, `count`, and `clear`. Its default collection is `messages`, and its default page size is 50. Clearing the store only clears its own collection.

## Tests

Run the Cardinal DB and message-store tests from the full Cardinal repository root:

```powershell
node --test test\cardinal-db.test.js test\cardinal-message-store.test.js
```

The standalone GitHub export includes these test files and a `npm test` command.

## License

Cardinal DB is covered by the [Cardinal | Cardinal DB license notice](LICENSE), which applies to both Cardinal and Cardinal DB. Third-party terms are listed in that notice.

