import { PGlite } from "@electric-sql/pglite";

import { isModuleName, moduleTable, type ModuleName } from "./modules.ts";
import { assertEnabled, tableName, type SocleStore } from "./store.ts";

export async function openPgliteMemory(): Promise<SocleStore> {
  const db = new PGlite();
  await db.waitReady;
  return new PgliteStore(db);
}

class PgliteStore implements SocleStore {
  private enabled = new Set<ModuleName>();
  private readonly db: PGlite;

  constructor(db: PGlite) {
    this.db = db;
  }

  async migrate(enabled: readonly ModuleName[]): Promise<void> {
    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, seq INTEGER NOT NULL)`,
    );
    for (const module of enabled) {
      const table = tableName(module);
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      const current = await this.db.query<{ seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM schema_migration`,
      );
      const seq = Number(current.rows[0]?.seq ?? 0) + 1;
      await this.db.query(
        `INSERT INTO schema_migration (id, seq) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [module, seq],
      );
    }
    this.enabled = new Set(enabled);
  }

  async applied(): Promise<ModuleName[]> {
    if (!(await this.migrationReady())) return [];
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM schema_migration ORDER BY seq, id`,
    );
    return result.rows.map((row) => row.id).filter((id): id is ModuleName => isModuleName(id));
  }

  async resume(): Promise<void> {
    this.enabled = new Set(await this.applied());
  }

  async rollback(): Promise<string | null> {
    if (!(await this.migrationReady())) return null;
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM schema_migration ORDER BY seq DESC, id DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    await this.db.query(`DELETE FROM schema_migration WHERE id = $1`, [row.id]);
    if (isModuleName(row.id)) this.enabled.delete(row.id);
    return row.id;
  }

  private async migrationReady(): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migration'`,
    );
    return result.rows.length > 0;
  }

  async put(module: ModuleName, key: string, value: string): Promise<void> {
    assertEnabled(this.enabled, module);
    await this.db.query(
      `INSERT INTO ${tableName(module)} (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  async delete(module: ModuleName, key: string): Promise<void> {
    assertEnabled(this.enabled, module);
    await this.db.query(`DELETE FROM ${tableName(module)} WHERE key = $1`, [key]);
  }

  async get(module: ModuleName, key: string): Promise<string | null> {
    assertEnabled(this.enabled, module);
    const result = await this.db.query<{ value: string }>(
      `SELECT value FROM ${tableName(module)} WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? row.value : null;
  }

  async list(module: ModuleName): Promise<Array<{ key: string; value: string }>> {
    assertEnabled(this.enabled, module);
    const result = await this.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${tableName(module)} ORDER BY key`,
    );
    return result.rows.map((row) => ({ key: String(row.key), value: String(row.value) }));
  }

  async tableReady(module: ModuleName): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [moduleTable(module)],
    );
    return result.rows.length > 0;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
