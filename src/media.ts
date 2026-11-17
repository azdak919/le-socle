import type { SocleStore } from "./store.ts";

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export type LibraryAsset = {
  id: string;
  kind: "image" | "audio" | "video" | "document";
  src: string;
  remoteSrc: string;
  alt: string;
  credit: string;
  creditUrl: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  focalPoint: { x: number; y: number };
  institution: string;
  campus: string;
  keywords: string[];
  usages: string[];
  source: { backend: string; backendId: string; fetchedAt: string };
};

export type ArticleImage = {
  id: string;
  kind: "image";
  src: string;
  alt: string;
  credit?: string;
  source: { backend: string; backendId: string; fetchedAt: string };
};

function pathOf(src: string): string {
  const path = src.replace(/^\/+/, "");
  if (!path || path.includes("..") || path.includes("\\")) throw new MediaError("chemin refusé");
  return path;
}

/** Les octets d'origine, sans recadrage. Le budget CPU d'un Worker gratuit est de 10 ms. */
export function originalBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export async function saveLibrary(store: SocleStore, asset: LibraryAsset, bytes: Uint8Array): Promise<void> {
  if (!asset.credit?.trim()) throw new MediaError("crédit requis");
  if (!asset.id || !asset.src || !asset.alt?.trim()) throw new MediaError("fiche incomplète");
  const kept = originalBytes(bytes);
  if (kept.byteLength === 0) throw new MediaError("fichier vide");
  await store.put("media", `library:${asset.id}`, JSON.stringify(asset));
  await store.put("media", `bytes:${pathOf(asset.src)}`, Buffer.from(kept).toString("base64"));
  await store.delete("media", `queue:credit:${asset.id}`);
}

export async function saveArticleImage(store: SocleStore, asset: ArticleImage, bytes: Uint8Array): Promise<void> {
  if (!asset.id || !asset.src || !asset.alt?.trim()) throw new MediaError("fiche incomplète");
  const kept = originalBytes(bytes);
  if (kept.byteLength === 0) throw new MediaError("fichier vide");
  await store.put("media", `image:${asset.id}`, JSON.stringify(asset));
  await store.put("media", `bytes:${pathOf(asset.src)}`, Buffer.from(kept).toString("base64"));
  if (asset.credit?.trim()) await store.delete("media", `queue:credit:${asset.id}`);
  else await store.put("media", `queue:credit:${asset.id}`, asset.src);
}

export async function creditQueue(store: SocleStore): Promise<Array<{ id: string; src: string }>> {
  const rows = await store.list("media");
  return rows
    .filter((row) => row.key.startsWith("queue:credit:"))
    .map((row) => ({ id: row.key.slice("queue:credit:".length), src: row.value }));
}

export async function readBytes(store: SocleStore, src: string): Promise<Uint8Array> {
  const raw = await store.get("media", `bytes:${pathOf(src)}`);
  if (!raw) throw new MediaError("fichier absent");
  return Buffer.from(raw, "base64");
}
