import { PGlite } from "@electric-sql/pglite";

import { moduleTable, type ModuleName } from "./modules.ts";
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
      `CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY)`,
    );
    for (const module of enabled) {
      const table = tableName(module);
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      await this.db.query(
        `INSERT INTO schema_migration (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [module],
      );
    }
    this.enabled = new Set(enabled);
  }

  async put(module: ModuleName, key: string, value: string): Promise<void> {
    assertEnabled(this.enabled, module);
    await this.db.query(
      `INSERT INTO ${tableName(module)} (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
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
