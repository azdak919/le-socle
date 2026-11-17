import { membersForArchive, restoreMembers } from "./auth.ts";
import type { SocleStore } from "./store.ts";
import { ModuleOffError } from "./store.ts";
import { textFile, unzip, zipStore, type ZipFile } from "./zip.ts";

export type ArticleRecord = {
  id: string;
  title: string;
  year: number;
  session: string;
  status: string;
  markdown: string;
};

export type ArchivePrefs = {
  years: number[];
};

const FILE_NAMES = ["kiosque.config.ts", "theme/tokens.css", "OWNERS.md"] as const;
const SECRET_LINE = /(token|password|secret|api[_-]?key|authorization)\s*[:=]/i;

export function civilYear(date: Date): number {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
  }).format(date);
  return Number(formatted);
}

export function defaultYears(date: Date): number[] {
  const year = civilYear(date);
  return [year, year - 1];
}

export async function readPrefs(store: SocleStore, now: Date): Promise<ArchivePrefs> {
  const raw = await store.get("export", "prefs");
  if (!raw) return { years: defaultYears(now) };
  const parsed = JSON.parse(raw) as ArchivePrefs;
  if (!Array.isArray(parsed.years)) return { years: defaultYears(now) };
  return { years: parsed.years.map(Number) };
}

export async function writePrefs(store: SocleStore, prefs: ArchivePrefs): Promise<void> {
  await store.put("export", "prefs", JSON.stringify({ years: prefs.years }));
}

export function isSessionName(value: string): boolean {
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,40}$/u.test(value);
}

function stripSecrets(text: string): string {
  return text.split("\n").filter((line) => !SECRET_LINE.test(line)).join("\n");
}

async function rowsOf(store: SocleStore, module: "export" | "editorial"): Promise<Array<{ key: string; value: string }>> {
  try {
    return await store.list(module);
  } catch (error) {
    if (error instanceof ModuleOffError) return [];
    throw error;
  }
}

function recordFromEditorial(value: string): ArticleRecord | null {
  const parsed = JSON.parse(value) as {
    id?: string;
    title?: string;
    status?: string;
    session?: string;
    publishedAt?: string;
    updatedAt?: string;
    body?: { raw?: string };
  };
  if (!parsed.id || !parsed.title) return null;
  const when = parsed.publishedAt ?? parsed.updatedAt;
  if (!when) return null;
  const year = civilYear(new Date(when));
  if (!Number.isFinite(year)) return null;
  return {
    id: parsed.id,
    title: parsed.title,
    year,
    session: typeof parsed.session === "string" ? parsed.session : "",
    status: parsed.status ?? "draft",
    markdown: parsed.body?.raw ?? "",
  };
}

