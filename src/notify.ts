import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";

import { ModuleOffError, type SocleStore } from "./store.ts";

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const B64 = /^[A-Za-z0-9_-]+$/;

export type NotifyChannel = "courriel" | "push";

export type SubscriptionRecord = {
  channel: NotifyChannel;
  address: string;
  hash: string;
  p256dh?: string;
  auth?: string;
};

export type PushTarget = {
  address: string;
  p256dh: string;
  auth: string;
};

export type NotifyRuntime = {
  publicOrigin?: string;
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  mailer?: (to: string, url: string) => Promise<void>;
  randomBytes?: (size: number) => Uint8Array;
  sendPush?: (target: PushTarget, text: string) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export class NotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyError";
  }
}

export function generatePushKeys(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  const raw = Buffer.from(spki).subarray(-65);
  if (raw.length !== 65 || raw[0] !== 4) throw new NotifyError("clé illisible");
  const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "der" });
  return { publicKey: base64url(raw), privateKey: base64url(Buffer.from(pkcs8)) };
}

export function prepareSubscription(
  channel: NotifyChannel,
  address: string,
  runtime: NotifyRuntime,
  push?: { p256dh: string; auth: string },
): { token: string; address: string } {
  const clean = channel === "courriel" ? normalizeEmail(address) : normalizeEndpoint(address);
  if (!clean) throw new NotifyError("demande refusée");
  if (channel === "push") {
    if (!runtime.publicKey || !runtime.privateKey) throw new NotifyError("clés absentes");
    if (!push || !validKey(push.p256dh, 65) || !validKey(push.auth, 16)) throw new NotifyError("demande refusée");
  }
  const token = base64url(runtime.randomBytes ? runtime.randomBytes(32) : randomBytes(32));
  return { token, address: clean };
}

export async function saveSubscription(
  store: SocleStore,
  channel: NotifyChannel,
  address: string,
  token: string,
  push?: { p256dh: string; auth: string },
): Promise<void> {
  const hash = hashToken(token);
  const previous = await store.get("notify", addrKey(channel, address));
  if (previous) await store.delete("notify", `lien:${previous}`);
  const record: SubscriptionRecord = {
    channel,
    address,
    hash,
    ...(channel === "push" && push ? { p256dh: push.p256dh, auth: push.auth } : {}),
  };
  await store.put("notify", `lien:${hash}`, JSON.stringify(record));
  await store.put("notify", addrKey(channel, address), hash);
}

export async function unsubscribe(store: SocleStore, token: string): Promise<void> {
  const key = `lien:${hashToken(token)}`;
  const raw = await store.get("notify", key);
  if (!raw) throw new NotifyError("lien inconnu");
  const record = JSON.parse(raw) as SubscriptionRecord;
  await store.delete("notify", key);
  await store.delete("notify", addrKey(record.channel, record.address));
}

export async function listSubscriptions(store: SocleStore): Promise<SubscriptionRecord[]> {
  const records: SubscriptionRecord[] = [];
  for (const row of await store.list("notify")) {
    if (!row.key.startsWith("lien:")) continue;
    const record = JSON.parse(row.value) as SubscriptionRecord;
    if (record.channel !== "courriel" && record.channel !== "push") continue;
    if (!record.address || !record.hash) continue;
    records.push(record);
  }
  records.sort((a, b) => a.channel.localeCompare(b.channel) || a.address.localeCompare(b.address));
  return records;
}

export async function subscriptionsForArchive(store: SocleStore): Promise<SubscriptionRecord[]> {
  try {
    return await listSubscriptions(store);
  } catch (error) {
    if (error instanceof ModuleOffError) return [];
    throw error;
  }
}

export async function restoreSubscriptions(store: SocleStore, value: unknown): Promise<void> {
  if (!Array.isArray(value)) return;
  try {
    for (const item of value) {
      if (item === null || typeof item !== "object") continue;
      const record = item as SubscriptionRecord;
      if (record.channel !== "courriel" && record.channel !== "push") continue;
      if (!record.address || !record.hash) continue;
      await store.put("notify", `lien:${record.hash}`, JSON.stringify({
        channel: record.channel,
        address: record.address,
        hash: record.hash,
        ...(record.p256dh && record.auth ? { p256dh: record.p256dh, auth: record.auth } : {}),
      }));
      await store.put("notify", addrKey(record.channel, record.address), record.hash);
    }
  } catch (error) {
    if (error instanceof ModuleOffError) return;
    throw error;
  }
}

export function absoluteLink(origin: string, token: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/v1/notify/desabonnement?token=${encodeURIComponent(token)}`;
}

export function buildPushRequest(
  target: PushTarget,
  text: string,
  runtime: NotifyRuntime,
  now: Date,
): { url: string; headers: Record<string, string>; body: Buffer } {
  if (!runtime.publicKey || !runtime.privateKey) throw new NotifyError("clés absentes");
  const clientPublic = fromBase64url(target.p256dh);
  const auth = fromBase64url(target.auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4 || auth.length !== 16) throw new NotifyError("demande refusée");
  const server = createECDH("prime256v1");
  server.generateKeys();
  const shared = server.computeSecret(clientPublic);
  const serverPublic = server.getPublicKey();
  const salt = Buffer.from(runtime.randomBytes ? runtime.randomBytes(16) : randomBytes(16));
  const ikm = hkdf(shared, auth, Buffer.concat([
    Buffer.from("WebPush: info\0"),
    clientPublic,
    serverPublic,
  ]), 32);
  const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const plain = Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([2])]);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(plain.length + 16 + 1, 0);
  const body = Buffer.concat([
    salt,
    recordSize,
    Buffer.from([serverPublic.length]),
    serverPublic,
    sealed,
  ]);
  return {
    url: target.address,
    headers: {
      authorization: `vapid t=${vapidJwt(target.address, runtime, now)}, k=${runtime.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
    },
    body,
  };
}

export async function sendProjectPush(target: PushTarget, text: string, runtime: NotifyRuntime, now: Date): Promise<void> {
  const request = buildPushRequest(target, text, runtime, now);
  const fetchImpl = runtime.fetch ?? fetch;
  const response = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: request.body });
  if (!response.ok) throw new NotifyError("push refusé");
}

function vapidJwt(endpoint: string, runtime: NotifyRuntime, now: Date): string {
  const header = base64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims: { aud: string; exp: number; sub?: string } = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
  };
  if (runtime.subject) claims.sub = runtime.subject;
  const payload = base64url(Buffer.from(JSON.stringify(claims)));
  const key = createPrivateKey({ key: fromBase64url(runtime.privateKey ?? ""), format: "der", type: "pkcs8" });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${base64url(signature)}`;
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return null;
  return email;
}

function normalizeEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || value.length > 500) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function validKey(value: string, bytes: number): boolean {
  if (!B64.test(value)) return false;
  return fromBase64url(value).length === bytes;
}

function addrKey(channel: NotifyChannel, address: string): string {
  return `addr:${channel}:${hashToken(address)}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
