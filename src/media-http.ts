import { adminDocument, type AdminDeps } from "./admin.ts";
import type { SocleConfig } from "./config.ts";
import { creditQueue } from "./media.ts";

type Result = { status: number; body: string; headers: Record<string, string> };

const COPY = {
  fr: {
    title: "Médias",
    empty: "Aucun crédit en attente.",
    missing: "Cette image n'a pas de crédit. Elle reste dans le miroir.",
  },
  en: {
    title: "Media",
    empty: "No credit waiting.",
    missing: "This image has no credit. It stays in the mirror.",
  },
} as const;

export async function handleMedia(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
): Promise<Result> {
  const parsed = new URL(url, "http://127.0.0.1");
  if (!config.modules.media || parsed.pathname !== "/admin/medias" || method !== "GET") {
    return { status: 404, body: "", headers: {} };
  }
  const lang = parsed.searchParams.get("lang") === "en" ? "en" : "fr";
  const copy = COPY[lang];
  const queue = await creditQueue(deps.store);
  const items = queue.map((item) => `<li>${item.src}<p>${copy.missing}</p></li>`).join("");
  const list = items ? `<ul>${items}</ul>` : `<p>${copy.empty}</p>`;
  const page = adminDocument(lang, copy.title, list);
  return { status: page.status, body: String(page.body), headers: page.headers };
}
