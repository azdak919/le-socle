import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ADMIN_ASSETS, adminPage, serverPage, SOCLE_VERSION } from "../admin/page.js";
import { serveRedactionPage, SERVER_ASSETS } from "../src/redaction-page.ts";
import { VERSION } from "../src/version.ts";
import { adminDocument, setAdminJournalName } from "../src/admin.ts";
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

test("l'en-tête de la barre peint le journal ou, à défaut, Le Socle", () => {
  const source = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(source, /function paintBrand\(state\)/);
  assert.match(source, /paintBrand\('socle'\)/);
  // Socle neuf : la fiche de départ n'est pas un journal, l'en-tête reste au Socle.
  assert.match(source, /paintBrand\(bundle\.firstRun \? 'socle' : 'journal'\)/);
  assert.match(source, /Espace de rédaction/);
  const page = readFileSync(join(ROOT, "admin", "serveur.html"), "utf8");
  // Logo du Socle (Twemoji, CC BY 4.0) dans la barre latérale et, sur mobile, dans la barre du haut.
  assert.equal(page.match(/<img class="admin-brand-logo" src="data:image\/svg\+xml;base64,/g)?.length, 2);
  assert.match(page, /<div class="admin-header-brand" data-state="socle" aria-hidden="true">/);
  // Icônes d'onglet : 16 et 32 px, puis le SVG clair ou sombre.
  assert.match(page, /<link rel="icon" type="image\/png" sizes="16x16"/);
  assert.match(page, /<link rel="icon" type="image\/png" sizes="32x32"/);
  assert.match(page, /<link rel="icon" type="image\/svg\+xml" sizes="any"/);
});

test("barre du haut : le titre de l'écran, jamais « Rédaction de … » répété", () => {
  const page = readFileSync(join(ROOT, "admin", "serveur.html"), "utf8");
  assert.doesNotMatch(page, /Rédaction de/);
  assert.match(page, /<h1 id="admin-page-title"><\/h1>/);
  const source = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(source, /function paintTitle\(\)/);
  assert.match(source, /main\.innerHTML = \(\{ dashboard,[^\n]+\n  paintTitle\(\);/);
  // Le titre vient du menu : un seul libellé par écran, et pas de h2 qui le répète.
  for (const repeated of ["<h2>Tableau de bord</h2>", "<h2>Articles</h2>", "<h2>Photos</h2>", "<h2>Sections et catégories</h2>", "<h2>Configuration du journal</h2>", "<h2>Exporter mon journal</h2>", "Équipe : comptes et rôles"]) {
    assert.ok(!source.includes(repeated), `${repeated} répète le titre de la barre`);
  }
});

test("pages Sauvegarde et Mise à jour : le journal s'il est configuré, sinon le logo du Socle", () => {
  setAdminJournalName("");
  const neuf = String(adminDocument("fr", "Sauvegarde", "<p>x</p>").body);
  assert.match(neuf, /<a class="brand" href="\/admin"><img class="logo" src="data:image\/svg\+xml;base64,[^"]+" alt="" width="32" height="32"><span><strong>Le Socle<\/strong><small>Espace de rédaction<\/small>/);
  assert.match(neuf, /<link rel="icon" type="image\/svg\+xml" sizes="any"/);
  setAdminJournalName("La <Vigie>");
  const vigie = String(adminDocument("fr", "Sauvegarde", "<p>x</p>").body);
  assert.match(vigie, /<a class="brand" href="\/admin"><span><strong>La &lt;Vigie&gt;<\/strong><small>Espace de rédaction<\/small>/);
  assert.match(vigie, /<title>Sauvegarde — La &lt;Vigie&gt;<\/title>/);
  assert.match(vigie, /Propulsé par <a href="https:\/\/azdak919\.github\.io\/le-socle\/">Le Socle<\/a>/);
  setAdminJournalName("");
});

test("le logo du Socle est le même en Node et en PHP", () => {
  const js = readFileSync(join(ROOT, "admin", "marque.js"), "utf8");
  const php = readFileSync(join(ROOT, "php", "src", "lib.php"), "utf8");
  for (const name of ["SOCLE_ICON_SVG_B64", "SOCLE_FAVICON_16_B64", "SOCLE_FAVICON_32_B64"]) {
    const value = js.match(new RegExp(`${name} = '([^']+)'`))?.[1];
    assert.ok(value && value.length > 500, name);
    assert.ok(php.includes(`const ${name} = '${value}';`), `${name} identique dans lib.php`);
  }
  const svg = Buffer.from(js.match(/SOCLE_ICON_SVG_B64 = '([^']+)'/)![1]!, "base64").toString("utf8");
  assert.match(svg, /prefers-color-scheme:dark/);
  assert.equal(svg, readFileSync(join(ROOT, "site", "assets", "logo", "icone.svg"), "utf8"));
});

test("l'admin vit dans le socle : chaque fichier importé est là, et seulement là", () => {
  const present = readdirSync(ASSETS).sort();
  assert.deepEqual(present, [...ADMIN_ASSETS].sort(), "admin/assets contient exactement la liste");
  for (const file of ADMIN_ASSETS.filter((name: string) => name.endsWith(".js"))) {
    const { fixed, lazy } = imports(file);
    for (const target of [...fixed, ...lazy]) {
      assert.ok(existsSync(join(ASSETS, target)), `${file} importe ${target}, absent`);
    }
    assert.doesNotMatch(readFileSync(join(ASSETS, file), "utf8"), /from '\.\.\//, `${file} ne sort pas de admin/assets`);
  }
});

test("mode serveur : jamais la base de la démo, seulement les fichiers servis", () => {
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
  for (const file of ["demo-backend.js", "sqljs-db.js", "sql-wasm.js", "sql-wasm.wasm"]) assert.ok(!SERVER_ASSETS.has(file), `${file} reste à la démo`);
  assert.doesNotMatch(readFileSync(join(ASSETS, "runtime.js"), "utf8"), /^import .*demo-backend/m, "la démo ne se charge qu'à la demande");
});

test("admin/serveur.html est à jour (npm run ui)", () => {
  assert.equal(readFileSync(join(ROOT, "admin", "serveur.html"), "utf8"), serverPage());
  const html = serverPage();
  assert.match(html, /"mode":"socle"/);
  assert.match(html, /src="\/redaction\/assets\/admin\.js"/);
  assert.match(html, /href="\/admin\/mise-a-jour"/);
  assert.doesNotMatch(html, /pglite|sql-wasm|seedUrl/);
  assert.match(html, /data-state="socle"/);
  assert.match(html, /<strong>Le Socle<\/strong><small>Espace de rédaction<\/small>/);
  assert.match(html, /Propulsé par <a href="https:\/\/azdak919\.github\.io\/le-socle\/">Le Socle<\/a> 1\.\d/);
  assert.ok(html.includes(`"version":"${SOCLE_VERSION}"`));
  assert.doesNotMatch(html, /admin-brand[\s\S]*Le Kiosque/);
});

test("la version affichée dans la barre suit le paquet", () => {
  assert.equal(SOCLE_VERSION, VERSION);
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
  assert.equal(serveRedactionPage("/admin/sauvegarde", "GET"), null);
  assert.equal(serveRedactionPage("/redaction", "GET")?.status, 301);
  assert.equal(serveRedactionPage("/redaction/", "GET")?.headers?.location, undefined);
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
  const state = { format: "socle-redaction", version: 1, publication: null, articles: [], authors: [], taxonomies: { sections: [], categories: [], tags: [] }, media: [], role: "administrateur", modules: { media: false } };
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

test("la démo en mode navigateur tourne sur sql.js copié tel quel, sans PGlite", async () => {
  const dist = join(ROOT, "node_modules", "sql.js", "dist");
  if (existsSync(dist)) {
    assert.deepEqual(readFileSync(join(ASSETS, "sql-wasm.js")), readFileSync(join(dist, "sql-wasm-browser.js")), "npm run ui");
    assert.deepEqual(readFileSync(join(ASSETS, "sql-wasm.wasm")), readFileSync(join(dist, "sql-wasm-browser.wasm")), "npm run ui");
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(!JSON.stringify(pkg).includes("pglite"), "PGlite est retiré");
  const demo = readFileSync(join(ASSETS, "demo-backend.js"), "utf8");
  assert.match(demo, /from '\.\/sqljs-db\.js'/);
  assert.doesNotMatch(demo, /pglite|::jsonb|->>/i);
  // Le dialecte de la démo passe dans SQLite : on rejoue le schéma et les requêtes délicates.
  const { toSqlite } = await import("../admin/assets/sqljs-db.js");
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const schema = /#migrate\(\) \{\s*await this\.db\.exec\(`([\s\S]*?)`\);/.exec(demo)?.[1] ?? "";
  db.exec(toSqlite(schema));
  db.run(toSqlite("INSERT INTO authors(id, slug, is_demo, is_user_modified, data) VALUES ($1,$2,true,false,$3::jsonb)"), ["a1", "lea", JSON.stringify({ slug: "lea" })]);
  db.run(toSqlite("INSERT INTO authors(id, slug, is_demo, is_user_modified, data) VALUES ($1,$2,true,false,$3::jsonb)"), ["a2", "max", JSON.stringify({ slug: "max" })]);
  db.run(toSqlite("INSERT INTO articles(id,slug,status,is_demo,is_user_modified,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7)"), ["r1", "un", "published", 0, 1, "2026-11-18", JSON.stringify({ authors: ["lea"] })]);
  const removeDemo = /await tx\.exec\(`(DELETE FROM authors[\s\S]*?)`\);/.exec(demo)?.[1] ?? "";
  db.exec(toSqlite(removeDemo));
  assert.deepEqual(db.exec("SELECT slug FROM authors ORDER BY slug")[0].values, [["lea"]], "une signature encore utilisée reste");
  db.run(toSqlite("INSERT INTO kiosque_meta(key, value) VALUES ('seeded', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value"), [JSON.stringify({ version: 3 })]);
  assert.equal(JSON.parse(String(db.exec("SELECT value FROM kiosque_meta WHERE key = 'seeded'")[0].values[0][0])).version, 3);
});

test("assistant d'installation : le journal et le compte administrateur en un formulaire", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  for (const field of ["nom", "etablissement", "organisme", "contact", "sections", "couleur", "logo", "radio", "station", "noindex", "fictif", "email", "password"]) {
    assert.match(admin, new RegExp(`name="${field}"`), `champ ${field} de l'assistant`);
  }
  // La fiche passe par la même porte que le fichier du configurateur.
  assert.match(admin, /await applyKiosqueConfig\(JSON\.parse\(raw\)\)/);
  assert.match(admin, /authCall\('POST', 'installation'/);
});

test("assistant : exemples en placeholder, jamais de valeur préremplie, champs obligatoires signalés", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const form = admin.slice(admin.indexOf("function assistantForm()"), admin.indexOf("function bindAssistant()"));
  const inputs = form.match(/<input [^>]*>/g) || [];
  for (const input of inputs) {
    if (/type="(checkbox|file|color)"/.test(input)) continue;
    assert.match(input, /placeholder="[^"]+"/, `exemple pâle pour ${input}`);
    assert.doesNotMatch(input, /\svalue=/, `aucune valeur préremplie pour ${input}`);
  }
  for (const example of ["La Vigie", "Cégep de Sainte-Foy", "redaction@exemple.ca"]) assert.ok(form.includes(`placeholder="${example}"`), example);
  assert.match(form, /novalidate/);
  assert.match(admin, /if \(!flagInvalidFields\(form\)\) return;/);
  assert.match(admin, /'Ce champ est obligatoire\.'/);
});

test("aperçu du mât avant d'enregistrer : ordinateur et mobile, clair et sombre", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const css = readFileSync(join(ASSETS, "admin.css"), "utf8");
  const preview = admin.slice(admin.indexOf("function mastPreview("), admin.indexOf("const LOGO_TYPES"));
  for (const frame of ["frame('desktop', 'light'", "frame('desktop', 'dark'", "frame('mobile', 'light'", "frame('mobile', 'dark'"]) assert.ok(preview.includes(frame), frame);
  // Assistant, réglages et banque de photos montrent l'image choisie avant tout envoi.
  assert.match(admin, /<div data-mast-preview/);
  assert.match(admin, /bindMastPreview\(document\.getElementById\('logo-preview'\)/);
  assert.match(admin, /id="photo-file-preview"/);
  assert.match(admin, /URL\.createObjectURL\(chosen\)/);
  assert.match(css, /\.mast-preview/);
  assert.match(css, /\.field-error/);
});

test("rédaction pour néophytes : mots simples, états vides, erreurs lisibles", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const backend = readFileSync(join(ASSETS, "socle-backend.js"), "utf8");
  const php = readFileSync(join(import.meta.dirname, "../php/src/admin.php"), "utf8");
  // Pas de « socle » dans les messages montrés à la rédaction.
  assert.doesNotMatch(admin, /'Le socle ne répond pas\.'|Le socle a refusé|Ce socle a déjà/);
  assert.doesNotMatch(backend, /Le socle a refusé|Connectez-vous au socle/);
  assert.match(backend, /'un article publié doit être signé': 'Pour publier, cochez au moins une signature/);
  for (const empty of ["Aucun article pour l’instant", "La banque est vide", "Aucune signature pour l’instant"]) assert.ok(admin.includes(empty), empty);
  assert.match(admin, /document\.body\.classList\.add\('signed-out'\)/);
  // Pages sans JavaScript : champ de restauration étiqueté, confirmation, et plus de page blanche au rechargement.
  assert.match(php, /<label>Fichier de sauvegarde \(ZIP\) <input type="file"/);
  assert.match(php, /'\/admin\/mise-a-jour\/paquet\/revenir'\) && \$method === 'GET'\)/);
});

test("fondation et droits sur les articles ; Configuration et Mise à jour à l'administrateur", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(admin, /<input name="fondation" inputmode="numeric" maxlength="4" pattern="\[0-9\]\{4\}"[^>]*placeholder="1971">/);
  assert.match(admin, /<select name="licence"><option value="">Tous droits réservés \(par défaut\)<\/option><option value="CC BY-NC-ND 4\.0">/);
  assert.match(admin, /fondation: String\(data\.get\('fondation'\) \|\| ''\)\.trim\(\), licence:/);
  assert.match(admin, /publication\.license = pick\(journal\.licence, publication\.license \|\| ''\);/);
  assert.match(admin, /publication\.founded = String\(data\.get\('founded'\) \|\| ''\)\.trim\(\); publication\.license = String\(data\.get\('license'\) \|\| ''\);/);
  assert.match(admin, /\(!admin && link\.dataset\.view === 'settings'\)/);
  assert.match(admin, /\.admin-nav \[data-nav="save"\], \.admin-nav \[data-nav="update"\]'\)\.forEach\(\(link\) => \{ link\.hidden = !admin; \}\)/);
  const css = readFileSync(join(ASSETS, "admin.css"), "utf8");
  assert.match(css, /admin-app\{background:linear-gradient\(to right/);
});

test("réseaux sociaux : un champ par réseau, exemple pâle et adresse vérifiée, dans l'assistant et la Configuration", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const block = /const SOCIAL_FIELDS = (\[[\s\S]*?\n\]);/.exec(admin)?.[1];
  assert.ok(block, "liste SOCIAL_FIELDS");
  const fields = new Function(`return ${block}`)() as Array<[string, string, string, string]>;
  assert.deepEqual(fields.map(([id]) => id), ["facebook", "instagram", "x", "bluesky", "mastodon", "tiktok", "youtube", "linkedin", "threads", "email"]);
  for (const [id, , example, pattern] of fields) {
    assert.ok(example, `${id} : exemple pâle`);
    if (!pattern) continue;
    // L'attribut pattern est compilé avec le drapeau v par les navigateurs.
    const re = new RegExp(`^(?:${pattern})$`, "v");
    assert.ok(re.test(example), `${id} : l'exemple passe`);
    assert.equal(re.test("lavigie"), false, `${id} : un simple nom est refusé`);
  }
  assert.equal(new RegExp(`^(?:${fields[2][3]})$`, "v").test("https://facebook.com/oups"), false, "X refuse une adresse Facebook");
  assert.match(admin, /<details class="field full assistant-social"><summary>Réseaux sociaux \(facultatif\)<\/summary>/);
  assert.match(admin, /reseaux: readSocial\(data\)/);
  assert.match(admin, /<legend>Réseaux sociaux<\/legend>[^]*socialFieldsHtml\(publication\.social \|\| \{\}\)/);
  assert.match(admin, /publication\.social = readSocial\(data\);/);
  assert.match(admin, /field\.closest\('details'\)\?\.setAttribute\('open', ''\);/);
});

test("la barre de l'espace de rédaction ignore un monogramme d'initiales, comme le site public", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const brand = admin.slice(admin.indexOf("function paintBrandIn"), admin.indexOf("function paintBrandIn") + 1200);
  assert.match(brand, /!isGeneratedInitialsLogoSrc\(pub\.logo\.src\)/);
});
