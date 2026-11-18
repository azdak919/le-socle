/**
 * Paquet complet (Kiosque) : le même programme PHP sert le site du journal
 * depuis site/ (racine « journal/ », déposée dans /journal/). Une adresse
 * d'article reçoit la coquille du site, avec les chemins du sous-dossier ;
 * noindex de la publication ferme robots.txt et ajoute la balise robots.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

test("paquet complet : le site du journal servi par le socle PHP", { skip: !hasPhp && !process.env.CI ? "php absent" : false }, async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-complet-"));
  const site = join(work, "site");
  const shell = (title: string) => `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/assets/theme.css"></head><body><a href="/sports/">Sports</a>`
    + `<script>window.KIOSQUE_EDITORIAL={"mode":"socle-vivant","apiBase":"","publicBasePath":"","adminBasePath":"/redaction","assetsBase":"/assets/editorial"};</script></body></html>`;
  mkdirSync(join(site, "assets", "editorial"), { recursive: true });
  writeFileSync(join(site, "index.html"), shell("Accueil"));
  writeFileSync(join(site, "404.html"), shell("Coquille"));
  writeFileSync(join(site, "kiosque-vivant.json"), "{}\n");
  writeFileSync(join(site, "assets", "theme.css"), "body{}");
  const zipPath = join(work, "kiosque-journal.zip");
  const built = spawnSync(process.execPath, [join(REPO, "tools/paquet-php.mjs"), "--sortie", zipPath, "--racine", "journal", "--site", site, "--paquet", '{"nom":"essai"}'], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const host = join(work, "public_html");
  const names: string[] = [];
  for (const [name, data] of unzip(new Uint8Array(readFileSync(zipPath)))) {
    names.push(name);
    const target = join(host, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  assert.ok(names.includes("journal/index.php") && names.includes("journal/site/404.html") && names.includes("journal/paquet.json"), names.join(" "));
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
    env: { ...process.env, SOCLE_AUTH_MODE: "", SOCLE_CONFIG: "", SOCLE_DB: "", SOCLE_STATIC: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr?.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); });
  const base = `http://127.0.0.1:${port}/journal`;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await call(`${base}/v1/health`)).status) break; } catch { /* démarre */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const home = await call(`${base}/`);
    assert.equal(home.status, 200, logs);
    assert.match(home.text, /<title>Accueil<\/title>/);
    assert.match(home.text, /href="\/journal\/assets\/theme\.css"/);
    assert.match(home.text, /"publicBasePath":"\/journal"/);
    assert.match(home.text, /"assetsBase":"\/journal\/assets\/editorial"/);
    assert.match(home.text, /"apiBase":"\/journal"/);
    assert.doesNotMatch(home.text, /noindex/);
    const article = await call(`${base}/sports/2026/un-match/`);
    assert.equal(article.status, 200);
    assert.match(article.text, /<title>Coquille<\/title>/);
    assert.equal((await call(`${base}/assets/absent.css`)).status, 404, "un fichier absent reste introuvable");
    assert.equal((await call(`${base}/assets/theme.css`)).text, "body{}");
    assert.match((await call(`${base}/robots.txt`)).text, /Allow: \//);
    assert.equal((await call(`${base}/redaction/`)).status, 200);
    // Installation, puis publication marquée noindex.
    const json = { "content-type": "application/json" };
    const install = await call(`${base}/v1/auth/installation`, { method: "POST", headers: json, body: JSON.stringify({ email: "admin@journal.example", password: "un long secret" }) });
    assert.equal(install.status, 204, install.text);
    const cookie = String(install.headers.get("set-cookie")).split(";")[0];
    const pub = await call(`${base}/v1/redaction/publication`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ publication: { name: "Le Phare", slug: "le-phare", noindex: true } }) });
    assert.equal(pub.status, 200, `${pub.status} ${pub.text}`);
    assert.equal((await call(`${base}/v1/editorial/snapshot`)).status, 200);
    assert.match((await call(`${base}/robots.txt`)).text, /Disallow: \//);
    assert.match((await call(`${base}/`)).text, /<meta name="robots" content="noindex, nofollow"><\/head>/);
    assert.equal((await call(`${base}/`)).headers.get("x-robots-tag"), "noindex, nofollow");
    assert.doesNotMatch((await call(`${base}/`)).text, /demo-banner/);
    // Journal fictif : bandeau au-dessus du mât, sur l'accueil comme sur un article.
    const fictif = await call(`${base}/v1/redaction/publication`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ publication: { name: "Le Phare", slug: "le-phare", noindex: true, fictif: true } }) });
    assert.equal(fictif.status, 200, fictif.text);
    assert.match((await call(`${base}/`)).text, /<body[^>]*><div class="demo-banner" role="note"><span class="demo-banner__lead">Journal étudiant fictif<\/span>/);
    assert.match((await call(`${base}/articles/un-article/`)).text, /demo-banner/);
  } finally {
    child.kill();
  }
});
