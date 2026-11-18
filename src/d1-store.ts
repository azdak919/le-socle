/** Pilote D1 sans Miniflare : le Worker lui donne sa liaison `DB`. */
import type { SqlDb } from "./sql.ts";

export type D1Prepared = {
  bind(...values: readonly unknown[]): D1Prepared;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};

export type D1Database = {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): D1Prepared;
};

export function wrapD1(db: D1Database, close: () => Promise<void>): SqlDb {
  return {
    exec: (sql) => db.exec(sql).then(() => undefined),
    run: (sql, params) => db.prepare(sql).bind(...params).run().then(() => undefined),
    async get(sql, params) {
      const row = await db.prepare(sql).bind(...params).first<Record<string, unknown>>();
      return row ?? undefined;
    },
    async all(sql, params) {
      const result = await db.prepare(sql).bind(...params).all<Record<string, unknown>>();
      return result.results;
    },
    async tableExists(name) {
      const row = await db.prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).bind(name).first();
      return row !== null && row !== undefined;
    },
    close,
  };
}
