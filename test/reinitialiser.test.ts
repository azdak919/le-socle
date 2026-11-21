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
  assert.deepEqual(empty, { email: "ana@cegep.example", nom: "", nomAffiche: "", courrielEtat: "non-confirmee", courrielEnAttente: null });
  const saved = JSON.parse((await call("POST", "/v1/auth/profil", { nom: "  Anne  Marie  ", nomAffiche: "Anne" }, cookie)).body);
  assert.deepEqual(saved, { email: "ana@cegep.example", nom: "Anne Marie", nomAffiche: "Anne", courrielEtat: "non-confirmee", courrielEnAttente: null });
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
  assert.equal(profile.courrielEtat, "confirmee");
  assert.equal(profile.courrielEnAttente, null);
});


test("profil : le nouveau courriel n’est appliqué qu’après un lien unique non expiré", async () => {
  const sent: Array<{ to: string; text: string }> = [];
  const { call, at, issued, store } = await setup({
    mailer: async (to, _subject, text) => {
      sent.push({ to, text });
    },
  });
  const install = await call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
  const cookie = cookieOf(install.headers);
  await call("POST", "/v1/auth/membres", { email: "lea@cegep.example", role: "auteur", password: "mot de passe de Léa" }, cookie);

  const withoutMail = await setup();
  const bare = cookieOf((await withoutMail.call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).headers);
  assert.equal((await withoutMail.call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, bare)).status, 409);
  assert.equal((await withoutMail.call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, bare)).body, "smtp absent");
  assert.equal(JSON.parse((await withoutMail.call("GET", "/v1/auth/etat", undefined, bare)).body).email, "ana@cegep.example");

  assert.equal((await call("POST", "/v1/auth/profil/courriel", { courriel: "pas-un-courriel" }, cookie)).status, 400);
  assert.equal((await call("POST", "/v1/auth/profil/courriel", { courriel: "ana@cegep.example" }, cookie)).body, "courriel inchangé");
  assert.equal((await call("POST", "/v1/auth/profil/courriel", { courriel: "lea@cegep.example" }, cookie)).body, "courriel déjà utilisé");

  const asking = await call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, cookie);
  assert.equal(asking.status, 202);
  const token = issued.at(-1) ?? "";
  assert.equal(sent.at(-1)?.to, "anne@cegep.example");
  assert.match(sent.at(-1)?.text ?? "", /#courriel=/);
  assert.equal(JSON.stringify(sent.at(-1)).includes(token), true);
  const rows = await store.list("auth");
  const pending = rows.filter((row) => row.key.startsWith("courriel:"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.key, "courriel:" + hashToken(token));
  assert.equal(pending[0]?.value.includes(token), false);
  assert.match(pending[0]?.value ?? "", /ana@cegep\.example/);
  assert.match(pending[0]?.value ?? "", /anne@cegep\.example/);
  assert.equal(JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body).email, "ana@cegep.example");
  assert.equal(JSON.parse((await call("GET", "/v1/auth/profil", undefined, cookie)).body).email, "ana@cegep.example");
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "anne@cegep.example", password: "mot de passe d’Ana" })).status, 401);

  assert.equal((await call("POST", "/v1/auth/profil/courriel/confirmer", { token })).status, 401);
  assert.equal(JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body).email, "ana@cegep.example");

  const foreign = await setup({
    mailer: async (to, _subject, text) => {
      sent.push({ to, text });
    },
  });
  const foreignAdmin = cookieOf((await foreign.call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).headers);
  await foreign.call("POST", "/v1/auth/membres", { email: "lea@cegep.example", role: "auteur", password: "mot de passe de Léa" }, foreignAdmin);
  const foreignLea = cookieOf((await foreign.call("POST", "/v1/auth/motdepasse", { email: "lea@cegep.example", password: "mot de passe de Léa" })).headers);
  assert.equal((await foreign.call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, foreignAdmin)).status, 202);
  const foreignToken = foreign.issued.at(-1) ?? "";
  assert.equal((await foreign.call("POST", "/v1/auth/profil/courriel/confirmer", { token: foreignToken }, foreignLea)).body, "lien inconnu");
  assert.equal(JSON.parse((await foreign.call("GET", "/v1/auth/etat", undefined, foreignAdmin)).body).email, "ana@cegep.example");
  assert.equal((await foreign.call("POST", "/v1/auth/profil/courriel/confirmer", { token: foreignToken }, foreignAdmin)).body, "lien inconnu");

  const expired = await setup({
    mailer: async (to, _subject, text) => {
      sent.push({ to, text });
    },
  });
  const expCookie = cookieOf((await expired.call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).headers);
  assert.equal((await expired.call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, expCookie)).status, 202);
  const expToken = expired.issued.at(-1) ?? "";
  expired.at.current = new Date("2026-11-21T21:00:01.000Z");
  assert.equal((await expired.call("POST", "/v1/auth/profil/courriel/confirmer", { token: expToken }, expCookie)).body, "lien expiré");
  assert.equal(JSON.parse((await expired.call("GET", "/v1/auth/etat", undefined, expCookie)).body).email, "ana@cegep.example");
  assert.equal((await expired.call("POST", "/v1/auth/profil/courriel/confirmer", { token: expToken }, expCookie)).body, "lien inconnu");

  const broken = await setup({
    mailer: async () => {
      throw new Error("relais muet");
    },
  });
  const brokenCookie = cookieOf((await broken.call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).headers);
  assert.equal((await broken.call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, brokenCookie)).body, "smtp absent");
  assert.equal(JSON.parse((await broken.call("GET", "/v1/auth/etat", undefined, brokenCookie)).body).email, "ana@cegep.example");
  const leftover = (await broken.store.list("auth")).filter((row) => row.key.startsWith("courriel:"));
  assert.equal(leftover.length, 0);
  assert.equal((await broken.call("POST", "/v1/auth/profil/courriel/confirmer", { token: broken.issued.at(-1) }, brokenCookie)).body, "lien inconnu");

  const confirmed = await call("POST", "/v1/auth/profil/courriel/confirmer", { token }, cookie);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(JSON.parse(confirmed.body), { email: "anne@cegep.example" });
  assert.equal(JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body).email, "anne@cegep.example");
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).status, 401);
  assert.equal((await call("POST", "/v1/auth/motdepasse", { email: "anne@cegep.example", password: "mot de passe d’Ana" })).status, 204);
  assert.equal((await call("POST", "/v1/auth/profil/courriel/confirmer", { token }, cookie)).body, "lien inconnu");
});


