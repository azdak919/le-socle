import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleAdmin, type AdminDeps } from "../src/admin.ts";
import { buildSessionZip, buildSiteZip, restoreZip } from "../src/archive.ts";
import { defaultConfig } from "../src/config.ts";
import { handleNotify } from "../src/notify-http.ts";
import { buildPushRequest, generatePushKeys, sendProjectPush, type NotifyRuntime } from "../src/notify.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { unzip } from "../src/zip.ts";

const NOW = new Date("2026-11-17T15:00:00.000Z");
const NOTICE = "Le journal a un texte.";

function deps(store: SocleStore, notify?: NotifyRuntime): AdminDeps {
  return {
    store,
    now: () => NOW,
    backupDir: mkdtempSync(join(tmpdir(), "socle-notify-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => undefined,
    notify,
  };
}

async function opened(modules: Array<"notify" | "auth" | "export">) {
  const store = openSqliteMemory();
  await store.migrate(modules);
  return store;
}

function configFor(flags: { notify?: boolean; auth?: boolean }) {
  const config = defaultConfig();
  config.modules.notify = flags.notify ?? false;
  config.modules.auth = flags.auth ?? false;
  return config;
}

function clientKeys(): { p256dh: string; auth: string; authBytes: Buffer; client: ReturnType<typeof createECDH> } {
  const client = createECDH("prime256v1");
  client.generateKeys();
  const authBytes = randomBytes(16);
  return {
    p256dh: client.getPublicKey().toString("base64url"),
    auth: authBytes.toString("base64url"),
    authBytes,
    client,
  };
}

function decryptPush(body: Buffer, client: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + idLen);
  const encrypted = body.subarray(21 + idLen);
  const shared = client.computeSecret(serverPublic);
  const clientPublic = client.getPublicKey();
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([
    Buffer.from("WebPush: info\0"),
    clientPublic,
    serverPublic,
  ]), 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const tag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, -1).toString("utf8");
}

