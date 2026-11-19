/**
 * Contrat des extensions (docs/extensions.md), sur le paquet PHP :
 * - chaque extension épinglée se charge et répond (essai de contrat) ;
 * - une extension invalide, incompatible ou en erreur est isolée et coupée,
 *   sans faire tomber l'espace de rédaction ni le site public ;
 * - une mise à jour garde extensions/, avertit avant le clic, et le retour
 *   arrière remet extensions/ comme il était ;
 * - l'accès GitHub fourni par le Socle déclenche un workflow et propose une PR
 *   sans jamais écrire sur main ni afficher le jeton.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { unzip } from "../src/zip.ts";
import { REPO, call, copierExtension, equipe, form, installer, lancer, paquet, skipPhp, versionEssai } from "./extensions-outils.ts";

const FIXTURES = join(REPO, "test/fixtures/extensions");
const SITE = { "index.html": "<html><head></head><body>journal public</body></html>", "kiosque-vivant.json": "{}" };

/**
 * Extensions soumises à l'essai de contrat : l'exemple du Socle, et celles
 * qu'on épingle par SOCLE_EXTENSIONS_CONTRAT (dossiers séparés par « : »).
 * Le lot 2 y ajoutera les extensions du Radar (dépôt le-radar, commit épinglé).
 */
function contrat(): string[] {
  const extra = (process.env.SOCLE_EXTENSIONS_CONTRAT ?? "").split(":").map((item) => item.trim()).filter(Boolean);
  return [join(REPO, "examples/extension-bonjour"), ...extra.map((item) => resolve(item))];
}

function manifeste(dir: string) {
  return JSON.parse(readFileSync(join(dir, "extension.json"), "utf8")) as { id: string; nom: string; roles?: Array<{ id: string; defaut?: string[] }> };
}

test("contrat : chaque extension épinglée s'active, se charge et répond", { skip: skipPhp }, async () => {
  for (const dir of contrat()) {
    const { id, nom } = manifeste(dir);
    const work = mkdtempSync(join(tmpdir(), `socle-contrat-${id}-`));
    const host = join(work, "public_html");
    installer(paquet(work, "1.0.0", versionEssai(), SITE), host);
    copierExtension(dir, host, id);
    const server = await lancer(work, host);
    try {
      const who = await equipe(server.base, ["auteur", "editeur"]);
      const admin = { cookie: who.administrateur };
      const page = await call(`${server.base}/admin/extensions`, { headers: admin });
      assert.equal(page.status, 200, server.logs());
      assert.match(page.text, new RegExp(`id="extension-${id}" data-statut="desactivee"`), `${id} : présente, désactivée par défaut`);
      assert.match(page.text, /<h1>Extensions<\/h1>/);
      assert.match(page.text, /aria-current="page">Extensions<\/a>/, "lien Extensions de la barre, marqué");
      assert.equal((await call(`${server.base}/admin/extensions`, { headers: { cookie: who.auteur } })).status, 403, "page réservée à l’administrateur");
      assert.equal((await call(`${server.base}/admin/extensions/${id}/activer`, { method: "POST", headers: { ...form, cookie: who.editeur } })).status, 403);
      const on = await call(`${server.base}/admin/extensions/${id}/activer`, { method: "POST", headers: { ...form, ...admin } });
      assert.equal(on.status, 200, server.logs());
      assert.match(on.text, new RegExp(`« ${nom} » est active\\.`), on.text.slice(0, 3000));
      assert.match(on.text, new RegExp(`id="extension-${id}" data-statut="active"`));
      const etat = JSON.parse(readFileSync(join(host, "journal/donnees/extensions.json"), "utf8"));
      assert.equal(etat.extensions[id].active, true, "l’état est rangé dans donnees/");

      const menu = JSON.parse((await call(`${server.base}/admin/extensions/menu.json`, { headers: admin })).text);
      assert.equal(menu.api, 1);
      assert.deepEqual(menu.avis, [], `${id} : aucun avis`);
      for (const carte of menu.cartes) assert.notEqual(carte.etat, "alerte", `${id} : carte ${carte.id} sans erreur`);
      for (const item of menu.menu.filter((entry: { extension: string }) => entry.extension === id)) {
        const opened = await call(`${server.base}${item.adresse}`, { headers: admin });
        assert.equal(opened.status, 200, `${item.adresse} : ${opened.text.slice(0, 500)}`);
        assert.match(opened.text, /<h1>/);
      }
      const reglages = await call(`${server.base}/admin/extensions/${id}/reglages`, { headers: admin });
      if (reglages.status === 200) assert.match(reglages.text, /Ces réglages ne sont pas secrets/);
      else assert.equal(reglages.status, 404);
      const listed = await call(`${server.base}/admin/extensions`, { headers: admin });
      for (const [, task] of listed.text.matchAll(new RegExp(`action="/journal/admin/extensions/${id}/taches/([a-z0-9-]+)"`, "g"))) {
        const ran = await call(`${server.base}/admin/extensions/${id}/taches/${task}`, { method: "POST", headers: { ...form, ...admin } });
        assert.match(ran.text, new RegExp(`Tâche « ${task} » faite`), `${id}/${task}`);
      }
      const cron = await call(`${server.base}/v1/taches`, { method: "POST" });
      assert.equal(cron.status, 200);
      for (const done of JSON.parse(cron.text).taches) assert.notEqual(done.statut, "erreur", `${id}/${done.tache}`);
      assert.doesNotMatch((await call(`${server.base}/admin/extensions`, { headers: admin })).text, /data-statut="coupee"/, `${id} : jamais coupée`);
    } finally {
      server.stop();
    }
  }
});

