import type { SocleStore } from "./store.ts";
import { ModuleOffError } from "./store.ts";

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
  caption?: string;
  checksum?: string;
  /** Miniatures d'affichage, produites en PHP avec GD. Absentes sans GD, en Node ou sur le Worker. */
  variants?: Array<{ src: string; width: number; height: number }>;
  source: { backend: string; backendId: string; fetchedAt: string };
};

export type ArticleImage = {
  id: string;
  kind: "image";
  src: string;
  alt: string;
  credit?: string;
  caption?: string;
  checksum?: string;
  variants?: Array<{ src: string; width: number; height: number }>;
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

export async function libraryAssets(store: SocleStore): Promise<LibraryAsset[]> {
  const rows = await store.list("media");
  return rows.filter((row) => row.key.startsWith("library:")).map((row) => JSON.parse(row.value) as LibraryAsset);
}

export async function findDuplicate(store: SocleStore, checksum: string, ignoreId = ""): Promise<LibraryAsset | null> {
  if (!checksum) return null;
  for (const asset of await libraryAssets(store)) {
    if (asset.id === ignoreId) continue;
    if (asset.checksum === checksum) return asset;
  }
  return null;
}

export async function deleteMediaFiles(store: SocleStore, asset: { src: string; variants?: Array<{ src: string }> }): Promise<void> {
  await store.delete("media", `bytes:${pathOf(asset.src)}`);
  for (const variant of asset.variants ?? []) {
    if (variant?.src) await store.delete("media", `bytes:${pathOf(variant.src)}`);
  }
}


export function attachVariants<T>(value: T, bySrc: Map<string, LibraryAsset>): T {
  if (Array.isArray(value)) {
    for (const item of value) attachVariants(item, bySrc);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const src = record.src;
  if (typeof src === "string" && bySrc.has(src)) {
    const asset = bySrc.get(src)!;
    if (asset.variants?.length) record.variants = asset.variants;
    if (record.width == null && asset.width) record.width = asset.width;
    if (record.height == null && asset.height) record.height = asset.height;
  }
  for (const item of Object.values(record)) attachVariants(item, bySrc);
  return value;
}

export async function attachLibraryVariants<T extends object>(store: SocleStore, snapshot: T): Promise<T> {
  try {
    const bySrc = new Map((await libraryAssets(store)).filter((asset) => asset.src).map((asset) => [asset.src, asset]));
    return attachVariants(snapshot, bySrc);
  } catch (error) {
    if (error instanceof ModuleOffError) return snapshot;
    throw error;
  }
}
