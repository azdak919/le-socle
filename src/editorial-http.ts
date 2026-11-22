import { randomUUID } from "node:crypto";

import { adminDocument, type AdminDeps } from "./admin.ts";
import type { SocleConfig } from "./config.ts";
import {
  EditorialError,
  createSocleEditorial,
  readArticles,
  readPublication,
  saveArticle,
  type EditorialStatus,
  type SocleArticle,
} from "./editorial.ts";

type Result = { status: number; body: string | Uint8Array; headers: Record<string, string> };
type Lang = "fr" | "en";

const STATUSES: readonly EditorialStatus[] = ["draft", "in-review", "scheduled", "published", "archived", "retracted"];

const STATUS_FR: Record<EditorialStatus, string> = { draft: "Brouillon", "in-review": "En révision", scheduled: "Programmé", published: "Publié", archived: "Archivé", retracted: "Retiré" };

const COPY = {
  fr: {
    articles: "Articles",
    review: "Relecture",
    title: "Titre",
    slug: "Adresse",
    status: "Statut",
    body: "Texte",
    excerpt: "Extrait",
    author: "Auteur (nom court)",
    section: "Section",
    scheduled: "Heure de publication",
    session: "Session",
    submitted: "Soumis le",
    reviewedAt: "Révisé le",
    reviewedBy: "Révisé par",
    save: "Enregistrer",
    empty: "Aucun article.",
    queueEmpty: "Rien en relecture.",
    missingPub: "Le journal n'a pas encore de fiche.",
  },
  en: {
    articles: "Articles",
    review: "Review",
    title: "Title",
    slug: "Slug",
    status: "Status",
    body: "Text",
    excerpt: "Excerpt",
    author: "Author slug",
    section: "Section",
    scheduled: "Publish time",
    session: "Session",
    submitted: "Submitted",
    reviewedAt: "Reviewed at",
    reviewedBy: "Reviewed by",
    save: "Save",
    empty: "No articles.",
    queueEmpty: "Nothing in review.",
    missingPub: "The journal has no publication record yet.",
  },
} as const;

function langOf(url: URL): Lang {
  return url.searchParams.get("lang") === "en" ? "en" : "fr";
}

function withLang(path: string, lang: Lang): string {
  if (lang === "fr") return path;
  return path.includes("?") ? `${path}&lang=en` : `${path}?lang=en`;
}

