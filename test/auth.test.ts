import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleAdmin } from "../src/admin.ts";
import type { AdminDeps } from "../src/admin.ts";
import { buildSessionZip, buildSiteZip, restoreZip } from "../src/archive.ts";
import { handleAuth } from "../src/auth-http.ts";
import { ensureResponsable, hashToken } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { createSocleServer } from "../src/server.ts";
import { sendSmtp, smtpFromEnv } from "../src/smtp.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { unzip } from "../src/zip.ts";

const START = new Date("2026-11-17T15:00:00.000Z");

function sha(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function clocked(store: SocleStore, patch: Partial<AdminDeps> = {}): {
  deps: AdminDeps;
  issued: string[];
  sent: Array<{ to: string; url: string }>;
  at: { current: Date };
  version: { current: string };
} {
  const issued: string[] = [];
  const sent: Array<{ to: string; url: string }> = [];
  const at = { current: new Date(START) };
  const version = { current: "0.0.0" };
  let n = 0;
  const { auth: authPatch, ...rest } = patch;
  const deps: AdminDeps = {
    store,
    now: () => at.current,
    backupDir: mkdtempSync(join(tmpdir(), "socle-auth-")),
    release: () => ({ version: "0.1.0", notes: "correctifs" }),
    version: () => version.current,
    setVersion: async (next) => {
      version.current = next;
    },
    auth: {
      mode: "magic",
      publicOrigin: "http://127.0.0.1:8787",
      randomBytes: () => {
        n += 1;
        const bytes = new Uint8Array(32);
        bytes.fill(n);
        issued.push(Buffer.from(bytes).toString("base64url"));
        return bytes;
      },
      mailer: async (to, url) => {
        sent.push({ to, url });
      },
      ...authPatch,
    },
    ...rest,
  };
  return { deps, issued, sent, at, version };
}

async function migrated(modules: Array<"auth" | "export"> = ["auth"]) {
  const store = openSqliteMemory();
  await store.migrate(modules);
  return store;
}

async function dumped(store: SocleStore): Promise<string> {
  return JSON.stringify(await store.list("auth"));
}

function silence<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const previous = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  }
  return run().finally(() => {
    methods.forEach((name, index) => {
      console[name] = previous[index] as typeof console.log;
    });
  }).then((result) => ({ result, logs }));
}

