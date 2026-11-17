import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

import { runMigrate } from "../src/migrate.ts";
import { openRunningAdmin } from "../src/server.ts";
import { openSqliteFile, openSqliteMemory } from "../src/sqlite.ts";
import { ModuleOffError } from "../src/store.ts";
import { VERSION } from "../src/version.ts";
import { unzip } from "../src/zip.ts";

const exec = promisify(execFile);
const NOW = new Date("2026-11-17T15:00:00Z");

test("migrate écrit une archive avant, et s'arrête si l'écriture échoue", async () => {
  const store = openSqliteMemory();
  try {
    await store.migrate(["export"]);
    await store.put("export", "article:neuf", JSON.stringify({
      id: "neuf", title: "Neuf", year: 2026, session: "automne", status: "draft", markdown: "texte neuf",
    }));
    await assert.rejects(() => runMigrate({
      store,
      enabled: ["export", "editorial"],
      now: NOW,
      down: false,
      writeBackup() {
        throw new Error("disque");
      },
    }), /disque/);
    assert.equal(await store.tableReady("editorial"), false);
    assert.equal(await store.get("export", "article:neuf") !== null, true);
    const chunks: Uint8Array[] = [];
    await runMigrate({
      store,
      enabled: ["export", "editorial"],
      now: NOW,
      down: false,
      writeBackup(bytes) {
        chunks.push(bytes);
      },
    });
    const files = unzip(chunks[0]!);
    assert.equal(files.has("index.html"), true);
    assert.equal(files.has("content/articles/neuf.md"), true);
    assert.equal(await store.tableReady("editorial"), true);
    await runMigrate({
      store,
      enabled: ["export", "editorial"],
      now: NOW,
      down: true,
      writeBackup(bytes) {
        chunks.push(bytes);
      },
    });
    await assert.rejects(() => store.put("editorial", "a", "1"), ModuleOffError);
    assert.equal(await store.tableReady("editorial"), true);
    const kept = JSON.parse((await store.get("export", "article:neuf"))!);
    assert.equal(kept.title, "Neuf");
  } finally {
    await store.close();
  }
});

test("la commande refuse de migrer sans fichier, puis revient d'un cran", async () => {
  const dir = mkdtempSync(join(tmpdir(), "socle-cli-"));
  const db = join(dir, "socle.sqlite");
  const config = join(dir, "socle.config.json");
  const backup = join(dir, "avant.zip");
  const blocked = join(dir, "bloque");
  mkdirSync(blocked);
  writeFileSync(config, `${JSON.stringify({ modules: { editorial: true } }, null, 2)}\n`);
  await assert.rejects(exec(process.execPath, [
    "src/cli.ts", "migrate", "--db", db, "--config", config, "--backup", blocked,
  ], { cwd: root }));
  const afterFail = openSqliteFile(db);
  try {
    await afterFail.resume();
    assert.equal(await afterFail.tableReady("editorial"), false);
  } finally {
    await afterFail.close();
  }
  const ok = await exec(process.execPath, [
    "src/cli.ts", "migrate", "--db", db, "--config", config, "--backup", backup,
  ], { cwd: root });
  assert.match(ok.stdout, /avant\.zip/);
  const files = unzip(readFileSync(backup));
  assert.equal(files.has("manifest.json"), true);
  assert.equal(files.has("index.html"), true);
  const down = join(dir, "retour.zip");
  await exec(process.execPath, [
    "src/cli.ts", "migrate", "--down", "--db", db, "--config", config, "--backup", down,
  ], { cwd: root });
  const store = openSqliteFile(db);
  try {
    await store.resume();
    await assert.rejects(() => store.put("editorial", "a", "1"), ModuleOffError);
    assert.equal(await store.tableReady("editorial"), true);
  } finally {
    await store.close();
  }
});

test("ouvrir la base ne migre pas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "socle-run-"));
  const config = join(dir, "socle.config.json");
  writeFileSync(config, `${JSON.stringify({ modules: { export: true } }, null, 2)}\n`);
  const opened = await openRunningAdmin(config, join(dir, "socle.sqlite"), join(dir, "bak"), join(dir, "socle.version"));
  try {
    assert.equal(await opened.admin.store.tableReady("export"), false);
    assert.equal(opened.admin.release(), null);
    assert.equal(opened.admin.version(), VERSION);
    assert.equal(opened.admin.version(), "1.0.0");
  } finally {
    await opened.admin.store.close();
  }
});