test("Bonjour, l'exemple : menu, page, réglage, rôle d'extension, API, carte et tâche", { skip: skipPhp }, async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-bonjour-"));
  const host = join(work, "public_html");
  installer(paquet(work, "1.0.0", versionEssai(), SITE), host);
  copierExtension(join(REPO, "examples/extension-bonjour"), host, "bonjour");
  const server = await lancer(work, host);
  try {
    const who = await equipe(server.base, ["auteur", "editeur"]);
    const admin = { cookie: who.administrateur };
    await call(`${server.base}/admin/extensions/bonjour/activer`, { method: "POST", headers: { ...form, ...admin } });
    assert.equal((await call(`${server.base}/admin/x/bonjour/note`, { method: "POST", headers: { ...form, ...admin }, body: "texte=Premi%C3%A8re+note" })).status, 303);
    const page = await call(`${server.base}/admin/x/bonjour`, { headers: admin });
    assert.match(page.text, /<p>Bonjour, admin@journal\.example\.<\/p><ul><li>Première note/);
    // Le rôle d'extension « bonjour-lecteur » est donné par défaut aux éditeurs, pas aux auteurs.
    assert.equal((await call(`${server.base}/admin/x/bonjour`, { headers: { cookie: who.editeur } })).status, 200);
    assert.equal((await call(`${server.base}/admin/x/bonjour`, { headers: { cookie: who.auteur } })).status, 403);
    assert.deepEqual(JSON.parse((await call(`${server.base}/admin/extensions/menu.json`, { headers: { cookie: who.auteur } })).text).menu, []);
    const editorMenu = JSON.parse((await call(`${server.base}/admin/extensions/menu.json`, { headers: { cookie: who.editeur } })).text);
    assert.deepEqual(editorMenu.menu, [{ extension: "bonjour", libelle: "Bonjour", adresse: "/admin/x/bonjour" }]);
    assert.equal(editorMenu.cartes[0].lignes[0], "1 note dans Bonjour.");
    assert.deepEqual(editorMenu.avis, [], "les avis sont pour l’administrateur");
    // L'administrateur retire le rôle aux éditeurs et le donne aux auteurs.
    await call(`${server.base}/admin/extensions/bonjour/roles`, { method: "POST", headers: { ...form, ...admin }, body: "bonjour-lecteur=auteur" });
    assert.equal((await call(`${server.base}/admin/x/bonjour`, { headers: { cookie: who.editeur } })).status, 403);
    assert.equal((await call(`${server.base}/admin/x/bonjour`, { headers: { cookie: who.auteur } })).status, 200);
    // Réglage.
    const saved = await call(`${server.base}/admin/extensions/bonjour/reglages`, { method: "POST", headers: { ...form, ...admin }, body: "salutation=Salut&maximum=5" });
    assert.match(saved.text, /Réglages enregistrés\./);
    assert.match((await call(`${server.base}/admin/x/bonjour`, { headers: admin })).text, /<p>Salut, admin/);
    // API JSON.
    const api = await call(`${server.base}/v1/x/bonjour/notes`, { headers: admin });
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.text).notes[0].texte, "Première note");
    assert.equal((await call(`${server.base}/v1/x/bonjour/notes`)).status, 401);
    // Tâche : due au premier passage, puis pas avant une heure.
    const first = JSON.parse((await call(`${server.base}/v1/taches`, { method: "POST" })).text).taches;
    assert.deepEqual(first, [{ extension: "bonjour", tache: "compter", statut: "ok", message: "1 note" }]);
    const second = JSON.parse((await call(`${server.base}/v1/taches`, { method: "POST" })).text).taches;
    assert.equal(second[0].statut, "pas-due");
    assert.match((await call(`${server.base}/admin/extensions`, { headers: admin })).text, /Dernière : .* — réussie \(1 note\)/);
    // Le site public ne charge jamais une extension.
    assert.match((await call(`${server.base}/`)).text, /journal public/);
    // Désactivée : la page n'est plus servie, rien n'est perdu.
    await call(`${server.base}/admin/extensions/bonjour/desactiver`, { method: "POST", headers: { ...form, ...admin } });
    assert.equal((await call(`${server.base}/admin/x/bonjour`, { headers: admin })).status, 404);
    await call(`${server.base}/admin/extensions/bonjour/activer`, { method: "POST", headers: { ...form, ...admin } });
    assert.match((await call(`${server.base}/admin/x/bonjour`, { headers: admin })).text, /Première note/);
  } finally {
    server.stop();
  }
});

