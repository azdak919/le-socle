import { DatabaseSync } from "node:sqlite";

import { createModuleStore, type SqlDb } from "./sql.ts";
import type { SocleStore } from "./store.ts";

export function openSqliteMemory(): SocleStore {
  return createModuleStore(wrapSqlite(new DatabaseSync(":memory:")));
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
    async close() {
      db.close();
    },
  };
}
