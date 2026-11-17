import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AdminDeps } from "../src/admin.ts";
import { createSocleEditorial, saveArticle, type SocleArticle } from "../src/editorial.ts";
import { handleMedia } from "../src/media-http.ts";
import { MediaError, readBytes, saveArticleImage, saveLibrary, type ArticleImage, type LibraryAsset } from "../src/media.ts";
import { defaultConfig } from "../src/config.ts";
import { KIOSQUE_PIN } from "../src/kiosque-pin.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NOW = "2026-11-17T15:00:00Z";
const BYTES = Uint8Array.from([1, 2, 3, 255, 0, 9]);

function library(credit = "Ada"): LibraryAsset {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    kind: "image",
    src: "/media/2026/a.jpg",
    remoteSrc: "https://example.com/a.jpg",
    alt: "Le campus",
    credit,
    creditUrl: "https://example.com/ada",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceUrl: "https://example.com/source",
    width: 1200,
    height: 800,
    focalPoint: { x: 50, y: 50 },
    institution: "Cégep",
    campus: "Centre",
    keywords: ["campus"],
    usages: ["article"],
    source: { backend: "socle", backendId: "99999999-9999-4999-8999-999999999999", fetchedAt: NOW },
  };
}

function image(credit?: string): ArticleImage {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    kind: "image",
    src: "/media/2026/b.jpg",
    alt: "La salle",
    credit,
    source: { backend: "socle", backendId: "88888888-8888-4888-8888-888888888888", fetchedAt: NOW },
  };
}

function deps(store: SocleStore): AdminDeps {
  return {
    store,
    now: () => new Date(NOW),
    backupDir: mkdtempSync(join(tmpdir(), "socle-media-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => undefined,
  };
}

test("la banque refuse un média sans crédit, l'article le met en file sans bloquer le miroir", async () => {
  const pinDir = process.env.KIOSQUE_PIN_DIR ?? join(root, "../le-kiosque");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: pinDir, encoding: "utf8" }).trim();
  assert.equal(head, KIOSQUE_PIN);
  const validate = await import(pathToFileURL(join(pinDir, "packages/core/src/validate.ts")).href) as {
    validateSharedMedia: (asset: LibraryAsset) => Array<{ level: string; message: string }>;
    validateMedia: (asset: ArticleImage, path: string) => Array<{ level: string; message: string }>;
  };
  const store = openSqliteMemory();
  const config = defaultConfig();
  await store.migrate(["media", "editorial"]);
  try {
    const valid = library();
    assert.equal(validate.validateSharedMedia(valid).some((issue) => issue.level === "error"), false);
    await saveLibrary(store, valid, BYTES);
    assert.deepEqual([...(await readBytes(store, valid.src))], [...BYTES]);

    const bare = library("");
    assert.equal(validate.validateSharedMedia(bare).some((issue) => issue.level === "error"), true);
    await assert.rejects(() => saveLibrary(store, bare, BYTES), MediaError);

    const lead = image();
    const mediaIssues = validate.validateMedia(lead, "lead");
    assert.equal(mediaIssues.some((issue) => issue.level === "error"), false);
    assert.equal(mediaIssues.some((issue) => issue.level === "warning"), true);
    await saveArticleImage(store, lead, BYTES);
    assert.deepEqual([...(await readBytes(store, lead.src))], [...BYTES]);

    const article: SocleArticle = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      slug: "photo",
      publication: "journal",
      title: "Photo",
      excerpt: "Une salle.",
      body: { format: "markdown", raw: "texte" },
      lead: { ...lead, source: lead.source },
      media: [],
      authors: ["ada"],
      section: "campus",
      categories: [],
      tags: [],
      lang: "fr-CA",
      status: "published",
      publishedAt: NOW,
      updatedAt: NOW,
      canonicalUrl: "https://journal.example/photo",
      source: { backend: "socle", backendId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fetchedAt: NOW },
    };
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
    await saveArticle(store, article, NOW);
    const snap = await createSocleEditorial(store).getSnapshot({ audience: "public" });
    assert.equal(snap.articles.some((item) => item.id === article.id), true);

    config.modules.media = true;
    const page = await handleMedia("GET", "/admin/medias?lang=en", config, deps(store));
    assert.match(page.body, /no credit/i);
    assert.match(page.body, /stays in the mirror/);
    await saveArticleImage(store, image("Ada"), BYTES);
    const quiet = await handleMedia("GET", "/admin/medias", config, deps(store));
    assert.match(quiet.body, /Aucun crédit en attente/);
    config.modules.media = false;
    assert.equal((await handleMedia("GET", "/admin/medias", config, deps(store))).status, 404);
  } finally {
    await store.close();
  }
});
