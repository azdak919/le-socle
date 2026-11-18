/**
 * Porte des pages `/admin` (recours sans JavaScript : sauvegarde, mise à
 * jour, articles, relecture, médias…).
 *
 * - `auth` allumé : il faut une session et un rôle ; sans session, une page
 *   mène à l'écran de connexion de la rédaction. La sauvegarde (télécharger,
 *   restaurer, régler) est à l'administrateur ; le formulaire d'article sans
 *   JavaScript, aux réviseurs, éditeurs et à l'administrateur ;
 * - `auth` éteint : seulement depuis la machine du socle, comme l'API de
 *   rédaction.
 */

import { roleOf } from "./auth.ts";
import type { SocleConfig } from "./config.ts";
import type { SocleStore } from "./store.ts";

type Result = { status: number; body: string; headers: Record<string, string> };

const TEXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
const WRITERS = ["reviseur", "editeur", "administrateur"];

export async function adminGate(
  method: string,
  path: string,
  config: SocleConfig,
  store: SocleStore,
  actor: string | null | undefined,
  local: boolean,
): Promise<Result | null> {
  if (path !== "/admin" && !path.startsWith("/admin/")) return null;
  if (!config.modules.auth) {
    return local ? null : { status: 403, body: "Sans le module auth, l'administration ne s'ouvre que depuis la machine du socle.", headers: TEXT };
  }
  if (!actor) {
    if (method === "GET" && config.modules.editorial) return { status: 303, body: "", headers: { location: "/redaction/", "cache-control": "no-store" } };
    return { status: 401, body: "Connexion requise.", headers: TEXT };
  }
  const role = await roleOf(store, actor);
  if (!role) return { status: 403, body: "Ce compte n'a pas de rôle dans la rédaction.", headers: TEXT };
  if (path.startsWith("/admin/sauvegarde") && role !== "administrateur") {
    return { status: 403, body: "réservé à l’administrateur", headers: TEXT };
  }
  if (path.startsWith("/admin/articles") && method !== "GET" && !WRITERS.includes(role)) {
    return { status: 403, body: "Publier sans JavaScript demande un réviseur, un éditeur ou l’administrateur ; passez par la rédaction.", headers: TEXT };
  }
  return null;
}
