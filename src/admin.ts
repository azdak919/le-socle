import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSessionZip,
  buildSiteZip,
  defaultYears,
  isSessionName,
  markDownloaded,
  readPrefs,
  archiveSummary,
  restoreZip,
  sessionsIn,
  wasDownloaded,
  writePrefs,
} from "./archive.ts";
import { mayUpdate, type AuthRuntime } from "./auth.ts";
import type { NotifyRuntime } from "./notify.ts";
import { enabledModules, type SocleConfig } from "./config.ts";
import type { SocleStore } from "./store.ts";
import { VERSION } from "./version.ts";
import { SOCLE_ICON_URI, socleBriqueHtml, socleFavicons } from "../admin/marque.js";

export type ReleaseInfo = { version: string; notes: string };

/** Script de restauration en deux temps, partagé avec PHP (lu à la demande : le Worker n'a pas de fichiers). */
function restoreScript(): string {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "admin", "assets", "restauration.js");
    return readFileSync(path, "utf8").replaceAll("</", "<\\/");
  } catch {
    return "";
  }
}

function jsonResult(status: number, value: unknown): Result {
  return { status, body: JSON.stringify(value), headers: { "content-type": "application/json; charset=utf-8" } };
}

/** Archives en attente de confirmation, gardées une heure en mémoire. */
const pendingRestores = new Map<string, { bytes: Uint8Array; at: number }>();

function stashRestore(bytes: Uint8Array): string {
  const now = Date.now();
  for (const [token, entry] of pendingRestores) if (now - entry.at > 3_600_000) pendingRestores.delete(token);
  const token = randomBytes(16).toString("hex");
  pendingRestores.set(token, { bytes, at: now });
  return token;
}

function unstashRestore(token: string): Uint8Array {
  const entry = /^[a-f0-9]{32}$/.test(token) ? pendingRestores.get(token) : undefined;
  if (!entry || Date.now() - entry.at > 3_600_000) throw new Error("archive expirée : choisissez-la de nouveau");
  pendingRestores.delete(token);
  return entry.bytes;
}

