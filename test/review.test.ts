import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdminDeps } from "../src/admin.ts";
import { buildSessionZip, buildSiteZip, restoreZip } from "../src/archive.ts";
import { handleAuth } from "../src/auth-http.ts";
import { defaultConfig } from "../src/config.ts";
import { createSocleEditorial, publishDue, saveArticle, type SocleArticle } from "../src/editorial.ts";
import { handleEditorial } from "../src/editorial-http.ts";
import { handleReview } from "../src/review-http.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { unzip } from "../src/zip.ts";

const NOW = new Date("2026-11-17T15:00:00.000Z");
const ISO = "2026-11-17T15:00:00.000Z";

function article(patch: Partial<SocleArticle> = {}): SocleArticle {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "greve",
    publication: "journal",
    title: "Grève",
    excerpt: "Le campus.",
    body: { format: "markdown", raw: "Le texte tenu." },
    media: [],
    authors: ["ada"],
    section: "campus",
    categories: [],
    tags: [],
    lang: "fr-CA",
    status: "in-review",
    updatedAt: ISO,
    submittedAt: ISO,
    canonicalUrl: "https://journal.example/greve",
    source: { backend: "socle", backendId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fetchedAt: ISO },
    ...patch,
  };
}

function deps(store: SocleStore, patch: Partial<AdminDeps> = {}): AdminDeps {
  return {
    store,
    now: () => NOW,
    backupDir: mkdtempSync(join(tmpdir(), "socle-review-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => undefined,
    ...patch,
  };
}

async function opened(modules: Array<"editorial" | "review" | "export" | "auth">) {
  const store = openSqliteMemory();
  await store.migrate(modules);
  return store;
}

test("l'heure passée publie, l'heure future non, et le module éteint ne le fait pas", async () => {
  const store = await opened(["editorial", "review"]);
  const config = defaultConfig();
  config.modules.editorial = true;
  config.modules.review = true;
  await store.put("editorial", "publication", JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "journal",
    name: "Le Journal",
    institution: "Cégep",
    institutionType: "cegep",
    lang: "fr-CA",
    siteUrl: "https://journal.example",
    timeZone: "America/Toronto",
    theme: { accent: "#112233" },
    governance: { owner: "Association", contact: "redaction@journal.example" },
  }));
  await saveArticle(store, article({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    slug: "passe",
    title: "Passé",
    status: "scheduled",
    scheduledAt: "2000-01-01T00:00:00.000Z",
    canonicalUrl: "https://journal.example/passe",
    source: { backend: "socle", backendId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", fetchedAt: ISO },
  }), ISO);
  await saveArticle(store, article({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    slug: "futur",
    title: "Futur",
    status: "scheduled",
    scheduledAt: "2099-01-01T00:00:00.000Z",
    canonicalUrl: "https://journal.example/futur",
    source: { backend: "socle", backendId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", fetchedAt: ISO },
  }), ISO);
  try {
    const editorial = createSocleEditorial(store);
    const pub = await editorial.getSnapshot({ audience: "public" });
    assert.equal(pub.articles.some((item) => item.slug === "passe"), true);
    assert.equal(pub.articles.some((item) => item.slug === "futur"), false);
    const past = pub.articles.find((item) => item.slug === "passe");
    assert.equal(past?.status, "published");
    assert.equal(past?.publishedAt, "2000-01-01T00:00:00.000Z");
    assert.equal(await publishDue(store, new Date()), 0);

    const off = await opened(["editorial"]);
    await saveArticle(off, article({
      status: "scheduled",
      scheduledAt: "2000-01-01T00:00:00.000Z",
    }), ISO);
    assert.equal(await publishDue(off, NOW), 0);
    assert.equal((JSON.parse((await off.get("editorial", "article:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!)).status, "scheduled");
    const hidden = defaultConfig();
    hidden.modules.editorial = true;
    const still = await handleEditorial("GET", "/admin/relecture", hidden, deps(off), new Uint8Array());
    assert.equal(still.status, 200);
    const missing = await handleReview("POST", "/v1/review/echeance", hidden, deps(off), new Uint8Array());
    assert.equal(missing.status, 404);
    await off.close();
  } finally {
    await store.close();
  }
});

test("la décision, la correction et le rôle restent dans la rédaction", async () => {
  const store = await opened(["editorial", "review", "export", "auth"]);
  const config = defaultConfig();
  config.modules.editorial = true;
  config.modules.review = true;
  config.modules.export = true;
  config.modules.auth = true;
  await saveArticle(store, article(), ISO);
  await store.put("auth", "member:ada@journal.test", "reviseur");
  await store.put("auth", "member:ben@journal.test", "auteur");
  const admin = deps(store, {
    auth: {
      mode: "magic",
      publicOrigin: "http://127.0.0.1:8787",
      mailer: async (_to, _subject, text) => {
        sent.push(text);
      },
    },
  });
  const sent: string[] = [];
  try {
    const early = await handleReview("POST", "/admin/relecture", config, admin, Buffer.from(
      "id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&decision=programmer&reviewer=ada",
    ), "ada@journal.test");
    assert.equal(early.status, 400);
    assert.match(early.body, /heure/);

    const blocked = await handleReview("POST", "/admin/relecture", config, admin, Buffer.from(
      "id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&decision=publier&reviewer=ben",
    ), "ben@journal.test");
    assert.equal(blocked.status, 403);
    assert.equal((JSON.parse((await store.get("editorial", "article:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!)).status, "in-review");

    const programmed = await handleReview("POST", "/admin/relecture", config, admin, Buffer.from(
      "id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&decision=programmer&reviewer=ada&heure=2099-01-01T00:00:00.000Z",
    ), "ada@journal.test");
    assert.equal(programmed.status, 303);
    const waiting = JSON.parse((await store.get("editorial", "article:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!);
    assert.equal(waiting.status, "scheduled");
    assert.equal(waiting.reviewedBy, "ada");

    const extra = await handleReview("POST", "/admin/relecture/correction", config, admin, Buffer.from(JSON.stringify({
      articleId: waiting.id,
      text: "Proposition secrète de relecture",
      url: "https://journal.example/greve",
      email: "ada@journal.test",
    })), "ada@journal.test");
    assert.equal(extra.status, 400);
    assert.deepEqual(await store.list("review"), []);

    const added = await handleReview("POST", "/admin/relecture/correction", config, admin, Buffer.from(JSON.stringify({
      articleId: waiting.id,
      text: "Proposition secrète de relecture",
      url: "javascript:alert(1)",
    })), "ada@journal.test");
    assert.equal(added.status, 400);

    const saved = await handleReview("POST", "/admin/relecture/correction", config, admin, Buffer.from(JSON.stringify({
      articleId: waiting.id,
      text: "Proposition secrète de relecture",
      url: "https://journal.example/greve",
    })), "ada@journal.test");
    assert.equal(saved.status, 204);
    const correction = (await store.list("review")).find((row) => row.key.startsWith("correction:"));
    assert.ok(correction);
    const correctionId = correction.key.slice("correction:".length);
    const closed = await handleReview("POST", "/admin/relecture/correction/decision", config, admin, Buffer.from(JSON.stringify({
      id: correctionId,
      state: "acceptee",
    })), "ada@journal.test");
    assert.equal(closed.status, 204);
    const markdown = JSON.parse((await store.get("editorial", "article:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!).body.raw;
    assert.equal(markdown, "Le texte tenu.");

    const page = await handleReview("GET", "/admin/relecture?lang=en", config, admin, new Uint8Array(), "ben@journal.test");
    const html = String(page.body);
    assert.match(html, /lang="en"/);
    assert.match(html, /@page letter/);
    assert.match(html, /Skip to content/);
    assert.equal(html.includes("<form"), false);
    assert.match(html, /Proposition secrète de relecture/);
    assert.match(html, /Accepted/);

    const zip = await buildSiteZip(store, NOW);
    const files = unzip(zip);
    const index = new TextDecoder().decode(files.get("index.html")!);
    assert.equal(index.includes("Proposition secrète de relecture"), false);
    const restoredNotes = JSON.parse(new TextDecoder().decode(files.get("review/corrections.json")!)) as Array<{ state: string }>;
    assert.equal(restoredNotes[0]?.state, "acceptee");
    assert.equal(Buffer.from(await buildSessionZip(store, "automne")).toString("latin1").includes("review/corrections.json"), false);
    const copy = await opened(["editorial", "review", "export"]);
    await restoreZip(copy, zip);
    assert.equal((await copy.list("review")).some((row) => row.key.startsWith("correction:")), true);
    await copy.close();

    const server = createSocleServer(config, admin);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const anon = await fetch(`${base}/admin/relecture`, {
        method: "POST",
        body: "id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&decision=publier&reviewer=ada",
      });
      assert.equal(anon.status, 401, "sans session : connexion requise");
      await handleAuth("POST", "/v1/auth/lien", config, admin, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
      const token = (sent.at(-1) ?? "").match(/token=([^\s]+)/)?.[1] ?? "";
      const login = await fetch(`${base}/v1/auth/lien?token=${encodeURIComponent(token)}`, { redirect: "manual" });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const done = await fetch(`${base}/admin/relecture`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie },
        body: "id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&decision=publier&reviewer=ada",
      });
      assert.equal(done.status, 303);
      assert.equal((JSON.parse((await store.get("editorial", "article:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!)).status, "published");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await store.close();
  }
});
