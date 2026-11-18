/**
 * Base de la démo en mode navigateur : SQLite compilé en WebAssembly par
 * sql.js (MIT, github.com/sql-js/sql.js), gardé dans IndexedDB.
 *
 * - `sql-wasm.js` et `sql-wasm.wasm` sont copiés tels quels de sql.js
 *   (`dist/sql-wasm-browser.*`) par `npm run ui`. Le mode serveur ne les sert
 *   jamais.
 * - La base vit en mémoire ; après chaque écriture, ses octets partent dans
 *   IndexedDB (base `<nom>`, magasin `sqlite`). Au chargement, on les relit.
 * - Même petite interface qu'avant : `query(sql, params)` rend `{ rows }`,
 *   `exec(sql)`, `transaction(fn)`. Les colonnes `data` et `value` sont du
 *   JSON relu en objet ; `$1` devient `?1`.
 */
const STORE = 'sqlite';
const KEY = 'db';
let loader = null;

function loadSqlJs(assetsBase) {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    if (globalThis.initSqlJs) { resolve(globalThis.initSqlJs); return; }
    const script = document.createElement('script');
    script.src = `${assetsBase}/sql-wasm.js`;
    script.onload = () => (globalThis.initSqlJs ? resolve(globalThis.initSqlJs) : reject(new Error('sql.js absent.')));
    script.onerror = () => reject(new Error('La base de la démo (sql.js) ne se charge pas.'));
    document.head.append(script);
  // sql.js demande « sql-wasm-browser.wasm » : on le sert sous le nom copié.
  }).then((init) => init({ locateFile: (file) => `${assetsBase}/${file.endsWith('.wasm') ? 'sql-wasm.wasm' : file}` }));
  return loader;
}

function idb(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(db, mode, act) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = act(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Postgres → SQLite, pour les quelques tournures de la démo. */
export function toSqlite(sql) {
  return String(sql)
    .replace(/::(jsonb|json|int|integer|text|boolean|timestamptz)\b/g, '')
    .replace(/\$(\d+)/g, '?$1');
}

function bindValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

function readRow(row) {
  for (const key of ['data', 'value']) {
    if (typeof row[key] === 'string') {
      try { row[key] = JSON.parse(row[key]); } catch { /* texte simple */ }
    }
  }
  return row;
}

export class SqlJsDb {
  #db = null;
  #idb = null;
  #depth = 0;
  #saving = Promise.resolve();

  static async open({ assetsBase, name }) {
    const instance = new SqlJsDb();
    const SQL = await loadSqlJs(String(assetsBase || '').replace(/\/$/, ''));
    instance.#idb = await idb(name);
    const bytes = await idbRequest(instance.#idb, 'readonly', (store) => store.get(KEY));
    instance.#db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
    instance.#db.exec('PRAGMA foreign_keys = ON;');
    instance.SQL = SQL;
    return instance;
  }

  /** Relit la base gardée (un autre onglet vient d'écrire). */
  async reload() {
    const bytes = await idbRequest(this.#idb, 'readonly', (store) => store.get(KEY));
    if (!bytes) return;
    this.#db.close();
    this.#db = new this.SQL.Database(new Uint8Array(bytes));
  }

  async query(sql, params = []) {
    const statement = this.#db.prepare(toSqlite(sql));
    const rows = [];
    try {
      statement.bind(params.map(bindValue));
      while (statement.step()) rows.push(readRow(statement.getAsObject()));
    } finally {
      statement.free();
    }
    if (!/^\s*select\b/i.test(sql)) await this.#persist();
    return { rows };
  }

  async exec(sql) {
    this.#db.exec(toSqlite(sql));
    await this.#persist();
  }

  async transaction(fn) {
    this.#db.exec('BEGIN');
    this.#depth += 1;
    try {
      const result = await fn(this);
      this.#depth -= 1;
      this.#db.exec('COMMIT');
      await this.#persist();
      return result;
    } catch (error) {
      this.#depth -= 1;
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async #persist() {
    if (this.#depth > 0) return;
    const bytes = this.#db.export();
    this.#saving = this.#saving.then(() => idbRequest(this.#idb, 'readwrite', (store) => store.put(bytes, KEY)));
    await this.#saving;
  }

  async close() {
    await this.#saving;
    this.#db?.close();
    this.#idb?.close();
  }
}
