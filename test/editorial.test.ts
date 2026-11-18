import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AdminDeps } from "../src/admin.ts";
import { handleEditorial } from "../src/editorial-http.ts";
import {
  EditorialError,
  createSocleEditorial,
  createSocleSource,
  putBytes,
  saveArticle,
  type SocleArticle,
  type SocleAuthor,
  type SoclePublication,
} from "../src/editorial.ts";
import { buildSiteZip } from "../src/archive.ts";
import { defaultConfig } from "../src/config.ts";
import { openD1Memory } from "../src/d1.ts";
import { KIOSQUE_PIN } from "../src/kiosque-pin.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { unzip } from "../src/zip.ts";

function depsFor(store: SocleStore, backupDir: string): AdminDeps {
  return {
    store,
    now: () => NOW,
    backupDir,
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => undefined,
  };
}

const NOW = new Date("2026-11-17T15:00:00Z");
const ISO = "2026-11-17T15:00:00.000Z";
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const publication: SoclePublication = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "journal",
  name: "Le Journal",
  institution: "Cégep",
  institutionType: "cegep",
  lang: "fr-CA",
  siteUrl: "https://journal.example",
  timeZone: "America/Toronto",
  theme: { accent: "#112233" },
  governance: { owner: "Association", contact: "redaction@journal.example", repo: "exemple/journal" },
};

function author(): SocleAuthor {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "ada",
    name: "Ada",
    email: "ada@journal.example",
    source: { backend: "socle", backendId: "22222222-2222-4222-8222-222222222222", fetchedAt: ISO },
  };
}

function article(patch: Partial<SocleArticle> = {}): SocleArticle {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "greve",
    publication: "journal",
    title: "Grève",
    excerpt: "Le campus.",
    body: { format: "markdown", raw: "Le texte.\n\n![](/media/2026/a.jpg)" },
    lead: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "image",
      src: "/media/2026/a.jpg",
      alt: "Le campus",
      credit: "Ada",
      source: { backend: "socle", backendId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fetchedAt: ISO },
    },
    media: [],
    authors: ["ada"],
    section: "campus",
    categories: [],
    tags: [],
    lang: "fr-CA",
    status: "published",
    publishedAt: ISO,
    updatedAt: ISO,
    canonicalUrl: "https://journal.example/greve",
    source: { backend: "socle", backendId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fetchedAt: ISO },
    ...patch,
  };
}

test("l'adaptateur passe la suite du Kiosque épinglé, hors ligne, sur SQLite et D1", async () => {
  const pinDir = process.env.KIOSQUE_PIN_DIR ?? join(root, "../le-kiosque");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: pinDir, encoding: "utf8" }).trim();
  assert.equal(head, KIOSQUE_PIN);
  const kit = await import(pathToFileURL(join(pinDir, "packages/core/src/testkit.ts")).href) as {
    runConformanceSuite: (factory: () => unknown, config: unknown, options?: unknown) => Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> }>;
    formatConformanceReport: (report: unknown) => string;
  };
  const drivers = [
    ["sqlite", () => openSqliteMemory()],
    ["d1", () => openD1Memory()],
  ] as const;
  for (const [name, open] of drivers) {
    const store = await open();
    await store.migrate(["editorial"]);
    await store.put("editorial", "publication", JSON.stringify(publication));
    await store.put("editorial", "author:22222222-2222-4222-8222-222222222222", JSON.stringify(author()));
    await store.put("editorial", "section:33333333-3333-4333-8333-333333333333", JSON.stringify({
      id: "33333333-3333-4333-8333-333333333333", slug: "campus", name: "Campus",
    }));
    await store.put("editorial", "category:44444444-4444-4444-8444-444444444444", JSON.stringify({
      id: "44444444-4444-4444-8444-444444444444", slug: "une", name: "Une",
    }));
    await store.put("editorial", "tag:55555555-5555-4555-8555-555555555555", JSON.stringify({
      id: "55555555-5555-4555-8555-555555555555", slug: "greve", name: "grève",
    }));
    await saveArticle(store, article(), ISO);
    await saveArticle(store, article({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      slug: "brouillon",
      title: "Brouillon",
      status: "draft",
      authors: [],
      section: undefined,
      publishedAt: undefined,
      lead: undefined,
      body: { format: "markdown", raw: "pas encore" },
      canonicalUrl: "https://journal.example/brouillon",
      source: { backend: "socle", backendId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", fetchedAt: ISO },
    }), ISO);
    await putBytes(store, "/media/2026/a.jpg", Buffer.from("jpeg"));
    try {
      let fetched = false;
      const report = await kit.runConformanceSuite(() => createSocleSource(store), {}, {
        ctx: {
          fetch: async () => {
            fetched = true;
            throw new Error("réseau");
          },
        },
      });
      assert.equal(report.ok, true, `${name}\n${kit.formatConformanceReport(report)}`);
      assert.equal(fetched, false);
      const authors = await createSocleSource(store).fetchAuthors();
      assert.equal("email" in authors[0]!, false);
    } finally {
      await store.close();
    }
  }
});

