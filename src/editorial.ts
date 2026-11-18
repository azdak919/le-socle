import { randomUUID } from "node:crypto";

import type { SocleStore } from "./store.ts";
import { ModuleOffError } from "./store.ts";

export const SOURCE_ID = "socle";

const STATUSES = ["draft", "in-review", "scheduled", "published", "archived", "retracted"] as const;
export type EditorialStatus = (typeof STATUSES)[number];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class EditorialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorialError";
  }
}

export type SourceMark = {
  backend: string;
  backendId: string;
  fetchedAt: string;
  revision?: string;
};

export type SocleMedia = {
  id: string;
  kind: "image" | "audio" | "video" | "document";
  src: string;
  alt: string;
  credit?: string;
  source: SourceMark;
};

export type SocleArticle = {
  id: string;
  slug: string;
  publication: string;
  title: string;
  excerpt: string;
  body: { format: "markdown"; raw: string };
  lead?: SocleMedia;
  media: SocleMedia[];
  authors: string[];
  section?: string;
  categories: string[];
  tags: string[];
  lang: string;
  status: EditorialStatus;
  isDemo?: boolean;
  /** Mis en avant : seul cet article porte « À la une » sur le site. */
  featured?: boolean;
  publishedAt?: string;
  updatedAt: string;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  scheduledAt?: string;
  session?: string;
  canonicalUrl: string;
  source: SourceMark;
};

export type SocleAuthor = {
  id: string;
  slug: string;
  name: string;
  editorialRole?: "auteur" | "reviseur" | "editeur";
  email?: string;
  isDemo?: boolean;
  source: SourceMark;
};

export type SocleTaxon = { id: string; slug: string; name: string };

export type SoclePublication = {
  id: string;
  slug: string;
  name: string;
  institution: string;
  institutionType: "cegep" | "universite" | "autre";
  lang: string;
  siteUrl: string;
  timeZone: string;
  theme: { accent: string };
  governance: { owner: string; contact: string; repo?: string };
};

type Listener = (event: { kind: string; id?: string }) => void;

function isStatus(value: string): value is EditorialStatus {
  return (STATUSES as readonly string[]).includes(value);
}

function mark(id: string, now: string): SourceMark {
  return { backend: SOURCE_ID, backendId: id, fetchedAt: now };
}

export function mediaPath(src: string): string {
  return src.replace(/^\/+/, "");
}

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

async function rows(store: SocleStore): Promise<Array<{ key: string; value: string }>> {
  try {
    return await store.list("editorial");
  } catch (error) {
    if (error instanceof ModuleOffError) return [];
    throw error;
  }
}

export async function readPublication(store: SocleStore): Promise<SoclePublication | null> {
  return parse<SoclePublication>(await store.get("editorial", "publication"));
}

/** Adresse publique d’un article, d’après l’adresse courante du journal (pas un chemin périmé). */
export function articlePublicUrl(siteUrl: string, slug: string): string {
  return `${siteUrl.replace(/\/$/, "")}/articles/${encodeURIComponent(slug)}/`;
}

/** Quand siteUrl change, les canonicalUrl stockées suivent, pour le flux et les liens. */
export async function refreshCanonicalUrls(store: SocleStore, siteUrl: string): Promise<number> {
  const base = siteUrl.replace(/\/$/, "");
  if (!base) return 0;
  let count = 0;
  for (const article of await readArticles(store)) {
    const slug = String(article.slug ?? "");
    if (!slug || !article.id) continue;
    const next = articlePublicUrl(base, slug);
    if (article.canonicalUrl === next) continue;
    await store.put("editorial", `article:${article.id}`, JSON.stringify({ ...article, canonicalUrl: next }));
    count += 1;
  }
  return count;
}

