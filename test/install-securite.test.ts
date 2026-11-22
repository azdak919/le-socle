import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  avisDonneesExposees,
  assurerCodeInstallation,
  inventerCodeInstallation,
  retirerCodeInstallation,
  verifierCodeInstallation,
} from "../src/install-securite.ts";
import { openSqliteMemory } from "../src/sqlite.ts";

test("le code d’installation a le format ABCD-EFGH, sans 0, O, 1 ni I", () => {
  for (let i = 0; i < 20; i++) {
    const code = inventerCodeInstallation();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.doesNotMatch(code, /[01IO]/);
  }
});

test("avis : rien à signaler hors de l’espace Web, ou avec le routeur, ou avec .htaccess", () => {
  assert.equal(avisDonneesExposees({ dataDir: "/var/lib/journal", webRoot: "/var/www/journal", viaRouteur: false }), null);
  assert.equal(avisDonneesExposees({
    dataDir: "/var/www/journal/donnees",
    webRoot: "/var/www/journal",
    viaRouteur: true,
    sapi: "cli-server",
  }), null);
  assert.equal(avisDonneesExposees({
    dataDir: "/var/www/journal/donnees",
    webRoot: "/var/www/journal",
    htaccess: true,
  }), null);
});

test("avis : le serveur intégré de PHP sans routeur, ou .htaccess absent", () => {
  const cli = avisDonneesExposees({
    dataDir: "/var/www/journal/donnees",
    webRoot: "/var/www/journal",
    sapi: "cli-server",
  });
  assert.match(String(cli), /routeur\.php/);
  const apache = avisDonneesExposees({
    dataDir: "/var/www/journal/donnees",
    webRoot: "/var/www/journal",
    htaccess: false,
  });
  assert.match(String(apache), /\.htaccess/);
});

test("le code vit dans le magasin ; le fichier n’est écrit que s’il y a une vraie base", async () => {
  const store = openSqliteMemory();
  await store.migrate(["auth"]);
  const previous = process.env.SOCLE_DB;
  const previousFile = process.env.SOCLE_INSTALL_CODE_FILE;
  delete process.env.SOCLE_DB;
  delete process.env.SOCLE_INSTALL_CODE_FILE;
  try {
    const { code, created } = await assurerCodeInstallation(store);
    assert.equal(created, true);
    assert.equal(await store.get("auth", "install-code"), code);
    await verifierCodeInstallation(store, code.toLowerCase());
    await assert.rejects(() => verifierCodeInstallation(store, "ZZZZ-ZZZZ"), /n’est pas le bon/);
    const work = mkdtempSync(join(tmpdir(), "socle-code-"));
    const db = join(work, "socle.sqlite");
    process.env.SOCLE_DB = db;
    const again = await assurerCodeInstallation(store);
    assert.equal(again.created, false);
    assert.equal(again.code, code);
    const file = join(work, "code-installation.txt");
    assert.equal(existsSync(file), true);
    assert.match(readFileSync(file, "utf8"), new RegExp(code));
    await retirerCodeInstallation(store);
    assert.equal(await store.get("auth", "install-code"), null);
    assert.equal(existsSync(file), false);
    rmSync(work, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.SOCLE_DB;
    else process.env.SOCLE_DB = previous;
    if (previousFile === undefined) delete process.env.SOCLE_INSTALL_CODE_FILE;
    else process.env.SOCLE_INSTALL_CODE_FILE = previousFile;
    await store.close();
  }
});
