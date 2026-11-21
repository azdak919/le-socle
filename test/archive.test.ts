import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleAdmin, programBackupName, type AdminDeps } from "../src/admin.ts";
import { archiveSummary, buildSessionZip, buildSiteZip, readPrefs, restoreZip, writePrefs } from "../src/archive.ts";
import { defaultConfig } from "../src/config.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import type { SocleStore } from "../src/store.ts";
import { textFile, unzip, zipStore } from "../src/zip.ts";

const NOW = new Date("2026-11-17T15:00:00Z");

function adminDeps(store: SocleStore, patch: Partial<AdminDeps> = {}): AdminDeps {
  return {
    store,
    now: () => NOW,
    backupDir: mkdtempSync(join(tmpdir(), "socle-bak-")),
    release: () => null,
    version: () => "0.0.0",
    setVersion: async () => undefined,
    ...patch,
  };
}

async function seeded() {
  const store = openSqliteMemory();
  const config = defaultConfig();
  config.modules.export = true;
  await store.migrate(["export"]);
  await store.put("export", "article:neuf", JSON.stringify({
    id: "neuf", title: "Neuf", year: 2026, session: "automne", status: "published", markdown: "texte neuf\n\n![](media/2026/a.jpg)",
  }));
  await store.put("export", "article:vieux", JSON.stringify({
    id: "vieux", title: "Vieux", year: 2020, session: "hiver", status: "published", markdown: "texte vieux",
  }));
  await store.put("export", "article:brouillon", JSON.stringify({
    id: "brouillon", title: "Brouillon", year: 2026, session: "automne", status: "draft", markdown: "pas encore",
  }));
  await store.put("export", "file:kiosque.config.ts", "name: Journal\ntoken: super-secret\n");
  await store.put("export", "media:media/2026/a.jpg", Buffer.from("jpeg").toString("base64"));
  await store.put("export", "credit:media/2026/a.jpg", "Photo : Ada");
  return { store, config };
}

test("l'archive du site garde l'année courante et la précédente", async () => {
  const { store } = await seeded();
  try {
    const prefs = await readPrefs(store, NOW);
    assert.deepEqual(prefs.years, [2026, 2025]);
    const files = unzip(await buildSiteZip(store, NOW));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")!));
    assert.deepEqual(manifest.excludedYears, [2020]);
    assert.equal(files.has("content/articles/neuf.md"), true);
    assert.equal(files.has("content/articles/brouillon.md"), true);
    assert.equal(files.has("content/articles/vieux.md"), false);
    assert.equal(files.has("index.html"), true);
    assert.equal(files.has("html/neuf.html"), true);
    assert.equal(new TextDecoder().decode(files.get("media/2026/a.jpg")), "jpeg");
    assert.equal(new TextDecoder().decode(files.get("media/2026/a.jpg.credit")), "Photo : Ada");
    assert.equal(new TextDecoder().decode(files.get("kiosque.config.ts")).includes("super-secret"), false);
    const html = new TextDecoder().decode(files.get("index.html"));
    assert.match(html, /href="html\/neuf.html"/);
  } finally {
    await store.close();
  }
});

test("une session ne contient que ses articles et se restaure sans toucher le reste", async () => {
  const { store } = await seeded();
  try {
    await store.put("export", "article:ancien", JSON.stringify({
      id: "ancien", title: "Ancien automne", year: 2020, session: "automne", status: "draft", markdown: "encore là",
    }));
    const zip = await buildSessionZip(store, "automne");
    const files = unzip(zip);
    assert.equal(files.has("kiosque.config.ts"), false);
    assert.equal(files.has("content/articles/neuf.json"), true);
    assert.equal(files.has("content/articles/ancien.json"), true);
    assert.equal(files.has("content/articles/vieux.json"), false);
    assert.equal(files.has("media/2026/a.jpg.credit"), false);
    await store.put("export", "article:neuf", JSON.stringify({
      id: "neuf", title: "Changé", year: 2026, session: "automne", status: "published", markdown: "changé",
    }));
    const report = await restoreZip(store, zip);
    assert.equal(report.session, "automne");
    const restored = JSON.parse((await store.get("export", "article:neuf"))!);
    assert.equal(restored.title, "Neuf");
    const old = JSON.parse((await store.get("export", "article:vieux"))!);
    assert.equal(old.title, "Vieux");
  } finally {
    await store.close();
  }
});

