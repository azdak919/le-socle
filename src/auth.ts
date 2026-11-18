import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

import { cleanScope, ROLES, SCOPED, type OrgRole } from "./roles.ts";
import { ModuleOffError, type SocleStore } from "./store.ts";

/** Anciens noms de rôle encore lus (comptes et archives d’avant 1.2). */
const LEGACY_ROLES: Record<string, (typeof ROLES)[number]> = { responsable: "administrateur" };
const MAGIC_MS = 15 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;

export type { OrgRole } from "./roles.ts";
export type AuthMode = "magic" | "github" | "access" | "motdepasse";

const PBKDF2_ITERATIONS = 210000;
const MIN_PASSWORD = 10;
const MAX_TRIES = 10;
const TRIES_MS = 15 * 60 * 1000;
const DUMMY_HASH = "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthRuntime = {
  mode?: string;
  mailer?: (to: string, url: string) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  verifyAccess?: (token: string) => Promise<string | null>;
  publicOrigin?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  randomBytes?: (size: number) => Uint8Array;
};

/** `sections` : rubriques permises (auteur, chef de pupitre) ; absent = toutes. */
export type MemberRecord = { email: string; role: OrgRole; sections?: string[] };

/**
 * Mot de passe : PBKDF2-SHA256, sel de 16 octets, 210 000 tours. Même format
 * en PHP (`hash_pbkdf2`) : `pbkdf2-sha256$tours$sel$empreinte` (base64url).
 */
export function hashPassword(password: string, salt: Uint8Array = randomBytes(16)): string {
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${Buffer.from(salt).toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const rounds = Number(parts[1]);
  if (!Number.isInteger(rounds) || rounds < 1000 || rounds > 2_000_000) return false;
  const expected = Buffer.from(parts[3], "base64url");
  const actual = pbkdf2Sync(password, Buffer.from(parts[2], "base64url"), rounds, expected.length, "sha256");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function checkPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > 200) {
    throw new AuthError("mot de passe trop court");
  }
  return password;
}

async function anyMember(store: SocleStore): Promise<boolean> {
  return (await store.list("auth")).some((row) => row.key.startsWith("member:") && canonicalRole(row.value) !== null);
}

/** Premier passage : sans aucun membre, la première personne devient administrateur. */
export async function passwordInstall(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  email: unknown,
  password: unknown,
): Promise<string> {
  requireMode(runtime, "motdepasse");
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  const secret = checkPassword(password);
  if (await anyMember(store)) throw new AuthError("déjà installé");
  await store.put("auth", `member:${clean}`, "administrateur");
  await store.put("auth", `password:${clean}`, hashPassword(secret));
  return createSession(store, runtime, clean, now);
}

export async function passwordLogin(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  email: unknown,
  password: unknown,
): Promise<string> {
  requireMode(runtime, "motdepasse");
  const clean = normalizeEmail(email);
  if (!clean || typeof password !== "string") throw new AuthError("accès refusé");
  const triesKey = `tries:${clean}`;
  const tries = JSON.parse((await store.get("auth", triesKey)) ?? "{}") as { n?: number; since?: string };
  const fresh = tries.since && now.getTime() - Date.parse(tries.since) < TRIES_MS;
  if (fresh && (tries.n ?? 0) >= MAX_TRIES) throw new AuthError("trop d'essais");
  // Toujours un calcul PBKDF2, même pour une adresse inconnue : la durée de
  // la réponse ne dit pas qui a un compte.
  const known = (await roleOf(store, clean)) !== null;
  const matches = verifyPassword(password, (known ? await store.get("auth", `password:${clean}`) : null) ?? DUMMY_HASH);
  const ok = known && matches;
  if (!ok) {
    await store.put("auth", triesKey, JSON.stringify({ n: (fresh ? tries.n ?? 0 : 0) + 1, since: fresh ? tries.since : now.toISOString() }));
    throw new AuthError("accès refusé");
  }
  await store.delete("auth", triesKey);
  await forgetExpired(store, now);
  return createSession(store, runtime, clean, now);
}

export async function logout(store: SocleStore, cookie: string | undefined): Promise<void> {
  const token = readCookie(cookie, "socle_session");
  if (token) await store.delete("auth", `session:${hashToken(token)}`);
}

export async function authState(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  actor: string | null,
): Promise<{ mode: string | null; installed: boolean; email: string | null; role: OrgRole | null }> {
  return {
    mode: runtime?.mode ?? null,
    installed: await anyMember(store),
    email: actor,
    role: actor ? await roleOf(store, actor) : null,
  };
}

export async function listMembers(store: SocleStore, actor: string | null): Promise<MemberRecord[]> {
  if (!actor || (await roleOf(store, actor)) !== "administrateur") throw new AuthError("réservé à l’administrateur");
  return membersForArchive(store);
}

export function isRole(value: string | null | undefined): value is OrgRole {
  return value !== null && value !== undefined && (ROLES as readonly string[]).includes(value);
}

