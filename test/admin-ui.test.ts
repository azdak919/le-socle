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
  assert.equal(page.match(/class="socle-brique /g)?.length, 4, "deux briques (clair et sombre) dans la barre latérale et dans celle du haut");
  assert.equal((page.match(/alt="Le Socle"/g) || []).length, 2);
  assert.match(page, /<div class="admin-header-brand" data-state="socle">/);
  assert.doesNotMatch(page, /admin-header-brand"[^>]*aria-hidden="true"/);
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
  assert.match(neuf, /<a class="brand" href="\/admin"><img class="socle-brique[^"]*socle-brique-clair[^"]*" src="data:image\/svg\+xml;base64,[^"]+" alt="Le Socle"/);
  assert.match(neuf, /<strong>Le Socle<\/strong><small>Espace de rédaction<\/small>/);
  assert.match(neuf, /<link rel="icon" type="image\/svg\+xml" sizes="any"/);
  setAdminJournalName("La <Vigie>");
  const vigie = String(adminDocument("fr", "Sauvegarde", "<p>x</p>").body);
  assert.match(vigie, /alt="Le Socle"/);
  assert.match(vigie, /<strong>La &lt;Vigie&gt;<\/strong><small>Espace de rédaction<\/small>/);
  assert.match(vigie, /<title>Sauvegarde — La &lt;Vigie&gt;<\/title>/);
  assert.match(vigie, /Propulsé par <a href="https:\/\/socle\.le-radar\.ca\/">Le Socle<\/a>/);
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

test("les variantes claire et sombre de la brique du Socle sont les mêmes en JS et en PHP", () => {
  const js = readFileSync(join(ROOT, "admin", "marque.js"), "utf8");
  const php = readFileSync(join(ROOT, "php", "src", "lib.php"), "utf8");
  for (const [name, file] of [["SOCLE_ICON_CLAIR_B64", "icone-clair.svg"], ["SOCLE_ICON_SOMBRE_B64", "icone-sombre.svg"]] as const) {
    const value = js.match(new RegExp(`${name} = '([^']+)'`))?.[1];
    assert.ok(value && value.length > 500, name);
    assert.ok(php.includes(`const ${name} = '${value}';`), `${name} identique dans lib.php`);
    const svg = Buffer.from(value, "base64").toString("utf8");
    assert.equal(svg, readFileSync(join(ROOT, "site", "assets", "logo", file), "utf8"));
  }
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
  assert.match(html, /Propulsé par <a href="https:\/\/socle\.le-radar\.ca\/">Le Socle<\/a> 1\.\d/);
  assert.ok(html.includes(`"version":"${SOCLE_VERSION}"`));
  assert.doesNotMatch(html, /admin-brand[\s\S]*Le Kiosque/);
  assert.doesNotMatch(html, /chaque enregistrement est écrit sur le serveur/);
  assert.doesNotMatch(html, /class="local-warning"/);
});

test("bandeau d’information : seulement l’avertissement utile du mode démonstration", () => {
  const serveur = serverPage();
  assert.doesNotMatch(serveur, /local-warning/);
  assert.doesNotMatch(serveur, /chaque enregistrement/);
  const demo = adminPage({
    publicationName: "Le Quorum", lang: "fr-CA", publicBasePath: "/demo", adminBasePath: "/demo/admin",
    assetsBase: "/demo/assets/editorial", seedUrl: "/demo/assets/editorial/seed.json", publicationSlug: "le-quorum", databaseKey: "demo",
  });
  assert.match(demo, /class="local-warning"/);
  assert.match(demo, /Mode démonstration local — données conservées dans ce navigateur\./);
  assert.doesNotMatch(demo, /chaque enregistrement est écrit sur le serveur/);
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
      if (on) assert.match(await response.text(), /Espace de rédaction/);
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
  assert.deepEqual(db.exec("SELECT slug FROM authors ORDER BY slug")[0].values, [["lea"]], "un auteur encore cité dans un article reste");
  db.run(toSqlite("INSERT INTO kiosque_meta(key, value) VALUES ('seeded', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value"), [JSON.stringify({ version: 3 })]);
  assert.equal(JSON.parse(String(db.exec("SELECT value FROM kiosque_meta WHERE key = 'seeded'")[0].values[0][0])).version, 3);
});

test("assistant d'installation : le journal et le compte administrateur en un formulaire", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  for (const field of ["nom", "etablissement", "organisme", "contact", "sections", "couleur", "logo", "radio", "station", "noindex", "fictif", "prenom", "nomfamille", "email", "password", "code"]) {
    assert.match(admin, new RegExp(`name="${field}"`), `champ ${field} de l'assistant`);
  }
  // La fiche passe par la même porte que le fichier du configurateur.
  assert.match(admin, /await applyKiosqueConfig\(JSON\.parse\(raw\)\)/);
  assert.match(admin, /authCall\('POST', 'installation'/);
});

test("assistant : exemples en placeholder, jamais de valeur préremplie, champs obligatoires signalés", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const form = admin.slice(admin.indexOf("function assistantForm("), admin.indexOf("function bindAssistant()"));
  const inputs = form.match(/<input [^>]*>/g) || [];
  for (const input of inputs) {
    if (/type="(checkbox|file|color)"/.test(input)) continue;
    assert.match(input, /placeholder="[^"]+"/, `exemple pâle pour ${input}`);
    assert.doesNotMatch(input, /\svalue=/, `aucune valeur préremplie pour ${input}`);
  }
  for (const example of ["Le Sillage", "Cégep du Val-des-Brumes", "redaction@exemple.ca"]) assert.ok(form.includes(`placeholder="${example}"`), example);
  assert.ok(form.includes('placeholder="Association étudiante du Cégep du Val-des-Brumes"'));
  assert.ok(form.includes('placeholder="Le journal étudiant du Cégep du Val-des-Brumes"'));
  assert.ok(form.includes("Code d’installation (obligatoire)"));
  assert.ok(form.includes('placeholder="ABCD-EFGH"'));
  assert.match(form, /name="prenom"/);
  assert.match(form, /name="nomfamille"/);
  assert.ok(form.includes("donnees/code-installation.txt"));
  assert.match(form, /fileChooser\(/);
  assert.doesNotMatch(form, /<input name="logo" type="file"/);
  assert.match(admin, /button: 'Choisir un fichier'/);
  assert.match(admin, /empty: 'Aucun fichier choisi'/);
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
  assert.match(admin, /mountPhotoPond\(/);
  assert.match(admin, /id="photo-pond"/);
  assert.match(admin, /URL\.createObjectURL\(item\.file\)/);
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
  assert.match(backend, /'un article publié doit être signé': 'Pour publier, cochez au moins un auteur/);
  for (const empty of ["Aucun article pour l’instant", "La banque est vide", "Aucun auteur pour l’instant"]) assert.ok(admin.includes(empty), empty);
  assert.match(admin, /document\.body\.classList\.add\('signed-out'\)/);
  // Pages sans JavaScript : champ de restauration étiqueté en français, confirmation, et plus de page blanche au rechargement.
  assert.match(php, /<span class="choix-fichier-etiquette">Fichier de sauvegarde \(ZIP\)<\/span>/);
  assert.match(php, /<span class="bouton">Choisir un fichier<\/span><input class="choix-fichier-input" type="file" name="archive"/);
  assert.match(php, /data-choix-nom[^>]*>Aucun fichier choisi/);
  assert.match(php, /<span class="bouton">Choose a file<\/span>/);
  assert.match(php, /data-choix-nom[^>]*>No file chosen/);
  const adminPage = readFileSync(join(ROOT, "src/admin.ts"), "utf8");
  assert.match(adminPage, /choix-fichier-bouton/);
  assert.match(adminPage, /Choisir un fichier/);
  assert.match(adminPage, /Aucun fichier choisi/);
  assert.match(adminPage, /Choose a file/);
  assert.match(adminPage, /No file chosen/);
  const restauration = readFileSync(join(ASSETS, "restauration.js"), "utf8");
  assert.match(restauration, /\[data-choix-nom\]/);
  assert.match(restauration, /form\.archive\.addEventListener\("change", montrerFichier\)/);
  assert.match(restauration, /form\.addEventListener\("reset"/);
  assert.match(php, /'\/admin\/mise-a-jour\/paquet\/revenir'\) && \$method === 'GET'\)/);
});

test("Mon profil : mot de passe plus tôt, textes d’aide au même corps, « Propulsé par » contrasté", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const start = admin.indexOf("function profileView()");
  const end = admin.indexOf("function profileStatus(");
  assert.ok(start !== -1 && end > start);
  const profile = admin.slice(start, end);
  assert.match(profile, /panel-profil/);
  assert.match(profile, /<label>Prénom<input name="prenom"/);
  assert.match(profile, /<label>Nom<input name="nom"/);
  assert.match(profile, /Nom d’affichage \(facultatif\)/);
  assert.match(profile, /utilisent le prénom et le nom/);
  assert.ok(profile.indexOf("<label>Prénom") < profile.indexOf("<label>Nom<input"));
  assert.match(profile, /profil-courriel-ligne/);
  assert.match(profile, /<span id="profile-email" class="profil-actuel">/);
  assert.match(profile, /<span id="profile-email-etat" class="profil-courriel-etat" hidden>/);
  assert.match(profile, /<div id="profile-email-attente" class="profil-courriel-attente" hidden>/);
  assert.match(profile, /<div id="profile-email-actions" class="actions" hidden>/);
  assert.match(profile, /<p id="profile-email-aide" class="aide">Un lien de confirmation/);
  assert.match(admin, /function paintEmailStatus\(profile\)/);
  assert.match(admin, /form\.hidden = demandeEnCours/);
  assert.match(admin, /Nouvelle adresse en attente : \$\{profile\.courrielEnAttente\}/);
  assert.doesNotMatch(admin, /— En attente de confirmation/);
  assert.match(admin, /data-courriel-action/);
  assert.match(admin, /Confirmer mon adresse/);
  assert.match(admin, /Renvoyer le lien/);
  assert.match(admin, /Annuler la demande/);
  assert.doesNotMatch(profile, /auth-intro/);
  assert.ok(profile.indexOf("<h3>Mot de passe</h3>") < profile.indexOf("<h3>Courriel</h3>"));
  const css = readFileSync(join(ROOT, "admin/ui/admin.css"), "utf8");
  assert.match(css, /\.admin-sidebar-foot \{[^}]*color: oklch\(0\.32 0\.03 340\);/);
  assert.match(css, /\.auth-card-foot \{[^}]*color: oklch\(0\.32 0\.03 340\);/);
  assert.doesNotMatch(css, /text-foreground\/80/);
  assert.match(css, /html\.dark \.admin-sidebar-foot,\s*html\.dark \.auth-card-foot \{ color: oklch\(0\.93 0\.01 340\); \}/);
  assert.match(css, /\.panel-profil \.profil-courriel-ligne/);
  assert.match(css, /\.panel-profil \.profil-actuel/);
  assert.match(css, /\.panel-profil \.profil-courriel-etat/);
  assert.match(css, /\.panel-profil \.aide/);
  assert.match(css, /#smtp-panel h3/);
  assert.match(css, /#smtp-panel > \.aide/);
});

test("Comptes et rôles : prénom et nom à l’ajout d’un membre", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const start = admin.indexOf("async function fillAccessPanel()");
  const end = admin.indexOf("function bindLogout(");
  assert.ok(start !== -1 && end > start);
  const panel = admin.slice(start, end);
  assert.match(panel, /<label>Prénom<input name="prenom"/);
  assert.match(panel, /<label>Nom<input name="nom"/);
  assert.match(panel, /Nom d’affichage \(facultatif\)/);
  assert.match(panel, /utilisent le prénom et le nom/);
  assert.match(panel, /prenom: \(data\.get\('prenom'\)/);
  assert.ok(panel.indexOf("<label>Prénom") < panel.indexOf("<label>Nom<input"));
});

test("Configuration : réglages SMTP, hébergeur en premier, sans envoi par mail()", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const start = admin.indexOf("function smtpSettingsPanel()");
  const end = admin.indexOf("function smtpStatus(");
  assert.ok(start !== -1 && end > start);
  const panel = admin.slice(start, end);
  assert.match(panel, /<h3>Envoi de courriel<\/h3>/);
  assert.match(panel, /partent par le compte courriel du journal/);
  assert.doesNotMatch(panel, /serveur d’envoi intégré/);
  assert.doesNotMatch(panel, /sans identifiant ni mot de passe/);
  assert.match(panel, /smtp-ports/);
  const order = [
    panel.indexOf("Courriel de mon hébergeur"),
    panel.indexOf("Gmail ou Google Workspace"),
    panel.indexOf("Outlook ou Microsoft 365"),
    panel.indexOf("Serveur universitaire ou personnalisé"),
  ];
  assert.ok(order[0] !== -1 && order[0] < order[1] && order[1] < order[2] && order[2] < order[3]);
  assert.match(panel, /Envoyer un courriel d’essai/);
  assert.match(admin, /Un mot de passe est déjà enregistré/);
  assert.doesNotMatch(admin, /mail\(\)/);
  assert.match(admin, /smtpSettingsPanel\(\)/);
});

test("les liens de réinitialisation et de confirmation de courriel survivent au chargement", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(admin, /function isAuthRoute\(/);
  assert.match(admin, /if \(isAuthRoute\(\)\) return;/);
  assert.match(admin, /raw\.startsWith\('courriel='\)/);
  assert.match(admin, /Connectez-vous pour confirmer votre nouveau courriel/);
});

test("fondation et droits sur les articles ; Configuration et Mise à jour à l'administrateur", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(admin, /<input name="fondation" inputmode="numeric" maxlength="4" pattern="\[0-9\]\{4\}"[^>]*placeholder="1971">/);
  assert.match(admin, /<select name="licence"><option value="">Tous droits réservés \(par défaut\)<\/option><option value="CC BY-NC-ND 4\.0">/);
  assert.match(admin, /fondation: String\(data\.get\('fondation'\) \|\| ''\)\.trim\(\), licence:/);
  assert.match(admin, /publication\.license = pick\(journal\.licence, publication\.license \|\| ''\);/);
  assert.match(admin, /publication\.founded = String\(data\.get\('founded'\) \|\| ''\)\.trim\(\); publication\.license = String\(data\.get\('license'\) \|\| ''\);/);
  assert.match(admin, /\(!admin && link\.dataset\.view === 'settings'\)/);
  assert.match(admin, /\.admin-nav \[data-nav="save"\], \.admin-nav \[data-nav="update"\], \.admin-nav \[data-nav="extensions"\]'\)\.forEach\(\(link\) => \{ link\.hidden = !admin; \}\)/);
  const css = readFileSync(join(ASSETS, "admin.css"), "utf8");
  assert.match(css, /admin-app\{background:linear-gradient\(to right/);
});

test("réseaux sociaux : un champ par réseau, exemple pâle et adresse vérifiée, dans l'assistant et la Configuration", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const block = /const SOCIAL_FIELDS = (\[[\s\S]*?\n\]);/.exec(admin)?.[1];
  assert.ok(block, "liste SOCIAL_FIELDS");
  const fields = new Function(`return ${block}`)() as Array<[string, string, string, string]>;
  assert.deepEqual(fields.map(([id]) => id), ["instagram", "facebook", "tiktok", "linkedin", "threads", "x", "bluesky", "mastodon", "youtube", "email"]);
  for (const [id, , example, pattern] of fields) {
    assert.ok(example, `${id} : exemple pâle`);
    if (!pattern) continue;
    // L'attribut pattern est compilé avec le drapeau v par les navigateurs.
    const re = new RegExp(`^(?:${pattern})$`, "v");
    assert.ok(re.test(example), `${id} : l'exemple passe`);
    assert.equal(re.test("lavigie"), false, `${id} : un simple nom est refusé`);
  }
  const xPattern = fields.find(([id]) => id === "x")?.[3];
  assert.equal(new RegExp(`^(?:${xPattern})$`, "v").test("https://facebook.com/oups"), false, "X refuse une adresse Facebook");
  assert.match(admin, /<details class="field full assistant-social"><summary>Réseaux sociaux \(facultatif\)<\/summary>/);
  assert.match(admin, /reseaux: readSocial\(data\)/);
  assert.match(admin, /<legend>Réseaux sociaux<\/legend>[^]*socialFieldsHtml\(publication\.social \|\| \{\}\)/);
  assert.match(admin, /publication\.social = readSocial\(data\);/);
  assert.match(admin, /field\.closest\('details'\)\?\.setAttribute\('open', ''\);/);
});

test("la barre de l'espace de rédaction ignore un monogramme d'initiales, comme le site public", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const brand = admin.slice(admin.indexOf("function paintBrandIn"), admin.indexOf("function paintBrandIn") + 1200);
  assert.match(brand, /SOCLE_BRIQUE/);
  assert.match(brand, /Espace de rédaction/);
  assert.doesNotMatch(brand, /journal-logo/);
  assert.doesNotMatch(brand, /pub\.logo/);
});

test("liste des articles au téléphone : les boutons passent sous le titre", () => {
  const css = readFileSync(join(ROOT, "admin", "ui", "admin.css"), "utf8");
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.entity-list li \{ @apply flex-col items-stretch gap-2; \}/);
});

test("mât illustré : crédit demandé à l'envoi, cadrage appliqué au fichier, aperçu aux proportions du site", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(admin, /mountPhotoPond\(document\.getElementById\('background-files'\)/);
  assert.match(admin, /Chaque image du mât a besoin d’une description accessible et d’un crédit/);
  assert.match(admin, /index === 0 \? \{ x: Number\(data\.get\('mastheadFocalX'\)\)/);
  assert.match(admin, /form\.elements\.backgroundsEnabled\.checked = true;/);
  const css = readFileSync(join(ROOT, "admin", "ui", "admin.css"), "utf8");
  assert.match(css, /\[data-crop-prefix="masthead"\] \.crop-desktop img \{ aspect-ratio: 27 \/ 4; \}/);
  assert.match(css, /\[data-crop-prefix="masthead"\] \.crop-mobile img \{ aspect-ratio: 3 \/ 2; \}/);
});

test("formulaire d'équipe : genre, lien officiel facultatif et case En cours", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(admin, /<label>Genre<select data-team-sex>/);
  assert.match(admin, /<option value="F"[^>]*>Féminin<\/option>/);
  assert.match(admin, /<option value="M"[^>]*>Masculin<\/option>/);
  assert.match(admin, /<option value="mixte"[^>]*>Mixte<\/option>/);
  assert.match(admin, /<label>Lien officiel des résultats, facultatif<input data-team-official type="url"/);
  assert.match(admin, /<label><input type="checkbox" data-team-live[^>]*> En cours<\/label>/);
  assert.match(admin, /if \(sex\) team\.sex = sex;/);
  assert.match(admin, /if \(officialUrl\) team\.officialUrl = officialUrl;/);
  assert.match(admin, /if \(block\.querySelector\('\[data-team-live\]'\)\?\.checked\) nextGame\.live = true;/);
  assert.match(admin, /function sportsSexValue\(sex\)/);
  assert.match(admin, /\['m', 'h', 'men'/);
});

test("la banque téléverse avec FilePond, réduit la photo et en ôte l'orientation EXIF", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const adapter = readFileSync(join(ASSETS, "filepond-banque.js"), "utf8");
  assert.match(admin, /La banque est vide/);
  assert.doesNotMatch(admin, /autoStockPhoto|stock-photo-match|Suggérer une photo/);
  assert.match(adapter, /createImageBitmap\(file, \{ imageOrientation: 'from-image' \}\)/);
  assert.match(adapter, /LONG_SIDE = 2400/);
  assert.match(adapter, /Cette photo est déjà dans la banque/);
  assert.match(adapter, /labelFileSizeKilobytes: 'ko'/);
  assert.match(adapter, /1,2 Mo|formatFileSizeFr/);
  assert.match(adapter, /imagePreviewHeight: 120/);
  assert.match(admin, /button.disabled = !pond.hasFiles/);
  assert.match(admin, /choose-lead-media.*onclick/s);
  assert.match(admin, /length \? `\$\{mediaFilters\(\)\}/);
});

test("la banque vide cache la recherche, et la navigation mobile passe sur plusieurs lignes", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const css = readFileSync(join("admin", "ui", "admin.css"), "utf8");
  const page = readFileSync(join("admin", "page.js"), "utf8");
  assert.match(admin, /length \? `\$\{mediaFilters\(\)\}<div class="media-grid">/);
  assert.match(css, /photo-add > \.media-quality/);
  assert.match(css, /flex-wrap md:flex-nowrap/);
});

test("localités météo : le champ montre le nom et l’enregistrement garde les coordonnées", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const start = admin.indexOf("function localityName(");
  const end = admin.indexOf("function settings(");
  assert.ok(start >= 0 && end > start, "fonctions de localités");
  const fns = new Function(`${admin.slice(start, end)}\nreturn { localityName, formatWeatherLocalities, parseWeatherLocalities };`)() as {
    formatWeatherLocalities: (value: unknown) => string;
    parseWeatherLocalities: (text: string, previous: unknown) => unknown[];
  };
  const saint = { name: "Saint-Louis-du-Ha! Ha!", latitude: 47.6709, longitude: -68.9797, meteomediaSlug: "saint-louis-du-ha-ha" };
  const quebec = { name: "Québec", latitude: 46.8139, longitude: -71.208, meteomediaSlug: "quebec", envcanUrl: "https://meteo.gc.ca/quebec" };
  assert.equal(fns.formatWeatherLocalities([saint, quebec]), "Saint-Louis-du-Ha! Ha!, Québec");
  assert.equal(fns.formatWeatherLocalities(["Montréal", { name: "  Lévis  " }]), "Montréal, Lévis");
  assert.equal(fns.formatWeatherLocalities(undefined), "");
  assert.equal(String([{ name: "Québec" }]), "[object Object]", "le joint brut des objets reste illisible");
  const round = fns.parseWeatherLocalities("Québec, Saint-Louis-du-Ha! Ha!, Rimouski", [saint, quebec]);
  assert.deepEqual(round[0], quebec);
  assert.deepEqual(round[1], saint);
  assert.equal(round[2], "Rimouski");
  assert.equal(fns.parseWeatherLocalities("a, b, c, d, e", []).length, 4);
  assert.deepEqual(fns.parseWeatherLocalities("Montréal", ["Montréal"]), ["Montréal"]);
  assert.match(admin, /formatWeatherLocalities\(masthead\.weather\?\.localities\)/);
  assert.match(admin, /parseWeatherLocalities\(data\.get\('weatherLocalities'\), publication\.masthead\?\.weather\?\.localities\)/);
  assert.doesNotMatch(admin, /weather\?\.localities \|\| \[\]\)\.join\(/);
});

test("mât illustré : plusieurs photos de la banque, ordre aléatoire, photos du mât protégées", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(admin, /Choisir des photos/);
  assert.match(admin, /multiple: true/);
  assert.match(admin, /name="randomOrder"/);
  assert.match(admin, /randomOrder !== false/);
  assert.match(admin, /Ordre aléatoire/);
  assert.match(admin, /class="masthead-random"/);
  assert.match(admin, /class="masthead-selection"/);
  assert.match(admin, /randomOrder: data.has\('randomOrder'\)/);
  assert.match(admin, /Une photo utilisée dans le mât ne peut pas être retirée de la banque/);
  const paint = admin.slice(admin.indexOf("const paintMastheadSelection"), admin.indexOf("let clearMastheadImages"));
  assert.match(paint, /mediaThumb\(item\)/);
  assert.match(paint, /data-masthead-focus/);
  assert.match(paint, /data-masthead-up/);
  assert.match(paint, /data-masthead-down/);
  assert.match(paint, /data-masthead-remove/);
  assert.doesNotMatch(paint, /src="\$\{esc\(item\.src\)\}"/);
  const ui = readFileSync(join(ROOT, "admin/ui/admin.css"), "utf8");
  assert.match(admin, /class="field full masthead-fieldset"/);
  assert.match(ui, /fieldset\.masthead-fieldset \{\s*display: flex;\s*flex-direction: column;/);
  assert.match(ui, /\.masthead-selection \{/);
  assert.match(ui, /grid-template-areas: "thumb meta" "thumb actions"/);
  const compiled = readFileSync(join(ASSETS, "admin.css"), "utf8");
  assert.match(compiled, /\.masthead-selected\{/);
  const demo = readFileSync(join(ASSETS, "demo-backend.js"), "utf8");
  assert.match(demo, /Cette photo est encore dans le mât illustré/);
  assert.match(demo, /images \|\| \[\]\)\.some\(\(image\) => image\.src === asset\.src\)/);
  const php = readFileSync(join(ROOT, "php/src/media.php"), "utf8");
  assert.match(php, /function socle_media_used_in_masthead/);
  assert.match(php, /foreach \(\(\$publication\['masthead'\]\['backgrounds'\]\['images'\] \?\? \[\]\) as \$image\)/);
});

test("Propulsé par Le Socle mène au site officiel, pas à github.io", () => {
  const site = "https://socle.le-radar.ca/";
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const page = readFileSync(join(ROOT, "admin/page.js"), "utf8");
  const server = readFileSync(join(ROOT, "admin/serveur.html"), "utf8");
  const node = readFileSync(join(ROOT, "src/admin.ts"), "utf8");
  const php = readFileSync(join(ROOT, "php/src/lib.php"), "utf8");
  for (const [name, source] of [["admin.js", admin], ["page.js", page], ["serveur.html", server], ["admin.ts", node], ["lib.php", php]]) {
    assert.ok(source.includes(site), `${name} pointe vers ${site}`);
    assert.ok(!source.includes("azdak919.github.io/le-socle"), `${name} ne garde pas github.io`);
  }
});

test("tableau de bord : un seul « Voir le journal », celui de l’en-tête", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  const page = readFileSync(join(ROOT, "admin/page.js"), "utf8");
  const server = readFileSync(join(ROOT, "admin/serveur.html"), "utf8");
  assert.match(admin, /data-action="new-article">Créer un article<\/button><\/div>/);
  assert.doesNotMatch(admin, /Créer un article<\/button><a class="button"[^>]*>Voir le journal/);
  assert.doesNotMatch(admin, /Voir le journal/);
  assert.match(page, /label-long">Voir le journal ↗<\/span>/);
  assert.match(page, /admin-header-actions/);
  assert.match(server, /label-long">Voir le journal ↗<\/span>/);
});

test("l’horodatage de publication n’utilise pas l’invite native du navigateur", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.doesNotMatch(admin, /datetime-local/);
  assert.doesNotMatch(admin, /type="date"/);
  assert.doesNotMatch(admin, /type="time"/);
  assert.match(admin, /horodatageHtml/);
  assert.match(admin, /AAAA-MM-JJ/);
  assert.match(admin, /aideHeureJournal/);
  const css = readFileSync(join(ROOT, "admin", "ui", "admin.css"), "utf8");
  assert.match(css, /\.horodatage-champs/);
});

test("la page Équipe parle d’auteurs, avec les actifs et les anciens", () => {
  const admin = readFileSync(join(ASSETS, "admin.js"), "utf8");
  assert.match(admin, /<h2>Auteurs<\/h2>/);
  assert.match(admin, /Nouvel auteur/);
  assert.match(admin, /groupe\('Actifs'/);
  assert.match(admin, /groupe\('Anciens'/);
  assert.match(admin, /Passer dans les anciens/);
  assert.match(admin, /Ramener dans les actifs/);
  assert.doesNotMatch(admin, /alumni/i);
  assert.match(admin, /<legend>Auteurs<\/legend>/);
  assert.doesNotMatch(admin, /<legend>Signatures<\/legend>/);
  assert.doesNotMatch(admin, /Nouvelle signature/);
});
