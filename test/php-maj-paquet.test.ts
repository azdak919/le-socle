/**
 * Mise à jour en un clic d'un paquet complet : la page vérifie la dernière
 * Release, l'administrateur seul installe ; sauvegarde du programme et de la
 * base d'abord, donnees/ jamais touché, fichiers retirés supprimés ; retour
 * à la version précédente en un clic.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { unzip } from "../src/zip.ts";

const REPO = join(import.meta.dirname, "..");
const hasPhp = spawnSync("bash", ["-lc", "command -v php"], { encoding: "utf8" }).status === 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address !== "string" ? resolve(address.port) : reject(new Error("port"))));
    });
  });
}

async function call(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { redirect: "manual", ...init });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

function paquet(work: string, version: string, files: Record<string, string>): string {
  const site = join(work, `site-${version}`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(site, name)), { recursive: true });
    writeFileSync(join(site, name), text);
  }
  const out = join(work, `journal-${version}.zip`);
  const fiche = JSON.stringify({ nom: "kiosque-journal", version, depot: "exemple/journal", fichier: "kiosque-journal.zip" });
  const made = spawnSync(process.execPath, [join(REPO, "tools/paquet-php.mjs"), "--sortie", out, "--racine", "journal", "--site", site, "--paquet", fiche], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return out;
}

test("paquet complet : mise à jour en un clic, sauvegarde et retour arrière", { skip: !hasPhp && !process.env.CI ? "php absent" : false }, async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-maj-"));
  const v1 = paquet(work, "1.0.0", { "index.html": "<html><head></head><body>version 1</body></html>", "kiosque-vivant.json": "{}", "ancien.html": "<p>ancien</p>" });
  const v2 = paquet(work, "1.1.0", { "index.html": "<html><head></head><body>version 2</body></html>", "kiosque-vivant.json": "{}", "nouveau.html": "<p>nouveau</p>" });
  const release = join(work, "release.json");
  writeFileSync(release, JSON.stringify({ tag_name: "v1.1.0", body: "Ce qui change dans 1.1.0", html_url: "https://example.org/releases/v1.1.0", assets: [{ name: "kiosque-journal.zip", browser_download_url: `file://${v2}` }] }));
  const host = join(work, "public_html");
  for (const [name, data] of unzip(new Uint8Array(readFileSync(v1)))) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), data);
  }
  writeFileSync(join(work, "routeur.php"), `<?php
$uri = $_SERVER['REQUEST_URI'] ?? '/';
if (str_starts_with($uri, '/journal')) {
  $_SERVER['SCRIPT_NAME'] = '/journal/index.php';
  require ${JSON.stringify(join(host, "journal/index.php"))};
  return true;
}
http_response_code(404);
return true;
`);
  const port = await freePort();
  const child: ChildProcess = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", host, join(work, "routeur.php")], {
    env: { ...process.env, SOCLE_AUTH_MODE: "", SOCLE_CONFIG: "", SOCLE_DB: "", SOCLE_STATIC: "", SOCLE_MAJ_SOURCE: release },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr?.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); });
  const base = `http://127.0.0.1:${port}/journal`;
  const json = { "content-type": "application/json" };
  const form = { "content-type": "application/x-www-form-urlencoded" };
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await call(`${base}/v1/health`)).status) break; } catch { /* démarre */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match((await call(`${base}/`)).text, /version 1/, logs);
    const install = await call(`${base}/v1/auth/installation`, { method: "POST", headers: json, body: JSON.stringify({ email: "admin@journal.example", password: "un long secret" }) });
    assert.equal(install.status, 204, install.text);
    const cookie = String(install.headers.get("set-cookie")).split(";")[0];
    await call(`${base}/v1/auth/membres`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ email: "ana@journal.example", role: "auteur", password: "mot de passe d’Ana" }) });
    const ana = await call(`${base}/v1/auth/motdepasse`, { method: "POST", headers: json, body: JSON.stringify({ email: "ana@journal.example", password: "mot de passe d’Ana" }) });
    const anaCookie = String(ana.headers.get("set-cookie")).split(";")[0];

    const page = await call(`${base}/admin/mise-a-jour?verifier=1`, { headers: { cookie } });
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Version du journal<\/dt><dd>1\.0\.0/);
    assert.match(page.text, /Mettre à jour vers la version 1\.1\.0/);
    assert.match(page.text, /Ce qui change dans 1\.1\.0/);
    assert.match(page.text, /action="\/journal\/admin\/mise-a-jour\/paquet"/);

    assert.equal((await call(`${base}/admin/mise-a-jour/paquet`, { method: "POST", headers: form, body: "" })).status, 401, "sans session : rien");
    assert.equal((await call(`${base}/admin/mise-a-jour/paquet`, { method: "POST", headers: { ...form, cookie: anaCookie }, body: "" })).status, 403, "un auteur ne met pas à jour");
    assert.match((await call(`${base}/`)).text, /version 1/);

    const done = await call(`${base}/admin/mise-a-jour/paquet`, { method: "POST", headers: { ...form, cookie }, body: "" });
    assert.equal(done.status, 200);
    assert.match(done.text, /Mise à jour faite : 1\.0\.0 → 1\.1\.0/, done.text.slice(0, 2000));
    assert.match((await call(`${base}/`)).text, /version 2/);
    assert.ok(!existsSync(join(host, "journal/site/ancien.html")), "un fichier retiré par la nouvelle version disparaît");
    assert.ok(existsSync(join(host, "journal/site/nouveau.html")));
    const saved = readdirSync(join(host, "journal/donnees/mises-a-jour"));
    assert.ok(saved.some((name) => /^programme-1\.0\.0-.*\.zip$/.test(name)), saved.join(" "));
    assert.ok(saved.some((name) => /^base-.*\.sqlite$/.test(name)), saved.join(" "));
    const again = await call(`${base}/v1/auth/motdepasse`, { method: "POST", headers: json, body: JSON.stringify({ email: "admin@journal.example", password: "un long secret" }) });
    assert.equal(again.status, 204, "les comptes (donnees/) sont intacts");
    const after = await call(`${base}/admin/mise-a-jour`, { headers: { cookie } });
    assert.match(after.text, /Version du journal<\/dt><dd>1\.1\.0/);
    assert.match(after.text, /Le journal est à jour/);
    assert.match(after.text, /Revenir à la version 1\.0\.0/);

    const back = await call(`${base}/admin/mise-a-jour/paquet/revenir`, { method: "POST", headers: { ...form, cookie }, body: "" });
    assert.match(back.text, /Retour fait : la version 1\.0\.0 est revenue/);
    assert.match((await call(`${base}/`)).text, /version 1/);
    assert.ok(existsSync(join(host, "journal/site/ancien.html")));
    assert.ok(!existsSync(join(host, "journal/site/nouveau.html")));
  } finally {
    child.kill();
  }
});
