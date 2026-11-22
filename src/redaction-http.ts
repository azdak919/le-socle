/**
 * API de rédaction, en JSON, pour l'administration du Kiosque.
 *
 * L'admin du Kiosque est la seule interface d'écriture : la même page parle à
 * sql.js dans la démo et à ce module chez un vrai journal. Les pages HTML de
 * `/admin` restent le recours sans JavaScript.
 *
 * Règles :
 * - la route n'existe que si `editorial` est allumé (la banque de photos, si
 *   `media` l'est aussi) ;
 * - `auth` éteint : seul un appel local (127.0.0.1, ::1) passe. Un socle sans
 *   comptes n'accepte pas d'écriture venue d'Internet ;
 * - `auth` allumé : il faut une session et un rôle (droits dans `roles.ts`).
 *   Publier, programmer, archiver demandent un réviseur, un éditeur,
 *   l’administrateur, ou un chef de pupitre dans ses rubriques ; un auteur
 *   restreint n'écrit que dans ses rubriques ; un photographe ne touche
 *   qu'à la banque de photos ;
 * - chaque écriture exige `content-type: application/json` : un formulaire
 *   d'un autre site ne peut pas l'envoyer sans permission (pas de CORS ici,
 *   l'admin est servie par le socle lui-même).
 */

import { createHash, randomUUID } from "node:crypto";

import type { AdminDeps } from "./admin.ts";
import { roleOf, scopeOf, type OrgRole } from "./auth.ts";
import type { SocleConfig } from "./config.ts";
import {
  EditorialError,
  readArticles,
  readPublication,
  refreshCanonicalUrls,
  saveArticle,
  type SocleArticle,
} from "./editorial.ts";
import { MediaError, deleteMediaFiles, findDuplicate, readBytes, saveArticleImage, saveLibrary, type LibraryAsset } from "./media.ts";
import { inScope, isEditor, managesBank, publishesIn, writesArticles, type Scope } from "./roles.ts";
import { ModuleOffError } from "./store.ts";
import { auteurPeutEtreSupprime, normaliserAuteur } from "../admin/assets/auteurs-statut.js";

type Result = { status: number; body: string | Uint8Array; headers: Record<string, string> };

const JSON_TYPE = "application/json; charset=utf-8";
const KINDS = ["author", "section", "category", "tag"] as const;
const PUBLIC_STATUSES = ["published", "scheduled", "archived", "retracted"];
const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };


function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function usedInMasthead(publication: { masthead?: { backgrounds?: { images?: Array<{ src?: string }> } } } | null | undefined, src: string): boolean {
  return (publication?.masthead?.backgrounds?.images ?? []).some((image) => image?.src === src);
}

function duplicatePayload(dup: LibraryAsset | null): Record<string, unknown> {
  return dup ? { duplicate: { id: dup.id, alt: dup.alt, warning: "Cette photo est déjà dans la banque." } } : {};
}


function json(status: number, value: unknown): Result {
  return { status, body: JSON.stringify(value), headers: { "content-type": JSON_TYPE, "cache-control": "no-store" } };
}

function fail(status: number, message: string): Result {
  return json(status, { error: message });
}

/** Le type réel d'après les premiers octets, pas d'après ce que dit le client. */
export function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function text(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Adresse lisible tirée d'un titre : « Élection à l'AGE » → « election-a-l-age ». Même règle en PHP. */
export function slugFrom(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/Œ/g, "OE").replace(/Æ/g, "AE")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96).replace(/-+$/g, "");
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

async function library(store: AdminDeps["store"]): Promise<LibraryAsset[]> {
  try {
    const rows = await store.list("media");
    return rows.filter((row) => row.key.startsWith("library:")).map((row) => JSON.parse(row.value) as LibraryAsset)
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (error instanceof ModuleOffError) return [];
    throw error;
  }
}

async function readAll<T>(store: AdminDeps["store"], prefix: string): Promise<T[]> {
  const rows = await store.list("editorial");
  return rows.filter((row) => row.key.startsWith(prefix)).map((row) => JSON.parse(row.value) as T);
}

