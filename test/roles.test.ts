import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdminDeps } from "../src/admin.ts";
import { handleAuth } from "../src/auth-http.ts";
import { hashPassword } from "../src/auth.ts";
import { handleRedaction } from "../src/redaction-http.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { NOW, PUBLICATION, config, deps } from "./redaction-parcours.ts";

const CFG = config({ editorial: true, media: true, auth: true });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]).toString("base64");

function as(store: SocleStore, actor: string) {
  const d = deps(store);
  return async (path: string, body: unknown) => {
    const result = await handleRedaction("POST", path, CFG, d, Buffer.from(JSON.stringify(body)), { "content-type": "application/json" }, actor, false);
    return { status: result.status, json: JSON.parse(Buffer.from(result.body).toString("utf8") || "null") };
  };
}

async function newsroom() {
  const store = openSqliteMemory();
  await store.migrate(["auth", "editorial", "media"]);
  const people: Record<string, string> = {
    "admin@vigie.test": "administrateur",
    "photo@vigie.test": "photographe",
    "chef@vigie.test": "chef-pupitre",
    "chef-libre@vigie.test": "chef-pupitre",
    "autrice@vigie.test": "auteur",
  };
  for (const [email, role] of Object.entries(people)) await store.put("auth", `member:${email}`, role);
  await store.put("auth", "scope:chef@vigie.test", JSON.stringify(["sports"]));
  await store.put("auth", "scope:autrice@vigie.test", JSON.stringify(["campus"]));
  const admin = as(store, "admin@vigie.test");
  assert.equal((await admin("/v1/redaction/publication", { publication: PUBLICATION })).status, 200);
  assert.equal((await admin("/v1/redaction/entite", { kind: "section", entity: { id: "s-campus", name: "Campus", slug: "campus" } })).status, 200);
  assert.equal((await admin("/v1/redaction/entite", { kind: "section", entity: { id: "s-sports", name: "Sports", slug: "sports" } })).status, 200);
  return store;
}

const article = (id: string, section: string, status = "draft") => ({
  article: { id, slug: id, title: `Article ${id}`, body: { format: "markdown", raw: "Texte." }, authors: ["lea"], section, status, ...(status === "published" ? { publishedAt: NOW } : {}) },
});

test("photographe : la banque de photos, rien d'autre", async () => {
  const store = await newsroom();
  const photo = as(store, "photo@vigie.test");
  assert.equal((await photo("/v1/redaction/article", article("p1", "s-campus"))).status, 403);
  assert.equal((await photo("/v1/redaction/entite", { kind: "author", entity: { name: "X" } })).status, 403);
  assert.equal((await photo("/v1/redaction/photo", { bank: false, asset: { alt: "a" }, data: PNG })).status, 403);
  const up = await photo("/v1/redaction/photo", { asset: { id: "ph1", alt: "Gymnase", credit: "Noé", license: "CC BY 4.0" }, data: PNG });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal((await photo("/v1/redaction/photo/fiche", { asset: { id: "ph1", credit: "Noé T.", alt: "Gymnase" } })).status, 200);
  assert.equal((await photo("/v1/redaction/photo/supprimer", { id: "ph1" })).status, 200);
  await store.close();
});

test("chef de pupitre : relit et publie dans ses rubriques seulement", async () => {
  const store = await newsroom();
  const chef = as(store, "chef@vigie.test");
  assert.equal((await chef("/v1/redaction/article", article("c1", "s-sports", "published"))).status, 200);
  assert.equal((await chef("/v1/redaction/article", article("c2", "sports", "published"))).status, 200, "le nom court suffit");
  assert.equal((await chef("/v1/redaction/article", article("c3", "s-campus", "published"))).status, 403);
  assert.equal((await chef("/v1/redaction/article", article("c4", "s-campus"))).status, 403, "même un brouillon hors rubrique");
  const admin = as(store, "admin@vigie.test");
  assert.equal((await admin("/v1/redaction/article", article("a1", "s-campus", "published"))).status, 200);
  // Déplacer un article d'une autre rubrique vers la sienne : refusé.
  assert.equal((await chef("/v1/redaction/article", article("a1", "s-sports", "published"))).status, 403);
  assert.equal((await chef("/v1/redaction/supprimer", { kind: "article", id: "a1" })).status, 403);
  assert.equal((await chef("/v1/redaction/supprimer", { kind: "article", id: "c1" })).status, 200);
  assert.equal((await chef("/v1/redaction/entite", { kind: "section", entity: { name: "Culture" } })).status, 403);
  const libre = as(store, "chef-libre@vigie.test");
  assert.equal((await libre("/v1/redaction/article", article("l1", "s-campus", "published"))).status, 200, "sans rubrique choisie : toutes");
  await store.close();
});

