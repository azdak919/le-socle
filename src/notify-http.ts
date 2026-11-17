import { adminDocument, type AdminDeps } from "./admin.ts";
import { mayUpdate } from "./auth.ts";
import type { SocleConfig } from "./config.ts";
import {
  NotifyError,
  absoluteLink,
  listSubscriptions,
  prepareSubscription,
  saveSubscription,
  sendProjectPush,
  unsubscribe,
  type NotifyChannel,
} from "./notify.ts";

type Result = { status: number; body: string; headers: Record<string, string> };

const TEXT = { "content-type": "text/plain; charset=utf-8" };
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const COPY = {
  fr: {
    title: "Abonnements",
    empty: "Aucun abonnement.",
    email: "Courriel",
    push: "Push",
    missing: "Clés push absentes.",
    key: "Clé publique",
    message: "Message",
    send: "Envoyer",
    off: "Aucun envoi : le courriel du projet ou les clés push manquent.",
  },
  en: {
    title: "Subscriptions",
    empty: "No subscription.",
    email: "Email",
    push: "Push",
    missing: "Push keys are missing.",
    key: "Public key",
    message: "Message",
    send: "Send",
    off: "Nothing was sent: the project mail or the push keys are missing.",
  },
} as const;

export async function handleNotify(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
  actor?: string | null,
): Promise<Result> {
  if (!config.modules.notify) return { status: 404, body: "", headers: {} };
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname;
  const lang = parsed.searchParams.get("lang") === "en" ? "en" : "fr";
  const runtime = deps.notify ?? {};
  try {
    if (path === "/v1/notify/cles" && method === "GET") {
      if (!runtime.publicKey || !runtime.privateKey) return { status: 409, body: "clés absentes", headers: TEXT };
      return { status: 200, body: JSON.stringify({ publicKey: runtime.publicKey }), headers: JSON_HEADERS };
    }
    if (path === "/v1/notify/abonnement" && method === "POST") {
      const body = objectBody(rawBody);
      if (!body) throw new NotifyError("demande refusée");
      const channel = body.channel;
      if (channel !== "courriel" && channel !== "push") throw new NotifyError("demande refusée");
      const expected = channel === "courriel" ? "address,channel" : "address,auth,channel,p256dh";
      if (Object.keys(body).sort().join(",") !== expected) throw new NotifyError("demande refusée");
      if (typeof body.address !== "string") throw new NotifyError("demande refusée");
      if (channel === "push" && (typeof body.p256dh !== "string" || typeof body.auth !== "string")) {
        throw new NotifyError("demande refusée");
      }
      if (channel === "courriel" && !runtime.mailer) return { status: 409, body: "smtp absent", headers: TEXT };
      if (channel === "courriel" && !runtime.publicOrigin) return { status: 409, body: "origine absente", headers: TEXT };
      const pushKeys = channel === "push" ? { p256dh: String(body.p256dh), auth: String(body.auth) } : undefined;
      const prepared = prepareSubscription(channel, body.address, runtime, pushKeys);
      if (channel === "courriel") {
        try {
          await runtime.mailer?.(prepared.address, absoluteLink(runtime.publicOrigin ?? "", prepared.token));
        } catch {
          return { status: 409, body: "smtp absent", headers: TEXT };
        }
      }
      await saveSubscription(deps.store, channel, prepared.address, prepared.token, pushKeys);
      if (channel === "courriel") return { status: 202, body: "", headers: {} };
      return {
        status: 201,
        body: JSON.stringify({ url: `/v1/notify/desabonnement?token=${encodeURIComponent(prepared.token)}` }),
        headers: JSON_HEADERS,
      };
    }
    if (path === "/v1/notify/desabonnement" && method === "GET") {
      const token = parsed.searchParams.get("token") ?? "";
      if (!token) throw new NotifyError("lien inconnu");
      await unsubscribe(deps.store, token);
      return { status: 200, body: "désabonné", headers: TEXT };
    }
    if (path === "/admin/abonnements/envoi" && method === "POST") {
      const allowed = await mayUpdate(deps.store, config.modules.auth ? (actor ?? null) : undefined);
      if (!allowed) return { status: 403, body: "réservé au responsable", headers: TEXT };
      const text = postedText(rawBody);
      if (text === null) throw new NotifyError("demande refusée");
      const sent = await deliver(deps, text);
      const form = !new TextDecoder().decode(rawBody).trim().startsWith("{");
      if (form) return { status: 303, body: "", headers: { location: withLang("/admin/abonnements", lang) } };
      return { status: 200, body: JSON.stringify({ sent }), headers: JSON_HEADERS };
    }
    if (path === "/admin/abonnements" && method === "GET") {
      return await adminPage(deps, config, lang, actor);
    }
    return { status: 404, body: "", headers: {} };
  } catch (error) {
    if (error instanceof NotifyError) {
      const status = error.message === "clés absentes" || error.message === "smtp absent" || error.message === "origine absente"
        ? 409
        : 400;
      return { status, body: error.message, headers: TEXT };
    }
    throw error;
  }
}

