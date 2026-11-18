/**
 * Quels fichiers de l'admin le mode serveur sert sous `/admin/`, sans
 * lire le disque : Node (`redaction-page.ts`) lit le fichier, le Worker le
 * demande à ses fichiers statiques. Pas la base de la démo (sql.js).
 * L'ancienne adresse `/redaction/` redirige vers `/admin/`.
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

/** Pages PHP sous `/admin/…` qui ne sont pas l'espace de rédaction. */
export const RESERVED_ADMIN = /^\/admin\/(sauvegarde|mise-a-jour|medias|articles|relecture|audience|abonnements)(\/|$)/;

type Result = { status: number; body: string; headers: Record<string, string> };

/**
 * `null` : ce chemin n'est pas l'admin de rédaction. Sinon, soit une
 * réponse toute faite (redirection, refus), soit le fichier à servir,
 * relatif à `admin/`.
 */
export function redactionTarget(path: string, method: string): Result | { file: string; type: string } | null {
  const write = method !== "GET" && method !== "HEAD";
  if (path === "/redaction" || path === "/redaction/") {
    if (write) return { status: 405, body: "", headers: { allow: "GET, HEAD" } };
    return { status: 301, body: "", headers: { location: "/admin/" } };
  }
  if (path.startsWith("/redaction/")) {
    if (write) return { status: 405, body: "", headers: { allow: "GET, HEAD" } };
    if (path.startsWith("/redaction/assets/")) {
      const name = path.slice("/redaction/assets/".length);
      if (SERVER_ASSETS.has(name)) return { status: 301, body: "", headers: { location: `/admin/assets/${name}` } };
    }
    return { status: 404, body: "", headers: {} };
  }
  if (path !== "/admin" && !path.startsWith("/admin/")) return null;
  if (RESERVED_ADMIN.test(path)) return null;
  if (path === "/admin" || path === "/admin/" || path.startsWith("/admin/assets/")) {
    if (write) return { status: 405, body: "", headers: { allow: "GET, HEAD" } };
  } else {
    return null;
  }
  if (path === "/admin") return { status: 301, body: "", headers: { location: "/admin/" } };
  if (path === "/admin/") return { file: "serveur.html", type: "text/html; charset=utf-8" };
  const name = path.slice("/admin/assets/".length);
  if (!path.startsWith("/admin/assets/") || !SERVER_ASSETS.has(name)) return { status: 404, body: "", headers: {} };
  return { file: `assets/${name}`, type: name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" };
}
