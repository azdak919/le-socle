import { moduleTable, type ModuleName } from "./modules.ts";
import { assertEnabled, tableName, type SocleStore } from "./store.ts";

export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params: readonly unknown[]): Promise<void>;
  get<T extends Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T | undefined>;
  close(): Promise<void>;
}

export function createModuleStore(db: SqlDb): SocleStore {
  const enabled = new Set<ModuleName>();
  return {
    async migrate(modules) {
      await db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY)`);
      for (const module of modules) {
        await db.exec(
          `CREATE TABLE IF NOT EXISTS ${tableName(module)} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        );
        await db.run(
          `INSERT INTO schema_migration (id) VALUES (?) ON CONFLICT (id) DO NOTHING`,
          [module],
        );
      }
      enabled.clear();
      for (const module of modules) enabled.add(module);
    },
    async put(module, key, value) {
      assertEnabled(enabled, module);
      await db.run(
        `INSERT INTO ${tableName(module)} (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },
    async get(module, key) {
      assertEnabled(enabled, module);
      const row = await db.get<{ value: string }>(
        `SELECT value FROM ${tableName(module)} WHERE key = ?`,
        [key],
      );
      return row ? row.value : null;
    },
    async tableReady(module) {
      const row = await db.get<{ ok: number }>(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [moduleTable(module)],
      );
      return row !== undefined;
    },
    close: () => db.close(),
  };
}