async function articlesOf(store: SocleStore): Promise<ArticleRecord[]> {
  const byId = new Map<string, ArticleRecord>();
  for (const row of await rowsOf(store, "export")) {
    if (!row.key.startsWith("article:")) continue;
    const article = JSON.parse(row.value) as ArticleRecord;
    byId.set(article.id, article);
  }
  for (const row of await rowsOf(store, "editorial")) {
    if (!row.key.startsWith("article:")) continue;
    const article = recordFromEditorial(row.value);
    if (article) byId.set(article.id, article);
  }
  return [...byId.values()];
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

function articleHtml(article: ArticleRecord): string {
  return htmlPage(article.title, `<p>${escapeHtml(String(article.year))} · ${escapeHtml(article.session)} · ${escapeHtml(article.status)}</p>
<pre>${escapeHtml(article.markdown)}</pre>`);
}

export async function buildSiteZip(store: SocleStore, now: Date): Promise<Uint8Array> {
  const prefs = await readPrefs(store, now);
  const articles = await articlesOf(store);
  const included = articles.filter((article) => prefs.years.includes(article.year));
  const presentYears = [...new Set(articles.map((article) => article.year))].sort();
  const excluded = presentYears.filter((year) => !prefs.years.includes(year));
  const files: ZipFile[] = [];
  files.push(textFile("manifest.json", JSON.stringify({
    kind: "site",
    includedYears: prefs.years,
    excludedYears: excluded,
    note: "Les années plus anciennes ne sont pas dans ce fichier. Une archive antérieure est supposée les contenir. Ce programme ne peut pas le vérifier.",
  }, null, 2)));
  const links = included.map((article) => `<li><a href="html/${escapeHtml(article.id)}.html">${escapeHtml(article.title)}</a></li>`).join("\n");
  files.push(textFile("index.html", htmlPage("Sauvegarde", `<ul>\n${links}\n</ul>`)));
  for (const article of included) {
    files.push(textFile(`content/articles/${article.id}.md`, article.markdown));
    files.push(textFile(`content/articles/${article.id}.json`, JSON.stringify(article, null, 2)));
    files.push(textFile(`html/${article.id}.html`, articleHtml(article)));
  }
  const rows = await store.list("export");
  for (const name of FILE_NAMES) {
    const row = rows.find((item) => item.key === `file:${name}`);
    if (!row) continue;
    files.push(textFile(name, stripSecrets(row.value)));
  }
  for (const row of rows) {
    if (!row.key.startsWith("media:")) continue;
    const path = row.key.slice("media:".length);
    const used = included.some((article) => article.markdown.includes(path));
    if (!used) continue;
    files.push({ name: path, data: Buffer.from(row.value, "base64") });
    const credit = rows.find((item) => item.key === `credit:${path}`);
    if (credit) files.push(textFile(`${path}.credit`, credit.value));
  }
  for (const row of await rowsOf(store, "editorial")) {
    if (!row.key.startsWith("bytes:")) continue;
    const path = row.key.slice("bytes:".length);
    const used = included.some((article) => article.markdown.includes(path));
    if (!used) continue;
    files.push({ name: path, data: Buffer.from(row.value, "base64") });
  }
  const members = await membersForArchive(store);
  if (members.length > 0) files.push(textFile("auth/members.json", JSON.stringify(members, null, 2)));
  return zipStore(files);
}

export function emptySiteZip(): Uint8Array {
  return zipStore([
    textFile("manifest.json", JSON.stringify({
      kind: "site",
      includedYears: [],
      excludedYears: [],
      note: "Les années plus anciennes ne sont pas dans ce fichier. Une archive antérieure est supposée les contenir. Ce programme ne peut pas le vérifier.",
    }, null, 2)),
    textFile("index.html", htmlPage("Sauvegarde", "<p>Aucun article.</p>")),
  ]);
}

export async function sessionsIn(store: SocleStore): Promise<string[]> {
  const names = (await articlesOf(store)).map((article) => article.session);
  return [...new Set(names)];
}

export async function buildSessionZip(store: SocleStore, session: string): Promise<Uint8Array> {
  const articles = (await articlesOf(store)).filter((article) => article.session === session);
  const includedYears = [...new Set(articles.map((article) => article.year))].sort();
  const files: ZipFile[] = [
    textFile("manifest.json", JSON.stringify({ kind: "session", session, includedYears }, null, 2)),
    textFile("index.html", htmlPage(
      `Session ${session}`,
      `<ul>\n${articles.map((article) => `<li><a href="html/${escapeHtml(article.id)}.html">${escapeHtml(article.title)}</a></li>`).join("\n")}\n</ul>`,
    )),
  ];
  for (const article of articles) {
    files.push(textFile(`content/articles/${article.id}.md`, article.markdown));
    files.push(textFile(`content/articles/${article.id}.json`, JSON.stringify(article, null, 2)));
    files.push(textFile(`html/${article.id}.html`, articleHtml(article)));
  }
  return zipStore(files);
}

export async function restoreZip(store: SocleStore, bytes: Uint8Array): Promise<{ excludedYears: number[]; session: string | null }> {
  const files = unzip(bytes);
  const manifestRaw = files.get("manifest.json");
  if (!manifestRaw) throw new Error("manifest manquant");
  const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as {
    kind: string;
    session?: string;
    excludedYears?: number[];
    includedYears?: number[];
  };
  if (manifest.kind === "session") {
    const session = manifest.session ?? "";
    for (const [name, data] of files) {
      if (!name.endsWith(".json") || !name.startsWith("content/articles/")) continue;
      const article = JSON.parse(new TextDecoder().decode(data)) as ArticleRecord;
      if (article.session !== session) continue;
      await store.put("export", `article:${article.id}`, JSON.stringify(article));
    }
    return { excludedYears: [], session };
  }
  for (const name of FILE_NAMES) {
    const data = files.get(name);
    if (data) await store.put("export", `file:${name}`, new TextDecoder().decode(data));
  }
  for (const [name, data] of files) {
    if (!name.endsWith(".json") || !name.startsWith("content/articles/")) continue;
    const article = JSON.parse(new TextDecoder().decode(data)) as ArticleRecord;
    await store.put("export", `article:${article.id}`, JSON.stringify(article));
  }
  for (const [name, data] of files) {
    if (!name.startsWith("media/")) continue;
    await store.put("export", `media:${name}`, Buffer.from(data).toString("base64"));
  }
  const membersFile = files.get("auth/members.json");
  if (membersFile) {
    await restoreMembers(store, JSON.parse(new TextDecoder().decode(membersFile)) as unknown);
  }
  return { excludedYears: manifest.excludedYears ?? [], session: null };
}

export async function markDownloaded(store: SocleStore): Promise<void> {
  await store.put("export", "downloaded", "1");
}

export async function wasDownloaded(store: SocleStore): Promise<boolean> {
  return (await store.get("export", "downloaded")) === "1";
}
