import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { defaultConfig, loadConfigFile, parseConfig } from "../src/config.ts";
import { MODULES } from "../src/modules.ts";

test("la config par défaut éteint tous les modules", () => {
  const config = defaultConfig();
  for (const name of MODULES) assert.equal(config.modules[name], false);
});

test("le fichier commité est la config par défaut", () => {
  const fromFile = loadConfigFile(new URL("../socle.config.json", import.meta.url));
  assert.deepEqual(fromFile, defaultConfig());
  const raw = JSON.parse(readFileSync(new URL("../socle.config.json", import.meta.url), "utf8"));
  for (const name of MODULES) assert.equal(raw.modules[name], false);
});

test("un module absent reste éteint", () => {
  const config = parseConfig({ modules: { export: true } });
  assert.equal(config.modules.export, true);
  assert.equal(config.modules.auth, false);
});

test("un module inconnu est refusé", () => {
  assert.throws(() => parseConfig({ modules: { billing: true } }), /module inconnu/);
});

test("un interrupteur non booléen est refusé", () => {
  assert.throws(() => parseConfig({ modules: { auth: "yes" } }), /interrupteur invalide/);
});
