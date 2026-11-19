import assert from "node:assert/strict";
import test from "node:test";

import { readArticles, saveArticle, type SocleArticle } from "../src/editorial.ts";
import { openSqliteMemory } from "../src/sqlite.ts";

const ISO = "2026-11-18T20:00:00.000Z";

function article(patch: Partial<SocleArticle> = {}): SocleArticle {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "premier",
    publication: "journal",
    title: "Premier",
    excerpt: "Résumé.",
    body: { format: "markdown", raw: "Texte." },
    media: [],
    authors: ["ada"],
    section: "campus",
    categories: [],
    tags: [],
    lang: "fr-CA",
    status: "published",
    publishedAt: ISO,
    updatedAt: ISO,
    canonicalUrl: "https://journal.example/articles/premier/",
    source: { backend: "socle", backendId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fetchedAt: ISO },
    ...patch,
  };
}

test("un seul article à la fois reste mis en avant", async () => {
  const store = openSqliteMemory();
  await store.migrate(["editorial"]);
  await saveArticle(store, article({ featured: true }), ISO);
  await saveArticle(store, article({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    slug: "second",
    title: "Second",
    canonicalUrl: "https://journal.example/articles/second/",
    featured: true,
  }), ISO);
  const articles = await readArticles(store);
  const featured = articles.filter((item) => item.featured);
  assert.equal(featured.length, 1);
  assert.equal(featured[0].slug, "second");
  assert.equal(articles.find((item) => item.slug === "premier")?.featured, undefined);
  await store.close();
});
