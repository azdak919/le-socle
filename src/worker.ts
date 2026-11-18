/**
 * Point d'entrée Cloudflare Worker : le socle sur D1.
 *
 * Liaisons (voir `wrangler.toml.exemple`) :
 * - `DB` : la base D1 ; ses tables se créent avec `node src/cli.ts d1-sql`
 *   puis `wrangler d1 execute DB --remote --file …` (sauvegarde d'abord :
 *   `wrangler d1 export`). Rien ne migre au démarrage.
 * - `ASSETS` : les fichiers statiques du dossier `admin/` ; le Worker ne
 *   sert que la page et les fichiers du mode serveur (jamais sql.js).
 * - `SOCLE_CONFIG` : le contenu de `socle.config.json` (modules allumés).
 * - `SOCLE_ADMINISTRATEUR` : l'adresse de l'administrateur, posée au premier appel
 *   (`SOCLE_RESPONSABLE`, l'ancien nom, est encore lu).
 * - `SOCLE_ACCESS_TEAM`, `SOCLE_ACCESS_AUD` : Cloudflare Access. Derrière
 *   Cloudflare, aucune requête n'est « locale » : la rédaction demande le
 *   module `auth`, et Access est la porte prévue ici.
 *
 * Mêmes routes que le serveur Node pour la santé, l'éditorial, la connexion
 * et la rédaction. Les gestes qui écrivent sur le disque (sauvegarde du
 * programme, mise à jour) restent à Node et PHP.
 */
import { accessVerifier } from "./access.ts";
import type { AdminDeps } from "./admin.ts";
import { emailFromCookie, ensureAdministrateur } from "./auth.ts";
import { handleAuth } from "./auth-http.ts";
import { defaultConfig, parseConfig, type SocleConfig } from "./config.ts";
import { wrapD1, type D1Database } from "./d1-store.ts";
import { handleEditorial } from "./editorial-http.ts";
import { handleRequest } from "./health.ts";
import { handlePublicMedia } from "./public-media.ts";
import { handleRedaction } from "./redaction-http.ts";
import { REDACTION_HEADERS, redactionTarget } from "./redaction-assets.ts";
import { createModuleStore } from "./sql.ts";
import { ModuleOffError } from "./store.ts";
import { VERSION } from "./version.ts";

export type WorkerEnv = {
  DB: D1Database;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  SOCLE_CONFIG?: string;
  SOCLE_ADMINISTRATEUR?: string;
  SOCLE_RESPONSABLE?: string;
  SOCLE_AUTH_MODE?: string;
  SOCLE_ACCESS_TEAM?: string;
  SOCLE_ACCESS_AUD?: string;
  SOCLE_PUBLIC_ORIGIN?: string;
};

type Result = { status: number; body: string | Uint8Array; headers: Record<string, string> };

let administrateurSet = false;

function readConfig(env: WorkerEnv): SocleConfig {
  return env.SOCLE_CONFIG ? parseConfig(JSON.parse(env.SOCLE_CONFIG)) : defaultConfig();
}

function respond(result: Result, method: string): Response {
  const body = method === "HEAD" || result.status === 204 || result.status === 301 ? null : result.body;
  return new Response(body as BodyInit | null, { status: result.status, headers: result.headers });
}

async function servePage(request: Request, env: WorkerEnv, path: string): Promise<Response | null> {
  const target = redactionTarget(path, request.method);
  if (!target) return null;
  if ("status" in target) return respond(target, request.method);
  if (!env.ASSETS) return new Response("", { status: 404 });
  const asset = await env.ASSETS.fetch(new Request(new URL(`/${target.file}`, request.url)));
  if (!asset.ok) return new Response("", { status: 404 });
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: 200,
    headers: { "content-type": target.type, ...REDACTION_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      const config = readConfig(env);
      if (config.modules.editorial) {
        const page = await servePage(request, env, path);
        if (page) return page;
      }
      if (!path.startsWith("/v1/") && !path.startsWith("/media/")) return new Response("", { status: 404 });
      if (path === "/v1/health") return respond(handleRequest(method, path, config), method);
      const store = createModuleStore(wrapD1(env.DB, async () => {}));
      await store.resume();
      if (path.startsWith("/media/")) {
        const photo = await handlePublicMedia(method, path, config, store);
        return photo ? respond(photo, method) : new Response("", { status: 404 });
      }
      if (config.modules.auth && !administrateurSet) {
        try {
          await ensureAdministrateur(store, env.SOCLE_ADMINISTRATEUR ?? env.SOCLE_RESPONSABLE);
          administrateurSet = true;
        } catch (error) {
          if (!(error instanceof ModuleOffError)) throw error;
        }
      }
      const deps: AdminDeps = {
        store,
        now: () => new Date(),
        release: () => null,
        version: () => VERSION,
        setVersion: async () => { throw new Error("la mise à jour se fait par Wrangler"); },
        backupDir: "",
        auth: config.modules.auth
          ? {
              mode: env.SOCLE_AUTH_MODE ?? "access",
              publicOrigin: env.SOCLE_PUBLIC_ORIGIN ?? url.origin,
              verifyAccess: accessVerifier({ team: env.SOCLE_ACCESS_TEAM ?? "", aud: env.SOCLE_ACCESS_AUD ?? "" }),
            }
          : undefined,
      };
      const headers: Record<string, string | undefined> = {};
      request.headers.forEach((value, key) => { headers[key] = value; });
      const rawBody = method === "GET" || method === "HEAD" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
      const target = `${path}${url.search}`;
      const actor = config.modules.auth ? await emailFromCookie(store, deps.now, headers.cookie) : undefined;
      const result: Result = path.startsWith("/v1/redaction/")
        ? await handleRedaction(method, target, config, deps, rawBody, headers, actor, false)
        : path.startsWith("/v1/auth")
          ? await handleAuth(method, target, config, deps, rawBody, headers)
          : path.startsWith("/v1/editorial")
            ? await handleEditorial(method, target, config, deps, rawBody)
            : handleRequest(method, target, config);
      return respond(result, method);
    } catch (error) {
      // Le nom de l'erreur seulement : ni jeton, ni adresse dans les journaux.
      console.error("socle :", error instanceof Error ? error.name : "erreur");
      return new Response("erreur", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  },
};