export async function readArticles(store: SocleStore): Promise<SocleArticle[]> {
  const articles: SocleArticle[] = [];
  for (const row of await rows(store)) {
    if (!row.key.startsWith("article:")) continue;
    articles.push(JSON.parse(row.value) as SocleArticle);
  }
  articles.sort((a, b) => a.slug.localeCompare(b.slug));
  return articles;
}

async function readKind<T extends { id: string }>(store: SocleStore, prefix: string): Promise<T[]> {
  const items: T[] = [];
  for (const row of await rows(store)) {
    if (!row.key.startsWith(prefix)) continue;
    items.push(JSON.parse(row.value) as T);
  }
  return items;
}

export function checkArticle(article: SocleArticle): void {
  if (!article.id) throw new EditorialError("id requis");
  if (!SLUG.test(article.slug)) throw new EditorialError("slug invalide");
  if (!article.title.trim()) throw new EditorialError("titre requis");
  if (!isStatus(article.status)) throw new EditorialError("statut inconnu");
  if (!article.body || typeof article.body.raw !== "string") throw new EditorialError("corps requis");
  if (!ISO.test(article.updatedAt)) throw new EditorialError("updatedAt invalide");
  if (article.scheduledAt && !ISO.test(article.scheduledAt)) throw new EditorialError("scheduledAt invalide");
  if (article.status === "scheduled" && !article.scheduledAt) {
    throw new EditorialError("une publication programmée a besoin d'une heure");
  }
  if (article.reviewedBy && !SLUG.test(article.reviewedBy)) throw new EditorialError("reviewedBy invalide");
  if (article.reviewedAt && !ISO.test(article.reviewedAt)) throw new EditorialError("reviewedAt invalide");
  if (article.submittedAt && !ISO.test(article.submittedAt)) throw new EditorialError("submittedAt invalide");
  if (article.status === "published" || article.status === "archived") {
    if (!article.publishedAt || !ISO.test(article.publishedAt)) throw new EditorialError("date de publication requise");
    if (!article.authors.length) throw new EditorialError("un article publié doit être signé");
    if (!article.section) throw new EditorialError("un article publié doit avoir une section");
    if (!article.body.raw.trim()) throw new EditorialError("un article publié ne peut pas être vide");
  }
}

export async function publishDue(store: SocleStore, now: Date): Promise<number> {
  try {
    await store.get("review", "on");
  } catch (error) {
    if (error instanceof ModuleOffError) return 0;
    throw error;
  }
  const instant = now.toISOString();
  let count = 0;
  for (const article of await readArticles(store)) {
    if (article.status !== "scheduled" || !article.scheduledAt) continue;
    if (Date.parse(article.scheduledAt) > now.getTime()) continue;
    article.status = "published";
    article.publishedAt = article.scheduledAt;
    try {
      await saveArticle(store, article, instant);
      count += 1;
    } catch (error) {
      if (!(error instanceof EditorialError)) throw error;
    }
  }
  return count;
}

export async function saveArticle(store: SocleStore, article: SocleArticle, now: string): Promise<SocleArticle> {
  const next: SocleArticle = {
    ...article,
    updatedAt: now,
    source: { ...article.source, backend: SOURCE_ID, fetchedAt: now },
  };
  if (next.status === "in-review" && !next.submittedAt) next.submittedAt = now;
  checkArticle(next);
  if (!next.featured) delete next.featured;
  await store.put("editorial", `article:${next.id}`, JSON.stringify(next));
  if (next.featured) {
    for (const other of await readArticles(store)) {
      if (other.id === next.id || !other.featured) continue;
      delete other.featured;
      other.updatedAt = now;
      await store.put("editorial", `article:${other.id}`, JSON.stringify(other));
    }
  }
  return next;
}

function publicAuthor(author: SocleAuthor): SocleAuthor {
  const copy = { ...author };
  delete copy.email;
  return copy;
}