/** Copie de l'état actuel avant une restauration ; les cinq dernières sont gardées. */
async function autoBackup(deps: AdminDeps, now: Date): Promise<string> {
  const dir = join(deps.backupDir, "avant-restauration");
  mkdirSync(dir, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `avant-restauration-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
  writeFileSync(join(dir, name), await buildSiteZip(deps.store, now));
  const all = readdirSync(dir).filter((file) => file.startsWith("avant-restauration-") && file.endsWith(".zip")).sort();
  while (all.length > 5) unlinkSync(join(dir, all.shift() as string));
  return name;
}

export type AdminDeps = {
  store: SocleStore;
  now: () => Date;
  release: () => ReleaseInfo | null;
  version: () => string;
  setVersion: (version: string) => Promise<void>;
  backupDir: string;
  saveConfig?: (config: SocleConfig) => void;
  auth?: AuthRuntime;
  notify?: NotifyRuntime;
};

type Result = { status: number; body: string | Uint8Array; headers: Record<string, string> };
type Lang = "fr" | "en";

const COPY = {
  fr: {
    html: "fr",
    skip: "Aller au contenu",
    back: "Tableau de bord",
    brandSub: "Espace de rédaction",
    powered: "Propulsé par",
    other: "English",
    otherLang: "en",
    office: "Interface d’administration",
    notice: "Allumez la sauvegarde et téléchargez l'archive. Si le serveur est perdu, réinstallez avec le configurateur du Kiosque et choisissez cette archive.",
    saveLink: "Sauvegarde",
    updateLink: "Mise à jour",
    articlesLink: "Articles",
    reviewLink: "Relecture",
    mediaLink: "Médias",
    audienceLink: "Audience",
    notifyLink: "Abonnements",
    saveTitle: "Sauvegarde",
    off: "La sauvegarde est éteinte.",
    activate: "Activer",
    saveIntro: "Gardez une copie du journal hors du serveur : articles, photos, équipe et réglages, dans un seul fichier ZIP. Faites-le avant chaque mise à jour.",
    yearsTitle: "Années comprises dans la sauvegarde",
    yearsHelp: "L’année en cours et la précédente sont cochées au départ. Décochez les années déjà gardées dans une sauvegarde plus ancienne : le fichier sera plus léger.",
    sessionsTitle: "Sauvegarde d’une session",
    sessionsHelp: "Seulement les articles de la session choisie, sans photos ni réglages.",
    restored: "Sauvegarde restaurée. Rechargez la rédaction pour voir le contenu.",
    restoreFailed: "La restauration a échoué : vérifiez que c’est bien un ZIP téléchargé sur cette page.",
    savePrefs: "Garder ce choix d’années",
    downloadSite: "Télécharger la sauvegarde complète",
    sessionOf: "Session",
    articlesOnly: "articles seulement",
    restoreHint: "<h2>Restaurer une sauvegarde</h2><p class=\"aide\">Choisissez un fichier ZIP téléchargé sur cette page. Vous verrez d’abord ce qu’il contient : rien ne change avant votre confirmation. Une sauvegarde de session ne remplace que les articles de cette session. Réservé à l’administrateur.</p><form class=\"noprint\" id=\"restaurer\" data-lecture=\"Lecture du fichier…\" data-choisir=\"Choisissez d’abord un fichier.\" data-apercu=\"Contenu de cette sauvegarde\" data-fichier=\"Fichier\" data-date=\"Date de la sauvegarde\" data-inconnue=\"non indiquée (sauvegarde ancienne)\" data-journal=\"Journal\" data-session=\"Session seulement\" data-articles=\"Articles\" data-photos=\"Photos\" data-sections=\"Sections\" data-comptes=\"Comptes de l’équipe\" data-avertir=\"Restaurer remet en place les articles, les photos, les sections et les comptes de cette sauvegarde, par-dessus le contenu actuel ; les articles écrits depuis sont gardés. Juste avant, le journal garde automatiquement une copie de l’état actuel, que vous pourrez télécharger.\" data-confirmer=\"Restaurer cette sauvegarde\" data-annuler=\"Annuler\" data-fait=\"Sauvegarde restaurée. Rechargez la rédaction pour voir le contenu.\" data-auto=\"Copie de l’état d’avant la restauration :\" data-telecharger=\"la télécharger\" data-echec=\"Rien n’a changé :\"><label class=\"choix-fichier\"><span class=\"choix-fichier-etiquette\">Fichier de sauvegarde (ZIP)</span><span class=\"choix-fichier-bouton\"><span class=\"bouton\">Choisir un fichier</span><input class=\"choix-fichier-input\" type=\"file\" name=\"archive\" accept=\".zip,application/zip\" required></span><span class=\"choix-fichier-nom\" id=\"choix-fichier-nom\" data-choix-nom aria-live=\"polite\">Aucun fichier choisi</span></label> <button type=\"submit\">Voir le contenu</button></form><div id=\"restaurer-etat\" role=\"status\" tabindex=\"-1\"></div>",
    updateTitle: "Mise à jour",
    line: "Espace de rédaction",
    installed: "Version en place",
    offered: "Version proposée",
    none: "Aucune nouvelle version n’est préparée sur ce serveur.",
    latest: "<h2>Installer la dernière version à la main</h2><ol><li>Sur la page Sauvegarde, téléchargez la sauvegarde complète et gardez-la sur votre ordinateur.</li><li><a href=\"https://github.com/azdak919/le-socle/releases/latest/download/le-socle-php.zip\">Téléchargez le-socle-php.zip</a> (nouveautés sur la <a href=\"https://github.com/azdak919/le-socle/releases/latest\">page de la dernière version</a>).</li><li>Décompressez-le : vous obtenez un dossier « socle ». Copiez son contenu dans le dossier de l’espace de rédaction sur le serveur, en remplaçant les fichiers existants, sans toucher au dossier « donnees » (vos articles, vos photos et vos comptes).</li></ol>",
    backupWill: "Sauvegarde du programme, avant",
    notContent: "Le contenu du journal n'est pas dans cette sauvegarde.",
    major: "Cette version casse quelque chose. Je confirme.",
    updateBtn: "Mettre à jour",
    revert: "Revenir à la sauvegarde",
    done: "La mise à jour a réussi.",
    reverted: "La version d'avant est revenue.",
    noBackup: "Aucune sauvegarde de programme.",
  },
  en: {
    html: "en",
    skip: "Skip to content",
    back: "Dashboard",
    brandSub: "Newsroom",
    powered: "Powered by",
    other: "Français",
    otherLang: "fr",
    office: "Administration",
    notice: "Turn backup on and download the archive. If the server is lost, reinstall with the Kiosque configurator and choose that archive.",
    saveLink: "Backup",
    updateLink: "Update",
    articlesLink: "Articles",
    reviewLink: "Review",
    mediaLink: "Media",
    audienceLink: "Audience",
    notifyLink: "Subscriptions",
    saveTitle: "Backup",
    off: "Backup is off.",
    activate: "Turn on",
    saveIntro: "Keep a copy of the journal off the server: articles, photos, team and settings, in one ZIP file. Do it before every update.",
    yearsTitle: "Years in the archive",
    yearsHelp: "The current year and the previous one start checked. Uncheck years already kept in an older archive: the archive gets lighter.",
    sessionsTitle: "Archive of one session",
    sessionsHelp: "Only that session's articles, without photos or settings.",
    restored: "Archive restored. Reload the newsroom to see the content.",
    restoreFailed: "Restore failed: make sure it is a ZIP downloaded from this page.",
    savePrefs: "Save",
    downloadSite: "Download the full backup",
    sessionOf: "Session",
    articlesOnly: "articles only",
    restoreHint: "<h2>Restore a backup</h2><p class=\"aide\">Choose a ZIP file downloaded from this page. You will first see what it contains: nothing changes until you confirm. A session backup only replaces that session’s articles. Administrator only.</p><form class=\"noprint\" id=\"restaurer\" data-lecture=\"Reading the file…\" data-choisir=\"Choose a file first.\" data-apercu=\"What this backup contains\" data-fichier=\"File\" data-date=\"Backup date\" data-inconnue=\"not given (older backup)\" data-journal=\"Journal\" data-session=\"One session only\" data-articles=\"Articles\" data-photos=\"Photos\" data-sections=\"Sections\" data-comptes=\"Team accounts\" data-avertir=\"Restoring puts back this backup’s articles, photos, sections and accounts over the current content; articles written since are kept. Just before, the journal automatically keeps a copy of the current state, which you can download.\" data-confirmer=\"Restore this backup\" data-annuler=\"Cancel\" data-fait=\"Backup restored. Reload the newsroom to see the content.\" data-auto=\"Copy of the state before restoring:\" data-telecharger=\"download it\" data-echec=\"Nothing changed:\"><label class=\"choix-fichier\"><span class=\"choix-fichier-etiquette\">Backup file (ZIP)</span><span class=\"choix-fichier-bouton\"><span class=\"bouton\">Choose a file</span><input class=\"choix-fichier-input\" type=\"file\" name=\"archive\" accept=\".zip,application/zip\" required></span><span class=\"choix-fichier-nom\" id=\"choix-fichier-nom\" data-choix-nom aria-live=\"polite\">No file chosen</span></label> <button type=\"submit\">Show its content</button></form><div id=\"restaurer-etat\" role=\"status\" tabindex=\"-1\"></div>",
    updateTitle: "Update",
    line: "Newsroom",
    installed: "Installed version",
    offered: "Offered version",
    none: "No new version is prepared on this server.",
    latest: "<h2>Install the latest version</h2><ol><li>Download the full backup (Backup page).</li><li><a href=\"https://github.com/azdak919/le-socle/releases/latest/download/le-socle-php.zip\">Download le-socle-php.zip</a> (what is new is on the <a href=\"https://github.com/azdak919/le-socle/releases/latest\">latest release page</a>).</li><li>Unzip it: you get a folder named “socle”. Copy its content into the newsroom folder on the server, replacing the existing files, without touching the “donnees” folder (your articles, photos and accounts).</li></ol>",
    backupWill: "Program backup, before",
    notContent: "The journal content is not in this backup.",
    major: "This version breaks something. I confirm.",
    updateBtn: "Update",
    revert: "Restore the backup",
    done: "The update worked.",
    reverted: "The previous version is back.",
    noBackup: "No program backup.",
  },
} as const;

function langOf(url: URL): Lang {
  return url.searchParams.get("lang") === "en" ? "en" : "fr";
}

function withLang(path: string, lang: Lang): string {
  if (lang === "fr") return path;
  return path.includes("?") ? `${path}&lang=en` : `${path}?lang=en`;
}

// Nom du journal servi par ce socle (un socle = un journal), pour l’en-tête
// des pages Sauvegarde, Mise à jour et suivantes. Vide : journal pas encore
// configuré, l’en-tête montre alors le logo et le nom du Socle.
let journalName = "";
export function setAdminJournalName(name: unknown): void {
  journalName = typeof name === "string" ? name.trim() : "";
}

function adminBrandHtml(sub: string): string {
  const titre = journalName || "Le Socle";
  return `${socleBriqueHtml("logo")}<span><strong>${escapeHtml(titre)}</strong><small>${sub}</small></span>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function adminDocument(lang: Lang, title: string, body: string): Result {
  const copy = COPY[lang];
  const other = withLang("/admin", copy.otherLang === "en" ? "en" : "fr");
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html>
<html lang="${copy.html}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}${journalName ? ` — ${escapeHtml(journalName)}` : ""}</title>
${socleFavicons()}
<style>
  :root { --primary: #6d2350; --fg: #1f1a1d; --muted: #6b6468; --border: #e9e3e6; --bg: #fdfcfd; --card: #fff; --accent: #f8eff4; --radius: 0.625rem; color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.5; color: var(--fg); background: var(--bg); }
  a { color: var(--primary); }
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
  .skip { position: absolute; left: -999px; }
  .skip:focus { left: 0.5rem; top: 0.5rem; background: #fff; padding: 0.5rem; z-index: 2; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.5rem; padding: 0.75rem 1.25rem; background: #fff; border-bottom: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: 0.6rem; color: var(--fg); text-decoration: none; }
  .brand .logo, .brand .socle-brique { display: block; width: 2.35rem; height: 2.35rem; flex: none; border-radius: 0.4rem; object-fit: contain; }
  .socle-brique-sombre { display: none; }
  @media (prefers-color-scheme: dark) { .socle-brique-clair { display: none; } .socle-brique-sombre { display: block; } }
  .brand strong { display: block; font-size: 0.9rem; line-height: 1.2; }
  .brand small { display: block; color: var(--muted); font-size: 0.75rem; }
  .tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-left: auto; }
  .tabs a { padding: 0.4rem 0.7rem; border-radius: 0.5rem; color: var(--fg); text-decoration: none; font-size: 0.875rem; }
  .tabs a:hover { background: var(--accent); }
  .tabs a[aria-current="page"] { background: var(--accent); color: var(--primary); font-weight: 600; }
  main { max-width: 52rem; margin: 1.5rem auto; padding: 0 1rem; page: letter; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); padding: 1.25rem 1.5rem 1.5rem; }
  h1 { margin: 0 0 1rem; font-size: 1.5rem; letter-spacing: -0.02em; }
  h2 { margin: 1.5rem 0 0.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); font-size: 1.05rem; }
  h1 + h2 { margin-top: 0; padding-top: 0; border-top: 0; }
  p { margin: 0.5rem 0; }
  ol { margin: 0.5rem 0; padding-left: 1.25rem; } li { margin: 0.25rem 0; }
  .muted, .aide { color: var(--muted); font-size: 0.875rem; }
  .fiche { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0.5rem 0; }
  .fiche dt { color: var(--muted); }
  .fiche dd { margin: 0; font-weight: 600; }
  .note { background: var(--accent); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.75rem 1rem; }
  label { display: inline-flex; align-items: center; gap: 0.4rem; margin: 0.15rem 1rem 0.15rem 0; }
  ul.liens { list-style: none; padding: 0; margin: 0.5rem 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button, .bouton { display: inline-flex; align-items: center; min-height: 2.25rem; padding: 0.45rem 0.9rem; border: 1px solid var(--border); border-radius: 0.5rem; background: #fff; color: var(--fg); font: inherit; font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer; }
  button:hover, .bouton:hover { background: var(--accent); }
  button[type="submit"]:not(.secondaire), .bouton.principal { background: var(--primary); border-color: var(--primary); color: #fff; }
  input[type="file"] { font: inherit; font-size: 0.875rem; max-width: 100%; }
  label.choix-fichier { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; margin: 0.35rem 0; }
  .choix-fichier-etiquette { font-weight: 500; }
  .choix-fichier-bouton { position: relative; display: inline-flex; }
  .choix-fichier-input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; opacity: 0; cursor: pointer; }
  .choix-fichier-input:focus, .choix-fichier-input:focus-visible { outline: none; }
  .choix-fichier-bouton:focus-within .bouton { outline: 3px solid var(--primary); outline-offset: 2px; }
  .choix-fichier-nom { color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; min-width: 0; }
  button.danger { background: #991b1b; border-color: #991b1b; color: #fff; }
  button.danger:hover { background: #7f1d1d; }
  button:disabled { opacity: 0.6; cursor: default; }
  h3 { margin: 1rem 0 0.25rem; font-size: 0.95rem; }
  .versions { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.9rem; }
  .versions th, .versions td { text-align: left; vertical-align: top; padding: 0.5rem 0.75rem 0.5rem 0; border-bottom: 1px solid var(--border); }
  .versions thead th { color: var(--muted); font-weight: 500; font-size: 0.8rem; }
  .versions tbody th small { display: block; color: var(--muted); font-weight: 400; font-size: 0.8rem; }
  .nouveautes ul { margin: 0.25rem 0 0.75rem; padding-left: 1.25rem; } .nouveautes li { margin: 0.3rem 0; }
  #restaurer label { flex-wrap: wrap; }
  form { margin: 0.75rem 0; }
  @page letter { size: letter; }
  @page legal { size: legal; }
  @page tabloid { size: tabloid; }
  @page a4 { size: A4; }
  @page a3 { size: A3; }
  @media (max-width: 40rem) { .tabs { margin-left: 0; width: 100%; } main { margin-top: 1rem; padding: 0 0.6rem; } .panel { padding: 1rem; } }
  .powered { margin: 1.5rem auto 2rem; padding: 0 1rem; max-width: 52rem; font-size: 0.75rem; color: var(--muted); }
  .powered a { color: inherit; }
  @media print { nav, .noprint, .bar { display: none; } .panel { border: 0; padding: 0; } }
</style>
</head>
<body>
<a class="skip" href="#contenu">${copy.skip}</a>
<header class="bar noprint">
<a class="brand" href="${withLang("/admin", lang)}">${adminBrandHtml(copy.brandSub)}</a>
<nav class="tabs" aria-label="${copy.office}">
<a href="${withLang("/admin", lang)}">${copy.back}</a>
<a href="${withLang("/admin/sauvegarde", lang)}"${title === copy.saveTitle ? ' aria-current="page"' : ""}>${copy.saveLink}</a>
<a href="${withLang("/admin/mise-a-jour", lang)}"${title === copy.updateTitle ? ' aria-current="page"' : ""}>${copy.updateLink}</a>
<a href="${other}" hreflang="${copy.otherLang}">${copy.other}</a>
</nav>
</header>
<main id="contenu">
<div class="panel">
<h1>${title}</h1>
${body}
</div>
</main>
<p class="powered noprint">${copy.powered} <a href="https://socle.le-radar.ca/">Le Socle</a> ${VERSION}</p>
</body>
</html>`,
  };
}

function majorOf(version: string): number {
  const part = version.split(".")[0] ?? "0";
  const value = Number(part);
  return Number.isFinite(value) ? value : 0;
}

export function programBackupName(from: string, to: string): string {
  return `socle-${from}-vers-${to}.json`;
}

type ProgramBackup = { line: "socle"; from: string; to: string; at: string };

function writeProgramBackup(dir: string, from: string, to: string, at: string): string {
  mkdirSync(dir, { recursive: true });
  const name = programBackupName(from, to);
  const body = JSON.stringify({ line: "socle", from, to, at } satisfies ProgramBackup);
  writeFileSync(join(dir, name), body);
  writeFileSync(join(dir, "latest.json"), body);
  return name;
}

function readProgramBackup(dir: string): ProgramBackup | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as ProgramBackup;
    if (parsed.line !== "socle" || typeof parsed.from !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

const SEASONS = ["automne", "hiver", "ete"] as const;

/** `/admin` et les pages sous `/admin/…`, avec ou sans barre finale. */
export function canonicalAdminPath(path: string): string {
  if (path !== "/admin" && !path.startsWith("/admin/")) return path;
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
}

export async function handleAdmin(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
  actor?: string | null,
): Promise<Result> {
  const parsed = new URL(url, "http://127.0.0.1");
  const path = canonicalAdminPath(parsed.pathname);
  const lang = langOf(parsed);
  const copy = COPY[lang];
  const exportOn = config.modules.export;

  if (path === "/admin" && method === "GET") {
    // Une seule admin : avec le module éditorial, c'est la rédaction. Ces pages
    // restent le recours sans JavaScript, atteintes depuis elle.
    if (config.modules.editorial && !parsed.searchParams.has("outils")) return { status: 303, body: "", headers: { location: "/redaction/" } };
    const downloaded = exportOn ? await wasDownloaded(deps.store) : false;
    const notice = !exportOn || !downloaded ? `<p><strong>${copy.notice}</strong></p>` : "";
    const articlesLink = config.modules.editorial
      ? `<p><a href="${withLang("/admin/articles", lang)}">${copy.articlesLink}</a></p>`
      : "";
    const reviewLink = config.modules.editorial || config.modules.review
      ? `<p><a href="${withLang("/admin/relecture", lang)}">${copy.reviewLink}</a></p>`
      : "";
    const writing = `${articlesLink}${reviewLink}`;
    const media = config.modules.media
      ? `<p><a href="${withLang("/admin/medias", lang)}">${copy.mediaLink}</a></p>`
      : "";
    const audience = config.modules.audience
      ? `<p><a href="${withLang("/admin/audience", lang)}">${copy.audienceLink}</a></p>`
      : "";
    const notify = config.modules.notify
      ? `<p><a href="${withLang("/admin/abonnements", lang)}">${copy.notifyLink}</a></p>`
      : "";
    return adminDocument(lang, copy.office, `${notice}${writing}${media}${audience}${notify}<p><a href="${withLang("/admin/sauvegarde", lang)}">${copy.saveLink}</a></p><p><a href="${withLang("/admin/mise-a-jour", lang)}">${copy.updateLink}</a></p>`);
  }

  if (path === "/admin/sauvegarde/activer" && method === "POST") {
    config.modules.export = true;
    deps.saveConfig?.(config);
    await deps.store.migrate(enabledModules(config));
    return { status: 303, body: "", headers: { location: withLang("/admin/sauvegarde", lang) } };
  }

  if (!exportOn && path !== "/admin/mise-a-jour" && path !== "/admin/mise-a-jour/revenir") {
    if (path === "/admin/sauvegarde" && method === "GET") {
      return adminDocument(lang, copy.saveTitle, `<p class="note">${copy.off}</p><form class="noprint" method="post" action="${withLang("/admin/sauvegarde/activer", lang)}"><button type="submit">${copy.activate}</button></form>`);
    }
    return { status: 404, body: "", headers: {} };
  }

  if (path === "/admin/sauvegarde" && method === "GET") {
    const prefs = await readPrefs(deps.store, deps.now());
    const years = [...new Set([...defaultYears(deps.now()), ...prefs.years])].sort((a, b) => b - a);
    const boxes = years.map((year) => {
      const checked = prefs.years.includes(year) ? " checked" : "";
      return `<label><input type="checkbox" name="year" value="${year}"${checked}> ${year}</label>`;
    }).join(" ");
    const named = (await sessionsIn(deps.store)).filter((session) => isSessionName(session) && !SEASONS.includes(session as typeof SEASONS[number]));
    const sessions = [...SEASONS, ...named];
    const links = sessions.map((session) => {
      const href = withLang(`/admin/sauvegarde/session.zip?session=${encodeURIComponent(session)}`, lang);
      return `<li><a class="bouton" href="${href}">${copy.sessionOf} ${session === "ete" ? "été" : session}</a></li>`;
    }).join("");
    return adminDocument(lang, copy.saveTitle, `<p>${copy.saveIntro}</p>
<p class="noprint"><a class="bouton principal" href="${withLang("/admin/sauvegarde/site.zip", lang)}">${copy.downloadSite}</a></p>
<h2>${copy.yearsTitle}</h2>
<p class="aide">${copy.yearsHelp}</p>
<form class="noprint" method="post" action="${withLang("/admin/sauvegarde/prefs", lang)}"><p>${boxes}</p><p><button type="submit" class="secondaire">${copy.savePrefs}</button></p></form>
<h2>${copy.sessionsTitle}</h2>
<p class="aide">${copy.sessionsHelp}</p>
<ul class="liens noprint">${links}</ul>
${copy.restoreHint}<script>${restoreScript()}</script>`);
  }

  if (path === "/admin/sauvegarde/prefs" && method === "POST") {
    const text = new TextDecoder().decode(rawBody);
    const years = text.includes("{")
      ? (JSON.parse(text) as { years: number[] }).years
      : [...new URLSearchParams(text).getAll("year").map(Number)];
    await writePrefs(deps.store, { years });
    return { status: 303, body: "", headers: { location: withLang("/admin/sauvegarde", lang) } };
  }

  if (path === "/admin/sauvegarde/site.zip" && method === "GET") {
    const zip = await buildSiteZip(deps.store, deps.now());
    await markDownloaded(deps.store);
    return { status: 200, body: zip, headers: { "content-type": "application/zip" } };
  }

  if (path === "/admin/sauvegarde/session.zip" && method === "GET") {
    const session = parsed.searchParams.get("session") ?? "";
    if (!isSessionName(session)) {
      return { status: 400, body: "session inconnue", headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    const zip = await buildSessionZip(deps.store, session);
    await markDownloaded(deps.store);
    return { status: 200, body: zip, headers: { "content-type": "application/zip" } };
  }

  // Restauration en deux temps, comme en PHP : résumé sans rien écrire, puis,
  // après confirmation, copie automatique de l'état actuel et restauration.
  if (path === "/admin/sauvegarde/restaurer/apercu" && method === "POST") {
    try {
      const resume = archiveSummary(rawBody);
      return jsonResult(200, { jeton: stashRestore(rawBody), resume });
    } catch (error) {
      return jsonResult(400, { error: error instanceof Error ? error.message : "archive illisible" });
    }
  }

  if (path === "/admin/sauvegarde/restaurer" && method === "POST") {
    try {
      const head = new TextDecoder().decode(rawBody.subarray(0, 64)).trimStart();
      let bytes = rawBody;
      if (head.startsWith("{")) {
        const parsedBody = JSON.parse(new TextDecoder().decode(rawBody)) as { jeton?: unknown };
        bytes = unstashRestore(String(parsedBody.jeton ?? ""));
      }
      archiveSummary(bytes);
      const auto = await autoBackup(deps, deps.now());
      const report = await restoreZip(deps.store, bytes);
      return jsonResult(200, { ...report, sauvegardeAuto: auto });
    } catch (error) {
      return jsonResult(400, { error: error instanceof Error ? error.message : "restauration impossible" });
    }
  }

  const autoMatch = /^\/admin\/sauvegarde\/auto\/(avant-restauration-[0-9-]+\.zip)$/.exec(path);
  if (autoMatch && method === "GET") {
    const file = join(deps.backupDir, "avant-restauration", autoMatch[1]);
    if (!existsSync(file)) return { status: 404, body: "", headers: {} };
    return {
      status: 200,
      body: new Uint8Array(readFileSync(file)),
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${autoMatch[1]}"` },
    };
  }

  if (path === "/admin/mise-a-jour" && method === "GET") {
    const current = deps.version();
    const offered = deps.release();
    const offer = offered
      ? `<dt>${copy.offered}</dt><dd>${offered.version}</dd></dl><p>${offered.notes}</p>`
      : `</dl><p class="aide">${copy.none}</p>`;
    const major = offered !== null && majorOf(offered.version) !== majorOf(current);
    const extra = major ? `<label><input type="checkbox" name="confirmMajor" value="1"> ${copy.major}</label>` : "";
    const named = offered ? programBackupName(current, offered.version) : "";
    const backup = offered
      ? `<p class="note">${copy.backupWill} : ${named}. ${copy.notContent}</p>`
      : "";
    const saved = readProgramBackup(deps.backupDir);
    const allowed = await mayUpdate(deps.store, actor);
    const revert = allowed && saved
      ? `<form class="noprint" method="post" action="${withLang("/admin/mise-a-jour/revenir", lang)}"><button type="submit" class="secondaire">${copy.revert}</button></form>`
      : "";
    const form = allowed && offered
      ? `<form class="noprint" method="post" action="${withLang("/admin/mise-a-jour", lang)}">
${extra}
<p><button type="submit" name="confirm" value="1">${copy.updateBtn}</button></p>
</form>`
      : "";
    return adminDocument(lang, copy.updateTitle, `<dl class="fiche"><dt>${copy.installed}</dt><dd>${current}</dd>${offer}${backup}
${form}
${revert}
${copy.latest}`);
  }

  if (path === "/admin/mise-a-jour" && method === "POST") {
    if (!(await mayUpdate(deps.store, actor))) {
      return { status: 403, body: "réservé à l’administrateur", headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    const offered = deps.release();
    if (!offered) return { status: 409, body: "rien à mettre à jour", headers: { "content-type": "text/plain; charset=utf-8" } };
    const text = new TextDecoder().decode(rawBody);
    const params = new URLSearchParams(text);
    if (majorOf(offered.version) !== majorOf(deps.version()) && params.get("confirmMajor") !== "1") {
      return { status: 409, body: "version majeure en attente", headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    const previous = deps.version();
    writeProgramBackup(deps.backupDir, previous, offered.version, deps.now().toISOString());
    try {
      await deps.setVersion(offered.version);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { status: 500, body: previous, headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    return adminDocument(lang, copy.updateTitle, `<p class="note">${copy.done}</p><dl class="fiche"><dt>${copy.installed}</dt><dd>${deps.version()}</dd></dl>`);
  }

  if (path === "/admin/mise-a-jour/revenir" && method === "POST") {
    if (!(await mayUpdate(deps.store, actor))) {
      return { status: 403, body: "réservé à l’administrateur", headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    const saved = readProgramBackup(deps.backupDir);
    if (!saved) return { status: 409, body: COPY[lang].noBackup, headers: { "content-type": "text/plain; charset=utf-8" } };
    const previous = deps.version();
    try {
      await deps.setVersion(saved.from);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { status: 500, body: previous, headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    return adminDocument(lang, copy.updateTitle, `<p class="note">${copy.reverted}</p><dl class="fiche"><dt>${copy.installed}</dt><dd>${deps.version()}</dd></dl>`);
  }

  return { status: 404, body: "", headers: {} };
}
