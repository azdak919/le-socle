import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildSiteZip } from "./archive.ts";
import { defaultConfig, enabledModules, loadConfigFile } from "./config.ts";
import { d1MigrationSql } from "./d1-migrate.ts";
import { runMigrate } from "./migrate.ts";
import { openSqliteFile } from "./sqlite.ts";

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`option ${name} sans valeur`);
  return value;
}

function writeBytes(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dbPath = option("--db", "socle.sqlite");
  const configPath = option("--config", "socle.config.json");
  const config = existsSync(configPath) ? loadConfigFile(configPath) : defaultConfig();
  if (command === "d1-sql") {
    // SQL de migration pour D1 (Worker) : `wrangler d1 execute DB --file`.
    process.stdout.write(d1MigrationSql(enabledModules(config)));
    return;
  }
  const store = openSqliteFile(dbPath);
  try {
    if (command === "export") {
      await store.resume();
      if (!(await store.applied()).includes("export")) {
        throw new Error("module export éteint");
      }
      const out = option("--out", `sauvegardes/export-${stamp()}.zip`);
      writeBytes(out, await buildSiteZip(store, new Date()));
      console.log(out);
      return;
    }
    if (command === "migrate") {
      const backup = option("--backup", `sauvegardes/avant-migrate-${stamp()}.zip`);
      const result = await runMigrate({
        store,
        enabled: enabledModules(config),
        now: new Date(),
        down: flag("--down"),
        writeBackup: (bytes) => writeBytes(backup, bytes),
      });
      console.log(backup);
      if (result.removed) console.log(`retiré : ${result.removed}`);
      return;
    }
    throw new Error("commande : migrate, export ou d1-sql");
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "erreur";
  console.error(message);
  process.exitCode = 1;
});
