/**
 * L'admin de rédaction, servie par le socle lui-même sous `/redaction/`.
 * La page (`admin/serveur.html`) et ses fichiers (`admin/assets/`) sont dans
 * ce dépôt : l'admin se développe à un seul endroit, et chaque journal reçoit
 * la même avec la mise à jour du socle. Même règle en PHP
 * (`socle_serve_redaction_page`). Seulement si `editorial` est allumé.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "admin");

/** Fichiers servis en mode serveur. Pas de PGlite : il ne sert qu'à la démo. */
export const SERVER_ASSETS: ReadonlySet<string> = new Set([
  "admin.js", "admin.css", "runtime.js", "util.js", "export.js",
  "stock-photo-match.js", "marked.esm.js", "socle-backend.js",
]);

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cache-control": "no-cache",
};

type Result = { status: number; body: string | Uint8Array; headers: Record<string, string> };

/** `null` : ce chemin n'est pas l'admin, la requête continue ailleurs. */
export function serveRedactionPage(path: string, method: string): Result | null {
  if (path !== "/redaction" && !path.startsWith("/redaction/")) return null;
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: "", headers: { allow: "GET, HEAD" } };
  if (path === "/redaction") return { status: 301, body: "", headers: { location: "/redaction/" } };
  let file: string;
  let type: string;
  if (path === "/redaction/") {
    file = join(ADMIN_DIR, "serveur.html");
    type = "text/html; charset=utf-8";
  } else {
    const name = path.slice("/redaction/assets/".length);
    if (!path.startsWith("/redaction/assets/") || !SERVER_ASSETS.has(name)) return { status: 404, body: "", headers: {} };
    file = join(ADMIN_DIR, "assets", name);
    type = name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
  }
  const body = readFileSync(file);
  return { status: 200, body: method === "HEAD" ? "" : body, headers: { "content-type": type, ...HEADERS } };
}