/** La rubrique (section) est-elle permise ? On la reconnaît par identifiant ou nom court. */
async function sectionsAllow(deps: AdminDeps, scope: Scope, section: string | undefined): Promise<boolean> {
  if (!scope.length) return true;
  if (!section) return false;
  const known = await readAll<{ id?: string; slug?: string }>(deps.store, "section:");
  const match = known.find((item) => item.id === section || item.slug === section);
  return inScope(scope, match?.id ?? section, match?.slug);
}

export async function redactionState(config: SocleConfig, deps: AdminDeps, role: OrgRole | null) {
  return {
    format: "socle-redaction",
    version: 1,
    publication: await readPublication(deps.store),
    articles: (await readArticles(deps.store)).sort((a, b) => String(b.publishedAt || b.updatedAt).localeCompare(String(a.publishedAt || a.updatedAt))),
    authors: await readAll(deps.store, "author:"),
    taxonomies: {
      sections: await readAll(deps.store, "section:"),
      categories: await readAll(deps.store, "category:"),
      tags: await readAll(deps.store, "tag:"),
    },
    media: config.modules.media ? await library(deps.store) : [],
    demoVisible: (await deps.store.get("editorial", "demo-visible")) !== "0",
    modules: { media: config.modules.media, review: config.modules.review, auth: config.modules.auth },
    role,
    syncedAt: deps.now().toISOString(),
  };
}

function articleFrom(input: Record<string, unknown>, existing: SocleArticle | undefined, publicationSlug: string, now: string): SocleArticle {
  const id = text(input.id, 80) || existing?.id || randomUUID();
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as { format?: unknown; raw?: unknown };
  const status = text(input.status, 20) as SocleArticle["status"];
  return {
    ...(existing ?? {}),
    ...(input as Partial<SocleArticle>),
    id,
    // Sans adresse, on la tire du titre : l'API ne refuse pas un article pour ça.
    slug: text(input.slug, 96) || existing?.slug || slugFrom(text(input.title, 300)),
    publication: publicationSlug,
    title: text(input.title, 300),
    excerpt: text(input.excerpt, 2000),
    body: { format: (body.format === "html" ? "html" : "markdown") as "markdown", raw: typeof body.raw === "string" ? body.raw : "" },
    media: Array.isArray(input.media) ? input.media as SocleArticle["media"] : existing?.media ?? [],
    authors: list(input.authors),
    section: text(input.section, 96) || undefined,
    categories: list(input.categories),
    tags: list(input.tags),
    lang: text(input.lang, 12) || existing?.lang || "fr-CA",
    status,
    publishedAt: text(input.publishedAt, 40) || (status === "published" || status === "archived" ? existing?.publishedAt ?? now : existing?.publishedAt),
    updatedAt: now,
    canonicalUrl: text(input.canonicalUrl, 500) || existing?.canonicalUrl || "",
    source: { backend: "socle", backendId: id, fetchedAt: now },
    featured: Boolean(input.featured) || undefined,
  };
}