async function adminPage(deps: AdminDeps, config: SocleConfig, lang: "fr" | "en", actor?: string | null): Promise<Result> {
  const copy = COPY[lang];
  const rows = await listSubscriptions(deps.store);
  const emails = rows.filter((row) => row.channel === "courriel").length;
  const pushes = rows.filter((row) => row.channel === "push").length;
  const allowed = await mayUpdate(deps.store, config.modules.auth ? (actor ?? null) : undefined);
  const counts = `<p>${copy.email} : ${emails}. ${copy.push} : ${pushes}.</p>`;
  const list = !allowed
    ? ""
    : rows.length === 0
      ? `<p>${copy.empty}</p>`
      : `<ul>${rows.map((row) => `<li>${escapeText(row.channel)} · ${escapeText(row.address)}</li>`).join("")}</ul>`;
  const key = deps.notify?.publicKey
    ? `<p>${copy.key} : ${escapeText(deps.notify.publicKey)}</p>`
    : `<p>${copy.missing}</p>`;
  const form = allowed
    ? `<form class="noprint" method="post" action="${withLang("/admin/abonnements/envoi", lang)}"><label>${copy.message} <input name="text"></label> <button type="submit">${copy.send}</button></form>`
    : "";
  return adminDocument(lang, copy.title, `${counts}${list}${key}${form}`);
}

async function deliver(deps: AdminDeps, text: string): Promise<number> {
  const runtime = deps.notify ?? {};
  const rows = await listSubscriptions(deps.store);
  const emails = rows.filter((row) => row.channel === "courriel");
  const pushes = rows.filter((row) => row.channel === "push" && row.p256dh && row.auth);
  if (emails.length > 0 && !runtime.mailer) throw new NotifyError("smtp absent");
  if (pushes.length > 0 && !runtime.sendPush && (!runtime.publicKey || !runtime.privateKey)) throw new NotifyError("clés absentes");
  let sent = 0;
  for (const row of emails) {
    await runtime.mailer?.(row.address, text);
    sent += 1;
  }
  for (const row of pushes) {
    const target = { address: row.address, p256dh: row.p256dh ?? "", auth: row.auth ?? "" };
    if (runtime.sendPush) await runtime.sendPush(target, text);
    else await sendProjectPush(target, text, runtime, deps.now());
    sent += 1;
  }
  return sent;
}

function postedText(raw: Uint8Array): string | null {
  const text = new TextDecoder().decode(raw).trim();
  if (text.startsWith("{")) {
    const body = objectBody(raw);
    if (!body || Object.keys(body).sort().join(",") !== "text" || typeof body.text !== "string") return null;
    return cleanText(body.text);
  }
  const params = new URLSearchParams(text);
  if ([...params.keys()].sort().join(",") !== "text") return null;
  return cleanText(params.get("text") ?? "");
}

function cleanText(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 2000) return null;
  return text;
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

function withLang(path: string, lang: "fr" | "en"): string {
  return lang === "fr" ? path : `${path}?lang=en`;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

export type { NotifyChannel };