test("le courriel part par le projet, le lien retire, la clé privée ne sort pas", async () => {
  const keys = generatePushKeys();
  const sent: string[] = [];
  const store = await opened(["notify", "export"]);
  const config = configFor({ notify: true });
  const runtime: NotifyRuntime = {
    publicOrigin: "https://journal.example",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: "mailto:redaction@journal.example",
    mailer: async (_to, url) => {
      sent.push(url);
    },
  };
  const admin = deps(store, runtime);
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const calls: string[] = [];
  const originals = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      calls.push(args.map((part) => String(part)).join(" "));
    };
  }
  try {
    const silent = await handleNotify("POST", "/v1/notify/abonnement", config, deps(store, {}), Buffer.from(JSON.stringify({
      channel: "courriel",
      address: "ada@journal.test",
    })));
    assert.equal(silent.status, 409);
    assert.match(silent.body, /smtp absent/);
    assert.deepEqual(await store.list("notify"), []);

    const noOrigin = await handleNotify("POST", "/v1/notify/abonnement", config, deps(store, {
      mailer: async () => undefined,
    }), Buffer.from(JSON.stringify({
      channel: "courriel",
      address: "ada@journal.test",
    })));
    assert.equal(noOrigin.status, 409);
    assert.match(noOrigin.body, /origine absente/);
    assert.deepEqual(await store.list("notify"), []);

    const extra = await handleNotify("POST", "/v1/notify/abonnement", config, admin, Buffer.from(JSON.stringify({
      channel: "courriel",
      address: "ada@journal.test",
      email: "ada@journal.test",
    })));
    assert.equal(extra.status, 400);
    assert.deepEqual(await store.list("notify"), []);

    const created = await handleNotify("POST", "/v1/notify/abonnement", config, admin, Buffer.from(JSON.stringify({
      channel: "courriel",
      address: "Ada@journal.test",
    })));
    assert.equal(created.status, 202);
    assert.equal(created.body, "");
    assert.deepEqual(created.headers, {});
    const link = sent.at(-1) ?? "";
    const token = new URL(link).searchParams.get("token") ?? "";
    assert.ok(token);
    const kept = JSON.stringify(await store.list("notify"));
    assert.equal(kept.includes(token), false);
    assert.equal(kept.includes(keys.privateKey), false);
    assert.equal(calls.join("\n").includes(token), false);
    assert.equal(created.body.includes(token), false);

    const again = await handleNotify("POST", "/v1/notify/abonnement", config, admin, Buffer.from(JSON.stringify({
      channel: "courriel",
      address: "ada@journal.test",
    })));
    assert.equal(again.status, 202);
    const next = new URL(sent.at(-1) ?? "").searchParams.get("token") ?? "";
    const stale = await handleNotify("GET", `/v1/notify/desabonnement?token=${encodeURIComponent(token)}`, config, admin, new Uint8Array());
    assert.equal(stale.status, 400);
    const removed = await handleNotify("GET", `/v1/notify/desabonnement?token=${encodeURIComponent(next)}`, config, admin, new Uint8Array());
    assert.equal(removed.status, 200);
    assert.equal(removed.body, "désabonné");
    assert.equal(removed.body.includes(next), false);
    const second = await handleNotify("GET", `/v1/notify/desabonnement?token=${encodeURIComponent(next)}`, config, admin, new Uint8Array());
    assert.equal(second.status, 400);
    assert.deepEqual(await store.list("notify"), []);

    const pushedOff = await handleNotify("POST", "/v1/notify/abonnement", config, deps(store, {
      publicOrigin: "https://journal.example",
    }), Buffer.from(JSON.stringify({
      channel: "push",
      address: "https://push.example/sub/abc",
      p256dh: "aa",
      auth: "bb",
    })));
    assert.equal(pushedOff.status, 409);
    assert.match(pushedOff.body, /clés absentes/);
    assert.deepEqual(await store.list("notify"), []);

    const browser = clientKeys();
    const pushed = await handleNotify("POST", "/v1/notify/abonnement", config, admin, Buffer.from(JSON.stringify({
      channel: "push",
      address: "https://user:secret@push.example/sub/abc",
      p256dh: browser.p256dh,
      auth: browser.auth,
    })));
    assert.equal(pushed.status, 400);
    assert.deepEqual(await store.list("notify"), []);

    const endpoint = "https://push.example/sub/abc";
    const accepted = await handleNotify("POST", "/v1/notify/abonnement", config, admin, Buffer.from(JSON.stringify({
      channel: "push",
      address: endpoint,
      p256dh: browser.p256dh,
      auth: browser.auth,
    })));
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.includes(keys.privateKey), false);
    const pushUrl = (JSON.parse(accepted.body) as { url: string }).url;
    assert.match(pushUrl, /^\/v1\/notify\/desabonnement\?token=/);
    const stored = JSON.stringify(await store.list("notify"));
    assert.equal(stored.includes(endpoint), true);
    assert.equal(stored.includes(keys.privateKey), false);
    const shown = await handleNotify("GET", "/v1/notify/cles", config, admin, new Uint8Array());
    assert.equal(shown.status, 200);
    assert.equal(JSON.parse(shown.body).publicKey, keys.publicKey);
    assert.equal(shown.body.includes(keys.privateKey), false);

    const request = buildPushRequest({
      address: endpoint,
      p256dh: browser.p256dh,
      auth: browser.auth,
    }, NOTICE, runtime, NOW);
    assert.equal(request.url, endpoint);
    assert.match(request.headers.authorization, /^vapid t=/);
    assert.equal(request.headers.authorization.includes(keys.privateKey), false);
    assert.equal(request.body.includes(Buffer.from(NOTICE)), false);
    assert.equal(decryptPush(request.body, browser.client, browser.authBytes), NOTICE);
    const payload = JSON.parse(Buffer.from(request.headers.authorization.split(".")[1] ?? "", "base64url").toString()) as { aud: string };
    assert.equal(payload.aud, "https://push.example");

    let posted = "";
    await sendProjectPush({
      address: endpoint,
      p256dh: browser.p256dh,
      auth: browser.auth,
    }, NOTICE, {
      ...runtime,
      fetch: async (input) => {
        posted = input;
        return new Response(null, { status: 201 });
      },
    }, NOW);
    assert.equal(posted, endpoint);

    const zip = unzip(await buildSiteZip(store, NOW));
    const index = new TextDecoder().decode(zip.get("index.html")!);
    assert.equal(index.includes(endpoint), false);
    assert.equal(index.includes(keys.privateKey), false);
    const archived = JSON.parse(new TextDecoder().decode(zip.get("notify/subscriptions.json")!)) as Array<{ address: string }>;
    assert.equal(archived[0]?.address, endpoint);
    assert.equal(Buffer.from(await buildSessionZip(store, "automne")).toString("latin1").includes(endpoint), false);
    assert.equal(Buffer.from(await buildSiteZip(store, NOW)).toString("latin1").includes(keys.privateKey), false);
    const copy = await opened(["notify", "export"]);
    await restoreZip(copy, await buildSiteZip(store, NOW));
    assert.equal((await copy.list("notify")).some((row) => row.value.includes(endpoint)), true);
    await copy.close();
  } finally {
    methods.forEach((name, index) => {
      console[name] = originals[index]!;
    });
    await store.close();
  }
});

