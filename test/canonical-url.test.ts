import assert from "node:assert/strict";
import test from "node:test";

import { articlePublicUrl, readArticles, refreshCanonicalUrls } from "../src/editorial.ts";
import { openSqliteMemory } from "../src/sqlite.ts";

test("articlePublicUrl pose /articles/ devant le nom court, sans barre finale double", () => {
  assert.equal(articlePublicUrl("https://vigie.example/journal/", "la-biblio"), "https://vigie.example/journal/articles/la-biblio/");
  assert.equal(articlePublicUrl("https://vigie.example", "la-biblio"), "https://vigie.example/articles/la-biblio/");
});

test("un changement de siteUrl met à jour les canonicalUrl stockées", async () => {
  const store = openSqliteMemory();
  await store.migrate(["editorial"]);
  await store.put("editorial", "article:a1", JSON.stringify({
    id: "a1",
    slug: "premier-article",
    title: "Premier",
    canonicalUrl: "https://vigie.example/journal/articles/premier-article/",
  }));
  const changed = await refreshCanonicalUrls(store, "https://vigie.example/");
  assert.equal(changed, 1);
  const [article] = await readArticles(store);
  assert.equal(article.canonicalUrl, "https://vigie.example/articles/premier-article/");
  assert.equal(await refreshCanonicalUrls(store, "https://vigie.example/"), 0);
  await store.close();
});