test("profil : un compte existant reste non confirmé jusqu’à un vrai lien, avec renvoi et annulation", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const { call, issued } = await setup({
    mailer: async (to, subject, text) => {
      sent.push({ to, subject, text });
    },
    origin: "https://journal.example",
  });
  const cookie = cookieOf((await call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" })).headers);
  const debut = JSON.parse((await call("GET", "/v1/auth/profil", undefined, cookie)).body);
  assert.equal(debut.courrielEtat, "non-confirmee");
  assert.equal(debut.courrielEnAttente, null);

  assert.equal((await call("POST", "/v1/auth/profil/courriel/renvoyer", undefined, cookie)).body, "demande absente");
  assert.equal((await call("POST", "/v1/auth/profil/courriel/annuler", undefined, cookie)).body, "demande absente");

  const confirm = await call("POST", "/v1/auth/profil/courriel/confirmer-actuel", undefined, cookie);
  assert.equal(confirm.status, 202);
  assert.equal(sent.at(-1)?.to, "ana@cegep.example");
  assert.equal(sent.at(-1)?.subject, "Confirmer votre courriel");
  const attente = JSON.parse((await call("GET", "/v1/auth/profil", undefined, cookie)).body);
  assert.equal(attente.courrielEtat, "en-attente");
  assert.equal(attente.courrielEnAttente, null);

  const resend = await call("POST", "/v1/auth/profil/courriel/renvoyer", undefined, cookie);
  assert.equal(resend.status, 202);
  assert.equal(sent.at(-1)?.to, "ana@cegep.example");
  const token = issued.at(-1) ?? "";
  const done = await call("POST", "/v1/auth/profil/courriel/confirmer", { token }, cookie);
  assert.equal(done.status, 200);
  const ok = JSON.parse((await call("GET", "/v1/auth/profil", undefined, cookie)).body);
  assert.equal(ok.courrielEtat, "confirmee");
  assert.equal(ok.email, "ana@cegep.example");

  const change = await call("POST", "/v1/auth/profil/courriel", { courriel: "anne@cegep.example" }, cookie);
  assert.equal(change.status, 202);
  const pending = JSON.parse((await call("GET", "/v1/auth/profil", undefined, cookie)).body);
  assert.equal(pending.courrielEtat, "confirmee");
  assert.equal(pending.courrielEnAttente, "anne@cegep.example");
  const cancelled = JSON.parse((await call("POST", "/v1/auth/profil/courriel/annuler", undefined, cookie)).body);
  assert.equal(cancelled.courrielEtat, "confirmee");
  assert.equal(cancelled.courrielEnAttente, null);
  assert.equal(cancelled.email, "ana@cegep.example");
});

test("smtp : réglages enregistrés, mot de passe jamais renvoyé, essai vers la personne connectée", async () => {
  const { handleAuth } = await import("../src/auth-http.ts");
  const { openSqliteMemory } = await import("../src/sqlite.ts");
  const { defaultConfig } = await import("../src/config.ts");
  const { createServer } = await import("node:net");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = openSqliteMemory();
  await store.migrate(["auth"]);
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.write("220 ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      received.push(chunk.toString());
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("EHLO")) socket.write("250-AUTH LOGIN\r\n250 ok\r\n");
        else if (line === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n");
        else if (line === Buffer.from("redaction@journal.example").toString("base64")) socket.write("334 UGFzc3dvcmQ6\r\n");
        else if (line === Buffer.from("secret-smtp").toString("base64")) socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n");
        else if (line.startsWith("RCPT TO")) socket.write("250 ok\r\n");
        else if (line === "DATA") socket.write("354 go\r\n");
        else if (line === ".") socket.write("250 queued\r\n");
        else if (line === "QUIT") socket.end("221 bye\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("smtp local muet");
  const config = defaultConfig();
  config.modules.auth = true;
  const deps = {
    store,
    now: () => new Date("2026-11-21T20:00:00.000Z"),
    backupDir: mkdtempSync(join(tmpdir(), "socle-smtp-ui-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => {},
    auth: { mode: "motdepasse" as const, publicOrigin: "https://journal.example" },
  };
  const call = (method: string, path: string, body?: unknown, cookie?: string) => handleAuth(
    method,
    path,
    config,
    deps,
    new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)),
    { "content-type": "application/json", cookie },
  );
  try {
    const install = await call("POST", "/v1/auth/installation", { email: "ana@cegep.example", password: "mot de passe d’Ana" });
    const cookie = String(install.headers["set-cookie"] ?? "").split(";")[0];
    assert.equal((await call("GET", "/v1/auth/smtp")).status, 401);
    const empty = JSON.parse((await call("GET", "/v1/auth/smtp", undefined, cookie)).body);
    assert.equal(empty.source, "absent");
    assert.equal(empty.fournisseur, "hebergeur");
    assert.equal(empty.motDePasseEnregistre, false);
    const saved = await call("POST", "/v1/auth/smtp", {
      fournisseur: "hebergeur",
      host: "127.0.0.1",
      port: address.port,
      secure: false,
      user: "redaction@journal.example",
      password: "secret-smtp",
      from: "redaction@journal.example",
    }, cookie);
    assert.equal(saved.status, 200, saved.body);
    const publicSettings = JSON.parse(saved.body);
    assert.equal(publicSettings.source, "enregistrement");
    assert.equal(publicSettings.motDePasseEnregistre, true);
    assert.equal(publicSettings.host, "127.0.0.1");
    assert.equal("password" in publicSettings, false);
    assert.doesNotMatch(saved.body, /secret-smtp/);
    const etat = JSON.parse((await call("GET", "/v1/auth/etat", undefined, cookie)).body);
    assert.equal(etat.courriel, true);
    const essai = await call("POST", "/v1/auth/smtp/essai", undefined, cookie);
    assert.equal(essai.status, 200, essai.body);
    assert.deepEqual(JSON.parse(essai.body), { ok: true, destinataire: "ana@cegep.example" });
    const transcript = received.join("");
    assert.match(transcript, /RCPT TO:<ana@cegep.example>/);
    assert.match(transcript, /Courriel d’essai du Socle/);
    assert.doesNotMatch(transcript, /secret-smtp/);
    const again = JSON.parse((await call("GET", "/v1/auth/smtp", undefined, cookie)).body);
    assert.equal("password" in again, false);
    assert.equal(again.motDePasseEnregistre, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