test("isolation : extension invalide, incompatible, en attente d'un secret ou en erreur, sans panne", { skip: skipPhp }, async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-isolation-"));
  const host = join(work, "public_html");
  installer(paquet(work, "1.0.0", versionEssai(), SITE), host);
  for (const id of ["cassee-chargement", "cassee-fatale", "cassee-page", "incompatible", "invalide", "github"]) copierExtension(join(FIXTURES, id), host, id);
  copierExtension(join(REPO, "examples/extension-bonjour"), host, "bonjour");
  const server = await lancer(work, host);
  try {
    const who = await equipe(server.base);
    const admin = { cookie: who.administrateur };
    const activate = (id: string) => call(`${server.base}/admin/extensions/${id}/activer`, { method: "POST", headers: { ...form, ...admin } });
    const debout = async () => {
      assert.equal((await call(`${server.base}/v1/health`)).status, 200);
      assert.equal((await call(`${server.base}/redaction/`)).status, 200);
      assert.match((await call(`${server.base}/`)).text, /journal public/);
      assert.equal((await call(`${server.base}/admin/x/bonjour`, { headers: admin })).status, 200, "l’extension saine continue");
    };
    await activate("bonjour");
    const list = (await call(`${server.base}/admin/extensions`, { headers: admin })).text;
    assert.match(list, /id="extension-invalide" data-statut="invalide"[\s\S]*?Licence « Apache-2\.0 » non compatible avec la GPL version 2 seulement/);
    assert.match(list, /id="extension-incompatible" data-statut="incompatible"[\s\S]*?Elle demande Le Socle &gt;=99\.0\.0, et la version installée est /);
    assert.match((await activate("incompatible")).text, /« Trop récente » ne peut pas être activée/);
    assert.match((await activate("invalide")).text, /« invalide » ne peut pas être activée : licence « Apache-2\.0 »/);

    // Secret manquant : l'extension attend, sans erreur ; le nom du secret est dit, jamais une valeur.
    const github = await activate("github");
    assert.match(github.text, /« Pilote GitHub » n’a pas pu démarrer : secret à définir sur le serveur : SOCLE_GITHUB_JETON\./);
    assert.match(github.text, /<code>SOCLE_GITHUB_JETON<\/code> <span class="pastille pastille-attention">à définir<\/span>/);

    // Erreur au chargement : coupée aussitôt, avec la raison.
    const broken = await activate("cassee-chargement");
    assert.match(broken.text, /« Cassée au chargement » n’a pas pu démarrer : erreur au chargement : RuntimeException : réglage obligatoire absent\./);
    assert.match(broken.text, /id="extension-cassee-chargement" data-statut="coupee"/);
    assert.doesNotMatch(broken.text, new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "aucun chemin complet du serveur");
    await debout();

    // Erreur fatale de PHP (impossible à attraper) : cette requête échoue, l'extension est coupée, la suivante marche.
    const fatal = await activate("cassee-fatale");
    assert.equal(fatal.status, 500);
    const after = (await call(`${server.base}/admin/extensions`, { headers: admin })).text;
    assert.match(after, /id="extension-cassee-fatale" data-statut="coupee"[\s\S]*?Erreur fatale : Cannot redeclare/);
    await debout();

    // Page qui lève une erreur : message clair, puis coupée après trois erreurs de suite.
    await activate("cassee-page");
    for (let i = 1; i <= 3; i++) {
      const failed = await call(`${server.base}/admin/x/cassee-page`, { headers: admin });
      assert.equal(failed.status, 500);
      assert.match(failed.text, /L’extension « Page en erreur » a rencontré une erreur\. Le reste de l’espace de rédaction fonctionne normalement\./);
      assert.equal(/Elle est maintenant coupée/.test(failed.text), i === 3, `erreur ${i}`);
    }
    assert.match((await call(`${server.base}/admin/x/cassee-page`, { headers: admin })).text, /Cette extension n’est pas active pour l’instant/);
    await debout();

    // Avis pour l'administrateur, dans le menu de l'espace de rédaction.
    const avis = JSON.parse((await call(`${server.base}/admin/extensions/menu.json`, { headers: admin })).text).avis as Array<{ extension: string; statut: string }>;
    assert.deepEqual(avis.map((item) => `${item.extension}:${item.statut}`).sort(), ["cassee-chargement:coupee", "cassee-fatale:coupee", "cassee-page:coupee", "github:secret-manquant", "invalide:invalide"]);
    // Réactiver remet le compteur à zéro ; une extension toujours cassée est recoupée.
    const again = await call(`${server.base}/admin/extensions/cassee-chargement/reactiver`, { method: "POST", headers: { ...form, ...admin } });
    assert.match(again.text, /n’a pas pu démarrer/);
    await debout();
  } finally {
    server.stop();
  }
});

