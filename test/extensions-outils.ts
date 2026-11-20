/**
 * Outils des essais d'extensions (PHP) : fabriquer un paquet, l'installer
 * dans un dossier d'hébergement, lancer le serveur de PHP, ouvrir des sessions.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

import { unzip, zipStore, type ZipFile } from "../src/zip.ts";

export const REPO = join(import.meta.dirname, "..");
export const hasPhp = spawnSync("bash", ["-lc", "command -v php"], { encoding: "utf8" }).status === 0;
export const skipPhp = !hasPhp && !process.env.CI ? "php absent" : false;

/**
 * Version annoncée par le paquet d'essai. Le contrat d'extensions arrive avec
 * la 1.5.0 : tant que package.json dit encore 1.4.x, le paquet d'essai se
 * présente comme la 1.5.0 qui le publiera. Une fois la 1.5.0 publiée, rien ne change.
 */
export function versionEssai(): string {
  const own = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version as string;
  const [a, b, c] = own.split(".").map(Number);
  return a > 1 || (a === 1 && b >= 5) ? own : "1.5.0";
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address !== "string" ? resolve(address.port) : reject(new Error("port"))));
    });
  });
}

export async function call(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { redirect: "manual", ...init });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

/** Paquet complet (site + espace de rédaction) dans un dossier journal/, version imposée, fichiers ajoutés au besoin. */
export function paquet(work: string, version: string, socleVersion: string, site: Record<string, string>, extra: Record<string, string> = {}): string {
  const siteDir = join(work, `site-${version}`);
  for (const [name, text] of Object.entries(site)) {
    mkdirSync(dirname(join(siteDir, name)), { recursive: true });
    writeFileSync(join(siteDir, name), text);
  }
  const out = join(work, `journal-${version}.zip`);
  const fiche = JSON.stringify({ nom: "kiosque-journal", version, kiosque: version, depot: "exemple/journal", fichier: "kiosque-journal.zip" });
  const made = spawnSync(process.execPath, [join(REPO, "tools/paquet-php.mjs"), "--sortie", out, "--racine", "journal", "--site", siteDir, "--paquet", fiche], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const files: ZipFile[] = [];
  for (const [name, data] of unzip(new Uint8Array(readFileSync(out)))) {
    if (name === "journal/package.json") {
      const pkg = JSON.parse(new TextDecoder().decode(data));
      files.push({ name, data: new TextEncoder().encode(`${JSON.stringify({ ...pkg, version: socleVersion }, null, 2)}\n`) });
    } else {
      files.push({ name, data });
    }
  }
  for (const [name, text] of Object.entries(extra)) files.push({ name: `journal/${name}`, data: new TextEncoder().encode(text) });
  writeFileSync(out, zipStore(files));
  return out;
}

export function installer(zip: string, host: string): void {
  for (const [name, data] of unzip(new Uint8Array(readFileSync(zip)))) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), data);
  }
}

export function copierExtension(source: string, host: string, id: string): void {
  cpSync(source, join(host, "journal/extensions", id), { recursive: true });
}

export type Serveur = { base: string; child: ChildProcess; logs: () => string; stop: () => void };

/** Serveur de PHP qui imite le .htaccess : tout /journal/… passe par index.php. */
export async function lancer(work: string, host: string, env: Record<string, string> = {}): Promise<Serveur> {
  const router = join(work, "routeur.php");
  writeFileSync(router, `<?php
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
  const child = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", host, router], {
    env: { ...process.env, SOCLE_AUTH_MODE: "", SOCLE_CONFIG: "", SOCLE_DB: "", SOCLE_STATIC: "", SOCLE_EXTENSIONS_DIR: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr?.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-6000); });
  const base = `http://127.0.0.1:${port}/journal`;
  for (let i = 0; i < 100; i++) {
    try { if ((await call(`${base}/v1/health`)).status) break; } catch { /* démarre */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { base, child, logs: () => logs, stop: () => child.kill() };
}

const json = { "content-type": "application/json" };
export const form = { "content-type": "application/x-www-form-urlencoded" };

/** Compte administrateur, puis un membre par rôle demandé. Rend les témoins de session. */
export async function equipe(base: string, roles: string[] = []): Promise<Record<string, string>> {
  const install = await call(`${base}/v1/auth/installation`, { method: "POST", headers: json, body: JSON.stringify({ email: "admin@journal.example", password: "un long secret" }) });
  assert.equal(install.status, 204, install.text);
  const out: Record<string, string> = { administrateur: String(install.headers.get("set-cookie")).split(";")[0] };
  for (const role of roles) {
    const email = `${role}@journal.example`;
    const made = await call(`${base}/v1/auth/membres`, { method: "POST", headers: { ...json, cookie: out.administrateur }, body: JSON.stringify({ email, role, password: `mot de passe ${role}` }) });
    assert.equal(made.status, 204, made.text);
    const login = await call(`${base}/v1/auth/motdepasse`, { method: "POST", headers: json, body: JSON.stringify({ email, password: `mot de passe ${role}` }) });
    out[role] = String(login.headers.get("set-cookie")).split(";")[0];
  }
  return out;
}
