import { isModuleName, moduleTable, type ModuleName } from "./modules.ts";
import { assertEnabled, tableName, type SocleStore } from "./store.ts";

export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params: readonly unknown[]): Promise<void>;
  get<T extends Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T | undefined>;
  all<T extends Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T[]>;
  tableExists(name: string): Promise<boolean>;
  close(): Promise<void>;
}

export function createModuleStore(db: SqlDb): SocleStore {
  const enabled = new Set<ModuleName>();
  const store: SocleStore = {
    async migrate(modules) {
      await db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, seq INTEGER NOT NULL)`);
      for (const module of modules) {
        await db.exec(
          `CREATE TABLE IF NOT EXISTS ${tableName(module)} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        );
        const current = await db.get<{ seq: number }>(
          `SELECT COALESCE(MAX(seq), 0) AS seq FROM schema_migration`,
          [],
        );
        await db.run(
          `INSERT INTO schema_migration (id, seq) VALUES (?, ?) ON CONFLICT (id) DO NOTHING`,
          [module, Number(current?.seq ?? 0) + 1],
        );
      }
      enabled.clear();
      for (const module of modules) enabled.add(module);
    },
    async applied() {
      if (!(await db.tableExists("schema_migration"))) return [];
      const rows = await db.all<{ id: string }>(
        `SELECT id FROM schema_migration ORDER BY seq, id`,
        [],
      );
      return rows.map((row) => row.id).filter((id): id is ModuleName => isModuleName(id));
    },
    async resume() {
      enabled.clear();
      for (const id of await store.applied()) enabled.add(id);
    },
    async rollback() {
      if (!(await db.tableExists("schema_migration"))) return null;
      const row = await db.get<{ id: string }>(
        `SELECT id FROM schema_migration ORDER BY seq DESC, id DESC LIMIT 1`,
        [],
      );
      if (!row) return null;
      await db.run(`DELETE FROM schema_migration WHERE id = ?`, [row.id]);
      if (isModuleName(row.id)) enabled.delete(row.id);
      return row.id;
    },
    async put(module, key, value) {
      assertEnabled(enabled, module);
      await db.run(
        `INSERT INTO ${tableName(module)} (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },
    async delete(module, key) {
      assertEnabled(enabled, module);
      await db.run(`DELETE FROM ${tableName(module)} WHERE key = ?`, [key]);
    },
    async get(module, key) {
      assertEnabled(enabled, module);
      const row = await db.get<{ value: string }>(
        `SELECT value FROM ${tableName(module)} WHERE key = ?`,
        [key],
      );
      return row ? row.value : null;
    },
    async list(module) {
      assertEnabled(enabled, module);
      const rows = await db.all<{ key: string; value: string }>(
        `SELECT key, value FROM ${tableName(module)} ORDER BY key`,
        [],
      );
      return rows.map((row) => ({ key: String(row.key), value: String(row.value) }));
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
  return store;
}