test("mise à jour : extensions/ survit, l'avertissement précède le clic, le retour arrière le remet", { skip: skipPhp }, async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-maj-ext-"));
  const host = join(work, "public_html");
  const now = versionEssai();
  const [maj, min] = now.split(".").map(Number);
  const next = `${maj}.${min + 1}.0`;
  installer(paquet(work, "1.0.0", now, SITE), host);
  // L'ancienne extension ne suit que la version actuelle ; Bonjour suit toute la 1.x.
  copierExtension(join(REPO, "examples/extension-bonjour"), host, "bonjour");
  copierExtension(join(FIXTURES, "vieille"), host, "vieille");
  writeFileSync(join(host, "journal/extensions/vieille/extension.json"), JSON.stringify({ id: "vieille", nom: "Ancienne génération", version: "1.0.0", socle: `>=${now} <${next}`, api: 1, licence: "GPL-2.0-only" }));
  // Le paquet suivant contient, à tort, un dossier extensions/ : il ne doit rien écraser.
  const v2 = paquet(work, "1.1.0", next, SITE, {
    "extensions/bonjour/extension.json": "{\"id\":\"bonjour\",\"nom\":\"Écrasée\",\"version\":\"9.9.9\",\"socle\":\"*\",\"api\":1,\"licence\":\"MIT\"}",
    "extensions/intruse/extension.json": "{}",
  });
  const release = join(work, "release.json");
  writeFileSync(release, JSON.stringify({ tag_name: "v1.1.0", body: `<!-- kiosque-paquet {"kiosque":"1.1.0","socle":"${next}"} -->\nCe qui change\n\n## Espace de rédaction (socle ${next})\n- Mieux`, html_url: "https://example.org/releases/v1.1.0", assets: [{ name: "kiosque-journal.zip", browser_download_url: `file://${v2}` }] }));
  const server = await lancer(work, host, { SOCLE_MAJ_SOURCE: release });
  try {
    const who = await equipe(server.base);
    const admin = { cookie: who.administrateur };
    for (const id of ["bonjour", "vieille"]) await call(`${server.base}/admin/extensions/${id}/activer`, { method: "POST", headers: { ...form, ...admin } });
    await call(`${server.base}/admin/x/bonjour/note`, { method: "POST", headers: { ...form, ...admin }, body: "texte=Avant+la+mise+%C3%A0+jour" });
    const manifestBefore = readFileSync(join(host, "journal/extensions/bonjour/extension.json"), "utf8");

    const page = await call(`${server.base}/admin/mise-a-jour?verifier=1`, { headers: admin });
    assert.equal(page.status, 200, server.logs());
    const warning = page.text.match(/<div class="note alerte" role="alert" data-extensions-incompatibles>[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.match(warning, new RegExp(`après cette mise à jour, ces extensions seront coupées, car elles ne sont pas compatibles avec la version ${next.replace(/\./g, "\\.")}`));
    assert.match(warning, /<strong>Ancienne génération<\/strong> 1\.0\.0/);
    assert.doesNotMatch(warning, /Bonjour/, "Bonjour reste compatible");
    assert.ok(page.text.indexOf("data-extensions-incompatibles") < page.text.indexOf("Mettre à jour vers la version 1.1.0"), "l’avertissement vient avant le bouton");

    const done = await call(`${server.base}/admin/mise-a-jour/paquet`, { method: "POST", headers: { ...form, ...admin }, body: "" });
    assert.match(done.text, /Mise à jour faite : 1\.0\.0 → 1\.1\.0/, done.text.slice(0, 2000));
    assert.equal(readFileSync(join(host, "journal/extensions/bonjour/extension.json"), "utf8"), manifestBefore, "extensions/ n’est jamais écrit par une mise à jour");
    assert.ok(!existsSync(join(host, "journal/extensions/intruse")), "rien n’est ajouté à extensions/");
    const backup = readdirSync(join(host, "journal/donnees/mises-a-jour")).find((name) => /^programme-1\.0\.0-.*\.zip$/.test(name));
    assert.ok(backup);
    const saved = unzip(new Uint8Array(readFileSync(join(host, "journal/donnees/mises-a-jour", backup))));
    assert.ok(saved.has("journal/extensions/bonjour/extension.php"), "la sauvegarde du programme garde extensions/");
    assert.ok(saved.has("journal/extensions/.sauvegarde-du-socle"));

    assert.match((await call(`${server.base}/admin/x/bonjour`, { headers: admin })).text, /Avant la mise à jour/, "l’extension et ses données ont survécu");
    const list = (await call(`${server.base}/admin/extensions`, { headers: admin })).text;
    assert.match(list, /id="extension-bonjour" data-statut="active"/);
    assert.match(list, new RegExp(`id="extension-vieille" data-statut="incompatible"[\\s\\S]*?Elle demande Le Socle &gt;=${now.replace(/\./g, "\\.")} &lt;${next.replace(/\./g, "\\.")}, et la version installée est ${next.replace(/\./g, "\\.")}`));
    assert.match(JSON.parse((await call(`${server.base}/admin/extensions/menu.json`, { headers: admin })).text).avis[0].message, /Incompatible avec cette version du Socle/);

    // Après la mise à jour, on retire Bonjour à la main ; le retour arrière remet extensions/ tel qu'il était.
    rmSync(join(host, "journal/extensions/bonjour"), { recursive: true });
    const back = await call(`${server.base}/admin/mise-a-jour/paquet/revenir`, { method: "POST", headers: { ...form, ...admin }, body: "" });
    assert.match(back.text, /Retour fait : la version 1\.0\.0 est revenue/);
    assert.equal(readFileSync(join(host, "journal/extensions/bonjour/extension.json"), "utf8"), manifestBefore);
    const restored = (await call(`${server.base}/admin/extensions`, { headers: admin })).text;
    assert.match(restored, /id="extension-bonjour" data-statut="active"/);
    assert.match(restored, /id="extension-vieille" data-statut="active"/, "compatible de nouveau, elle se rallume d’elle-même");
    assert.match((await call(`${server.base}/admin/x/bonjour`, { headers: admin })).text, /Avant la mise à jour/);
  } finally {
    server.stop();
  }
});

test("accès GitHub : workflow, exécutions et PR sur une nouvelle branche, jeton jamais affiché", { skip: skipPhp }, async () => {
  const seen: Array<{ method: string; url: string; auth: string; body: unknown }> = [];
  const fake = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: raw ? JSON.parse(raw) : null });
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === null ? "" : JSON.stringify(body)); };
    const url = req.url ?? "";
    if (url.endsWith("/dispatches")) return send(204, null);
    if (url.includes("/runs?")) return send(200, { workflow_runs: [{ id: 1, status: "completed", conclusion: "success", created_at: "2026-11-19T18:00:00Z", html_url: "https://github.com/exemple/radar/actions/runs/1" }, { id: 2, status: "in_progress", conclusion: null }] });
    if (url.includes("/git/ref/heads/main")) return send(200, { object: { sha: "abc123" } });
    if (url.endsWith("/git/refs")) return send(201, { ref: "refs/heads/socle/sources-essai" });
    if (url.includes("/contents/news-sources.json") && req.method === "GET") return send(200, { type: "file", sha: "f1", content: Buffer.from("{}").toString("base64") });
    if (url.includes("/contents/")) return send(200, { content: {} });
    if (url.endsWith("/pulls")) return send(201, { number: 42, html_url: "https://github.com/exemple/radar/pull/42" });
    return send(404, { message: "Not Found" });
  });
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", () => done()));
  const address = fake.address();
  const api = `http://127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`;
  const jeton = "jeton-essai-0123456789abcdef";
  const work = mkdtempSync(join(tmpdir(), "socle-github-"));
  const host = join(work, "public_html");
  installer(paquet(work, "1.0.0", versionEssai(), SITE), host);
  copierExtension(join(FIXTURES, "github"), host, "github");
  const server = await lancer(work, host, { SOCLE_GITHUB_API: api, SOCLE_GITHUB_JETON: jeton });
  try {
    const who = await equipe(server.base);
    const admin = { cookie: who.administrateur };
    const on = await call(`${server.base}/admin/extensions/github/activer`, { method: "POST", headers: { ...form, ...admin } });
    assert.match(on.text, /« Pilote GitHub » est active\./, on.text.slice(0, 2000));
    assert.match(on.text, /<code>SOCLE_GITHUB_JETON<\/code> <span class="pastille pastille-ok">défini<\/span>/);
    assert.ok(!on.text.includes(jeton), "le jeton n’est jamais affiché");
    const ran = await call(`${server.base}/admin/x/github/lancer`, { method: "POST", headers: { ...form, ...admin } });
    assert.equal(ran.status, 200, ran.text.slice(0, 1000) + server.logs());
    assert.match(ran.text, /data-runs="2" data-pr="42" data-refus-main="oui"/);
    assert.ok(!ran.text.includes(jeton));
    assert.ok(seen.every((hit) => hit.auth === `Bearer ${jeton}`));
    assert.deepEqual(seen[0], { method: "POST", url: "/repos/exemple/radar/actions/workflows/update-news.yml/dispatches", auth: `Bearer ${jeton}`, body: { ref: "main", inputs: { dry_run: "true" } } });
    const put = seen.find((hit) => hit.method === "PUT");
    assert.deepEqual((put?.body as { branch: string; sha: string }).branch, "socle/sources-essai");
    assert.equal((put?.body as { sha: string }).sha, "f1", "un fichier existant est remplacé avec son sha");
    assert.deepEqual((seen.find((hit) => hit.url.endsWith("/pulls"))?.body as { head: string; base: string }), { title: "Corriger une source", head: "socle/sources-essai", base: "main", body: "Proposé depuis l’espace de rédaction." });
    assert.ok(!seen.some((hit) => hit.method === "PUT" && (hit.body as { branch: string }).branch === "main"), "jamais d’écriture sur main");
  } finally {
    server.stop();
    fake.close();
  }
});