test("une heure est requise pour programmer, et la file garde les champs de relecture", async () => {
  const store = openSqliteMemory();
  await store.migrate(["editorial"]);
  await store.put("editorial", "publication", JSON.stringify(publication));
  const editorial = createSocleEditorial(store);
  try {
    await assert.rejects(() => saveArticle(store, article({
      status: "scheduled",
      scheduledAt: undefined,
      publishedAt: undefined,
    }), ISO), EditorialError);
    const scheduled = await saveArticle(store, article({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      slug: "demain",
      status: "scheduled",
      scheduledAt: "2026-11-18T12:00:00Z",
      publishedAt: undefined,
      session: "automne",
    }), ISO);
    assert.equal(scheduled.scheduledAt, "2026-11-18T12:00:00Z");
    const review = await editorial.save("article", article({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      slug: "en-relecture",
      title: "En relecture",
      status: "in-review",
      publishedAt: undefined,
      submittedAt: undefined,
      lead: undefined,
      body: { format: "markdown", raw: "à lire" },
    }));
    assert.match((review as SocleArticle).submittedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const events: string[] = [];
    editorial.subscribe((event) => events.push(event.kind));
    await editorial.save("article", {
      ...(review as SocleArticle),
      reviewedAt: ISO,
      reviewedBy: "ada",
    });
    assert.deepEqual(events, ["article"]);
    const backup = await editorial.createBackup();
    assert.equal((backup.articles as SocleArticle[]).some((item) => item.scheduledAt === "2026-11-18T12:00:00Z"), true);
    const pub = await editorial.getSnapshot({ audience: "public" });
    assert.equal(pub.articles.some((item) => item.status === "in-review"), false);
    assert.equal(pub.articles.some((item) => item.status === "scheduled"), false);
    assert.equal(pub.articles.length, 0);
    await editorial.close();
    await assert.rejects(() => editorial.getSnapshot({ audience: "editorial" }), /fermé/);
  } finally {
    await store.close();
  }
});

test("le module éteint n'ouvre pas de route, la page est bilingue et imprimable", async () => {
  const store = openSqliteMemory();
  const config = defaultConfig();
  const dir = mkdtempSync(join(tmpdir(), "socle-ed-"));
  const deps = depsFor(store, dir);
  try {
    const hidden = await handleEditorial("GET", "/v1/editorial/snapshot", config, deps, new Uint8Array());
    assert.equal(hidden.status, 404);
    const quiet = await handleEditorial("GET", "/admin/articles", config, deps, new Uint8Array());
    assert.equal(quiet.status, 404);
    config.modules.editorial = true;
    await store.migrate(["editorial", "export"]);
    await store.put("editorial", "publication", JSON.stringify(publication));
    await store.put("editorial", `author:${author().id}`, JSON.stringify(author()));
    await putBytes(store, "/media/2026/a.jpg", Buffer.from("jpeg"));
    await saveArticle(store, article({ isDemo: true, session: "automne" }), ISO);
    await saveArticle(store, article({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      slug: "vieux",
      title: "Vieux",
      publishedAt: "2020-02-02T15:00:00Z",
      updatedAt: "2020-02-02T15:00:00Z",
      canonicalUrl: "https://journal.example/vieux",
      body: { format: "markdown", raw: "ancien" },
      lead: undefined,
    }), "2020-02-02T15:00:00Z");
    const page = await handleEditorial("GET", "/admin/articles?lang=en", config, deps, new Uint8Array());
    const html = String(page.body);
    assert.match(html, /lang="en"/);
    assert.match(html, /for="titre"|Articles/);
    assert.match(html, /@page letter/);
    assert.match(html, /Skip to content/);
    const refused = await handleEditorial("POST", "/admin/articles", config, deps, Buffer.from(
      "title=Demain&slug=demain&status=scheduled&markdown=texte",
    ));
    assert.equal(refused.status, 400);
    assert.match(String(refused.body), /heure/);
    await handleEditorial("POST", "/admin/articles", config, deps, Buffer.from(
      "title=A%20lire&slug=a-lire&status=in-review&markdown=texte&author=ada&section=campus",
    ));
    const queue = await handleEditorial("GET", "/admin/relecture", config, deps, new Uint8Array());
    assert.match(String(queue.body), /A lire|A lire|A lire/);
    assert.match(String(queue.body), /Soumis le/);
    const snap = await handleEditorial("GET", "/v1/editorial/snapshot", config, deps, new Uint8Array());
    const body = JSON.parse(String(snap.body)) as { articles: SocleArticle[]; authors: Array<Record<string, unknown>> };
    assert.equal(body.articles.some((item) => item.isDemo), false);
    assert.equal(body.authors[0]?.email, undefined);
    const zip = unzip(await buildSiteZip(store, NOW));
    assert.equal(zip.has("content/articles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.md"), true);
    assert.equal(zip.has("content/articles/ffffffff-ffff-4fff-8fff-ffffffffffff.md"), false);
    assert.equal(new TextDecoder().decode(zip.get("media/2026/a.jpg")), "jpeg");
  } finally {
    await store.close();
  }
});
