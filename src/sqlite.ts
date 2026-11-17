import { DatabaseSync } from "node:sqlite";

import { createModuleStore, type SqlDb } from "./sql.ts";
import type { SocleStore } from "./store.ts";

export function openSqliteMemory(): SocleStore {
  return createModuleStore(wrapSqlite(new DatabaseSync(":memory:")));
}

export function openSqliteFile(path: string): SocleStore {
  return createModuleStore(wrapSqlite(new DatabaseSync(path)));
}

function wrapSqlite(db: DatabaseSync): SqlDb {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params) {
      db.prepare(sql).run(...params);
    },
    async get(sql, params) {
      return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    },
    async all(sql, params) {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    async tableExists(name) {
      const row = db.prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name);
      return row !== undefined;
    },
    async close() {
      db.close();
    },
  };
}
