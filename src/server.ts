import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { handleAdmin, type AdminDeps } from "./admin.ts";
import { defaultConfig, loadConfigFile, stringifyConfig, type SocleConfig } from "./config.ts";
import { handleEditorial } from "./editorial-http.ts";
import { handleRequest } from "./health.ts";
import { openSqliteFile } from "./sqlite.ts";
import { VERSION } from "./version.ts";

export function createSocleServer(config: SocleConfig, admin?: AdminDeps) {
  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    const path = new URL(url, "http://127.0.0.1").pathname;
    try {
      const editorialPath = path.startsWith("/admin/articles")
        || path.startsWith("/admin/relecture")
        || path.startsWith("/v1/editorial");
      const result = admin && editorialPath
        ? await handleEditorial(method, url, config, admin, rawBody)
        : admin && path.startsWith("/admin")
          ? await handleAdmin(method, url, config, admin, rawBody)
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
  let version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : VERSION;
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