test("restaurer le site dit les années absentes", async () => {
  const { store } = await seeded();
  try {
    const zip = await buildSiteZip(store, NOW);
    await store.put("export", "article:neuf", JSON.stringify({
      id: "neuf", title: "Changé", year: 2026, session: "automne", status: "draft", markdown: "changé",
    }));
    const report = await restoreZip(store, zip);
    assert.deepEqual(report.excludedYears, [2020]);
    const restored = JSON.parse((await store.get("export", "article:neuf"))!);
    assert.equal(restored.title, "Neuf");
    const old = JSON.parse((await store.get("export", "article:vieux"))!);
    assert.equal(old.title, "Vieux");
  } finally {
    await store.close();
  }
});

test("la sauvegarde complète remet la rédaction en place", async () => {
  const { store } = await seeded();
  try {
    await store.migrate(["export", "editorial", "media"]);
    await store.put("editorial", "publication", JSON.stringify({ name: "La Vigie", slug: "la-vigie" }));
    await store.put("editorial", "article:a1", JSON.stringify({ id: "a1", title: "Gardé", status: "published", section: "sports", publishedAt: "2026-11-18T15:00:00.000Z", body: { raw: "x" } }));
    await store.put("media", "bytes:media/banque/p1.jpg", "AAAA");
    const zip = await buildSiteZip(store, NOW);
    assert.ok(unzip(zip).has("redaction/donnees.json"));
    assert.ok(unzip(zip).has("media/banque/p1.jpg"), "la banque de photos est dans le ZIP, même sans citation dans un article");
    assert.equal(Buffer.from(unzip(zip).get("media/banque/p1.jpg")!).toString("base64"), "AAAA");
    await store.delete("editorial", "article:a1");
    await store.delete("media", "bytes:media/banque/p1.jpg");
    await restoreZip(store, zip);
    assert.equal(JSON.parse((await store.get("editorial", "article:a1"))!).section, "sports");
    assert.equal(await store.get("media", "bytes:media/banque/p1.jpg"), "AAAA");
  } finally {
    await store.close();
  }
});

