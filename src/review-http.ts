import { adminDocument, type AdminDeps } from "./admin.ts";
import type { SocleConfig } from "./config.ts";
import { publishDue } from "./editorial.ts";
import {
  ReviewError,
  addCorrection,
  closeCorrection,
  decide,
  mayReview,
  queue,
  readCorrections,
} from "./review.ts";

type Result = { status: number; body: string; headers: Record<string, string> };
type Lang = "fr" | "en";

const TEXT = { "content-type": "text/plain; charset=utf-8" };
const DECISION_KEYS = ["decision", "heure", "id", "reviewer"];
const CORRECTION_KEYS = ["articleId", "text", "url"];

const COPY = {
  fr: {
    title: "Relecture",
    empty: "Rien en relecture.",
    submitted: "Soumis le",
    hour: "Heure",
    reviewer: "Réviseur ou réviseure (nom court)",
    publish: "Publier",
    schedule: "Programmer",
    back: "Renvoyer",
    save: "Enregistrer",
    due: "Publication à l'heure",
    correction: "Correction",
    propose: "Proposer",
    accept: "Accepter",
    refuse: "Refuser",
    states: { ouverte: "Ouverte", acceptee: "Acceptée", refusee: "Refusée" },
  },
  en: {
    title: "Review",
    empty: "Nothing in review.",
    submitted: "Submitted",
    hour: "Hour",
    reviewer: "Reviewer slug",
    publish: "Publish",
    schedule: "Schedule",
    back: "Send back",
    save: "Save",
    due: "Published on time",
    correction: "Correction",
    propose: "Propose",
    accept: "Accept",
    refuse: "Refuse",
    states: { ouverte: "Open", acceptee: "Accepted", refusee: "Refused" },
  },
} as const;

export async function handleReview(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
  actor?: string | null,
): Promise<Result> {
  if (!config.modules.review) return { status: 404, body: "", headers: {} };
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname;
  const lang: Lang = parsed.searchParams.get("lang") === "en" ? "en" : "fr";
  const allowed = await mayReview(deps.store, config.modules.auth ? (actor ?? null) : undefined);
  try {
    if (path === "/v1/review/echeance" && method === "POST") {
      if (rawBody.byteLength > 0 && rawBody.toString() !== "{}") throw new ReviewError("demande refusée");
      const published = await publishDue(deps.store, deps.now());
      return {
        status: 200,
        body: JSON.stringify({ published }),
        headers: { "content-type": "application/json; charset=utf-8" },
      };
    }
    if (path === "/admin/relecture/correction" && method === "POST") {
      if (!allowed) return forbidden();
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== CORRECTION_KEYS.join(",")) throw new ReviewError("demande refusée");
      if (typeof body.articleId !== "string" || typeof body.text !== "string" || typeof body.url !== "string") {
        throw new ReviewError("demande refusée");
      }
      await addCorrection(deps.store, body.articleId, body.text, body.url);
      return { status: 204, body: "", headers: {} };
    }
    if (path === "/admin/relecture/correction/decision" && method === "POST") {
      if (!allowed) return forbidden();
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "id,state") throw new ReviewError("demande refusée");
      if (typeof body.id !== "string" || typeof body.state !== "string") throw new ReviewError("demande refusée");
      await closeCorrection(deps.store, body.id, body.state);
      return { status: 204, body: "", headers: {} };
    }
    if (path === "/admin/relecture" && method === "POST") {
      if (!allowed) return forbidden();
      const params = new URLSearchParams(new TextDecoder().decode(rawBody));
      const keys = [...params.keys()].sort();
      if (keys.some((key) => !DECISION_KEYS.includes(key)) || !params.get("id") || !params.get("decision") || !params.get("reviewer")) {
        throw new ReviewError("demande refusée");
      }
      await decide(
        deps.store,
        params.get("id") ?? "",
        params.get("decision") ?? "",
        params.get("reviewer") ?? "",
        deps.now().toISOString(),
        params.get("heure") || undefined,
      );
      await publishDue(deps.store, deps.now());
      return { status: 303, body: "", headers: { location: withLang("/admin/relecture", lang) } };
    }
    if (path === "/admin/relecture" && method === "GET") {
      const published = await publishDue(deps.store, deps.now());
      return page(lang, await queue(deps.store), await readCorrections(deps.store), published, allowed);
    }
    return { status: 404, body: "", headers: {} };
  } catch (error) {
    if (error instanceof ReviewError) {
      const status = error.message === "réservé à la relecture" ? 403 : 400;
      return { status, body: error.message, headers: TEXT };
    }
    throw error;
  }
}

function forbidden(): Result {
  return { status: 403, body: "réservé à la relecture", headers: TEXT };
}

function page(
  lang: Lang,
  articles: Awaited<ReturnType<typeof queue>>,
  corrections: Awaited<ReturnType<typeof readCorrections>>,
  published: number,
  allowed: boolean,
): Result {
  const copy = COPY[lang];
  const due = published > 0 ? `<p>${copy.due} : ${published}.</p>` : "";
  const items = articles.map((article) => {
    const form = allowed
      ? `<form class="noprint" method="post" action="${withLang("/admin/relecture", lang)}">
<input type="hidden" name="id" value="${escapeAttr(article.id)}">
<label>${copy.reviewer} <input name="reviewer" value="${escapeAttr(article.reviewedBy ?? "")}"></label>
<label>${copy.hour} <input name="heure" value="${escapeAttr(article.scheduledAt ?? "")}"></label>
<button type="submit" name="decision" value="publier">${copy.publish}</button>
<button type="submit" name="decision" value="programmer">${copy.schedule}</button>
<button type="submit" name="decision" value="renvoyer">${copy.back}</button>
</form>`
      : "";
    return `<li><p>${escapeAttr(article.title)}</p><p>${copy.submitted} : ${escapeAttr(article.submittedAt ?? "")}</p>${form}</li>`;
  }).join("");
  const notes = corrections.map((item) => `<li>${escapeAttr(item.text)} <p>${copy.states[item.state]}</p></li>`).join("");
  const list = items ? `<ul>${items}</ul>` : `<p>${copy.empty}</p>`;
  const noteList = notes ? `<h2>${copy.correction}</h2><ul>${notes}</ul>` : "";
  return adminDocument(lang, copy.title, `${due}${list}${noteList}`);
}

function withLang(path: string, lang: Lang): string {
  return lang === "fr" ? path : `${path}?lang=en`;
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

function objectBody(raw: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
