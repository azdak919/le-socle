import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdminDeps } from "../src/admin.ts";
import { handleAuth } from "../src/auth-http.ts";
import { hashToken } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { openSqliteMemory } from "../src/sqlite.ts";

const JSON_HEADERS = { "content-type": "application/json" };

async function setup(options: { mailer?: (to: string, subject: string, text: string) => Promise<void>; origin?: string } = {}) {
  const store = openSqliteMemory();
  await store.migrate(["auth"]);
  const config = defaultConfig();
  config.modules.auth = true;
  const at = { current: new Date("2026-11-21T20:00:00.000Z") };
  let n = 0;
  const issued: string[] = [];
  const deps: AdminDeps = {
    store,
    now: () => at.current,
    backupDir: mkdtempSync(join(tmpdir(), "socle-reset-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => {},
    auth: {
      mode: "motdepasse",
      publicOrigin: options.origin ?? "https://journal.example",
      randomBytes: () => {
        n += 1;
        const bytes = new Uint8Array(32);
        bytes.fill(n);
        issued.push(Buffer.from(bytes).toString("base64url"));
        return bytes;
      },
      mailer: options.mailer,
    },
  };
  const call = (
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
    ip?: string,
  ) => handleAuth(
    method,
    path,
    config,
    deps,
    new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)),
    { ...JSON_HEADERS, cookie },
    { ip },
  );
  return { store, call, at, issued };
}

function cookieOf(headers: Record<string, string>): string {
  return String(headers["set-cookie"] ?? "").split(";")[0];
}

test("réinitialisation : même réponse, jeton haché, usage unique, échéance d’une heure, sessions révoquées", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const { call, at, issued, store } = await setup({
    mailer: async (to, subject, text) => {
      sent.push({ to, subject, text });
    },
  });
  const install = await call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
  assert.equal(install.status, 204);
  const firstCookie = cookieOf(install.headers);
  assert.match(install.headers["set-cookie"] ?? "", /Secure/);
  const other = await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
  assert.equal(other.status, 204);
  const secondCookie = cookieOf(other.headers);

  const unknown = await call("POST", "/v1/auth/reinitialiser", { email: "inconnu@cegep.example" });
  const known = await call("POST", "/v1/auth/reinitialiser", { email: "Ana@Cegep.example" });
  assert.equal(unknown.status, 202);
  assert.equal(known.status, 202);
  assert.equal(unknown.body, known.body);
  assert.equal(unknown.body, "");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "ana@cegep.example");
  const token = issued[2] ?? "";
  assert.equal(token.length > 20, true);
  assert.equal(JSON.stringify(known).includes(token), false);
  assert.equal(JSON.stringify(await store.list("auth")).includes(token), false);
  assert.equal(await store.get("auth", `reset:${hashToken(token)}`) !== null, true);
  assert.equal(sent[0]?.text.includes(token), true);
  assert.equal(sent[0]?.text.includes("/redaction/#reinitialiser="), true);

  at.current = new Date(at.current.getTime() + 61 * 60 * 1000);
  const expired = await call("POST", "/v1/auth/reinitialiser/confirmer", { token, password: "nouveau mot de passe" });
  assert.equal(expired.status, 400);
  assert.equal(expired.body, "lien expiré");

  const again = await call("POST", "/v1/auth/reinitialiser", { email: "ana@cegep.example" });
  assert.equal(again.status, 202);
  const fresh = issued[3] ?? "";
  at.current = new Date(at.current.getTime() + 10 * 60 * 1000);
  const confirm = await call("POST", "/v1/auth/reinitialiser/confirmer", { token: fresh, password: "nouveau mot de passe" });
  assert.equal(confirm.status, 204);
  const newCookie = cookieOf(confirm.headers);
  const reused = await call("POST", "/v1/auth/reinitialiser/confirmer", { token: fresh, password: "autre mot de passe" });
  assert.equal(reused.status, 400);
  assert.equal(reused.body, "lien inconnu");
  assert.equal((await call("GET", "/v1/auth/etat", undefined, firstCookie)).status, 200);
  assert.equal(JSON.parse((await call("GET", "/v1/auth/etat", undefined, firstCookie)).body).email, null);
  assert.equal(JSON.parse((await call("GET", "/v1/auth/etat", undefined, secondCookie)).body).email, null);
  const me = JSON.parse((await call("GET", "/v1/auth/etat", undefined, newCookie)).body);
  assert.equal(me.email, "ana@cegep.example");
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).status, 401);
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "nouveau mot de passe" })).status, 204);
});

