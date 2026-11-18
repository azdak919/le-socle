/**
 * Pages construites du journal, servies par le socle quand `SOCLE_STATIC`
 * nomme leur dossier. Même règle que la cible PHP (`socle_serve_static`) :
 * pas de `..`, pas de barre oblique inverse, pas d'octet nul, et le fichier
 * réel doit rester sous la racine (un lien symbolique ne fait pas sortir).
 * C'est ce qui permet de servir l'admin du Kiosque (`/redaction/`) depuis la
 * même origine que l'API : la session reste un témoin SameSite=Lax.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
};

export function serveStatic(rootDir: string | undefined, urlPath: string, method: string) {
  const none = { status: 404, body: "", headers: {} as Record<string, string> };
  if (!rootDir || !existsSync(rootDir) || (method !== "GET" && method !== "HEAD")) return none;
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return none;
  }
  if (path.includes("\\") || path.includes("\0") || path.includes("..")) return none;
  const root = realpathSync(rootDir);
  let candidate = join(root, path.replace(/^\/+/, "") || "index.html");
  try {
    if (statSync(candidate).isDirectory()) candidate = join(candidate, "index.html");
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(root + sep)) return none;
    if (!statSync(real).isFile()) return none;
    const body = readFileSync(real);
    return {
      status: 200,
      body: method === "HEAD" ? "" : body,
      headers: { "content-type": TYPES[extname(real).toLowerCase()] ?? "application/octet-stream" } as Record<string, string>,
    };
  } catch {
    return none;
  }
}
