import { adminDocument, type AdminDeps } from "./admin.ts";
import { mayUpdate } from "./auth.ts";
import { AudienceError, allowName, recordEvent, resetBursts, totalsFor } from "./audience.ts";
import type { SocleConfig } from "./config.ts";

type Result = { status: number; body: string; headers: Record<string, string> };

const TEXT = { "content-type": "text/plain; charset=utf-8" };

const COPY = {
  fr: { title: "Audience", empty: "Aucun total aujourd'hui.", totals: "Totaux du jour.", name: "Nom", save: "Autoriser" },
  en: { title: "Audience", empty: "No total today.", totals: "Today's totals.", name: "Name", save: "Allow" },
} as const;

export async function handleAudience(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
  actor?: string | null,
): Promise<Result> {
  if (!config.modules.audience) return { status: 404, body: "", headers: {} };
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname;
  const lang = parsed.searchParams.get("lang") === "en" ? "en" : "fr";
  try {
    if (path === "/v1/audience/event" && method === "POST") {
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "contexte,name") throw new AudienceError("demande refusée");
      if (typeof body.name !== "string" || typeof body.contexte !== "string") throw new AudienceError("demande refusée");
      await recordEvent(deps.store, deps.now(), body.name, body.contexte);
      return { status: 204, body: "", headers: {} };
    }
    if (path === "/admin/audience/noms" && method === "POST") {
      const allowed = await mayUpdate(deps.store, config.modules.auth ? (actor ?? null) : undefined);
      if (!allowed) return { status: 403, body: "réservé au responsable", headers: TEXT };
      const name = postedName(rawBody);
      if (!name) throw new AudienceError("demande refusée");
      await allowName(deps.store, name);
      const text = new TextDecoder().decode(rawBody).trim();
      if (!text.startsWith("{")) {
        return { status: 303, body: "", headers: { location: withLang("/admin/audience", lang) } };
      }
      return { status: 204, body: "", headers: {} };
    }
    if (path === "/admin/audience" && method === "GET") {
      const copy = COPY[lang];
      const rows = await totalsFor(deps.store, deps.now());
      const items = rows.map((row) => `<li>${escapeText(row.name)} · ${escapeText(row.contexte)} · ${row.count}</li>`).join("");
      const list = items ? `<ul>${items}</ul>` : `<p>${copy.empty}</p>`;
      const allowed = await mayUpdate(deps.store, config.modules.auth ? (actor ?? null) : undefined);
      const form = allowed
        ? `<form class="noprint" method="post" action="${withLang("/admin/audience/noms", lang)}"><label>${copy.name} <input name="name"></label> <button type="submit">${copy.save}</button></form>`
        : "";
      return adminDocument(lang, copy.title, `<p>${copy.totals}</p>${list}${form}`);
    }
    return { status: 404, body: "", headers: {} };
  } catch (error) {
    if (error instanceof AudienceError) return { status: 400, body: error.message, headers: TEXT };
    throw error;
  }
}

export { resetBursts };

function withLang(path: string, lang: "fr" | "en"): string {
  return lang === "fr" ? path : `${path}?lang=en`;
}

function postedName(raw: Uint8Array): string | null {
  const text = new TextDecoder().decode(raw).trim();
  if (text.startsWith("{")) {
    const body = objectBody(raw);
    if (!body || Object.keys(body).sort().join(",") !== "name" || typeof body.name !== "string") return null;
    return body.name;
  }
  const params = new URLSearchParams(text);
  if ([...params.keys()].sort().join(",") !== "name") return null;
  return params.get("name");
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

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}
