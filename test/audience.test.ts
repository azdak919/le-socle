import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleAdmin, type AdminDeps } from "../src/admin.ts";
import { buildSiteZip } from "../src/archive.ts";
import { handleAudience, resetBursts } from "../src/audience-http.ts";
import { civilDate, recordEvent } from "../src/audience.ts";
import { defaultConfig } from "../src/config.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { unzip } from "../src/zip.ts";

const NOW = new Date("2026-11-17T15:00:00.000Z");

function deps(store: SocleStore): AdminDeps {
  return {
    store,
    now: () => NOW,
    backupDir: mkdtempSync(join(tmpdir(), "socle-audience-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => undefined,
  };
}

async function opened(modules: Array<"audience" | "auth" | "export">) {
  const store = openSqliteMemory();
  await store.migrate(modules);
  return store;
}

function configFor(flags: { audience?: boolean; auth?: boolean; export?: boolean }) {
  const config = defaultConfig();
  config.modules.audience = flags.audience ?? false;
  config.modules.auth = flags.auth ?? false;
  config.modules.export = flags.export ?? false;
  return config;
}

test("la date de Toronto, le plafond et les 90 jours ne gardent aucun identifiant", async () => {
  resetBursts();
  assert.equal(civilDate(new Date("2026-11-17T04:30:00.000Z")), "2026-11-16");
  assert.equal(civilDate(new Date("2026-11-17T05:30:00.000Z")), "2026-11-17");

  const store = await opened(["audience", "export"]);
  const config = configFor({ audience: true, export: true });
  const admin = deps(store);
  try {
    const planted = await handleAudience("POST", "/v1/audience/event", config, admin, Buffer.from(JSON.stringify({
      name: "article",
      contexte: "greve",
      ip: "203.0.113.5",
      email: "ada@journal.test",
    })));
    assert.equal(planted.status, 400);
    assert.match(planted.body, /demande refusée/);
    assert.deepEqual(await store.list("audience"), []);

    for (const contexte of ["203.0.113.5", "ada@journal.test", "A".repeat(25)]) {
      const refused = await recordEvent(store, NOW, "article", contexte).then(() => "ok", (error: Error) => error.message);
      assert.equal(refused, "demande refusée");
    }
    const upper = await recordEvent(store, NOW, "Article", "greve").then(() => "ok", (error: Error) => error.message);
    assert.equal(upper, "demande refusée");
    const unknown = await handleAudience("POST", "/v1/audience/event", config, admin, Buffer.from(JSON.stringify({
      name: "lecteur",
      contexte: "greve",
    })));
    assert.equal(unknown.status, 400);
    assert.match(unknown.body, /nom refusé/);
    assert.deepEqual(await store.list("audience"), []);

    const named = await handleAudience("POST", "/admin/audience/noms", config, admin, Buffer.from(JSON.stringify({ name: "une" })));
    assert.equal(named.status, 204);
    assert.equal(named.body, "");
    assert.equal(await store.get("audience", "allowed:une"), "1");

    const evening = new Date("2026-11-17T04:30:00.000Z");
    await recordEvent(store, evening, "article", "greve");
    assert.equal(await store.get("audience", "day:2026-11-16:article:greve"), "1");

    const first = await handleAudience("POST", "/v1/audience/event", config, admin, Buffer.from(JSON.stringify({
      name: "article",
      contexte: "deux",
    })));
    const second = await handleAudience("POST", "/v1/audience/event", config, admin, Buffer.from(JSON.stringify({
      name: "article",
      contexte: "deux",
    })));
    assert.equal(first.status, 204);
    assert.equal(first.body, "");
    assert.deepEqual(first.headers, {});
    assert.equal(second.status, 204);
    assert.equal(await store.get("audience", "day:2026-11-17:article:deux"), "2");
    await recordEvent(store, NOW, "sport", "accueil");
    assert.equal(await store.get("audience", "day:2026-11-17:sport:accueil"), "1");
    assert.equal(await store.get("audience", "allowed:article"), null);
    assert.equal(await store.get("audience", "allowed:sport"), null);

    await recordEvent(store, NOW, "article", "rafale", 2);
    await recordEvent(store, NOW, "article", "rafale", 2);
    await recordEvent(store, NOW, "article", "rafale", 2);
    assert.equal(await store.get("audience", "day:2026-11-17:article:rafale"), "2");

    await store.put("audience", "day:2026-08-18:article:ancien", "4");
    await store.put("audience", "day:2026-08-19:article:ancien", "2");
    await recordEvent(store, NOW, "article", "ancien");
    assert.equal(await store.get("audience", "day:2026-08-18:article:ancien"), null);
    assert.equal(await store.get("audience", "day:2026-08-19:article:ancien"), "2");
    assert.equal(await store.get("audience", "day:2026-11-17:article:ancien"), "1");
    const week = (await store.list("audience")).find((row) => row.key.startsWith("week:") && row.key.endsWith(":article:ancien"));
    assert.equal(week?.value, "4");
    const dump = JSON.stringify(await store.list("audience"));
    assert.equal(dump.includes("poids"), false);
    assert.equal(dump.includes("weight"), false);
    assert.equal(dump.includes("ip"), false);
    assert.equal(dump.includes("203.0.113.5"), false);

    const zip = unzip(await buildSiteZip(store, NOW));
    const names = [...zip.keys()].join("\n");
    assert.equal(names.includes("audience"), false);
    assert.equal(Buffer.from(await buildSiteZip(store, NOW)).toString("latin1").includes("day:2026-11-17"), false);
  } finally {
    await store.close();
  }
});

test("la route n'existe pas éteinte, les en-têtes ne sont pas gardés, la page est bilingue", async () => {
  const off = await opened([]);
  const offConfig = configFor({});
  const offAdmin = deps(off);
  try {
    const missing = await handleAudience("POST", "/v1/audience/event", offConfig, offAdmin, Buffer.from(JSON.stringify({
      name: "article",
      contexte: "page",
    })));
    assert.equal(missing.status, 404);
    assert.equal(await off.tableReady("audience"), false);
    const homeOff = await handleAdmin("GET", "/admin", offConfig, offAdmin, new Uint8Array());
    assert.equal(String(homeOff.body).includes("/admin/audience"), false);
  } finally {
    await off.close();
  }

  const store = await opened(["audience"]);
  const config = configFor({ audience: true });
  const admin = deps(store);
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const calls: string[] = [];
  const originals = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      calls.push(args.map((part) => String(part)).join(" "));
    };
  }
  const server = createSocleServer(config, admin);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const posted = await fetch(`${base}/v1/audience/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "secret-browser",
        referer: "https://journal.example/secret",
      },
      body: JSON.stringify({ name: "article", contexte: "page" }),
    });
    assert.equal(posted.status, 204);
    assert.equal(await posted.text(), "");
    const headerDump = [...posted.headers.entries()].map(([key, value]) => `${key}:${value}`).join("\n");
    const kept = JSON.stringify(await store.list("audience"));
    const seen = `${calls.join("\n")}\n${headerDump}\n${kept}`;
    assert.equal(seen.includes("203.0.113.5"), false);
    assert.equal(seen.includes("secret-browser"), false);
    assert.equal(seen.includes("journal.example/secret"), false);
    assert.equal(await store.get("audience", "day:2026-11-17:article:page"), "1");
    const pageFr = await fetch(`${base}/admin/audience`);
    assert.equal(pageFr.status, 200);
    assert.match(await pageFr.text(), /Totaux du jour\./);

    const form = await handleAudience("POST", "/admin/audience/noms", config, admin, Buffer.from("name=deux"));
    assert.equal(form.status, 303);
    assert.equal(form.headers.location, "/admin/audience");
    const formEn = await handleAudience("POST", "/admin/audience/noms?lang=en", config, admin, Buffer.from("name=deux-en"));
    assert.equal(formEn.status, 303);
    assert.equal(formEn.headers.location, "/admin/audience?lang=en");
    const extra = await handleAudience("POST", "/admin/audience/noms", config, admin, Buffer.from("name=trois&email=ada@journal.test"));
    assert.equal(extra.status, 400);
    assert.equal(await store.get("audience", "allowed:trois"), null);

    const page = await handleAudience("GET", "/admin/audience?lang=en", config, admin, new Uint8Array());
    const html = String(page.body);
    assert.match(html, /lang="en"/);
    assert.match(html, /@page letter/);
    assert.match(html, /Skip to content/);
    assert.match(html, /Today's totals\./);
    assert.match(html, /article · page · 1/);
    assert.equal(html.includes("Loi 25"), false);
    assert.equal(html.toLowerCase().includes("privacy policy"), false);
    assert.match(html, /<form class="noprint"/);

    const linked = await handleAdmin("GET", "/admin", config, admin, new Uint8Array());
    assert.match(String(linked.body), /href="\/admin\/audience"/);
  } finally {
    methods.forEach((name, index) => {
      console[name] = originals[index]!;
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  }
});

test("allumer un nom est réservé au responsable", async () => {
  const store = await opened(["audience", "auth"]);
  const config = configFor({ audience: true, auth: true });
  const admin = deps(store);
  try {
    await recordEvent(store, NOW, "article", "page");
    await store.put("auth", "member:ada@journal.test", "auteur");
    await store.put("auth", "member:lea@journal.test", "responsable");
    const blocked = await handleAudience("POST", "/admin/audience/noms", config, admin, Buffer.from(JSON.stringify({
      name: "une",
    })), "ada@journal.test");
    assert.equal(blocked.status, 403);
    assert.match(blocked.body, /réservé au responsable/);
    assert.equal((await store.list("audience")).some((row) => row.key.startsWith("allowed:")), false);

    const openedName = await handleAudience("POST", "/admin/audience/noms", config, admin, Buffer.from(JSON.stringify({
      name: "une",
    })), "lea@journal.test");
    assert.equal(openedName.status, 204);
    assert.equal(await store.get("audience", "allowed:une"), "1");

    const hidden = await handleAudience("GET", "/admin/audience?lang=en", config, admin, new Uint8Array(), "ada@journal.test");
    const html = String(hidden.body);
    assert.match(html, /lang="en"/);
    assert.match(html, /Today's totals\./);
    assert.match(html, /article · page · 1/);
    assert.equal(html.includes("<form"), false);
    assert.equal(html.includes("Loi 25"), false);
    assert.equal(html.toLowerCase().includes("privacy policy"), false);
  } finally {
    await store.close();
  }
});
