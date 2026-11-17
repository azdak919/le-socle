import type { SocleConfig } from "./config.ts";
import { MODULES, type ModuleName } from "./modules.ts";
import { VERSION } from "./version.ts";

export type HealthDocument = {
  version: string;
  modules: Record<ModuleName, boolean>;
};

export function healthDocument(config: SocleConfig): HealthDocument {
  const modules = {} as Record<ModuleName, boolean>;
  for (const name of MODULES) modules[name] = config.modules[name];
  return { version: VERSION, modules };
}

export type HttpResult = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

export function handleRequest(method: string, url: string, config: SocleConfig): HttpResult {
  const path = new URL(url, "http://127.0.0.1").pathname;
  if (path !== "/v1/health") {
    return { status: 404, body: "", headers: {} };
  }
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, body: "", headers: { allow: "GET, HEAD" } };
  }
  const body = JSON.stringify(healthDocument(config));
  return {
    status: 200,
    body: method === "HEAD" ? "" : body,
    headers: { "content-type": "application/json; charset=utf-8" },
  };
}