function field(id: string, label: string, name: string, value: string, kind = "text"): string {
  return `<p><label for="${id}">${label}</label><br><input id="${id}" name="${name}" type="${kind}" value="${escapeAttr(value)}"></p>`;
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

function articleForm(lang: Lang, article: Partial<SocleArticle>, error = ""): string {
  const copy = COPY[lang];
  const status = article.status ?? "draft";
  const options = STATUSES.map((item) => {
    const selected = item === status ? " selected" : "";
    return `<option value="${item}"${selected}>${lang === "fr" ? STATUS_FR[item] : item}</option>`;
  }).join("");
  const alert = error ? `<p role="alert">${escapeAttr(error)}</p>` : "";
  return `${alert}<form method="post" action="${withLang("/admin/articles", lang)}">
<input type="hidden" name="id" value="${escapeAttr(article.id ?? "")}">
${field("titre", copy.title, "title", article.title ?? "")}
${field("slug", copy.slug, "slug", article.slug ?? "")}
<p><label for="statut">${copy.status}</label><br><select id="statut" name="status">${options}</select></p>
<p><label for="texte">${copy.body}</label><br><textarea id="texte" name="markdown">${escapeAttr(article.body?.raw ?? "")}</textarea></p>
${field("extrait", copy.excerpt, "excerpt", article.excerpt ?? "")}
${field("auteur", copy.author, "author", article.authors?.[0] ?? "")}
${field("section", copy.section, "section", article.section ?? "")}
${field("heure", copy.scheduled, "scheduledAt", article.scheduledAt ?? "")}
${field("session", copy.session, "session", article.session ?? "")}
${field("soumis", copy.submitted, "submittedAt", article.submittedAt ?? "")}
${field("revu", copy.reviewedAt, "reviewedAt", article.reviewedAt ?? "")}
${field("reviseur", copy.reviewedBy, "reviewedBy", article.reviewedBy ?? "")}
<p class="noprint"><button type="submit">${copy.save}</button></p>
</form>`;
}

export async function handleEditorial(
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
  if (!config.modules.editorial) return { status: 404, body: "", headers: {} };

  if (path === "/v1/editorial/snapshot" && method === "GET") {
    const editorial = createSocleEditorial(deps.store);
    const snapshot = await editorial.getSnapshot({ audience: "public" });
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(snapshot),
    };
  }

  if (path === "/admin/articles" && method === "GET") {
    const articles = await readArticles(deps.store);
    const items = articles.map((article) => {
      const when = article.scheduledAt ? ` — ${article.scheduledAt}` : "";
      return `<li><a href="${withLang(`/admin/articles/${article.id}`, lang)}">${escapeAttr(article.title)}</a> (${article.status}${when})</li>`;
    }).join("");
    const list = items ? `<ul>${items}</ul>` : `<p>${copy.empty}</p>`;
    return adminDocument(lang, copy.articles, `${list}<p class="noprint"><a href="${withLang("/admin/articles/nouveau", lang)}">${copy.save}</a></p>`);
  }

  if (path === "/admin/articles/nouveau" && method === "GET") {
    return adminDocument(lang, copy.articles, articleForm(lang, {}));
  }

  const one = path.match(/^\/admin\/articles\/([^/]+)$/);
  if (one && method === "GET" && one[1] !== "nouveau") {
    const articles = await readArticles(deps.store);
    const article = articles.find((item) => item.id === one[1]);
    if (!article) return { status: 404, body: "", headers: {} };
    return adminDocument(lang, article.title, `<article><h2>${escapeAttr(article.title)}</h2><p>${escapeAttr(article.status)}</p><pre>${escapeAttr(article.body.raw)}</pre></article>${articleForm(lang, article)}`);
  }

  if (path === "/admin/articles" && method === "POST") {
    const params = new URLSearchParams(new TextDecoder().decode(rawBody));
    const publication = await readPublication(deps.store);
    if (!publication) {
      return adminDocument(lang, copy.articles, `<p role="alert">${copy.missingPub}</p>`);
    }
    const now = deps.now().toISOString();
    const id = params.get("id") || randomUUID();
    const existing = (await readArticles(deps.store)).find((item) => item.id === id);
    const author = params.get("author") ?? "";
    const status = (params.get("status") ?? "draft") as EditorialStatus;
    const article: SocleArticle = {
      id,
      slug: params.get("slug") ?? "",
      publication: publication.slug,
      title: params.get("title") ?? "",
      excerpt: params.get("excerpt") ?? "",
      body: { format: "markdown", raw: params.get("markdown") ?? "" },
      lead: existing?.lead,
      media: existing?.media ?? [],
      authors: author ? [author] : [],
      section: params.get("section") || undefined,
      categories: existing?.categories ?? [],
      tags: existing?.tags ?? [],
      lang: publication.lang,
      status,
      isDemo: existing?.isDemo,
      publishedAt: status === "published" || status === "archived" ? (existing?.publishedAt ?? now) : existing?.publishedAt,
      updatedAt: now,
      submittedAt: params.get("submittedAt") || undefined,
      reviewedAt: params.get("reviewedAt") || undefined,
      reviewedBy: params.get("reviewedBy") || undefined,
      scheduledAt: params.get("scheduledAt") || undefined,
      session: params.get("session") || undefined,
      canonicalUrl: `${publication.siteUrl.replace(/\/$/, "")}/${params.get("slug") ?? ""}`,
      source: { backend: "socle", backendId: id, fetchedAt: now },
    };
    try {
      await saveArticle(deps.store, article, now);
    } catch (error) {
      const message = error instanceof EditorialError ? error.message : "erreur";
      return { status: 400, headers: { "content-type": "text/html; charset=utf-8" }, body: adminDocument(lang, copy.articles, articleForm(lang, article, message)).body };
    }
    return { status: 303, body: "", headers: { location: withLang("/admin/articles", lang) } };
  }

  if (path === "/admin/relecture" && method === "GET") {
    const queue = (await readArticles(deps.store)).filter((article) => article.status === "in-review");
    const items = queue.map((article) => `<li>
<p>${escapeAttr(article.title)}</p>
<p>${copy.submitted} : ${escapeAttr(article.submittedAt ?? "")}</p>
<form class="noprint" method="post" action="${withLang("/admin/relecture", lang)}">
<input type="hidden" name="id" value="${escapeAttr(article.id)}">
${field(`revu-${article.id}`, copy.reviewedAt, "reviewedAt", article.reviewedAt ?? "")}
${field(`par-${article.id}`, copy.reviewedBy, "reviewedBy", article.reviewedBy ?? "")}
<p><button type="submit">${copy.save}</button></p>
</form>
</li>`).join("");
    const list = items ? `<ul>${items}</ul>` : `<p>${copy.queueEmpty}</p>`;
    return adminDocument(lang, copy.review, list);
  }

  if (path === "/admin/relecture" && method === "POST") {
    const params = new URLSearchParams(new TextDecoder().decode(rawBody));
    const id = params.get("id") ?? "";
    const articles = await readArticles(deps.store);
    const article = articles.find((item) => item.id === id);
    if (!article) return { status: 404, body: "", headers: {} };
    article.reviewedAt = params.get("reviewedAt") || undefined;
    article.reviewedBy = params.get("reviewedBy") || undefined;
    try {
      await saveArticle(deps.store, article, deps.now().toISOString());
    } catch (error) {
      const message = error instanceof EditorialError ? error.message : "erreur";
      return { status: 400, body: message, headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    return { status: 303, body: "", headers: { location: withLang("/admin/relecture", lang) } };
  }

  return { status: 404, body: "", headers: {} };
}