test("réinitialisation : pas d’envoi sans relais, et limitation des essais", async () => {
  const { call, store } = await setup();
  await call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
  const etat = JSON.parse((await call("GET", "/v1/auth/etat")).body);
  assert.equal(etat.courriel, false);
  const none = await call("POST", "/v1/auth/reinitialiser", { email: "ana@cegep.example" });
  assert.equal(none.status, 202);
  const keys = (await store.list("auth")).map((row) => row.key).join(" ");
  assert.equal(keys.includes("reset:"), false, "sans relais, aucun jeton n’est créé");
  const { call: call2 } = await setup({
    mailer: async () => {},
  });
  await call2("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call2("POST", "/v1/auth/reinitialiser", { email: "ana@cegep.example" }, undefined, "203.0.113.10")).status, 202);
  }
  const limited = await call2("POST", "/v1/auth/reinitialiser", { email: "ana@cegep.example" }, undefined, "203.0.113.10");
  assert.equal(limited.status, 429);
  assert.equal(limited.body, "trop d'essais");
  const otherMail = await call2("POST", "/v1/auth/reinitialiser", { email: "autre@cegep.example" }, undefined, "203.0.113.11");
  assert.equal(otherMail.status, 202);
  for (let i = 0; i < 20; i++) {
    assert.equal((await call2("POST", "/v1/auth/reinitialiser", { email: `n${i}@cegep.example` }, undefined, "203.0.113.12")).status, 202);
  }
  assert.equal((await call2("POST", "/v1/auth/reinitialiser", { email: "dernier@cegep.example" }, undefined, "203.0.113.12")).status, 429);
});

test("profil : nom, mot de passe actuel exigé, courriel confirmé", async () => {
  const sent: Array<{ to: string; text: string }> = [];
  const { call, issued } = await setup({
    mailer: async (to, _subject, text) => {
      sent.push({ to, text });
    },
    origin: "https://journal.example",
  });
  const install = await call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
  const cookie = cookieOf(install.headers);
  const other = cookieOf((await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).headers);
  assert.equal((await call("GET", "/v1/auth/profil")).status, 401);
  const empty = JSON.parse((await call("GET", "/v1/auth/profil", undefined, cookie)).body);
  assert.deepEqual(empty, { email: "ana@cegep.example", nom: "", nomAffiche: "" });
  const saved = JSON.parse((await call("POST", "/v1/auth/profil", { nom: "  Anne  Marie  ", nomAffiche: "Anne" }, cookie)).body);
  assert.deepEqual(saved, { email: "ana@cegep.example", nom: "Anne Marie", nomAffiche: "Anne" });
  assert.equal((await call("POST", "/v1/auth/profil/motdepasse", { actuel: "mauvais mot de passe", nouveau: "un secret neuf" }, cookie)).status, 401);
  assert.equal((await call("POST", "/v1/auth/profil/motdepasse", { actuel: "mot de passe d’Ana", nouveau: "court" }, cookie)).status, 400);
  assert.equal((await call("POST", "/v1/auth/profil/motdepasse", { actuel: "mot de passe d’Ana", nouveau: "un secret neuf" }, cookie)).status, 204);
  assert.equal(JSON.parse((await call("GET", "/v1/auth/etat", undefined, other)).body).email, null);
  assert.equal(JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body).email, "ana@cegep.example");
  const change = await call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, cookie);
  assert.equal(change.status, 202);
  const token = issued.at(-1) ?? "";
  assert.equal(sent.at(-1)?.to, "anne@cegep.example");
  assert.equal(JSON.stringify(sent).includes(token), true);
  const confirmed = await call("POST", "/v1/auth/profil/courriel/confirmer", { token }, cookie);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(JSON.parse(confirmed.body), { email: "anne@cegep.example" });
  const me = JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body);
  assert.equal(me.email, "anne@cegep.example");
  const profile = JSON.parse((await call("GET", "/v1/auth/profil", undefined, cookie)).body);
  assert.equal(profile.nom, "Anne Marie");
  assert.equal(profile.email, "anne@cegep.example");
});
