/**
 * Photos publiques : `GET /media/…`.
 *
 * `sync`, chez le Kiosque, rapatrie chaque photo à l'adresse
 * `<socle>/media/banque/<id>.<ext>` donnée par l'instantané public. Le socle
 * sert donc ces octets, et seulement ceux qu'un article publié (ou archivé),
 * une signature ou la fiche du journal utilise : une photo de la banque qui
 * n'illustre rien de public reste privée.
 *
 * Même règle en Node, en PHP (`socle_public_media`) et dans le Worker.
 */
import type { SocleConfig } from "./config.ts";
import { createSocleEditorial } from "./editorial.ts";
import { readBytes } from "./media.ts";
import { sniffImage } from "./redaction-http.ts";
import type { SocleStore } from "./store.ts";

type Result = { status: number; body: Uint8Array; headers: Record<string, string> };

const INLINE = /\/media\/[A-Za-z0-9._\/-]+/g;

/** Toutes les adresses `/media/…` citées dans une valeur JSON, texte compris. */
export function mediaRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.match(INLINE) ?? []) into.add(match);
  } else if (Array.isArray(value)) {
    for (const item of value) mediaRefs(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) mediaRefs(item, into);
  }
  return into;
}

export async function handlePublicMedia(method: string, path: string, config: SocleConfig, store: SocleStore): Promise<Result | null> {
  if ((method !== "GET" && method !== "HEAD") || !path.startsWith("/media/") || !config.modules.editorial) return null;
  let wanted: string;
  try {
    wanted = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (wanted.includes("..") || wanted.includes("\\") || wanted.includes("\0")) return null;
  let refs: Set<string>;
  try {
    refs = mediaRefs(await createSocleEditorial(store).getSnapshot({ audience: "public" }));
  } catch {
    return null;
  }
  if (!refs.has(wanted)) return null;
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(store, wanted);
  } catch {
    const raw = await store.get("editorial", `bytes:${wanted.replace(/^\/+/, "")}`).catch(() => null);
    if (!raw) return null;
    bytes = new Uint8Array(Buffer.from(raw, "base64"));
  }
  const type = sniffImage(bytes);
  if (!type) return null;
  return {
    status: 200,
    body: bytes,
    headers: { "content-type": type, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
  };
}