export function createSocleSource(store: SocleStore) {
  let ready = false;
  return {
    id: SOURCE_ID,
    capabilities: {
      incremental: true,
      webhooks: false,
      writeBack: true,
      media: "binary" as const,
      taxonomies: ["section", "category", "tag"] as Array<"section" | "category" | "tag">,
      editorialWorkflow: true,
    },
    async init() {
      try {
        await store.list("editorial");
        ready = true;
      } catch (error) {
        if (!(error instanceof ModuleOffError)) throw error;
        ready = false;
      }
    },
    async health() {
      const checkedAt = new Date().toISOString();
      if (!ready) return { ok: false, checkedAt, reason: "not-configured" };
      return { ok: true, checkedAt };
    },
    async fetchPublication() {
      const publication = await readPublication(store);
      if (!publication) throw new EditorialError("publication absente");
      return publication;
    },
    async fetchAuthors() {
      const authors = await readKind<SocleAuthor>(store, "author:");
      return authors.map(publicAuthor);
    },
    async fetchTaxonomies() {
      return {
        sections: await readKind<SocleTaxon>(store, "section:"),
        categories: await readKind<SocleTaxon>(store, "category:"),
        tags: await readKind<SocleTaxon>(store, "tag:"),
      };
    },
    async *fetchArticles(cursor?: { since?: string }) {
      await publishDue(store, new Date());
      const since = cursor?.since;
      for (const article of await readArticles(store)) {
        if (since && article.updatedAt <= since) continue;
        yield article;
      }
    },
    async resolveMedia(asset: SocleMedia) {
      const path = mediaPath(asset.src);
      const raw = await store.get("editorial", `bytes:${path}`);
      if (!raw) throw new EditorialError(`média absent : ${path}`);
      return Buffer.from(raw, "base64");
    },
    async pushStatus(articleId: string, status: EditorialStatus) {
      const raw = await store.get("editorial", `article:${articleId}`);
      if (!raw) throw new EditorialError("article absent");
      const article = JSON.parse(raw) as SocleArticle;
      const now = new Date().toISOString();
      article.status = status;
      if ((status === "published" || status === "archived") && !article.publishedAt) article.publishedAt = now;
      await saveArticle(store, article, now);
    },
  };
}