export async function handleRedaction(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
  headers: Record<string, string | undefined>,
  actor: string | null | undefined,
  local: boolean,
): Promise<Result> {
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname;
  if (!config.modules.editorial || !path.startsWith("/v1/redaction/")) return { status: 404, body: "", headers: {} };

  // Qui parle ?
  let role: OrgRole | null = null;
  let scope: Scope = [];
  if (actor === undefined) {
    if (!local) return fail(403, "Sans le module auth, la rédaction ne s'ouvre que depuis la machine du socle.");
    role = "administrateur";
  } else {
    if (!actor) return fail(401, "Connexion requise.");
    role = await roleOf(deps.store, actor);
    if (!role) return fail(403, "Ce compte n'a pas de rôle dans la rédaction.");
    if (role === "auteur" || role === "chef-pupitre") scope = await scopeOf(deps.store, actor);
  }
  const editor = isEditor(role);

  if (method === "GET" && path === "/v1/redaction/etat") {
    return json(200, { ...(await redactionState(config, deps, role)), scope });
  }
  if (method === "GET" && path === "/v1/redaction/fichier") {
    const src = parsed.searchParams.get("src") ?? "";
    try {
      const bytes = await readBytes(deps.store, src).catch(async () => {
        const raw = await deps.store.get("editorial", `bytes:${src.replace(/^\/+/, "")}`);
        if (!raw) throw new MediaError("fichier absent");
        return Buffer.from(raw, "base64");
      });
      const type = sniffImage(bytes) ?? "application/octet-stream";
      return { status: 200, body: bytes, headers: { "content-type": type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } };
    } catch {
      return fail(404, "Fichier absent.");
    }
  }
  if (method !== "POST") return { status: 405, body: "", headers: { allow: "GET, POST" } };
  if (!String(headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    return fail(415, "Envoyez du JSON (content-type: application/json).");
  }
  let body: Record<string, unknown>;
  try {
    const value = JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("objet");
    body = value as Record<string, unknown>;
  } catch {
    return fail(400, "JSON illisible.");
  }
  const now = deps.now().toISOString();

  try {
    if (path === "/v1/redaction/article") {
      const input = (body.article ?? {}) as Record<string, unknown>;
      const publication = await readPublication(deps.store);
      if (!publication) return fail(409, "Créez d'abord la publication.");
      if (!writesArticles(role)) return fail(403, "Un compte photographe gère la banque de photos ; il n'écrit pas d'articles.");
      const existing = (await readArticles(deps.store)).find((item) => item.id === input.id);
      const article = articleFrom(input, existing, publication.slug, now);
      const allowedHere = await sectionsAllow(deps, scope, article.section) && (!existing || await sectionsAllow(deps, scope, existing.section));
      if (!editor && !allowedHere) return fail(403, "Cet article est hors de vos rubriques : choisissez une de vos rubriques.");
      const touchesPublic = PUBLIC_STATUSES.includes(article.status) || (existing && PUBLIC_STATUSES.includes(existing.status));
      if (touchesPublic && !publishesIn(role, allowedHere)) return fail(403, "Publier ou programmer demande un réviseur, un éditeur, l’administrateur, ou le chef de pupitre de la rubrique.");
      const clash = (await readArticles(deps.store)).find((item) => item.slug === article.slug && item.id !== article.id);
      if (clash) return fail(409, `L'adresse « ${article.slug} » est déjà prise par un autre article.`);
      return json(200, { article: await saveArticle(deps.store, article, now) });
    }
    if (path === "/v1/redaction/entite") {
      const kind = text(body.kind, 20) as (typeof KINDS)[number];
      if (!KINDS.includes(kind)) return fail(400, "Genre inconnu.");
      if (kind !== "author" && !editor) return fail(403, "Les sections, catégories et étiquettes demandent un éditeur.");
      if (kind === "author" && role === "photographe") return fail(403, "Un compte photographe ne gère pas les auteurs.");
      const input = (body.entity ?? {}) as Record<string, unknown>;
      const id = text(input.id, 80) || randomUUID();
      const name = text(input.name, 200);
      const slug = text(input.slug, 96) || slugFrom(name);
      if (!name) return fail(400, "Un nom est requis.");
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return fail(400, "Le nom court ne garde que des lettres minuscules, des chiffres et des tirets.");
      const entity = kind === "author"
        ? normaliserAuteur({ ...input, id, name, slug })
        : { ...input, id, name, slug };
      await deps.store.put("editorial", `${kind}:${id}`, JSON.stringify(entity));
      return json(200, { entity });
    }
    if (path === "/v1/redaction/supprimer") {
      const kind = text(body.kind, 20);
      const id = text(body.id, 80);
      if (!id || ![...KINDS, "article"].includes(kind)) return fail(400, "Genre ou identifiant invalide.");
      if (!editor) {
        const target = kind === "article" ? (await readArticles(deps.store)).find((item) => item.id === id) : undefined;
        const pupitre = role === "chef-pupitre" && target !== undefined && await sectionsAllow(deps, scope, target.section);
        if (!pupitre) return fail(403, "Supprimer demande un éditeur, ou le chef de pupitre de la rubrique.");
      }
      if (kind === "author") {
        const raw = await deps.store.get("editorial", `author:${id}`);
        const auteur = raw ? JSON.parse(raw) as { slug?: string; id?: string } : null;
        const articles = await readArticles(deps.store);
        if (auteur && !auteurPeutEtreSupprime(auteur, articles)) {
          return fail(409, "Cet auteur figure encore sur un article. Passez-le dans les anciens plutôt que de le supprimer.");
        }
      }
      await deps.store.delete("editorial", `${kind}:${id}`);
      return json(200, { ok: true });
    }
    if (path === "/v1/redaction/publication") {
      if (!editor) return fail(403, "La configuration du journal demande un éditeur.");
      const publication = body.publication as Record<string, unknown> | undefined;
      if (!publication || !text(publication.name) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text(publication.slug, 96))) {
        return fail(400, "La publication a besoin d'un nom et d'un identifiant.");
      }
      const previous = await readPublication(deps.store);
      await deps.store.put("editorial", "publication", JSON.stringify(publication));
      const nextUrl = String((publication as { siteUrl?: string }).siteUrl ?? "").replace(/\/$/, "");
      const prevUrl = String(previous?.siteUrl ?? "").replace(/\/$/, "");
      if (nextUrl && nextUrl !== prevUrl) await refreshCanonicalUrls(deps.store, nextUrl);
      return json(200, { publication });
    }
    if (path === "/v1/redaction/exemples") {
      if (!editor) return fail(403, "Réservé à un éditeur.");
      await deps.store.put("editorial", "demo-visible", body.visible === false ? "0" : "1");
      return json(200, { ok: true });
    }
    if (path === "/v1/redaction/photo") {
      if (!config.modules.media) return fail(404, "Le module media est éteint.");
      if (body.bank === false && !writesArticles(role)) return fail(403, "Un compte photographe ajoute ses photos à la banque.");
      const input = (body.asset ?? {}) as Record<string, unknown>;
      const data = typeof body.data === "string" ? body.data.replace(/^data:[^,]*,/, "") : "";
      const bytes = new Uint8Array(Buffer.from(data, "base64"));
      if (!bytes.length) return fail(400, "Fichier vide.");
      if (bytes.length > MAX_BYTES) return fail(413, "Photo trop lourde (8 Mo au plus).");
      const type = sniffImage(bytes);
      if (!type) return fail(415, "Seules les photos JPEG, PNG ou WebP sont acceptées.");
      const id = text(input.id, 80).replace(/[^a-zA-Z0-9-]/g, "") || randomUUID();
      const src = `/media/banque/${id}.${IMAGE_TYPES[type]}`;
      const focal = (input.focalPoint ?? {}) as { x?: unknown; y?: unknown };
      const clamp = (value: unknown) => Math.min(100, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 50));
      if (body.bank === false) {
        const checksum = checksumOf(bytes);
        const image = { id, kind: "image" as const, src, alt: text(input.alt, 500), credit: text(input.credit, 200) || undefined, caption: text(input.caption, 500) || undefined, license: text(input.license, 100) || undefined, licenseUrl: text(input.licenseUrl, 500) || undefined, checksum, variants: [] as Array<{ src: string; width: number; height: number }>, source: { backend: "socle", backendId: id, fetchedAt: now } };
        await saveArticleImage(deps.store, image, bytes);
        return json(200, { asset: image, ...duplicatePayload(await findDuplicate(deps.store, checksum, id)) });
      }
      const asset: LibraryAsset = {
        id,
        kind: "image",
        src,
        remoteSrc: "",
        alt: text(input.alt, 500),
        credit: text(input.credit, 200),
        creditUrl: text(input.creditUrl, 500),
        license: text(input.license, 100) || "Tous droits réservés",
        licenseUrl: text(input.licenseUrl, 500),
        sourceUrl: text(input.sourceUrl, 500),
        width: Math.max(0, Math.round(Number(input.width) || 0)),
        height: Math.max(0, Math.round(Number(input.height) || 0)),
        focalPoint: { x: clamp(focal.x), y: clamp(focal.y) },
        institution: text(input.institution, 200),
        campus: text(input.campus, 200),
        keywords: list(input.keywords).slice(0, 30),
        usages: list(input.usages).slice(0, 10),
        caption: text(input.caption, 500),
        checksum: checksumOf(bytes),
        variants: [],
        source: { backend: "socle", backendId: id, fetchedAt: now },
      };
      await saveLibrary(deps.store, asset, bytes);
      return json(200, { asset, ...duplicatePayload(await findDuplicate(deps.store, asset.checksum ?? "", id)) });
    }
    if (path === "/v1/redaction/photo/fiche") {
      if (!config.modules.media) return fail(404, "Le module media est éteint.");
      if (!managesBank(role)) return fail(403, "Modifier la fiche d'une photo demande un photographe, un réviseur, un éditeur ou l’administrateur.");
      const input = (body.asset ?? {}) as Record<string, unknown>;
      const id = text(input.id, 80);
      const raw = id ? await deps.store.get("media", `library:${id}`) : null;
      if (!raw) return fail(404, "Photo absente de la banque.");
      const current = JSON.parse(raw) as LibraryAsset;
      const credit = text(input.credit, 200);
      if (!credit) return fail(400, "Une photo de la banque garde toujours un crédit.");
      const focal = (input.focalPoint ?? current.focalPoint) as { x?: unknown; y?: unknown };
      const clamp = (value: unknown) => Math.min(100, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 50));
      const next: LibraryAsset = {
        ...current,
        alt: text(input.alt, 500) || current.alt,
        credit,
        caption: text(input.caption, 500),
        creditUrl: text(input.creditUrl, 500),
        license: text(input.license, 100) || current.license,
        licenseUrl: text(input.licenseUrl, 500),
        keywords: list(input.keywords).slice(0, 30),
        usages: list(input.usages).slice(0, 10),
        focalPoint: { x: clamp(focal.x), y: clamp(focal.y) },
      };
      await deps.store.put("media", `library:${id}`, JSON.stringify(next));
      return json(200, { asset: next });
    }
    if (path === "/v1/redaction/photo/supprimer") {
      if (!config.modules.media) return fail(404, "Le module media est éteint.");
      if (!managesBank(role)) return fail(403, "Retirer une photo de la banque demande un photographe ou un éditeur.");
      const id = text(body.id, 80);
      const raw = id ? await deps.store.get("media", `library:${id}`) : null;
      if (!raw) return fail(404, "Photo absente de la banque.");
      const asset = JSON.parse(raw) as LibraryAsset;
      // Une photo encore utilisée reste : la retirer casserait l'article.
      const users = (await readArticles(deps.store)).filter((article) => article.lead?.src === asset.src || article.media.some((item) => item.src === asset.src));
      if (users.length) return fail(409, `Cette photo illustre encore ${users.length} article(s) : ${users.map((item) => item.title).join(", ")}.`);
      const publication = await readPublication(deps.store);
      if (usedInMasthead(publication, asset.src)) return fail(409, "Cette photo est encore dans le mât illustré.");
      await deps.store.delete("media", `library:${id}`);
      await deleteMediaFiles(deps.store, asset);
      return json(200, { ok: true });
    }
  } catch (error) {
    if (error instanceof EditorialError || error instanceof MediaError) return fail(400, error.message);
    if (error instanceof ModuleOffError) return fail(409, `Module éteint : ${error.module}.`);
    throw error;
  }
  return { status: 404, body: "", headers: {} };
}
