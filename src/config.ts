import { readFileSync } from "node:fs";

import { MODULES, isModuleName, type ModuleName } from "./modules.ts";

export type SocleConfig = {
  modules: Record<ModuleName, boolean>;
};

export function defaultConfig(): SocleConfig {
  const modules = {} as Record<ModuleName, boolean>;
  for (const name of MODULES) modules[name] = false;
  return { modules };
}

export function parseConfig(value: unknown): SocleConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config invalide");
  }
  const root = value as Record<string, unknown>;
  const keys = Object.keys(root);
  if (keys.length !== 1 || keys[0] !== "modules") {
    throw new Error("config invalide");
  }
  const rawModules = root.modules;
  if (rawModules === null || typeof rawModules !== "object" || Array.isArray(rawModules)) {
    throw new Error("config invalide");
  }
  const source = rawModules as Record<string, unknown>;
  const config = defaultConfig();
  for (const key of Object.keys(source)) {
    if (!isModuleName(key)) throw new Error(`module inconnu : ${key}`);
    if (typeof source[key] !== "boolean") throw new Error(`interrupteur invalide : ${key}`);
    config.modules[key] = source[key];
  }
  return config;
}

export function loadConfigFile(path: string | URL): SocleConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