test("auteur restreint : écrit dans ses rubriques, ne publie pas", async () => {
  const store = await newsroom();
  const autrice = as(store, "autrice@vigie.test");
  assert.equal((await autrice("/v1/redaction/article", article("r1", "s-campus"))).status, 200);
  assert.equal((await autrice("/v1/redaction/article", article("r1", "s-campus", "in-review"))).status, 200);
  assert.equal((await autrice("/v1/redaction/article", article("r2", "s-sports"))).status, 403);
  assert.equal((await autrice("/v1/redaction/article", article("r3", ""))).status, 403, "sans rubrique, refusé pour un compte restreint");
  assert.equal((await autrice("/v1/redaction/article", article("r1", "s-campus", "published"))).status, 403);
  const d = deps(store);
  const etat = await handleRedaction("GET", "/v1/redaction/etat", CFG, d, new Uint8Array(), {}, "autrice@vigie.test", false);
  const state = JSON.parse(Buffer.from(etat.body).toString("utf8"));
  assert.equal(state.role, "auteur");
  assert.deepEqual(state.scope, ["campus"]);
  await store.close();
});

test("l'administrateur donne rôles et rubriques ; les rubriques ne collent qu'à auteur et chef de pupitre", async () => {
  const store = openSqliteMemory();
  await store.migrate(["auth"]);
  const cfg = config({ auth: true });
  const d: AdminDeps = { ...deps(store), backupDir: mkdtempSync(join(tmpdir(), "socle-roles-")), auth: { mode: "motdepasse" } };
  const call = (method: string, path: string, body?: unknown, cookie?: string) =>
    handleAuth(method, path, cfg, d, new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)), { "content-type": "application/json", cookie });
  await store.put("auth", "member:admin@vigie.test", "administrateur");
  await store.put("auth", "password:admin@vigie.test", hashPassword("mot de passe admin"));
  const login = await call("POST", "/v1/auth/motdepasse", { email: "admin@vigie.test", password: "mot de passe admin" });
  const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0];
  assert.equal((await call("POST", "/v1/auth/membres", { email: "chef@vigie.test", role: "chef-pupitre", sections: ["sports", "sports", "../x"], password: "mot de passe chef" }, cookie)).status, 204);
  assert.equal((await call("POST", "/v1/auth/membres", { email: "photo@vigie.test", role: "photographe", sections: ["sports"] }, cookie)).status, 204);
  assert.equal((await call("POST", "/v1/auth/membres", { email: "x@vigie.test", role: "chef-pupitre", sections: "sports" }, cookie)).status, 400);
  assert.equal((await call("POST", "/v1/auth/membres", { email: "x@vigie.test", role: "pirate" }, cookie)).status, 400);
  const team = JSON.parse(String((await call("GET", "/v1/auth/membres", undefined, cookie)).body));
  assert.deepEqual(team, [
    { email: "admin@vigie.test", role: "administrateur" },
    { email: "chef@vigie.test", role: "chef-pupitre", sections: ["sports"] },
    { email: "photo@vigie.test", role: "photographe" },
  ]);
  // Repasser en éditeur efface les rubriques.
  assert.equal((await call("POST", "/v1/auth/membres", { email: "chef@vigie.test", role: "editeur" }, cookie)).status, 204);
  assert.equal(await store.get("auth", "scope:chef@vigie.test"), null);
  await store.close();
});
