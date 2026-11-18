/**
 * Quels fichiers de l'admin le mode serveur sert sous `/redaction/`, sans
 * lire le disque : Node (`redaction-page.ts`) lit le fichier, le Worker le
 * demande à ses fichiers statiques. Pas la base de la démo (sql.js).
 * `/admin` (sans sous-page) redirige vers `/redaction/` quand le module
 * éditorial est allumé. Les pages Sauvegarde et Mise à jour restent sous
 * `/admin/sauvegarde` et `/admin/mise-a-jour`.
 */
export const SERVER_ASSETS: ReadonlySet<string> = new Set([
  "admin.js", "admin.css", "runtime.js", "util.js", "export.js",
  "stock-photo-match.js", "marked.esm.js", "socle-backend.js",
]);

export const REDACTION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cache-control": "no-cache",
});

type Result = { status: number; body: string; headers: Record<string, string> };

/**
 * `null` : ce chemin n'est pas l'admin de rédaction. Sinon, soit une
 * réponse toute faite (redirection, refus), soit le fichier à servir,
 * relatif à `admin/`.
 */
export function redactionTarget(path: string, method: string): Result | { file: string; type: string } | null {
  if (path !== "/redaction" && !path.startsWith("/redaction/")) return null;
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: "", headers: { allow: "GET, HEAD" } };
  if (path === "/redaction") return { status: 301, body: "", headers: { location: "/redaction/" } };
  if (path === "/redaction/") return { file: "serveur.html", type: "text/html; charset=utf-8" };
  const name = path.slice("/redaction/assets/".length);
  if (!path.startsWith("/redaction/assets/") || !SERVER_ASSETS.has(name)) return { status: 404, body: "", headers: {} };
  return { file: `assets/${name}`, type: name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" };
}