export function createSocleEditorial(store: SocleStore) {
  const listeners = new Set<Listener>();
  let closed = false;
  function emit(kind: string, id?: string) {
    for (const listener of listeners) listener({ kind, id });
  }
  function guard() {
    if (closed) throw new EditorialError("fermé");
  }
  return {
    id: SOURCE_ID,
    capabilities: {
      writable: true,
      preview: false,
      media: true,
      persistent: "remote" as const,
      authentication: false,
      collaboration: true,
      remoteBackup: true,
      remotePublishing: false,
    },
    async init() {
      guard();
    },
    async getSnapshot(options: { audience: "public" | "editorial"; includeDemo?: boolean }) {
      guard();
      await publishDue(store, new Date());
      const publication = await readPublication(store);
      if (!publication) throw new EditorialError("publication absente");
      const demoOn = (await store.get("editorial", "demo-visible")) !== "0";
      let articles = await readArticles(store);
      if (options.audience === "public") {
        articles = articles.filter((article) => article.status === "published" || article.status === "archived");
      }
      if (!options.includeDemo && !(demoOn && options.audience === "editorial")) {
        articles = articles.filter((article) => !article.isDemo);
      }
      const authors = await readKind<SocleAuthor>(store, "author:");
      return {
        publication,
        articles,
        authors: options.audience === "public" ? authors.map(publicAuthor) : authors,
        taxonomies: {
          sections: await readKind<SocleTaxon>(store, "section:"),
          categories: await readKind<SocleTaxon>(store, "category:"),
          tags: await readKind<SocleTaxon>(store, "tag:"),
        },
        syncedAt: new Date().toISOString(),
      };
    },
    async save(kind: string, entity: { id?: string }) {
      guard();
      const now = new Date().toISOString();
      const id = entity.id || randomUUID();
      const stored = { ...entity, id };
      if (kind === "article") {
        const article = stored as SocleArticle;
        if (!article.source) article.source = mark(id, now);
        const saved = await saveArticle(store, article, now);
        emit(kind, saved.id);
        return saved;
      }
      const prefix = `${kind}:`;
      if (!["author", "section", "category", "tag", "media"].includes(kind)) {
        throw new EditorialError("genre inconnu");
      }
      await store.put("editorial", `${prefix}${id}`, JSON.stringify(stored));
      emit(kind, id);
      return stored;
    },
    async remove(kind: string, id: string) {
      guard();
      await store.delete("editorial", `${kind}:${id}`);
      emit(kind, id);
    },
    async savePublication(publication: SoclePublication) {
      guard();
      await store.put("editorial", "publication", JSON.stringify(publication));
      emit("publication", publication.id);
      return publication;
    },
    async setDemoVisibility(visible: boolean) {
      guard();
      await store.put("editorial", "demo-visible", visible ? "1" : "0");
    },
    async removeDemo() {
      guard();
      for (const article of await readArticles(store)) {
        if (article.isDemo) await store.delete("editorial", `article:${article.id}`);
      }
      for (const author of await readKind<SocleAuthor>(store, "author:")) {
        if (author.isDemo) await store.delete("editorial", `author:${author.id}`);
      }
    },
    async resetDemo(options?: { full?: boolean }) {
      guard();
      const seed = parse<{ articles: SocleArticle[]; authors: SocleAuthor[] }>(await store.get("editorial", "seed"));
      if (!seed) return;
      if (options?.full) {
        const publication = await store.get("editorial", "publication");
        const seedRaw = await store.get("editorial", "seed");
        for (const row of await store.list("editorial")) await store.delete("editorial", row.key);
        if (publication) await store.put("editorial", "publication", publication);
        if (seedRaw) await store.put("editorial", "seed", seedRaw);
      }
      for (const article of seed.articles) await store.put("editorial", `article:${article.id}`, JSON.stringify(article));
      for (const author of seed.authors) await store.put("editorial", `author:${author.id}`, JSON.stringify(author));
    },
    async createBackup() {
      guard();
      return {
        publication: await readPublication(store),
        articles: await readArticles(store),
        authors: await readKind<SocleAuthor>(store, "author:"),
        sections: await readKind<SocleTaxon>(store, "section:"),
        categories: await readKind<SocleTaxon>(store, "category:"),
        tags: await readKind<SocleTaxon>(store, "tag:"),
      };
    },
    async restoreBackup(backup: Record<string, unknown>) {
      guard();
      for (const row of await store.list("editorial")) {
        if (row.key === "publication" && !backup.publication) continue;
        if (row.key.startsWith("article:") || row.key.startsWith("author:") || row.key === "publication") {
          await store.delete("editorial", row.key);
        }
      }
      if (backup.publication) await store.put("editorial", "publication", JSON.stringify(backup.publication));
      for (const article of (backup.articles as SocleArticle[] | undefined) ?? []) {
        await store.put("editorial", `article:${article.id}`, JSON.stringify(article));
      }
      for (const author of (backup.authors as SocleAuthor[] | undefined) ?? []) {
        await store.put("editorial", `author:${author.id}`, JSON.stringify(author));
      }
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      listeners.clear();
    },
    async rememberSeed() {
      guard();
      const articles = (await readArticles(store)).filter((article) => article.isDemo);
      const authors = (await readKind<SocleAuthor>(store, "author:")).filter((author) => author.isDemo);
      await store.put("editorial", "seed", JSON.stringify({ articles, authors }));
    },
  };
}

export async function putBytes(store: SocleStore, src: string, bytes: Uint8Array): Promise<void> {
  await store.put("editorial", `bytes:${mediaPath(src)}`, Buffer.from(bytes).toString("base64"));
}