test("un mode inconnu ou un smtp absent ne crée pas de jeton", async () => {
  const bare = openSqliteMemory();
  const config = defaultConfig();
  config.modules.auth = true;
  const { deps } = clocked(bare, { auth: { mode: undefined, mailer: undefined } });
  try {
    const unknown = await handleAuth("POST", "/v1/auth/lien", config, deps, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body, "mode inconnu");
    assert.equal(await bare.tableReady("auth"), false);

    const quiet = clocked(bare, { auth: { mode: "magic", mailer: undefined } });
    const smtp = await handleAuth("POST", "/v1/auth/lien", config, quiet.deps, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
    assert.equal(smtp.status, 409);
    assert.equal(smtp.body, "smtp absent");
    assert.equal(await bare.tableReady("auth"), false);

    const github = clocked(bare, { auth: { mode: "github" } });
    const client = await handleAuth("GET", "/v1/auth/github", config, github.deps, new Uint8Array());
    assert.equal(client.status, 409);
    assert.equal(client.body, "client absent");
  } finally {
    await bare.close();
  }
});

test("le lien magique ne garde que le hachage, et un champ en trop est refusé", async () => {
  const store = await migrated();
  const config = defaultConfig();
  config.modules.auth = true;
  const { deps, issued, sent, at } = clocked(store);
  try {
    const extra = await silence(() => handleAuth(
      "POST",
      "/v1/auth/lien",
      config,
      deps,
      Buffer.from(JSON.stringify({ email: "ada@journal.test", password: "hunter2" })),
    ));
    assert.equal(extra.result.status, 400);
    assert.equal(await dumped(store), "[]");
    assert.equal(extra.logs.join(" ").includes("hunter2"), false);

    const posted = await silence(() => handleAuth(
      "POST",
      "/v1/auth/lien",
      config,
      deps,
      Buffer.from(JSON.stringify({ email: "Ada@Journal.test" })),
    ));
    assert.equal(posted.result.status, 202);
    assert.equal(posted.result.body, "");
    const token = issued[0] ?? "";
    assert.equal(token.length > 20, true);
    assert.equal(JSON.stringify(posted.result).includes(token), false);
    assert.equal(posted.logs.join(" ").includes(token), false);
    assert.equal(sent[0]?.to, "ada@journal.test");
    assert.equal(sent[0]?.url.includes(token), true);
    const rows = await store.list("auth");
    assert.deepEqual(rows.map((row) => row.key), [`magic:${sha(token)}`]);
    assert.equal(hashToken(token), sha(token));
    const stored = JSON.parse(rows[0]?.value ?? "{}") as { email: string; exp: string };
    assert.deepEqual(Object.keys(stored).sort(), ["email", "exp"]);
    assert.equal(stored.email, "ada@journal.test");
    assert.equal(JSON.stringify(rows).includes(token), false);
    assert.equal(JSON.stringify(rows).includes("password"), false);

    const consumed = await silence(() => handleAuth("GET", `/v1/auth/lien?token=${encodeURIComponent(token)}`, config, deps, new Uint8Array()));
    const session = issued[1] ?? "";
    assert.equal(consumed.result.status, 303);
    assert.equal(consumed.result.body, "");
    assert.equal(consumed.result.headers.location, "/admin");
    assert.equal(consumed.result.headers.location.includes(session), false);
    assert.match(consumed.result.headers["set-cookie"] ?? "", new RegExp(`^socle_session=${session}; HttpOnly`));
    assert.equal(consumed.logs.join(" ").includes(session), false);
    const after = await store.list("auth");
    assert.equal(after.some((row) => row.key.startsWith("magic:")), false);
    assert.deepEqual(after.map((row) => row.key), [`session:${sha(session)}`]);
    assert.equal(JSON.stringify(after).includes(session), false);

    const again = await handleAuth("GET", `/v1/auth/lien?token=${encodeURIComponent(token)}`, config, deps, new Uint8Array());
    assert.equal(again.status, 400);
    assert.equal((await store.list("auth")).filter((row) => row.key.startsWith("session:")).length, 1);

    at.current = new Date(START.getTime() + 16 * 60 * 1000);
    await handleAuth("POST", "/v1/auth/lien", config, deps, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
    const expiredToken = issued[2] ?? "";
    at.current = new Date(at.current.getTime() + 16 * 60 * 1000);
    const expired = await handleAuth("GET", `/v1/auth/lien?token=${encodeURIComponent(expiredToken)}`, config, deps, new Uint8Array());
    assert.equal(expired.status, 400);
    assert.equal(expired.body, "lien expiré");
    assert.equal((await store.list("auth")).some((row) => row.key === `magic:${sha(expiredToken)}`), false);
    assert.equal((await store.list("auth")).some((row) => row.key === `session:${sha(expiredToken)}`), false);
  } finally {
    await store.close();
  }
});

test("un envoi raté efface le jeton, GitHub n'appelle le réseau que sur un retour valide, Access ne décode pas", async () => {
  const store = await migrated();
  const config = defaultConfig();
  config.modules.auth = true;
  try {
    const down = clocked(store, {
      auth: {
        mode: "magic",
        mailer: async () => {
          throw new Error("relais coupé");
        },
      },
    });
    const refused = await handleAuth("POST", "/v1/auth/lien", config, down.deps, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
    assert.equal(refused.status, 409);
    assert.equal(refused.body, "smtp absent");
    assert.equal(await dumped(store), "[]");
    assert.equal(await dumped(store).then((text) => text.includes(down.issued[0] ?? "x")), false);

    const calls: string[] = [];
    const github = clocked(store, {
      auth: {
        mode: "github",
        githubClientId: "client-public",
        githubClientSecret: "secret-value",
        fetch: async (input, init) => {
          calls.push(String(input));
          if (String(input).endsWith("/access_token")) {
            const body = JSON.parse(String(init?.body)) as { client_secret?: string };
            assert.equal(body.client_secret, "secret-value");
            return Response.json({ access_token: "gho_testtoken" });
          }
          return Response.json([{ email: "ada@journal.test", primary: true, verified: true }]);
        },
      },
    });
    const start = await handleAuth("GET", "/v1/auth/github", config, github.deps, new Uint8Array());
    assert.equal(start.status, 302);
    const location = new URL(start.headers.location ?? "");
    assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "client-public");
    assert.equal(start.headers.location?.includes("secret-value"), false);
    const state = location.searchParams.get("state") ?? "";
    assert.equal(state, github.issued[0]);
    assert.equal((await dumped(store)).includes(state), false);
    assert.equal((await store.list("auth")).some((row) => row.key === `state:${sha(state)}`), true);

    const bad = await handleAuth("GET", "/v1/auth/github/retour?code=code-123&state=autre", config, github.deps, new Uint8Array());
    assert.equal(bad.status, 400);
    assert.deepEqual(calls, []);

    const back = await handleAuth("GET", `/v1/auth/github/retour?code=code-123&state=${encodeURIComponent(state)}`, config, github.deps, new Uint8Array());
    assert.equal(back.status, 303);
    assert.equal(back.body.includes("gho_testtoken"), false);
    const dump = await dumped(store);
    assert.equal(dump.includes("gho_testtoken"), false);
    assert.equal(dump.includes("secret-value"), false);
    assert.equal(dump.includes("code-123"), false);
    assert.equal(dump.includes(github.issued[1] ?? "session"), false);
    assert.deepEqual(calls, [
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user/emails",
    ]);

    const payload = Buffer.from(JSON.stringify({ email: "hidden@journal.test" })).toString("base64url");
    const assertion = `eyJhbGciOiJub25lIn0.${payload}.sig`;
    const locked = clocked(store, { auth: { mode: "access" } });
    const denied = await handleAuth("GET", "/v1/auth/access", config, locked.deps, new Uint8Array(), {
      "cf-access-jwt-assertion": assertion,
    });
    assert.equal(denied.status, 401);
    assert.equal((await dumped(store)).includes("hidden@journal.test"), false);
    assert.equal((await dumped(store)).includes(assertion), false);

    const opened = clocked(store, {
      auth: {
        mode: "access",
        verifyAccess: async (token) => {
          assert.equal(token, assertion);
          return "Ada@Journal.test";
        },
      },
    });
    const allowed = await handleAuth("GET", "/v1/auth/access", config, opened.deps, new Uint8Array(), {
      cookie: `CF_Authorization=${assertion}`,
    });
    assert.equal(allowed.status, 303);
    const accessDump = await dumped(store);
    assert.equal(accessDump.includes(assertion), false);
    assert.match(accessDump, /ada@journal\.test/);
  } finally {
    await store.close();
  }
});

test("le bouton de mise à jour est au responsable seulement quand l'identité est allumée", async () => {
  const store = await migrated(["auth", "export"]);
  const config = defaultConfig();
  config.modules.auth = true;
  config.modules.export = true;
  const { deps, issued, sent } = clocked(store);
  try {
    await ensureResponsable(store, "ada@journal.test");
    await handleAuth("POST", "/v1/auth/lien", config, deps, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
    const ada = await handleAuth("GET", `/v1/auth/lien?token=${encodeURIComponent(issued[0] ?? "")}`, config, deps, new Uint8Array());
    const adaCookie = (ada.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    await handleAuth("POST", "/v1/auth/membres", config, deps, Buffer.from(JSON.stringify({
      email: "ben@journal.test",
      role: "auteur",
    })), { cookie: adaCookie });
    const unknown = await handleAuth("POST", "/v1/auth/membres", config, deps, Buffer.from(JSON.stringify({
      email: "ben@journal.test",
      role: "chef",
    })), { cookie: adaCookie });
    assert.equal(unknown.status, 400);
    assert.equal(await store.get("auth", "member:ben@journal.test"), "auteur");

    await handleAuth("POST", "/v1/auth/lien", config, deps, Buffer.from(JSON.stringify({ email: "ben@journal.test" })));
    const benToken = new URL(sent.at(-1)?.url ?? "").searchParams.get("token") ?? "";
    const ben = await handleAuth("GET", `/v1/auth/lien?token=${encodeURIComponent(benToken)}`, config, deps, new Uint8Array());
    const benCookie = (ben.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    const refusedMember = await handleAuth("POST", "/v1/auth/membres", config, deps, Buffer.from(JSON.stringify({
      email: "chia@journal.test",
      role: "editeur",
    })), { cookie: benCookie });
    assert.equal(refusedMember.status, 403);
    assert.equal(await store.get("auth", "member:chia@journal.test"), null);

    const server = createSocleServer(config, deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const anon = await fetch(`${base}/admin/mise-a-jour`, { method: "POST", body: "confirm=1" });
      assert.equal(anon.status, 401, "sans session : connexion requise");
      const anonZip = await fetch(`${base}/admin/sauvegarde/site.zip`, { redirect: "manual" });
      assert.ok([303, 401].includes(anonZip.status), "sans session, aucune archive");
      const anonRestore = await fetch(`${base}/admin/sauvegarde/restaurer`, { method: "POST", headers: { "content-type": "application/zip" }, body: "PK" });
      assert.equal(anonRestore.status, 401, "sans session, aucune restauration");
      const benZip = await fetch(`${base}/admin/sauvegarde/site.zip`, { headers: { cookie: benCookie } });
      assert.equal(benZip.status, 403, "la sauvegarde est à l’administrateur");
      assert.equal(deps.version(), "0.0.0");
      assert.deepEqual(readdirSync(deps.backupDir), []);

      const auteur = await fetch(`${base}/admin/mise-a-jour`, { headers: { cookie: benCookie } });
      const auteurHtml = await auteur.text();
      assert.equal(auteur.status, 200);
      assert.match(auteurHtml, /0\.0\.0/);
      assert.equal(auteurHtml.includes('name="confirm"'), false);

      const blocked = await fetch(`${base}/admin/mise-a-jour/revenir`, { method: "POST", headers: { cookie: benCookie } });
      assert.equal(blocked.status, 403);

      const done = await fetch(`${base}/admin/mise-a-jour`, { method: "POST", headers: { cookie: adaCookie }, body: "confirm=1" });
      assert.equal(done.status, 200);
      assert.equal(deps.version(), "0.1.0");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    const off = defaultConfig();
    const open = clocked(store);
    open.deps.auth = undefined;
    const page = await handleAdmin("POST", "/admin/mise-a-jour", off, open.deps, Buffer.from("confirm=1"));
    assert.equal(page.status, 200);
    assert.equal(open.version.current, "0.1.0");

    const zip = await buildSiteZip(store, START);
    const files = unzip(zip);
    const members = JSON.parse(new TextDecoder().decode(files.get("auth/members.json")!)) as Array<{ email: string; role: string }>;
    assert.deepEqual(members, [
      { email: "ada@journal.test", role: "administrateur" },
      { email: "ben@journal.test", role: "auteur" },
    ]);
    const index = new TextDecoder().decode(files.get("index.html")!);
    assert.equal(index.includes("ada@journal.test"), false);
    assert.equal(index.includes("ben@journal.test"), false);
    const raw = Buffer.from(zip).toString("latin1");
    assert.equal(raw.includes(issued[0] ?? "magic"), false);
    assert.equal(raw.includes(benToken), false);
    for (const token of issued) assert.equal(raw.includes(sha(token)), false);
    const sessionZip = await buildSessionZip(store, "automne");
    assert.equal(Buffer.from(sessionZip).toString("latin1").includes("auth/members.json"), false);

    const restored = await migrated(["auth", "export"]);
    await restoreZip(restored, zip);
    assert.equal(await restored.get("auth", "member:ada@journal.test"), "administrateur");
    assert.equal((await restored.list("auth")).some((row) => row.key.startsWith("session:")), false);
    await restored.close();
  } finally {
    await store.close();
  }
});

test("le module éteint n'ouvre pas de route", async () => {
  const store = await migrated();
  const { deps } = clocked(store);
  const config = defaultConfig();
  try {
    const missing = await handleAuth("POST", "/v1/auth/lien", config, deps, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
    assert.equal(missing.status, 404);
    assert.equal(await dumped(store), "[]");
  } finally {
    await store.close();
  }
});

test("le smtp du projet envoie le courriel et ne l'écrit pas dans la console", async () => {
  assert.equal(smtpFromEnv({}), null);
  const seen: string[] = [];
  const server = createServer((socket) => {
    socket.write("220 ready\r\n");
    let step = 0;
    const replies = [
      "250-hi\r\n250 ok\r\n",
      "334 dQ==\r\n",
      "334 cA==\r\n",
      "235 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
    ];
    socket.on("data", (chunk) => {
      seen.push(chunk.toString("utf8"));
      const reply = replies[step];
      step += 1;
      if (reply) socket.write(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const { logs } = await silence(() => sendSmtp({
      host: "127.0.0.1",
      port: address.port,
      user: "ada",
      password: "s3cret",
      from: "journal@example.com",
    }, "ada@journal.test", "Lien de connexion", "http://127.0.0.1/v1/auth/lien?token=local-only"));
    assert.equal(logs.join(" ").includes("s3cret"), false);
    assert.equal(logs.join(" ").includes("local-only"), false);
    const wire = seen.join("");
    assert.equal(wire.includes("http://127.0.0.1/v1/auth/lien?token=local-only"), true);
    assert.equal(wire.includes("s3cret"), false);
    const decoded = seen.map((line) => Buffer.from(line.trim(), "base64").toString("utf8"));
    assert.equal(decoded.includes("ada"), true);
    assert.equal(decoded.includes("s3cret"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
