import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { pathToFileURL } from "node:url";

import { handleAdmin, type AdminDeps } from "./admin.ts";
import { emailFromCookie, ensureResponsable } from "./auth.ts";
import { handleAuth } from "./auth-http.ts";
import { defaultConfig, loadConfigFile, stringifyConfig, type SocleConfig } from "./config.ts";
import { handleEditorial } from "./editorial-http.ts";
import { handleRequest } from "./health.ts";
import { handleMedia } from "./media-http.ts";
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
      const editorialPath = path.startsWith("/admin/articles")
        || path.startsWith("/admin/relecture")
        || path.startsWith("/v1/editorial");
      const result = admin && path.startsWith("/v1/auth")
        ? await handleAuth(method, url, config, admin, rawBody, headers)
        : admin && path === "/admin/medias"
        ? await handleMedia(method, url, config, admin)
        : admin && editorialPath
          ? await handleEditorial(method, url, config, admin, rawBody)
          : admin && path.startsWith("/admin")
            ? await handleAdmin(method, url, config, admin, rawBody, actor)
            : handleRequest(method, url, config);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch {
      if (response.headersSent) return;
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("erreur");
    }
  });
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
      await ensureResponsable(store, process.env.SOCLE_RESPONSABLE);
    } catch (error) {
      if (!(error instanceof ModuleOffError)) throw error;
    }
  }
  let version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : VERSION;
  const smtp = config.modules.auth ? smtpFromEnv() : null;
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
            mailer: smtp
              ? async (to, url) => {
                  await sendSmtp(smtp, to, "Lien de connexion", url);
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