/** Rôle à jour : « responsable » (ancien nom) devient « administrateur ». */
export function canonicalRole(value: string | null | undefined): OrgRole | null {
  if (isRole(value)) return value;
  return value ? LEGACY_ROLES[value] ?? null : null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionCookie(token: string): string {
  return `socle_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}

/** Ancien nom, gardé pour les intégrations existantes. */
export const ensureResponsable = (store: SocleStore, email: string | undefined): Promise<void> => ensureAdministrateur(store, email);

export async function ensureAdministrateur(store: SocleStore, email: string | undefined): Promise<void> {
  if (!email?.trim()) return;
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  await store.put("auth", `member:${clean}`, "administrateur");
}

export async function roleOf(store: SocleStore, email: string): Promise<OrgRole | null> {
  try {
    return canonicalRole(await store.get("auth", `member:${email}`));
  } catch (error) {
    if (error instanceof ModuleOffError) return null;
    throw error;
  }
}

export async function mayUpdate(store: SocleStore, actor: string | null | undefined): Promise<boolean> {
  if (actor === undefined) return true;
  if (!actor) return false;
  return (await roleOf(store, actor)) === "administrateur";
}

/** Rubriques d'un compte ; liste vide = toutes. */
export async function scopeOf(store: SocleStore, email: string): Promise<string[]> {
  try {
    const raw = await store.get("auth", `scope:${email}`);
    return raw ? cleanScope(JSON.parse(raw)) : [];
  } catch (error) {
    if (error instanceof ModuleOffError || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function writeScope(store: SocleStore, email: string, role: OrgRole, sections: unknown): Promise<void> {
  const scope = SCOPED.includes(role) ? cleanScope(sections) : [];
  if (scope.length) await store.put("auth", `scope:${email}`, JSON.stringify(scope));
  else await store.delete("auth", `scope:${email}`);
}

export async function saveMember(
  store: SocleStore,
  actor: string | null,
  email: string,
  role: string,
  password?: string,
  sections?: unknown,
): Promise<void> {
  if (!actor || (await roleOf(store, actor)) !== "administrateur") throw new AuthError("réservé à l’administrateur");
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  const canonical = canonicalRole(role);
  if (!canonical) throw new AuthError("rôle inconnu");
  if (password !== undefined) {
    const secret = checkPassword(password);
    await store.put("auth", `password:${clean}`, hashPassword(secret));
  }
  await store.put("auth", `member:${clean}`, canonical);
  await writeScope(store, clean, canonical, sections);
}

export async function startMagic(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  email: string,
): Promise<void> {
  requireMode(runtime, "magic");
  if (!runtime?.mailer) throw new AuthError("smtp absent");
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  await forgetExpired(store, now);
  const raw = newToken(runtime);
  const hash = hashToken(raw);
  const exp = new Date(now.getTime() + MAGIC_MS).toISOString();
  await store.put("auth", `magic:${hash}`, JSON.stringify({ email: clean, exp }));
  const origin = (runtime.publicOrigin ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  try {
    await runtime.mailer(clean, `${origin}/v1/auth/lien?token=${encodeURIComponent(raw)}`);
  } catch {
    await store.delete("auth", `magic:${hash}`);
    throw new AuthError("smtp absent");
  }
}

export async function consumeMagic(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  token: string,
): Promise<string> {
  requireMode(runtime, "magic");
  if (!token) throw new AuthError("lien inconnu");
  const hash = hashToken(token);
  const row = await store.get("auth", `magic:${hash}`);
  if (!row) throw new AuthError("lien inconnu");
  await store.delete("auth", `magic:${hash}`);
  const parsed = JSON.parse(row) as { email?: string; exp?: string };
  if (!parsed.email || !parsed.exp || Date.parse(parsed.exp) <= now.getTime()) throw new AuthError("lien expiré");
  await forgetExpired(store, now);
  return createSession(store, runtime, parsed.email, now);
}

export async function githubStart(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
): Promise<string> {
  requireMode(runtime, "github");
  if (!runtime?.githubClientId || !runtime?.githubClientSecret) throw new AuthError("client absent");
  await forgetExpired(store, now);
  const state = newToken(runtime);
  await store.put("auth", `state:${hashToken(state)}`, JSON.stringify({
    exp: new Date(now.getTime() + STATE_MS).toISOString(),
  }));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", runtime.githubClientId);
  url.searchParams.set("scope", "user:email");
  url.searchParams.set("state", state);
  if (runtime.publicOrigin) {
    url.searchParams.set("redirect_uri", `${runtime.publicOrigin.replace(/\/$/, "")}/v1/auth/github/retour`);
  }
  return url.toString();
}

export async function githubFinish(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  code: string,
  state: string,
): Promise<string> {
  requireMode(runtime, "github");
  if (!runtime?.githubClientId || !runtime?.githubClientSecret) throw new AuthError("client absent");
  if (!runtime.fetch) throw new AuthError("réseau absent");
  if (!code || !state) throw new AuthError("demande refusée");
  const key = `state:${hashToken(state)}`;
  const row = await store.get("auth", key);
  await store.delete("auth", key);
  if (!row) throw new AuthError("demande refusée");
  const parsed = JSON.parse(row) as { exp?: string };
  if (!parsed.exp || Date.parse(parsed.exp) <= now.getTime()) throw new AuthError("lien expiré");
  const email = await githubEmail(runtime, code);
  return createSession(store, runtime, email, now);
}

export async function accessLogin(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  assertion: string | undefined,
): Promise<string> {
  requireMode(runtime, "access");
  if (!assertion) throw new AuthError("accès refusé");
  const verify = runtime?.verifyAccess ?? rejectAccess;
  let email: string | null = null;
  try {
    email = await verify(assertion);
  } catch {
    email = null;
  }
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("accès refusé");
  return createSession(store, runtime, clean, now);
}

export async function emailFromCookie(
  store: SocleStore,
  now: () => Date,
  cookie: string | undefined,
): Promise<string | null> {
  const token = readCookie(cookie, "socle_session");
  if (!token) return null;
  const key = `session:${hashToken(token)}`;
  try {
    const row = await store.get("auth", key);
    if (!row) return null;
    const parsed = JSON.parse(row) as { email?: string; exp?: string };
    if (!parsed.email || !parsed.exp || Date.parse(parsed.exp) <= now().getTime()) {
      await store.delete("auth", key);
      return null;
    }
    return parsed.email;
  } catch (error) {
    if (error instanceof ModuleOffError) return null;
    throw error;
  }
}

export async function membersForArchive(store: SocleStore): Promise<MemberRecord[]> {
  try {
    const rows = await store.list("auth");
    const members: MemberRecord[] = [];
    for (const row of rows) {
      if (!row.key.startsWith("member:")) continue;
      const role = canonicalRole(row.value);
      if (!role) continue;
      const email = row.key.slice("member:".length);
      const sections = await scopeOf(store, email);
      members.push(sections.length ? { email, role, sections } : { email, role });
    }
    members.sort((a, b) => a.email.localeCompare(b.email));
    return members;
  } catch (error) {
    if (error instanceof ModuleOffError) return [];
    throw error;
  }
}

export async function restoreMembers(store: SocleStore, value: unknown): Promise<void> {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { email?: unknown; role?: unknown; sections?: unknown };
    const email = normalizeEmail(record.email);
    const role = canonicalRole(typeof record.role === "string" ? record.role : null);
    if (!email || !role) continue;
    try {
      await store.put("auth", `member:${email}`, role);
      await writeScope(store, email, role, record.sections);
    } catch (error) {
      if (error instanceof ModuleOffError) return;
      throw error;
    }
  }
}

/** Sans vérificateur injecté, le jeton Access n'est pas décodé et n'ouvre pas de session. */
export function rejectAccess(_token: string): Promise<null> {
  return Promise.resolve(null);
}

function requireMode(runtime: AuthRuntime | undefined, expected: AuthMode): asserts runtime is AuthRuntime {
  if (runtime?.mode !== expected) throw new AuthError("mode inconnu");
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function newToken(runtime: AuthRuntime): string {
  const bytes = runtime.randomBytes ? runtime.randomBytes(32) : randomBytes(32);
  if (bytes.byteLength !== 32) throw new AuthError("demande refusée");
  return Buffer.from(bytes).toString("base64url");
}

async function createSession(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  email: string,
  now: Date,
): Promise<string> {
  if (!runtime) throw new AuthError("mode inconnu");
  const raw = newToken(runtime);
  await store.put("auth", `session:${hashToken(raw)}`, JSON.stringify({
    email,
    exp: new Date(now.getTime() + SESSION_MS).toISOString(),
  }));
  return raw;
}

async function forgetExpired(store: SocleStore, now: Date): Promise<void> {
  const rows = await store.list("auth");
  for (const row of rows) {
    if (!row.key.startsWith("magic:") && !row.key.startsWith("state:") && !row.key.startsWith("session:")) continue;
    let exp = "";
    try {
      exp = (JSON.parse(row.value) as { exp?: string }).exp ?? "";
    } catch {
      exp = "";
    }
    if (!exp || Date.parse(exp) <= now.getTime()) await store.delete("auth", row.key);
  }
}

async function githubEmail(runtime: AuthRuntime, code: string): Promise<string> {
  if (!runtime.fetch) throw new AuthError("réseau absent");
  try {
    const tokenRes = await runtime.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: runtime.githubClientId,
        client_secret: runtime.githubClientSecret,
        code,
      }),
    });
    const tokenBody = await tokenRes.json() as { access_token?: string };
    if (!tokenRes.ok || !tokenBody.access_token) throw new AuthError("github refusé");
    const emailsRes = await runtime.fetch("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tokenBody.access_token}`,
      },
    });
    const emails = await emailsRes.json() as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
    const chosen = emails.find((item) => item.primary && item.verified)?.email
      ?? emails.find((item) => item.verified)?.email;
    const clean = normalizeEmail(chosen);
    if (!emailsRes.ok || !clean) throw new AuthError("github refusé");
    return clean;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("github refusé");
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}