test("la notice reste tant que l'archive n'est pas téléchargée", async () => {
  const { store, config } = await seeded();
  config.modules.export = false;
  let version = "0.0.0";
  const deps = adminDeps(store, {
    release: () => ({ version: "0.1.0", notes: "correctifs" }),
    version: () => version,
    setVersion: async (next) => {
      version = next;
    },
  });
  try {
    const off = await handleAdmin("GET", "/admin", config, deps, new Uint8Array());
    assert.match(String(off.body), /téléchargez l'archive/);
    await handleAdmin("POST", "/admin/sauvegarde/activer", config, deps, new Uint8Array());
    assert.equal(config.modules.export, true);
    const still = await handleAdmin("GET", "/admin", config, deps, new Uint8Array());
    assert.match(String(still.body), /téléchargez l'archive/);
    const zip = await handleAdmin("GET", "/admin/sauvegarde/site.zip", config, deps, new Uint8Array());
    assert.equal(zip.headers["content-type"], "application/zip");
    const quiet = await handleAdmin("GET", "/admin", config, deps, new Uint8Array());
    assert.equal(String(quiet.body).includes("téléchargez l'archive"), false);
  } finally {
    await store.close();
  }
});

test("une majeure attend un oui de plus et un échec garde la version", async () => {
  const { store, config } = await seeded();
  let version = "0.0.0";
  let fail = false;
  const deps = (offered: string): AdminDeps => adminDeps(store, {
    release: () => ({ version: offered, notes: "note" }),
    version: () => version,
    setVersion: async (next) => {
      if (fail) throw new Error("migration");
      version = next;
    },
  });
  try {
    const blocked = await handleAdmin("POST", "/admin/mise-a-jour", config, deps("1.0.0"), Buffer.from("confirm=1"));
    assert.equal(blocked.status, 409);
    assert.equal(version, "0.0.0");
    const ok = await handleAdmin("POST", "/admin/mise-a-jour", config, deps("1.0.0"), Buffer.from("confirm=1&confirmMajor=1"));
    assert.equal(ok.status, 200);
    assert.equal(version, "1.0.0");
    version = "1.0.0";
    fail = true;
    const broken = await handleAdmin("POST", "/admin/mise-a-jour", config, deps("1.1.0"), Buffer.from("confirm=1"));
    assert.equal(broken.status, 500);
    assert.equal(version, "1.0.0");
  } finally {
    await store.close();
  }
});

test("le serveur ne migre pas au démarrage", async () => {
  const store = openSqliteMemory();
  const config = defaultConfig();
  const server = createSocleServer(config, adminDeps(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/admin`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /sauvegarde/);
    assert.equal(await store.tableReady("export"), false);
    const health = await fetch(`http://127.0.0.1:${address.port}/v1/articles`);
    assert.equal(health.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  }
});

test("les années choisies sont mémorisées", async () => {
  const { store } = await seeded();
  try {
    await writePrefs(store, { years: [2026, 2020] });
    const files = unzip(await buildSiteZip(store, NOW));
    assert.equal(files.has("content/articles/vieux.md"), true);
    assert.equal(files.has("content/articles/neuf.md"), true);
  } finally {
    await store.close();
  }
});

test("la restauration lit le JSON, pas le HTML", async () => {
  const { store } = await seeded();
  try {
    const zip = zipStore([
      textFile("manifest.json", JSON.stringify({ kind: "site", excludedYears: [1999] })),
      textFile("content/articles/neuf.json", JSON.stringify({
        id: "neuf", title: "Depuis le JSON", year: 2026, session: "automne", status: "published", markdown: "md",
      })),
      textFile("html/neuf.html", "<h1>Pas cette version</h1>"),
      textFile("index.html", "<p>index</p>"),
    ]);
    await restoreZip(store, zip);
    const restored = JSON.parse((await store.get("export", "article:neuf"))!);
    assert.equal(restored.title, "Depuis le JSON");
  } finally {
    await store.close();
  }
});

test("allumer l'export laisse les autres modules allumés", async () => {
  const { store, config } = await seeded();
  config.modules.export = false;
  config.modules.editorial = true;
  await store.migrate(["editorial"]);
  await store.put("editorial", "k", "v");
  let saved = false;
  const deps = adminDeps(store, {
    saveConfig: () => {
      saved = true;
    },
  });
  try {
    await handleAdmin("POST", "/admin/sauvegarde/activer", config, deps, new Uint8Array());
    assert.equal(saved, true);
    assert.equal(config.modules.export, true);
    assert.equal(config.modules.editorial, true);
    assert.equal(await store.get("editorial", "k"), "v");
  } finally {
    await store.close();
  }
});

test("la page nomme la sauvegarde du programme et un échec ne change pas la version", async () => {
  const { store, config } = await seeded();
  let version = "0.2.0";
  let fail = false;
  const deps = adminDeps(store, {
    release: () => ({ version: "0.3.0", notes: "trois lignes de correctifs" }),
    version: () => version,
    setVersion: async (next) => {
      if (fail) throw new Error("migration");
      version = next;
    },
  });
  try {
    const form = await handleAdmin("GET", "/admin/mise-a-jour", config, deps, new Uint8Array());
    assert.match(String(form.body), new RegExp(programBackupName("0.2.0", "0.3.0")));
    assert.match(String(form.body), /contenu du journal n'est pas/);
    assert.match(String(form.body), /Mettre à jour/);
    fail = true;
    const broken = await handleAdmin("POST", "/admin/mise-a-jour", config, deps, Buffer.from("confirm=1"));
    assert.equal(broken.status, 500);
    assert.equal(version, "0.2.0");
    const written = readFileSync(join(deps.backupDir, programBackupName("0.2.0", "0.3.0")), "utf8");
    assert.equal(written.includes("texte neuf"), false);
    assert.equal(written.includes("Photo"), false);
    fail = false;
    const back = await handleAdmin("POST", "/admin/mise-a-jour/revenir", config, deps, new Uint8Array());
    assert.equal(back.status, 200);
    assert.equal(version, "0.2.0");
    const updated = await handleAdmin("POST", "/admin/mise-a-jour", config, deps, Buffer.from("confirm=1"));
    assert.equal(updated.status, 200);
    assert.equal(version, "0.3.0");
    const reverted = await handleAdmin("POST", "/admin/mise-a-jour/revenir", config, deps, new Uint8Array());
    assert.equal(reverted.status, 200);
    assert.equal(version, "0.2.0");
  } finally {
    await store.close();
  }
});

test("la page d'admin a une version anglaise et une feuille d'impression", async () => {
  const { store, config } = await seeded();
  config.modules.export = false;
  try {
    const page = await handleAdmin("GET", "/admin?lang=en", config, adminDeps(store), new Uint8Array());
    const html = String(page.body);
    assert.match(html, /lang="en"/);
    assert.match(html, /Turn backup on and download the archive/);
    assert.match(html, /Aller au contenu|Skip to content/);
    assert.match(html, /@page letter/);
    assert.match(html, /@page legal/);
    assert.match(html, /@page tabloid/);
    assert.match(html, /@page a4/);
    assert.match(html, /@page a3/);
    assert.match(html, /@media print/);
  } finally {
    await store.close();
  }
});

test("une session nommée part, un chemin douteux non", async () => {
  const { store, config } = await seeded();
  await store.put("export", "article:special", JSON.stringify({
    id: "special", title: "Spéciale", year: 2019, session: "relève", status: "draft", markdown: "période",
  }));
  const deps = adminDeps(store);
  try {
    const zip = await handleAdmin("GET", "/admin/sauvegarde/session.zip?session=rel%C3%A8ve", config, deps, new Uint8Array());
    assert.equal(zip.status, 200);
    const files = unzip(zip.body as Uint8Array);
    assert.equal(files.has("content/articles/special.json"), true);
    const refused = await handleAdmin("GET", "/admin/sauvegarde/session.zip?session=..", config, deps, new Uint8Array());
    assert.equal(refused.status, 400);
  } finally {
    await store.close();
  }
});

test("restaurer en deux temps : résumé, copie de l'état actuel, puis restauration", async () => {
  const { store, config } = await seeded();
  const deps = adminDeps(store);
  try {
    await store.migrate(["export", "editorial", "media"]);
    await store.put("editorial", "publication", JSON.stringify({ name: "La Vigie", slug: "la-vigie" }));
    await store.put("editorial", "section:sports", JSON.stringify({ id: "sports", name: "Sports", slug: "sports" }));
    await store.put("editorial", "article:a1", JSON.stringify({ id: "a1", title: "Gardé", status: "published", section: "sports", body: { raw: "x" } }));
    await store.put("media", "bytes:banque/p1.jpg", "AAAA");
    const zip = await buildSiteZip(store, NOW);
    const resume = archiveSummary(zip);
    assert.deepEqual(resume, { kind: "site", session: null, createdAt: "2026-11-17T15:00:00Z", journal: "La Vigie", articles: 1, sections: 1, photos: 1, comptes: 0 });
    assert.throws(() => archiveSummary(new Uint8Array([1, 2, 3])), /ZIP/);
    assert.throws(() => archiveSummary(zipStore([textFile("a.txt", "x")])), /sauvegarde/);

    await store.put("editorial", "article:a1", JSON.stringify({ id: "a1", title: "Changé", status: "draft", body: { raw: "y" } }));
    const bad = await handleAdmin("POST", "/admin/sauvegarde/restaurer/apercu", config, deps, new Uint8Array([1, 2]));
    assert.equal(bad.status, 400);
    const preview = await handleAdmin("POST", "/admin/sauvegarde/restaurer/apercu", config, deps, zip);
    assert.equal(preview.status, 200);
    const { jeton, resume: shown } = JSON.parse(String(preview.body)) as { jeton: string; resume: { articles: number } };
    assert.equal(shown.articles, 1);
    assert.equal(JSON.parse((await store.get("editorial", "article:a1"))!).title, "Changé", "l'aperçu n'écrit rien");

    const done = await handleAdmin("POST", "/admin/sauvegarde/restaurer", config, deps, Buffer.from(JSON.stringify({ jeton })));
    assert.equal(done.status, 200, String(done.body));
    const report = JSON.parse(String(done.body)) as { sauvegardeAuto: string };
    assert.match(report.sauvegardeAuto, /^avant-restauration-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/);
    assert.equal(JSON.parse((await store.get("editorial", "article:a1"))!).title, "Gardé");
    assert.deepEqual(readdirSync(join(deps.backupDir, "avant-restauration")), [report.sauvegardeAuto]);
    const copy = await handleAdmin("GET", `/admin/sauvegarde/auto/${report.sauvegardeAuto}`, config, deps, new Uint8Array());
    assert.equal(copy.status, 200);
    const before = unzip(copy.body as Uint8Array);
    assert.match(new TextDecoder().decode(before.get("redaction/donnees.json")), /Changé/, "la copie garde l'état d'avant");

    const again = await handleAdmin("POST", "/admin/sauvegarde/restaurer", config, deps, Buffer.from(JSON.stringify({ jeton })));
    assert.equal(again.status, 400, "un jeton ne sert qu'une fois");
    const page = await handleAdmin("GET", "/admin/sauvegarde", config, deps, new Uint8Array());
    assert.match(String(page.body), /Voir le contenu/);
    assert.match(String(page.body), /Choisir un fichier/);
    assert.match(String(page.body), /Aucun fichier choisi/);
    assert.doesNotMatch(String(page.body), /Choose a file/);
    assert.match(String(page.body), /label\.choix-fichier/);
    assert.match(String(page.body), /restaurer\/apercu/);
    const english = await handleAdmin("GET", "/admin/sauvegarde?lang=en", config, deps, new Uint8Array());
    assert.match(String(english.body), /Choose a file/);
    assert.match(String(english.body), /No file chosen/);
    assert.doesNotMatch(String(english.body), /Choisir un fichier/);
    assert.equal(String(page.body).includes("</script>", String(page.body).indexOf("<script>") + 10) , true);
  } finally {
    await store.close();
  }
});

