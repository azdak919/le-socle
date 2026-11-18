import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdminDeps } from "../src/admin.ts";
import { handleAuth } from "../src/auth-http.ts";
import { hashPassword, verifyPassword } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { openSqliteMemory } from "../src/sqlite.ts";

const JSON_HEADERS = { "content-type": "application/json" };

async function setup() {
  const store = openSqliteMemory();
  await store.migrate(["auth"]);
  const config = defaultConfig();
  config.modules.auth = true;
  const at = { current: new Date("2026-11-18T15:00:00.000Z") };
  const deps: AdminDeps = {
    store,
    now: () => at.current,
    backupDir: mkdtempSync(join(tmpdir(), "socle-mdp-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => {},
    auth: { mode: "motdepasse" },
  };
  const call = (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = JSON_HEADERS) =>
    handleAuth(method, path, config, deps, new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)), { ...headers, cookie });
  return { store, call, at };
}

function cookieOf(headers: Record<string, string>): string {
  return String(headers["set-cookie"] ?? "").split(";")[0];
}

test("mot de passe : empreinte PBKDF2 vérifiable, jamais en clair", () => {
  const stored = hashPassword("correct horse battery");
  assert.match(stored, /^pbkdf2-sha256\$210000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(verifyPassword("correct horse battery", stored), true);
  assert.equal(verifyPassword("correct horse batterie", stored), false);
  assert.equal(verifyPassword("x", "n'importe quoi"), false);
});

test("installation : la première personne devient administrateur, une seule fois", async () => {
  const { call, store } = await setup();
  const before = JSON.parse((await call("GET", "/v1/auth/etat")).body);
  assert.deepEqual(before, { mode: "motdepasse", installed: false, email: null, role: null });
  const short = await call("POST", "/v1/auth/installation", { email: "resp@cegep.example", password: "court" });
  assert.equal(short.status, 400);
  assert.equal(short.body, "mot de passe trop court");
  const form = await call("POST", "/v1/auth/installation", { email: "resp@cegep.example", password: "un long secret" }, undefined, { "content-type": "text/plain" });
  assert.equal(form.status, 400, "un formulaire d’un autre site est refusé");
  const ok = await call("POST", "/v1/auth/installation", { email: "Resp@Cegep.example", password: "un long secret" });
  assert.equal(ok.status, 204);
  const cookie = cookieOf(ok.headers);
  assert.match(cookie, /^socle_session=/);
  const after = JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body);
  assert.deepEqual(after, { mode: "motdepasse", installed: true, email: "resp@cegep.example", role: "administrateur" });
  const again = await call("POST", "/v1/auth/installation", { email: "intrus@example.org", password: "un autre secret" });
  assert.equal(again.status, 409);
  const raw = JSON.stringify(await store.list("auth"));
  assert.doesNotMatch(raw, /un long secret/);
});

test("connexion, équipe, essais limités, déconnexion", async () => {
  const { call, at } = await setup();
  const install = await call("POST", "/v1/auth/installation", { email: "resp@cegep.example", password: "un long secret" });
  const resp = cookieOf(install.headers);
  assert.equal((await call("POST", "/v1/auth/membres", { email: "ana@cegep.example", role: "auteur", password: "mot de passe d’Ana" }, resp)).status, 204);
  const team = JSON.parse((await call("GET", "/v1/auth/membres", undefined, resp)).body);
  assert.deepEqual(team, [{ email: "ana@cegep.example", role: "auteur" }, { email: "resp@cegep.example", role: "administrateur" }]);
  const ana = await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
  assert.equal(ana.status, 204);
  const anaCookie = cookieOf(ana.headers);
  assert.equal((await call("GET", "/v1/auth/membres", undefined, anaCookie)).status, 403);
  assert.equal((await call("POST", "/v1/auth/membres", { email: "x@cegep.example", role: "administrateur", password: "aaaaaaaaaaaa" }, anaCookie)).status, 403);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mauvais essai" })).status, 401);
  }
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).status, 429);
  at.current = new Date(at.current.getTime() + 16 * 60 * 1000);
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).status, 204);
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "inconnu@cegep.example", password: "mot de passe d’Ana" })).status, 401);
  const out = await call("POST", "/v1/auth/deconnexion", undefined, anaCookie);
  assert.equal(out.status, 204);
  const gone = JSON.parse((await call("GET", "/v1/auth/etat", undefined, anaCookie)).body);
  assert.equal(gone.email, null);
});

test("un compte « responsable » d'avant 1.2 reste administrateur, sans rien refaire", async () => {
  const { call, store } = await setup();
  await store.put("auth", "member:ancien@cegep.example", "responsable");
  await store.put("auth", "password:ancien@cegep.example", hashPassword("ancien mot de passe"));
  const login = await call("POST", "/v1/auth/motdepasse", { email: "ancien@cegep.example", password: "ancien mot de passe" });
  assert.equal(login.status, 204);
  const cookie = cookieOf(login.headers);
  const etat = JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body);
  assert.equal(etat.role, "administrateur");
  assert.equal(etat.installed, true);
  // L'ancien nom est encore accepté en entrée, enregistré sous le nouveau.
  assert.equal((await call("POST", "/v1/auth/membres", { email: "zoe@cegep.example", role: "responsable", password: "mot de passe de Zoé" }, cookie)).status, 204);
  assert.equal(await store.get("auth", "member:zoe@cegep.example"), "administrateur");
  const team = JSON.parse((await call("GET", "/v1/auth/membres", undefined, cookie)).body);
  assert.deepEqual(team, [{ email: "ancien@cegep.example", role: "administrateur" }, { email: "zoe@cegep.example", role: "administrateur" }]);
  assert.equal((await call("POST", "/v1/auth/installation", { email: "intrus@example.org", password: "un autre secret" })).status, 409);
});
