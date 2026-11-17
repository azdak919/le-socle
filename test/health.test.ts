import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, parseConfig } from "../src/config.ts";
import { handleRequest, healthDocument } from "../src/health.ts";
import { createSocleServer } from "../src/server.ts";
import { VERSION } from "../src/version.ts";

test("GET /v1/health dit la version et les interrupteurs", () => {
  const config = parseConfig({ modules: { export: true } });
  const result = handleRequest("GET", "/v1/health", config);
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  const body = JSON.parse(result.body);
  assert.equal(body.version, VERSION);
  assert.equal(body.version, "0.0.0");
  assert.equal(body.modules.export, true);
  assert.equal(body.modules.auth, false);
  assert.equal(body.modules.editorial, false);
  assert.equal(body.modules.media, false);
  assert.equal(body.modules.audience, false);
  assert.equal(body.modules.notify, false);
  assert.equal(body.modules.review, false);
});

test("aucune autre route n'existe", () => {
  const config = defaultConfig();
  assert.equal(handleRequest("GET", "/v1/articles", config).status, 404);
  assert.equal(handleRequest("POST", "/v1/audience/event", config).status, 404);
  assert.equal(handleRequest("POST", "/v1/health", config).status, 405);
  assert.equal(handleRequest("GET", "/v1/health?x=1", config).status, 200);
});

test("le document de santé ne contient que la version et les interrupteurs", () => {
  const keys = Object.keys(healthDocument(defaultConfig())).sort();
  assert.deepEqual(keys, ["modules", "version"]);
});

test("le serveur répond sur /v1/health", async () => {
  const server = createSocleServer(defaultConfig());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.version, "0.0.0");
    assert.equal(body.modules.auth, false);
    const missing = await fetch(`http://127.0.0.1:${address.port}/v1/export`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