test("l'envoi est au responsable, le module éteint n'ouvre pas de route", async () => {
  const off = await opened([]);
  try {
    const missing = await handleNotify("POST", "/v1/notify/abonnement", configFor({}), deps(off), Buffer.from(JSON.stringify({
      channel: "courriel",
      address: "ada@journal.test",
    })));
    assert.equal(missing.status, 404);
    assert.equal(await off.tableReady("notify"), false);
    const homeOff = await handleAdmin("GET", "/admin", configFor({}), deps(off), new Uint8Array());
    assert.equal(String(homeOff.body).includes("/admin/abonnements"), false);
  } finally {
    await off.close();
  }

  const store = await opened(["notify", "auth"]);
  const config = configFor({ notify: true, auth: true });
  const mailed: string[] = [];
  let pushed = 0;
  const browser = clientKeys();
  const keys = generatePushKeys();
  const runtime: NotifyRuntime = {
    publicOrigin: "https://journal.example",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    mailer: async (_to, text) => {
      mailed.push(text);
    },
    sendPush: async () => {
      pushed += 1;
    },
  };
  const admin = deps(store, runtime);
  const server = createSocleServer(config, admin);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await store.put("auth", "member:ada@journal.test", "auteur");
    await store.put("auth", "member:lea@journal.test", "responsable");
    const subscribed = await fetch(`http://127.0.0.1:${address.port}/v1/notify/abonnement`, {
      method: "POST",
      body: JSON.stringify({ channel: "courriel", address: "lecteur@journal.test" }),
    });
    assert.equal(subscribed.status, 202);
    assert.equal(await subscribed.text(), "");
    const link = mailed.at(-1) ?? "";
    assert.equal(link.startsWith("https://journal.example/v1/notify/desabonnement?token="), true);
    mailed.length = 0;

    const blocked = await handleNotify("POST", "/admin/abonnements/envoi", config, admin, Buffer.from(JSON.stringify({
      text: NOTICE,
    })), "ada@journal.test");
    assert.equal(blocked.status, 403);
    assert.equal(mailed.length, 0);
    assert.equal(pushed, 0);

    const hidden = await handleNotify("GET", "/admin/abonnements?lang=en", config, admin, new Uint8Array(), "ada@journal.test");
    const html = String(hidden.body);
    assert.match(html, /lang="en"/);
    assert.match(html, /@page letter/);
    assert.match(html, /Skip to content/);
    assert.match(html, /Email : 1\./);
    assert.equal(html.includes("lecteur@journal.test"), false);
    assert.equal(html.includes("<form"), false);
    assert.equal(html.includes(keys.privateKey), false);

    await handleNotify("POST", "/v1/notify/abonnement", config, admin, Buffer.from(JSON.stringify({
      channel: "push",
      address: "https://push.example/sub/page",
      p256dh: browser.p256dh,
      auth: browser.auth,
    })));
    const sent = await handleNotify("POST", "/admin/abonnements/envoi", config, admin, Buffer.from(JSON.stringify({
      text: NOTICE,
      email: "ada@journal.test",
    })), "lea@journal.test");
    assert.equal(sent.status, 400);
    assert.equal(mailed.length, 0);
    assert.equal(pushed, 0);

    const done = await handleNotify("POST", "/admin/abonnements/envoi", config, admin, Buffer.from(JSON.stringify({
      text: NOTICE,
    })), "lea@journal.test");
    assert.equal(done.status, 200);
    assert.equal(JSON.parse(done.body).sent, 2);
    assert.equal(mailed[0], NOTICE);
    assert.equal(pushed, 1);
    const visible = await handleNotify("GET", "/admin/abonnements", config, admin, new Uint8Array(), "lea@journal.test");
    assert.match(String(visible.body), /lecteur@journal\.test/);
    assert.match(String(visible.body), /<form class="noprint"/);
    const linked = await handleAdmin("GET", "/admin", config, admin, new Uint8Array(), "lea@journal.test");
    assert.match(String(linked.body), /href="\/admin\/abonnements"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  }
});
