import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SocleConfig } from "../src/config.ts";
import { openD1Memory } from "../src/d1.ts";
import { handleRedaction } from "../src/redaction-http.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { NOW, PUBLICATION, config, deps, scenario, type Call } from "./redaction-parcours.ts";

function direct(store: SocleStore, cfg: SocleConfig, actor: string | null | undefined, local: boolean): Call {
  const d = deps(store);
  return async (method, path, body, type) => {
    const raw = body === undefined ? new Uint8Array() : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const result = await handleRedaction(method, path, cfg, d, raw, { "content-type": type ?? "application/json" }, actor, local);
    const bytes = Buffer.from(result.body);
    const ctype = result.headers["content-type"] ?? "";
    return { status: result.status, bytes, type: ctype, json: ctype.startsWith("application/json") ? JSON.parse(bytes.toString("utf8") || "null") : null };
  };
}

const ON = config({ editorial: true, media: true });

for (const [name, open] of [["SQLite", openSqliteMemory], ["D1", openD1Memory]] as const) {
  test(`${name} : l'admin du Kiosque écrit, publie et gère la banque de photos`, async () => {
    const store = await open();
    try {
      await store.migrate(["editorial", "media"]);
      await scenario(direct(store, ON, undefined, true));
    } finally {
      await store.close();
    }
  });
}

test("la route n'existe pas tant que editorial est éteint, et la banque sans media", async () => {
  const store = openSqliteMemory();
  await store.migrate(["editorial"]);
  assert.equal((await direct(store, config({}), undefined, true)("GET", "/v1/redaction/etat")).status, 404);
  const noMedia = direct(store, config({ editorial: true }), undefined, true);
  assert.equal((await noMedia("POST", "/v1/redaction/photo", { asset: {}, data: "" })).status, 404);
  assert.deepEqual((await noMedia("GET", "/v1/redaction/etat")).json.media, []);
  await store.close();
});

test("sans auth, une requête venue d'ailleurs est refusée", async () => {
  const store = openSqliteMemory();
  await store.migrate(["editorial", "media"]);
  const far = direct(store, ON, undefined, false);
  const result = await far("GET", "/v1/redaction/etat");
  assert.equal(result.status, 403);
  assert.match(result.json.error, /machine du socle/);
  await store.close();
});

test("avec auth : une autrice écrit un brouillon mais ne publie ni ne supprime", async () => {
  const store = openSqliteMemory();
  const cfg = config({ editorial: true, media: true, auth: true });
  await store.migrate(["auth", "editorial", "media"]);
  await store.put("auth", "member:autrice@gazette.exemple", "auteur");
  await store.put("auth", "member:editeur@gazette.exemple", "editeur");
  assert.equal((await direct(store, cfg, null, true)("GET", "/v1/redaction/etat")).status, 401);
  assert.equal((await direct(store, cfg, "inconnu@gazette.exemple", true)("GET", "/v1/redaction/etat")).status, 403);
  const editor = direct(store, cfg, "editeur@gazette.exemple", false);
  const author = direct(store, cfg, "autrice@gazette.exemple", false);
  assert.equal((await editor("POST", "/v1/redaction/publication", { publication: PUBLICATION })).status, 200);
  assert.equal((await author("POST", "/v1/redaction/publication", { publication: PUBLICATION })).status, 403);
  assert.equal((await author("POST", "/v1/redaction/entite", { kind: "author", entity: { id: "a1", name: "Léa", slug: "lea" } })).status, 200);
  assert.equal((await author("POST", "/v1/redaction/entite", { kind: "section", entity: { id: "s1", name: "Campus", slug: "campus" } })).status, 403);
  const draft = { id: "d1", slug: "brouillon", title: "Brouillon", body: { format: "markdown", raw: "x" }, authors: ["lea"], status: "draft" };
  assert.equal((await author("POST", "/v1/redaction/article", { article: draft })).status, 200);
  assert.equal((await author("POST", "/v1/redaction/article", { article: { ...draft, status: "in-review" } })).status, 200);
  assert.equal((await author("POST", "/v1/redaction/article", { article: { ...draft, status: "published", section: "campus", publishedAt: NOW } })).status, 403);
  assert.equal((await author("POST", "/v1/redaction/supprimer", { kind: "article", id: "d1" })).status, 403);
  assert.equal((await editor("POST", "/v1/redaction/entite", { kind: "section", entity: { id: "s1", name: "Campus", slug: "campus" } })).status, 200);
  assert.equal((await editor("POST", "/v1/redaction/article", { article: { ...draft, status: "published", section: "campus", publishedAt: NOW } })).status, 200);
  // Une fois publié, l'autrice ne peut plus le retoucher seule.
  assert.equal((await author("POST", "/v1/redaction/article", { article: { ...draft, status: "draft" } })).status, 403);
  assert.equal((await author("GET", "/v1/redaction/etat")).json.role, "auteur");
  await store.close();
});

test("le serveur Node : local, mandataire et pages construites", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-static-"));
  const site = join(work, "site");
  mkdirSync(join(site, "redaction"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<p>journal</p>");
  writeFileSync(join(site, "redaction", "index.html"), "<p>admin</p>");
  writeFileSync(join(work, "secret.txt"), "secret");
  symlinkSync(join(work, "secret.txt"), join(site, "fuite.txt"));
  const store = openSqliteMemory();
  await store.migrate(["editorial", "media"]);
  const previous = process.env.SOCLE_STATIC;
  process.env.SOCLE_STATIC = site;
  const server = createSocleServer(ON, deps(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const call: Call = async (method, path, body, type) => {
      const response = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { "content-type": type ?? "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const ctype = response.headers.get("content-type") ?? "";
      return { status: response.status, bytes, type: ctype, json: ctype.startsWith("application/json") ? JSON.parse(bytes.toString("utf8") || "null") : null };
    };
    await scenario(call);
    const proxied = await fetch(base + "/v1/redaction/etat", { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(proxied.status, 403, "derrière un mandataire, on n'est plus local");
    assert.equal(await (await fetch(base + "/")).text(), "<p>journal</p>");
    // L'admin vient du socle lui-même, pas du site construit.
    const admin = await (await fetch(base + "/redaction/")).text();
    assert.match(admin, /"mode":"socle"/);
    assert.ok(!admin.includes("<p>admin</p>"));
    assert.equal((await fetch(base + "/fuite.txt")).status, 404, "un lien symbolique ne sort pas de la racine");
    assert.equal((await fetch(base + "/%2e%2e/secret.txt")).status, 404);
    assert.equal((await fetch(base + "/v1/inconnu")).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.SOCLE_STATIC;
    else process.env.SOCLE_STATIC = previous;
    await store.close();
  }
});
