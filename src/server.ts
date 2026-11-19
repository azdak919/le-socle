import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { pathToFileURL } from "node:url";

import { handleAdmin, setAdminJournalName, type AdminDeps } from "./admin.ts";
import { handleAudience } from "./audience-http.ts";
import { accessVerifier } from "./access.ts";
import { adminGate } from "./admin-gate.ts";
import { emailFromCookie, ensureAdministrateur } from "./auth.ts";
import { handleAuth } from "./auth-http.ts";
import { defaultConfig, loadConfigFile, stringifyConfig, type SocleConfig } from "./config.ts";
import { handleEditorial } from "./editorial-http.ts";
import { readPublication } from "./editorial.ts";
import { handleRequest } from "./health.ts";
import { handleMedia } from "./media-http.ts";
import { handleNotify } from "./notify-http.ts";
import { handlePublicMedia } from "./public-media.ts";
import { handleRedaction } from "./redaction-http.ts";
import { serveRedactionPage } from "./redaction-page.ts";
import { handleReview } from "./review-http.ts";
import { serveStatic } from "./static.ts";
import { sendSmtp, smtpFromEnv } from "./smtp.ts";
import { openSqliteFile } from "./sqlite.ts";
import { ModuleOffError } from "./store.ts";
import { VERSION } from "./version.ts";

export function createSocleServer(config: SocleConfig, admin?: AdminDeps) {
  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    const path = new URL(url, "http://127.0.0.1").pathname;
    const headers = flatHeaders(request.headers);
    try {
      const actor = admin && config.modules.auth
        ? await emailFromCookie(admin.store, admin.now, headers.cookie)
        : undefined;
      const reviewPath = path.startsWith("/admin/relecture") || path.startsWith("/v1/review");
      const audiencePath = path.startsWith("/v1/audience") || path.startsWith("/admin/audience");
      const notifyPath = path.startsWith("/v1/notify") || path.startsWith("/admin/abonnements");
      const editorialPath = path.startsWith("/admin/articles")
        || path.startsWith("/admin/relecture")
        || path.startsWith("/v1/editorial");
      // Derrière un mandataire (nginx, Cloudflare), tout arrive de 127.0.0.1 :
      // un en-tête de transfert suffit pour ne plus se croire « local ».
      const forwarded = Boolean(headers["x-forwarded-for"] || headers.forwarded || headers["x-real-ip"] || headers["cf-connecting-ip"]);
      const local = isLoopback(request.socket.remoteAddress) && !forwarded;
      const gate = admin ? await adminGate(method, path, config, admin.store, actor, local) : null;
      if (gate) {
        response.writeHead(gate.status, gate.headers);
        response.end(gate.body);
        return;
      }
      if (admin && path.startsWith("/admin")) {
        // En-tête des pages d’administration : le journal, s’il est configuré.
        try { setAdminJournalName((await readPublication(admin.store))?.name); } catch { setAdminJournalName(""); }
      }
      const page = admin && config.modules.editorial ? serveRedactionPage(path, method) : null;
      const photo = !page && admin ? await handlePublicMedia(method, path, config, admin.store) : null;
      const result = page
        ? page
        : photo
        ? photo
        : admin && path.startsWith("/v1/redaction/")
        ? await handleRedaction(method, url, config, admin, rawBody, headers, actor, local)
        : admin && path.startsWith("/v1/auth")
        ? await handleAuth(method, url, config, admin, rawBody, headers)
        : admin && path === "/admin/medias"
        ? await handleMedia(method, url, config, admin)
        : admin && config.modules.review && reviewPath
          ? await handleReview(method, url, config, admin, rawBody, actor)
        : admin && editorialPath
          ? await handleEditorial(method, url, config, admin, rawBody)
          : admin && audiencePath
            ? await handleAudience(method, url, config, admin, rawBody, actor)
            : admin && notifyPath
              ? await handleNotify(method, url, config, admin, rawBody, actor)
              : admin && path.startsWith("/admin")
              ? await handleAdmin(method, url, config, admin, rawBody, actor)
              : path.startsWith("/v1") || path.startsWith("/admin")
                ? handleRequest(method, url, config)
                : serveStatic(process.env.SOCLE_STATIC, path, method);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch {
      if (response.headersSent) return;
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("erreur");
    }
  });
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value[0];
  }
  return out;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

export async function openRunningAdmin(
  configPath: string,
  dbPath: string,
  backupDir: string,
  versionFile = "socle.version",
): Promise<{
  config: SocleConfig;
  admin: AdminDeps;
}> {
  const config = existsSync(configPath) ? loadConfigFile(configPath) : defaultConfig();
  const store = openSqliteFile(dbPath);
  await store.resume();
  if (config.modules.auth) {
    try {
      await ensureAdministrateur(store, process.env.SOCLE_ADMINISTRATEUR ?? process.env.SOCLE_RESPONSABLE);
    } catch (error) {
      if (!(error instanceof ModuleOffError)) throw error;
    }
  }
  let version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : VERSION;
  const smtp = config.modules.auth || config.modules.notify ? smtpFromEnv() : null;
  return {
    config,
    admin: {
      store,
      now: () => new Date(),
      release: () => null,
      version: () => version,
      setVersion: async (next) => {
        writeFileSync(versionFile, `${next}\n`);
        version = next;
      },
      backupDir,
      saveConfig: (next) => {
        writeFileSync(configPath, stringifyConfig(next));
      },
      auth: config.modules.auth
        ? {
            mode: process.env.SOCLE_AUTH_MODE,
            publicOrigin: process.env.SOCLE_PUBLIC_ORIGIN,
            githubClientId: process.env.SOCLE_GITHUB_CLIENT_ID,
            githubClientSecret: process.env.SOCLE_GITHUB_CLIENT_SECRET,
            verifyAccess: process.env.SOCLE_ACCESS_TEAM
              ? accessVerifier({ team: process.env.SOCLE_ACCESS_TEAM, aud: process.env.SOCLE_ACCESS_AUD ?? "" })
              : undefined,
            mailer: smtp
              ? async (to, url) => {
                  await sendSmtp(smtp, to, "Lien de connexion", url);
                }
              : undefined,
          }
        : undefined,
      notify: config.modules.notify
        ? {
            publicOrigin: process.env.SOCLE_PUBLIC_ORIGIN,
            publicKey: process.env.SOCLE_VAPID_PUBLIC,
            privateKey: process.env.SOCLE_VAPID_PRIVATE,
            subject: process.env.SOCLE_SMTP_FROM ? `mailto:${process.env.SOCLE_SMTP_FROM}` : undefined,
            mailer: smtp
              ? async (to, text) => {
                  await sendSmtp(smtp, to, "Abonnement", text);
                }
              : undefined,
          }
        : undefined,
    },
  };
}

if (isDirectRun()) {
  const configPath = process.argv[2] ?? "socle.config.json";
  const dbPath = process.env.SOCLE_DB ?? "socle.sqlite";
  const backupDir = process.env.SOCLE_BACKUP_DIR ?? "sauvegardes";
  const port = Number(process.env.PORT ?? 8787);
  openRunningAdmin(configPath, dbPath, backupDir).then(({ config, admin }) => {
    const server = createSocleServer(config, admin);
    server.listen(port, "127.0.0.1", () => {
      console.log(`le-socle http://127.0.0.1:${port}/v1/health`);
    });
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "erreur");
    process.exitCode = 1;
  });
}
