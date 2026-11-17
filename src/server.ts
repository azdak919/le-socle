import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { defaultConfig, loadConfigFile, type SocleConfig } from "./config.ts";
import { handleRequest } from "./health.ts";

export function createSocleServer(config: SocleConfig) {
  return createServer((request, response) => {
    const result = handleRequest(request.method ?? "GET", request.url ?? "/", config);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const configPath = process.argv[2] ?? "socle.config.json";
  const config = existsSync(configPath) ? loadConfigFile(configPath) : defaultConfig();
  const port = Number(process.env.PORT ?? 8787);
  const server = createSocleServer(config);
  server.listen(port, "127.0.0.1", () => {
    console.log(`le-socle http://127.0.0.1:${port}/v1/health`);
  });
}
