/**
 * Paquet PHP pour hébergement mutualisé : déposé dans un sous-dossier
 * (/journal/socle/), il crée ses tables, propose l'installation du compte
 * responsable, puis la rédaction et les photos publiques marchent sous ce
 * préfixe. Le routeur imite le .htaccess (tout vers index.php).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { unzip } from "../src/zip.ts";

const REPO = join(import.meta.dirname, "..");

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

/** Lit toujours le corps : le serveur de PHP ferme la connexion, undici n'aime pas un corps laissé en plan. */
async function call(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

const hasPhp = spawnSync("bash", ["-lc", "command -v php"], { encoding: "utf8" }).status === 0;

test("paquet PHP mutualisé : sous-dossier, installation, équipe, rédaction", { skip: !hasPhp && !process.env.CI ? "php absent" : false }, async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-mutualise-"));
  const zipPath = join(work, "le-socle-php.zip");
  const built = spawnSync(process.execPath, [join(REPO, "tools/paquet-php.mjs"), "--sortie", zipPath], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const host = join(work, "public_html");
  const { readFileSync } = await import("node:fs");
  for (const [name, data] of unzip(new Uint8Array(readFileSync(zipPath)))) {
    const target = join(host, "journal", name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  writeFileSync(join(work, "routeur.php"), `<?php
$uri = $_SERVER['REQUEST_URI'] ?? '/';
if (str_starts_with($uri, '/journal/socle')) {
  $_SERVER['SCRIPT_NAME'] = '/journal/socle/index.php';
  require ${JSON.stringify(join(host, "journal/socle/index.php"))};
  return true;
}
http_response_code(404);
return true;
`);
  const port = await freePort();
  const child: ChildProcess = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", host, join(work, "routeur.php")], {
    env: { ...process.env, SOCLE_AUTH_MODE: "", SOCLE_CONFIG: "", SOCLE_DB: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr?.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); });
  const base = `http://127.0.0.1:${port}/journal/socle`;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await call(`${base}/v1/health`)).status) break; } catch { /* démarre */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const page = await call(`${base}/redaction/`);
    assert.equal(page.status, 200, logs);
    const html = page.text;
    assert.match(html, /"apiBase":"\/journal\/socle"/);
    assert.match(html, /src="\/journal\/socle\/redaction\/assets\/admin\.js"/);
    assert.equal((await call(`${base}/redaction/assets/admin.js`)).status, 200);
    assert.equal((await call(`${base}/v1/redaction/etat`)).status, 401);
    assert.equal((await call(`${base}/donnees/socle.sqlite`)).status, 404, "la base n’est jamais servie");
    const state = JSON.parse((await call(`${base}/v1/auth/etat`)).text);
    assert.deepEqual(state, { mode: "motdepasse", installed: false, email: null, role: null });
    const json = { "content-type": "application/json" };
    const install = await call(`${base}/v1/auth/installation`, { method: "POST", headers: json, body: JSON.stringify({ email: "resp@cegep.example", password: "un long secret" }) });
    assert.equal(install.status, 204, install.text);
    const cookie = String(install.headers.get("set-cookie")).split(";")[0];
    const etat = await call(`${base}/v1/redaction/etat`, { headers: { cookie } });
    assert.equal(etat.status, 200);
    assert.equal(JSON.parse(etat.text).role, "administrateur");
    const again = await call(`${base}/v1/auth/installation`, { method: "POST", headers: json, body: JSON.stringify({ email: "intrus@example.org", password: "un autre secret" }) });
    assert.equal(again.status, 409);
    const login = await call(`${base}/v1/auth/motdepasse`, { method: "POST", headers: json, body: JSON.stringify({ email: "resp@cegep.example", password: "un long secret" }) });
    assert.equal(login.status, 204);
    const wrong = await call(`${base}/v1/auth/motdepasse`, { method: "POST", headers: json, body: JSON.stringify({ email: "resp@cegep.example", password: "pas le bon" }) });
    assert.equal(wrong.status, 401);
    const member = await call(`${base}/v1/auth/membres`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ email: "ana@cegep.example", role: "auteur", password: "mot de passe d’Ana" }) });
    assert.equal(member.status, 204, member.text);
    const ana = await call(`${base}/v1/auth/motdepasse`, { method: "POST", headers: json, body: JSON.stringify({ email: "ana@cegep.example", password: "mot de passe d’Ana" }) });
    assert.equal(ana.status, 204);
    const team = JSON.parse((await call(`${base}/v1/auth/membres`, { headers: { cookie } })).text);
    assert.deepEqual(team, [{ email: "ana@cegep.example", role: "auteur" }, { email: "resp@cegep.example", role: "administrateur" }]);
    // L'ancien nom « responsable » est encore accepté, enregistré sous « administrateur ».
    const legacy = await call(`${base}/v1/auth/membres`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ email: "zoe@cegep.example", role: "responsable", password: "mot de passe de Zoé" }) });
    assert.equal(legacy.status, 204, legacy.text);
    const zoe = await call(`${base}/v1/auth/motdepasse`, { method: "POST", headers: json, body: JSON.stringify({ email: "zoe@cegep.example", password: "mot de passe de Zoé" }) });
    const zoeCookie = String(zoe.headers.get("set-cookie")).split(";")[0];
    assert.equal(JSON.parse((await call(`${base}/v1/auth/etat`, { headers: { cookie: zoeCookie } })).text).role, "administrateur");
    assert.equal((await call(`${base}/v1/auth/membres`, { headers: { cookie: zoeCookie } })).status, 200);
    // Sans session, les pages /admin ne donnent rien : ni archive, ni restauration, ni article.
    const anonZip = await call(`${base}/admin/sauvegarde/site.zip`, { redirect: "manual" });
    assert.equal(anonZip.status, 303);
    assert.equal(anonZip.headers.get("location"), "/journal/socle/redaction/");
    assert.equal((await call(`${base}/admin/sauvegarde/restaurer`, { method: "POST", headers: { "content-type": "application/zip" }, body: "PK" })).status, 401);
    assert.equal((await call(`${base}/admin/articles`, { method: "POST", body: "title=x&slug=x&status=published" })).status, 401);
    assert.equal((await call(`${base}/admin/mise-a-jour`, { method: "POST", body: "confirm=1" })).status, 401);
    // Une autrice n'a pas la sauvegarde ; l'administrateur, si.
    const anaCookie = String(ana.headers.get("set-cookie")).split(";")[0];
    assert.equal((await call(`${base}/admin/sauvegarde/site.zip`, { headers: { cookie: anaCookie } })).status, 403);
    assert.equal((await call(`${base}/admin/articles`, { method: "POST", headers: { cookie: anaCookie }, body: "title=x&slug=x&status=published" })).status, 403);
    assert.equal((await call(`${base}/admin/sauvegarde/site.zip`, { headers: { cookie } })).status, 200);
    const admin = await call(`${base}/admin`, { headers: { cookie }, redirect: "manual" });
    assert.equal(admin.status, 303);
    assert.equal(admin.headers.get("location"), "/journal/socle/redaction/");
  } finally {
    child.kill();
  }
});
