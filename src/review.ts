import { randomUUID } from "node:crypto";

import { roleOf } from "./auth.ts";
import {
  EditorialError,
  readArticles,
  saveArticle,
  type SocleArticle,
} from "./editorial.ts";
import { ModuleOffError, type SocleStore } from "./store.ts";

const DECISIONS = ["publier", "programmer", "renvoyer"] as const;
const STATES = ["ouverte", "acceptee", "refusee"] as const;

export type ReviewDecision = (typeof DECISIONS)[number];
export type CorrectionState = (typeof STATES)[number];

export type Correction = {
  id: string;
  articleId: string;
  text: string;
  url: string;
  state: CorrectionState;
};

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export function isDecision(value: string | null | undefined): value is ReviewDecision {
  return value !== null && value !== undefined && (DECISIONS as readonly string[]).includes(value);
}

export async function mayReview(store: SocleStore, actor: string | null | undefined): Promise<boolean> {
  if (actor === undefined) return true;
  if (!actor) return false;
  const role = await roleOf(store, actor);
  return role === "reviseur" || role === "editeur" || role === "administrateur";
}

export async function decide(
  store: SocleStore,
  id: string,
  decision: string,
  reviewer: string,
  now: string,
  scheduledAt?: string,
): Promise<SocleArticle> {
  if (!isDecision(decision)) throw new ReviewError("décision inconnue");
  const article = (await readArticles(store)).find((item) => item.id === id);
  if (!article || (article.status !== "in-review" && article.status !== "scheduled")) {
    throw new ReviewError("pas en relecture");
  }
  const next: SocleArticle = { ...article, reviewedAt: now, reviewedBy: reviewer };
  if (decision === "renvoyer") {
    next.status = "draft";
    next.scheduledAt = undefined;
  } else if (decision === "programmer") {
    if (!scheduledAt) throw new ReviewError("une publication programmée a besoin d'une heure");
    next.status = "scheduled";
    next.scheduledAt = scheduledAt;
  } else {
    next.status = "published";
    next.publishedAt = now;
  }
  try {
    return await saveArticle(store, next, now);
  } catch (error) {
    if (error instanceof EditorialError) throw new ReviewError(error.message);
    throw error;
  }
}

export async function queue(store: SocleStore): Promise<SocleArticle[]> {
  return (await readArticles(store)).filter((article) => article.status === "in-review" || article.status === "scheduled");
}

export async function addCorrection(
  store: SocleStore,
  articleId: string,
  text: string,
  url: string,
): Promise<Correction> {
  const cleanText = text.trim();
  if (!articleId || !cleanText || cleanText.length > 4000 || !acceptableUrl(url)) {
    throw new ReviewError("demande refusée");
  }
  const correction: Correction = {
    id: randomUUID(),
    articleId,
    text: cleanText,
    url,
    state: "ouverte",
  };
  await store.put("review", `correction:${correction.id}`, JSON.stringify(correction));
  return correction;
}

export async function closeCorrection(store: SocleStore, id: string, state: string): Promise<Correction> {
  if (state !== "acceptee" && state !== "refusee") throw new ReviewError("décision inconnue");
  const raw = await store.get("review", `correction:${id}`);
  if (!raw) throw new ReviewError("pas en relecture");
  const correction = JSON.parse(raw) as Correction;
  correction.state = state;
  await store.put("review", `correction:${id}`, JSON.stringify(correction));
  return correction;
}

export async function restoreCorrections(store: SocleStore, value: unknown): Promise<void> {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Partial<Correction>;
    if (!record.id || !record.articleId || !record.text || !record.url) continue;
    if (record.state !== "ouverte" && record.state !== "acceptee" && record.state !== "refusee") continue;
    const correction: Correction = {
      id: record.id,
      articleId: record.articleId,
      text: record.text,
      url: record.url,
      state: record.state,
    };
    try {
      await store.put("review", `correction:${correction.id}`, JSON.stringify(correction));
    } catch (error) {
      if (error instanceof ModuleOffError) return;
      throw error;
    }
  }
}

export async function readCorrections(store: SocleStore): Promise<Correction[]> {
  try {
    const rows = await store.list("review");
    const corrections: Correction[] = [];
    for (const row of rows) {
      if (!row.key.startsWith("correction:")) continue;
      corrections.push(JSON.parse(row.value) as Correction);
    }
    corrections.sort((a, b) => a.id.localeCompare(b.id));
    return corrections;
  } catch (error) {
    if (error instanceof ModuleOffError) return [];
    throw error;
  }
}

function acceptableUrl(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !value.includes("..")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
