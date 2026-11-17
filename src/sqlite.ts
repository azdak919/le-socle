import { DatabaseSync } from "node:sqlite";

import { moduleTable, type ModuleName } from "./modules.ts";
import { assertEnabled, tableName, type SocleStore } from "./store.ts";

export function openSqliteMemory(): SocleStore {
  return new SqliteStore(new DatabaseSync(":memory:"));
}

class SqliteStore implements SocleStore {
  private enabled = new Set<ModuleName>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async migrate(enabled: readonly ModuleName[]): Promise<void> {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY)`,
    );
    const insert = this.db.prepare(
      `INSERT INTO schema_migration (id) VALUES (?) ON CONFLICT (id) DO NOTHING`,
    );
    for (const module of enabled) {
      const table = tableName(module);
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      insert.run(module);
    }
    this.enabled = new Set(enabled);
  }

  async put(module: ModuleName, key: string, value: string): Promise<void> {
    assertEnabled(this.enabled, module);
    this.db.prepare(
      `INSERT INTO ${tableName(module)} (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  async get(module: ModuleName, key: string): Promise<string | null> {
    assertEnabled(this.enabled, module);
    const row = this.db.prepare(
      `SELECT value FROM ${tableName(module)} WHERE key = ?`,
    ).get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  async tableReady(module: ModuleName): Promise<boolean> {
    const row = this.db.prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(moduleTable(module)) as { ok: number } | undefined;
    return row !== undefined;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
