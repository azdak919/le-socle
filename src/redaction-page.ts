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

import { REDACTION_HEADERS, redactionTarget } from "./redaction-assets.ts";

const ADMIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "admin");

export { SERVER_ASSETS } from "./redaction-assets.ts";

type Result = { status: number; body: string | Uint8Array; headers: Record<string, string> };

/** `null` : ce chemin n'est pas l'admin, la requête continue ailleurs. */
export function serveRedactionPage(path: string, method: string): Result | null {
  const target = redactionTarget(path, method);
  if (!target || "status" in target) return target;
  const body = readFileSync(join(ADMIN_DIR, target.file));
  return { status: 200, body: method === "HEAD" ? "" : body, headers: { "content-type": target.type, ...REDACTION_HEADERS } };
}
