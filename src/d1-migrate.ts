/**
 * SQL de migration pour D1, à passer avec `wrangler d1 execute DB --file`.
 * Mêmes tables que `store.migrate()` ; chaque ligne se rejoue sans effet.
 * Avant : `wrangler d1 export DB --output sauvegarde.sql` (la sauvegarde
 * d'abord, comme `socle migrate`).
 */
import type { ModuleName } from "./modules.ts";
import { tableName } from "./store.ts";

export function d1MigrationSql(modules: readonly ModuleName[]): string {
  const lines = ["CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, seq INTEGER NOT NULL);"];
  for (const module of modules) {
    lines.push(`CREATE TABLE IF NOT EXISTS ${tableName(module)} (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    lines.push(`INSERT INTO schema_migration (id, seq) SELECT '${module}', COALESCE(MAX(seq), 0) + 1 FROM schema_migration WHERE true ON CONFLICT (id) DO NOTHING;`);
  }
  return `${lines.join("\n")}\n`;
}
