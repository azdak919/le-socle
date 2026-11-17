import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildSessionZip,
  buildSiteZip,
  defaultYears,
  isSessionName,
  markDownloaded,
  readPrefs,
  restoreZip,
  sessionsIn,
  wasDownloaded,
  writePrefs,
} from "./archive.ts";
import { enabledModules, type SocleConfig } from "./config.ts";
import type { SocleStore } from "./store.ts";

export type ReleaseInfo = { version: string; notes: string };

export type AdminDeps = {
  store: SocleStore;
  now: () => Date;
  release: () => ReleaseInfo | null;
  version: () => string;
  setVersion: (version: string) => Promise<void>;
  backupDir: string;
  saveConfig?: (config: SocleConfig) => void;
};

type Result = { status: number; body: string | Uint8Array; headers: Record<string, string> };
type Lang = "fr" | "en";

const COPY = {
  fr: {
    html: "fr",
    skip: "Aller au contenu",
    back: "Retour",
    other: "English",
    otherLang: "en",
    office: "Back-office",
    notice: "Allumez la sauvegarde et téléchargez l'archive. Si le serveur est perdu, réinstallez avec le configurateur du Kiosque et choisissez cette archive.",
    saveLink: "Sauvegarde",
    updateLink: "Mise à jour",
    articlesLink: "Articles",
    reviewLink: "Relecture",
    mediaLink: "Médias",
    saveTitle: "Sauvegarde",
    off: "La sauvegarde est éteinte.",
    activate: "Activer",
    yearsHelp: "L'année en cours et la précédente sont cochées au départ. Les années plus anciennes restent décochées : une archive antérieure est supposée les contenir. Ce programme ne peut pas le vérifier.",
    savePrefs: "Enregistrer",
    downloadSite: "Télécharger le site",
    sessionOf: "Session",
    articlesOnly: "articles seulement",
    restoreHint: "La restauration se fait en envoyant l'archive à cette adresse.",
    updateTitle: "Mise à jour",
    line: "Socle",
    installed: "Version en place",
    offered: "Version proposée",
    none: "Aucune version proposée. Sans réseau, seule la version en place est affichée.",
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
    back: "Back",
    other: "Français",
    otherLang: "fr",
    office: "Back office",
    notice: "Turn backup on and download the archive. If the server is lost, reinstall with the Kiosque configurator and choose that archive.",
    saveLink: "Backup",
    updateLink: "Update",
    articlesLink: "Articles",
    reviewLink: "Review",
    mediaLink: "Media",
    saveTitle: "Backup",
    off: "Backup is off.",
    activate: "Turn on",
    yearsHelp: "The current year and the previous one start checked. Older years stay unchecked: an earlier archive is assumed to hold them. This program cannot check that.",
    savePrefs: "Save",
    downloadSite: "Download the site",
    sessionOf: "Session",
    articlesOnly: "articles only",
    restoreHint: "Restore by sending the archive to this address.",
    updateTitle: "Update",
    line: "Socle",
    installed: "Installed version",
    offered: "Offered version",
    none: "No offered version. Offline, only the installed version is shown.",
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
<title>${title}</title>
<style>
  body { font-family: sans-serif; line-height: 1.45; color: #111; background: #fff; }
  a:focus, button:focus, input:focus { outline: 3px solid #111; outline-offset: 2px; }
  .skip { position: absolute; left: -999px; }
  .skip:focus { left: 0.5rem; top: 0.5rem; background: #fff; }
  @page letter { size: letter; }
  @page legal { size: legal; }
  @page tabloid { size: tabloid; }
  @page a4 { size: A4; }
  @page a3 { size: A3; }
  main { page: letter; }
  @media print { nav, .noprint { display: none; } }
</style>
</head>
<body>
<a class="skip" href="#contenu">${copy.skip}</a>
<main id="contenu">
<h1>${title}</h1>
${body}
</main>
<nav class="noprint">
<p><a href="${withLang("/admin", lang)}">${copy.back}</a></p>
<p><a href="${other}" hreflang="${copy.otherLang}">${copy.other}</a></p>
</nav>
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

export async function handleAdmin(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
): Promise<Result> {
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname;
  const lang = langOf(parsed);
  const copy = COPY[lang];
  const exportOn = config.modules.export;

  if (path === "/admin" && method === "GET") {
    const downloaded = exportOn ? await wasDownloaded(deps.store) : false;
    const notice = !exportOn || !downloaded ? `<p><strong>${copy.notice}</strong></p>` : "";
    const writing = config.modules.editorial
      ? `<p><a href="${withLang("/admin/articles", lang)}">${copy.articlesLink}</a></p><p><a href="${withLang("/admin/relecture", lang)}">${copy.reviewLink}</a></p>`
      : "";
    const media = config.modules.media
      ? `<p><a href="${withLang("/admin/medias", lang)}">${copy.mediaLink}</a></p>`
      : "";
    return adminDocument(lang, copy.office, `${notice}${writing}${media}<p><a href="${withLang("/admin/sauvegarde", lang)}">${copy.saveLink}</a></p><p><a href="${withLang("/admin/mise-a-jour", lang)}">${copy.updateLink}</a></p>`);
  }

  if (path === "/admin/sauvegarde/activer" && method === "POST") {
    config.modules.export = true;
    deps.saveConfig?.(config);
    await deps.store.migrate(enabledModules(config));
    return { status: 303, body: "", headers: { location: withLang("/admin/sauvegarde", lang) } };
  }

  if (!exportOn) {
    if (path === "/admin/sauvegarde" && method === "GET") {
      return adminDocument(lang, copy.saveTitle, `<p>${copy.off}</p><form class="noprint" method="post" action="${withLang("/admin/sauvegarde/activer", lang)}"><button type="submit">${copy.activate}</button></form>`);
    }
    return { status: 404, body: "", headers: {} };
  }

  if (path === "/admin/sauvegarde" && method === "GET") {
    const prefs = await readPrefs(deps.store, deps.now());
    const years = [...new Set([...defaultYears(deps.now()), ...prefs.years])].sort((a, b) => b - a);
    const boxes = years.map((year) => {
      const checked = prefs.years.includes(year) ? " checked" : "";
      return `<label><input type="checkbox" name="year" value="${year}"${checked}> ${year}</label>`;
    }).join("<br>");
    const named = (await sessionsIn(deps.store)).filter((session) => isSessionName(session) && !SEASONS.includes(session as typeof SEASONS[number]));
    const sessions = [...SEASONS, ...named];
    const links = sessions.map((session) => {
      const href = withLang(`/admin/sauvegarde/session.zip?session=${encodeURIComponent(session)}`, lang);
      return `<li><a href="${href}">${copy.sessionOf} ${session}, ${copy.articlesOnly}</a></li>`;
    }).join("");
    return adminDocument(lang, copy.saveTitle, `<p>${copy.yearsHelp}</p>
<form class="noprint" method="post" action="${withLang("/admin/sauvegarde/prefs", lang)}">${boxes}<p><button type="submit">${copy.savePrefs}</button></p></form>
<p class="noprint"><a href="${withLang("/admin/sauvegarde/site.zip", lang)}">${copy.downloadSite}</a></p>
<ul class="noprint">${links}</ul>
<p>${copy.restoreHint}</p>`);
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

  if (path === "/admin/sauvegarde/restaurer" && method === "POST") {
    const report = await restoreZip(deps.store, rawBody);
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(report),
    };
  }

  if (path === "/admin/mise-a-jour" && method === "GET") {
    const current = deps.version();
    const offered = deps.release();
    const offer = offered
      ? `<p>${copy.offered} : ${offered.version}. ${offered.notes}</p>`
      : `<p>${copy.none}</p>`;
    const major = offered !== null && majorOf(offered.version) !== majorOf(current);
    const extra = major ? `<label><input type="checkbox" name="confirmMajor" value="1"> ${copy.major}</label>` : "";
    const named = offered ? programBackupName(current, offered.version) : "";
    const backup = offered
      ? `<p>${copy.backupWill} : ${named}. ${copy.notContent}</p>`
      : "";
    const saved = readProgramBackup(deps.backupDir);
    const revert = saved
      ? `<form class="noprint" method="post" action="${withLang("/admin/mise-a-jour/revenir", lang)}"><button type="submit">${copy.revert}</button></form>`
      : "";
    return adminDocument(lang, copy.updateTitle, `<h2>${copy.line}</h2><p>${copy.installed} : ${current}.</p>${offer}${backup}
<form class="noprint" method="post" action="${withLang("/admin/mise-a-jour", lang)}">
${extra}
<p><button type="submit" name="confirm" value="1">${copy.updateBtn}</button></p>
</form>
${revert}`);
  }

  if (path === "/admin/mise-a-jour" && method === "POST") {
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
    return adminDocument(lang, copy.updateTitle, `<h2>${copy.line}</h2><p>${copy.done}</p><p>${copy.installed} : ${deps.version()}.</p>`);
  }

  if (path === "/admin/mise-a-jour/revenir" && method === "POST") {
    const saved = readProgramBackup(deps.backupDir);
    if (!saved) return { status: 409, body: COPY[lang].noBackup, headers: { "content-type": "text/plain; charset=utf-8" } };
    const previous = deps.version();
    try {
      await deps.setVersion(saved.from);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { status: 500, body: previous, headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    return adminDocument(lang, copy.updateTitle, `<h2>${copy.line}</h2><p>${copy.reverted}</p><p>${copy.installed} : ${deps.version()}.</p>`);
  }

  return { status: 404, body: "", headers: {} };
}
