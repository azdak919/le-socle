import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ADMIN_ASSETS, adminPage, serverPage } from "../admin/page.js";
import { serveRedactionPage, SERVER_ASSETS } from "../src/redaction-page.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import { config, deps } from "./redaction-parcours.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "admin", "assets");

function imports(file: string): { fixed: string[]; lazy: string[] } {
  const source = readFileSync(join(ASSETS, file), "utf8");
  const fixed = [...source.matchAll(/^import\s[^;]*?from\s+'(\.\/[^']+)'/gm)].map((m) => m[1].slice(2));
  const lazy = [...source.matchAll(/import\('(\.\/[^']+)'\)/g)].map((m) => m[1].slice(2));
  return { fixed, lazy };
}

test("l'admin vit dans le socle : chaque fichier importé est là, et seulement là", () => {
  const present = readdirSync(ASSETS).sort();
  assert.deepEqual(present, [...ADMIN_ASSETS].sort(), "admin/assets contient exactement la liste");
  for (const file of ADMIN_ASSETS.filter((name: string) => name.endsWith(".js"))) {
    const { fixed, lazy } = imports(file);
    // PGlite (`pglite/`) est ajouté par la construction de la démo, jamais servi par le socle.
    for (const target of [...fixed, ...lazy].filter((name) => !name.startsWith("pglite/"))) {
      assert.ok(existsSync(join(ASSETS, target)), `${file} importe ${target}, absent`);
    }
    assert.doesNotMatch(readFileSync(join(ASSETS, file), "utf8"), /from '\.\.\//, `${file} ne sort pas de admin/assets`);
  }
});

test("mode serveur : jamais PGlite, seulement les fichiers servis", () => {
  // Graphe des imports fixes depuis admin.js, plus le client du socle.
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const target of imports(file).fixed) walk(target);
  };
  walk("admin.js");
  walk("socle-backend.js");
  for (const file of seen) assert.ok(SERVER_ASSETS.has(file), `${file} doit être servi en mode serveur`);
  assert.ok(!SERVER_ASSETS.has("demo-backend.js") && !SERVER_ASSETS.has("pglite-worker.js"));
  assert.doesNotMatch(readFileSync(join(ASSETS, "runtime.js"), "utf8"), /^import .*demo-backend/m, "la démo ne se charge qu'à la demande");
});

test("admin/serveur.html est à jour (npm run ui)", () => {
  assert.equal(readFileSync(join(ROOT, "admin", "serveur.html"), "utf8"), serverPage());
  const html = serverPage();
  assert.match(html, /"mode":"socle"/);
  assert.match(html, /src="\/redaction\/assets\/admin\.js"/);
  assert.match(html, /href="\/admin\/mise-a-jour"/);
  assert.doesNotMatch(html, /pglite|seedUrl/);
});

test("mode navigateur : la même page, pour la démo", () => {
  const html = adminPage({
    publicationName: "Le <Quorum>", lang: "fr-CA", publicBasePath: "/demo", adminBasePath: "/demo/admin",
    assetsBase: "/demo/assets/editorial", seedUrl: "/demo/assets/editorial/seed.json", publicationSlug: "le-quorum", databaseKey: "k</script>",
  });
  assert.match(html, /"mode":"demo-local"/);
  assert.match(html, /Le &lt;Quorum&gt;/);
  assert.ok(!html.includes("k</script>"), "le manifeste ne ferme pas la balise");
  assert.match(html, /href="\/demo\/admin\/mise-a-jour\/"/);
});

test("/redaction/ : page, fichiers, refus", () => {
  assert.equal(serveRedactionPage("/ailleurs", "GET"), null);
  assert.equal(serveRedactionPage("/redaction", "GET")?.status, 301);
  assert.equal(serveRedactionPage("/redaction/", "POST")?.status, 405);
  assert.equal(serveRedactionPage("/redaction/assets/demo-backend.js", "GET")?.status, 404);
  assert.equal(serveRedactionPage("/redaction/assets/../page.js", "GET")?.status, 404);
  assert.equal(serveRedactionPage("/redaction/autre", "GET")?.status, 404);
  const css = serveRedactionPage("/redaction/assets/admin.css", "GET");
  assert.equal(css?.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(css?.headers["x-content-type-options"], "nosniff");
});

test("le serveur ne sert l'admin que si editorial est allumé", async () => {
  const store = openSqliteMemory();
  await store.migrate(["editorial"]);
  for (const [on, expected] of [[true, 200], [false, 404]] as const) {
    const server = createSocleServer(config(on ? { editorial: true } : {}), deps(store));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/redaction/`);
      assert.equal(response.status, expected);
      if (on) assert.match(await response.text(), /Rédaction/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  await store.close();
});

test("client du socle : un socle neuf ouvre l'admin avec une fiche de départ, rien n'est écrit avant", async () => {
  const { SocleBackend } = await import("../admin/assets/socle-backend.js");
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const state = { format: "socle-redaction", version: 1, publication: null, articles: [], authors: [], taxonomies: { sections: [], categories: [], tags: [] }, media: [], role: "responsable", modules: { media: false } };
  const fetch = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body });
    return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
  };
  const backend = new SocleBackend();
  await backend.init({ apiBase: "", fetch });
  const snapshot = await backend.getSnapshot();
  assert.equal(snapshot.publication.name, "Mon journal");
  assert.ok(calls.every((call) => call.method === "GET"), "aucune écriture au démarrage");
  assert.ok(calls.every((call) => call.url === "/v1/redaction/etat"));
});
