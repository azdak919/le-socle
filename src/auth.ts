import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

import { cleanScope, ROLES, SCOPED, type OrgRole } from "./roles.ts";
import { resolveSmtp } from "./smtp.ts";
import { ModuleOffError, type SocleStore } from "./store.ts";
import {
  assurerCodeInstallation,
  avisDonneesExposees,
  dossierDesDonnees,
  retirerCodeInstallation,
  verifierCodeInstallation,
  viaRouteur,
} from "./install-securite.ts";

/** Anciens noms de rôle encore lus (comptes et archives d’avant 1.2). */
const LEGACY_ROLES: Record<string, (typeof ROLES)[number]> = { responsable: "administrateur" };
const MAGIC_MS = 15 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const EMAIL_CHANGE_MS = 60 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const RESET_MAX = 5;
const RESET_IP_MAX = 20;

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
  mailer?: (to: string, subject: string, text: string) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  verifyAccess?: (token: string) => Promise<string | null>;
  publicOrigin?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  randomBytes?: (size: number) => Uint8Array;
  /** Présence réelle d’un SMTP (réglages enregistrés ou environnement). */
  smtpConfigured?: () => boolean | Promise<boolean>;
};

/** `sections` : rubriques permises (auteur, chef de pupitre) ; absent = toutes. */
export type MemberRecord = {
  email: string;
  role: OrgRole;
  sections?: string[];
  prenom?: string;
  nom?: string;
  nomAffiche?: string;
  affichage?: string;
};

export type CourrielEtat = "confirmee" | "non-confirmee" | "en-attente";

export type ProfileNames = { prenom: string; nom: string; nomAffiche: string };

export type ProfileRecord = {
  email: string;
  prenom: string;
  nom: string;
  nomAffiche: string;
  affichage: string;
  courrielEtat: CourrielEtat;
  courrielEnAttente: string | null;
};

/** Nom montré : le nom d’affichage s’il est rempli, sinon « Prénom Nom ». */
export function nomPourAffichage(names: ProfileNames): string {
  const affiche = names.nomAffiche.trim();
  if (affiche) return affiche;
  return [names.prenom, names.nom].map((part) => part.trim()).filter(Boolean).join(" ");
}

/**
 * Ancien format : un seul champ `nom` (nom complet), sans clé `prenom`.
 * On ne le découpe jamais : s’il n’y a pas déjà un nom d’affichage, on y
 * range l’ancienne valeur, et on laisse prénom et nom à compléter.
 */
export function parseStoredProfile(raw: string | null | undefined): ProfileNames {
  const empty: ProfileNames = { prenom: "", nom: "", nomAffiche: "" };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as { prenom?: unknown; nom?: unknown; nomAffiche?: unknown };
    if (!parsed || typeof parsed !== "object") return empty;
    const nom = typeof parsed.nom === "string" ? parsed.nom : "";
    const nomAffiche = typeof parsed.nomAffiche === "string" ? parsed.nomAffiche : "";
    if (Object.prototype.hasOwnProperty.call(parsed, "prenom")) {
      return {
        prenom: typeof parsed.prenom === "string" ? parsed.prenom : "",
        nom,
        nomAffiche,
      };
    }
    return { prenom: "", nom: "", nomAffiche: nomAffiche.trim() ? nomAffiche : nom };
  } catch {
    return empty;
  }
}

function storedProfileJson(names: ProfileNames): string {
  return JSON.stringify({ prenom: names.prenom, nom: names.nom, nomAffiche: names.nomAffiche });
}

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
  code: unknown = undefined,
  names?: { prenom?: unknown; nom?: unknown },
): Promise<string> {
  requireMode(runtime, "motdepasse");
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  const secret = checkPassword(password);
  if (await anyMember(store)) throw new AuthError("déjà installé");
  try {
    await verifierCodeInstallation(store, code);
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : "Ce code d’installation n’est pas le bon. Il se trouve dans le fichier donnees/code-installation.txt, sur le serveur.");
  }
  await store.put("auth", `member:${clean}`, "administrateur");
  await store.put("auth", `password:${clean}`, hashPassword(secret));
  if (names && (names.prenom !== undefined || names.nom !== undefined)) {
    const next = {
      prenom: names.prenom !== undefined ? cleanName(names.prenom, "prénom") : "",
      nom: names.nom !== undefined ? cleanName(names.nom, "nom") : "",
      nomAffiche: "",
    };
    if (next.prenom || next.nom) await store.put("auth", `profil:${clean}`, storedProfileJson(next));
  }
  const session = await createSession(store, runtime, clean, now);
  await retirerCodeInstallation(store);
  return session;
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
  journal: string | null = null,
): Promise<{
  mode: string | null;
  installed: boolean;
  email: string | null;
  role: OrgRole | null;
  journal: string | null;
  courriel: boolean;
  codeRequis: boolean;
  avisDonnees: string | null;
}> {
  const installed = await anyMember(store);
  if (!installed && (runtime?.mode ?? null) === "motdepasse") {
    const { code, created } = await assurerCodeInstallation(store);
    if (created) console.log(`Socle : code d’installation (donnees/code-installation.txt) : ${code}`);
  }
  return {
    mode: runtime?.mode ?? null,
    installed,
    email: actor,
    role: actor ? await roleOf(store, actor) : null,
    journal: journal?.trim() ? journal.trim() : null,
    courriel: Boolean(await resolveSmtp(store)) || await canSendMail(runtime),
    codeRequis: !installed && (runtime?.mode ?? null) === "motdepasse",
    avisDonnees: avisDonneesExposees({
      dataDir: dossierDesDonnees(),
      webRoot: process.cwd(),
      viaRouteur: viaRouteur(),
    }),
  };
}

export async function listMembers(store: SocleStore, actor: string | null): Promise<MemberRecord[]> {
  if (!actor || (await roleOf(store, actor)) !== "administrateur") throw new AuthError("réservé à l’administrateur");
  const members = await membersForArchive(store);
  const listed: MemberRecord[] = [];
  for (const member of members) {
    const names = parseStoredProfile(await store.get("auth", `profil:${member.email}`));
    listed.push({
      email: member.email,
      role: member.role,
      ...(member.sections ? { sections: member.sections } : {}),
      prenom: names.prenom,
      nom: names.nom,
      nomAffiche: names.nomAffiche,
      affichage: nomPourAffichage(names),
    });
  }
  return listed;
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

export function cookieSecure(runtime: AuthRuntime | undefined): boolean {
  return Boolean(runtime?.publicOrigin?.startsWith("https://"));
}

export function sessionCookie(token: string, secure = false): string {
  const flag = secure ? "; Secure" : "";
  return `socle_session=${token}; HttpOnly; Path=/; SameSite=Lax${flag}; Max-Age=${SESSION_MS / 1000}`;
}

export function clearSessionCookie(secure = false): string {
  const flag = secure ? "; Secure" : "";
  return `socle_session=; HttpOnly; Path=/; SameSite=Lax${flag}; Max-Age=0`;
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
  names?: { prenom?: unknown; nom?: unknown; nomAffiche?: unknown },
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
  if (names && (names.prenom !== undefined || names.nom !== undefined || names.nomAffiche !== undefined)) {
    const current = parseStoredProfile(await store.get("auth", `profil:${clean}`));
    const next: ProfileNames = {
      prenom: names.prenom !== undefined ? cleanName(names.prenom, "prénom") : current.prenom,
      nom: names.nom !== undefined ? cleanName(names.nom, "nom") : current.nom,
      nomAffiche: names.nomAffiche !== undefined ? cleanName(names.nomAffiche, "nom d’affichage") : current.nomAffiche,
    };
    await store.put("auth", `profil:${clean}`, storedProfileJson(next));
  }
}

export async function startMagic(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  email: string,
): Promise<void> {
  requireMode(runtime, "magic");
  if (!await canSendMail(runtime) || !runtime?.mailer) throw new AuthError("smtp absent");
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  await forgetExpired(store, now);
  const raw = newToken(runtime);
  const hash = hashToken(raw);
  const exp = new Date(now.getTime() + MAGIC_MS).toISOString();
  await store.put("auth", `magic:${hash}`, JSON.stringify({ email: clean, exp }));
  const origin = (runtime.publicOrigin ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  try {
    const url = `${origin}/v1/auth/lien?token=${encodeURIComponent(raw)}`;
    await runtime.mailer(
      clean,
      "Lien de connexion",
      `Bonjour,\n\nPour ouvrir l’espace de rédaction, suivez ce lien (il expire dans 15 minutes) :\n\n${url}\n`,
    );
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
      const names = parseStoredProfile(await store.get("auth", `profil:${email}`));
      const record: MemberRecord = sections.length ? { email, role, sections } : { email, role };
      if (names.prenom || names.nom || names.nomAffiche) {
        record.prenom = names.prenom;
        record.nom = names.nom;
        record.nomAffiche = names.nomAffiche;
      }
      members.push(record);
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
    const record = item as { email?: unknown; role?: unknown; sections?: unknown; prenom?: unknown; nom?: unknown; nomAffiche?: unknown };
    const email = normalizeEmail(record.email);
    const role = canonicalRole(typeof record.role === "string" ? record.role : null);
    if (!email || !role) continue;
    try {
      await store.put("auth", `member:${email}`, role);
      await writeScope(store, email, role, record.sections);
      if (record.prenom !== undefined || record.nom !== undefined || record.nomAffiche !== undefined) {
        const names: ProfileNames = {
          prenom: typeof record.prenom === "string" ? record.prenom : "",
          nom: typeof record.nom === "string" ? record.nom : "",
          nomAffiche: typeof record.nomAffiche === "string" ? record.nomAffiche : "",
        };
        await store.put("auth", `profil:${email}`, storedProfileJson(names));
      }
    } catch (error) {
      if (error instanceof ModuleOffError) return;
      throw error;
    }
  }
}

async function tooManyTries(
  store: SocleStore,
  key: string,
  now: Date,
  max: number,
  windowMs: number = TRIES_MS,
): Promise<boolean> {
  const tries = JSON.parse((await store.get("auth", key)) ?? "{}") as { n?: number; since?: string };
  const fresh = Boolean(tries.since && now.getTime() - Date.parse(tries.since) < windowMs);
  return fresh && (tries.n ?? 0) >= max;
}

async function bumpTries(
  store: SocleStore,
  key: string,
  now: Date,
  windowMs: number = TRIES_MS,
): Promise<void> {
  const tries = JSON.parse((await store.get("auth", key)) ?? "{}") as { n?: number; since?: string };
  const fresh = Boolean(tries.since && now.getTime() - Date.parse(tries.since) < windowMs);
  await store.put("auth", key, JSON.stringify({
    n: (fresh ? tries.n ?? 0 : 0) + 1,
    since: fresh ? tries.since : now.toISOString(),
  }));
}

export async function revokeSessions(store: SocleStore, email: string, keepHash?: string): Promise<void> {
  const rows = await store.list("auth");
  for (const row of rows) {
    if (!row.key.startsWith("session:")) continue;
    if (keepHash && row.key === `session:${keepHash}`) continue;
    let stored = "";
    try {
      stored = (JSON.parse(row.value) as { email?: string }).email ?? "";
    } catch {
      stored = "";
    }
    if (stored === email) await store.delete("auth", row.key);
  }
}

async function rewriteSessionEmail(store: SocleStore, from: string, to: string): Promise<void> {
  const rows = await store.list("auth");
  for (const row of rows) {
    if (!row.key.startsWith("session:")) continue;
    let parsed: { email?: string; exp?: string };
    try {
      parsed = JSON.parse(row.value) as { email?: string; exp?: string };
    } catch {
      continue;
    }
    if (parsed.email === from) {
      await store.put("auth", row.key, JSON.stringify({ ...parsed, email: to }));
    }
  }
}

export async function startPasswordReset(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  email: unknown,
  ip?: string | null,
): Promise<void> {
  requireMode(runtime, "motdepasse");
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  if (ip && await tooManyTries(store, `reset-ip:${ip}`, now, RESET_IP_MAX)) throw new AuthError("trop d'essais");
  if (await tooManyTries(store, `reset-tries:${clean}`, now, RESET_MAX)) throw new AuthError("trop d'essais");
  await bumpTries(store, `reset-tries:${clean}`, now);
  if (ip) await bumpTries(store, `reset-ip:${ip}`, now);
  const known = (await roleOf(store, clean)) !== null;
  if (!known || !await canSendMail(runtime) || !runtime.mailer) return;
  await forgetExpired(store, now);
  const raw = newToken(runtime);
  const hash = hashToken(raw);
  await store.put("auth", `reset:${hash}`, JSON.stringify({
    email: clean,
    exp: new Date(now.getTime() + RESET_MS).toISOString(),
  }));
  const origin = (runtime.publicOrigin ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const url = `${origin}/redaction/#reinitialiser=${encodeURIComponent(raw)}`;
  try {
    await runtime.mailer(
      clean,
      "Réinitialiser votre mot de passe",
      `Bonjour,\n\nPour choisir un nouveau mot de passe pour l’espace de rédaction, suivez ce lien (il expire dans une heure, et ne sert qu’une fois) :\n\n${url}\n\nSi vous n’avez pas demandé ce message, vous pouvez l’ignorer.\n`,
    );
  } catch {
    await store.delete("auth", `reset:${hash}`);
  }
}

export async function consumePasswordReset(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  token: unknown,
  password: unknown,
): Promise<string> {
  requireMode(runtime, "motdepasse");
  if (typeof token !== "string" || !token) throw new AuthError("lien inconnu");
  const hash = hashToken(token);
  const row = await store.get("auth", `reset:${hash}`);
  if (!row) throw new AuthError("lien inconnu");
  await store.delete("auth", `reset:${hash}`);
  const parsed = JSON.parse(row) as { email?: string; exp?: string };
  if (!parsed.email || !parsed.exp || Date.parse(parsed.exp) <= now.getTime()) throw new AuthError("lien expiré");
  const secret = checkPassword(password);
  await store.put("auth", `password:${parsed.email}`, hashPassword(secret));
  await store.delete("auth", `tries:${parsed.email}`);
  await revokeSessions(store, parsed.email);
  await forgetExpired(store, now);
  return createSession(store, runtime, parsed.email, now);
}

type PendingCourriel = { email: string; nouveau: string; exp: string; kind?: "changement" | "confirmation" };

async function canSendMail(runtime: AuthRuntime | undefined): Promise<boolean> {
  if (runtime?.smtpConfigured) return Boolean(await runtime.smtpConfigured());
  return Boolean(runtime?.mailer);
}

function isConfirmedFlag(value: string | null): boolean {
  return Boolean(value);
}

async function emailIsConfirmed(store: SocleStore, email: string): Promise<boolean> {
  return isConfirmedFlag(await store.get("auth", `courriel-ok:${email}`));
}

async function markEmailConfirmed(store: SocleStore, email: string, now: Date): Promise<void> {
  await store.put("auth", `courriel-ok:${email}`, now.toISOString());
}

async function dropPendingCourriel(store: SocleStore, actor: string, now: Date): Promise<void> {
  await forgetExpired(store, now);
  for (const row of await store.list("auth")) {
    if (!row.key.startsWith("courriel:")) continue;
    let parsed: PendingCourriel | null = null;
    try {
      parsed = JSON.parse(row.value) as PendingCourriel;
    } catch {
      parsed = null;
    }
    if (parsed?.email === actor) await store.delete("auth", row.key);
  }
}

async function findPendingCourriel(store: SocleStore, actor: string, now: Date): Promise<PendingCourriel | null> {
  await forgetExpired(store, now);
  let found: PendingCourriel | null = null;
  for (const row of await store.list("auth")) {
    if (!row.key.startsWith("courriel:")) continue;
    let parsed: PendingCourriel | null = null;
    try {
      parsed = JSON.parse(row.value) as PendingCourriel;
    } catch {
      parsed = null;
    }
    if (!parsed?.email || parsed.email !== actor || !parsed.nouveau || !parsed.exp) continue;
    if (Date.parse(parsed.exp) <= now.getTime()) continue;
    found = parsed;
  }
  return found;
}

async function loadProfile(store: SocleStore, email: string, now = new Date()): Promise<ProfileRecord> {
  const names = parseStoredProfile(await store.get("auth", `profil:${email}`));
  const pending = await findPendingCourriel(store, email, now);
  const confirmingSelf = pending?.kind === "confirmation" || (pending?.nouveau === email);
  const changing = Boolean(pending && pending.nouveau !== email);
  const courrielEtat: CourrielEtat = confirmingSelf
    ? "en-attente"
    : (await emailIsConfirmed(store, email) ? "confirmee" : "non-confirmee");
  return {
    email,
    prenom: names.prenom,
    nom: names.nom,
    nomAffiche: names.nomAffiche,
    affichage: nomPourAffichage(names),
    courrielEtat,
    courrielEnAttente: changing ? pending!.nouveau : null,
  };
}

function cleanName(value: unknown, label: string): string {
  if (value === undefined) throw new AuthError("demande refusée");
  if (typeof value !== "string") throw new AuthError("demande refusée");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > 120) throw new AuthError(`${label} trop long`);
  return name;
}

export async function readProfile(store: SocleStore, actor: string | null, now = new Date()): Promise<ProfileRecord> {
  if (!actor) throw new AuthError("accès refusé");
  if (!(await roleOf(store, actor))) throw new AuthError("accès refusé");
  return loadProfile(store, actor, now);
}

export async function updateProfile(
  store: SocleStore,
  actor: string | null,
  prenom: unknown,
  nom: unknown,
  nomAffiche: unknown,
  now: Date,
): Promise<ProfileRecord> {
  if (!actor) throw new AuthError("accès refusé");
  if (!(await roleOf(store, actor))) throw new AuthError("accès refusé");
  const names: ProfileNames = {
    prenom: cleanName(prenom, "prénom"),
    nom: cleanName(nom, "nom"),
    nomAffiche: cleanName(nomAffiche, "nom d’affichage"),
  };
  await store.put("auth", `profil:${actor}`, storedProfileJson(names));
  return loadProfile(store, actor, now);
}

export async function changeOwnPassword(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  actor: string | null,
  current: unknown,
  next: unknown,
  cookie: string | undefined,
): Promise<void> {
  requireMode(runtime, "motdepasse");
  if (!actor) throw new AuthError("accès refusé");
  if (!(await roleOf(store, actor))) throw new AuthError("accès refusé");
  if (typeof current !== "string") throw new AuthError("accès refusé");
  const secret = checkPassword(next);
  const matches = verifyPassword(current, (await store.get("auth", `password:${actor}`)) ?? DUMMY_HASH);
  if (!matches) throw new AuthError("accès refusé");
  if (current === secret) throw new AuthError("mot de passe inchangé");
  await store.put("auth", `password:${actor}`, hashPassword(secret));
  const keep = readCookie(cookie, "socle_session");
  await revokeSessions(store, actor, keep ? hashToken(keep) : undefined);
  await store.delete("auth", `tries:${actor}`);
  await forgetExpired(store, now);
}

export async function startEmailChange(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  actor: string | null,
  email: unknown,
): Promise<void> {
  if (!actor) throw new AuthError("accès refusé");
  if (!(await roleOf(store, actor))) throw new AuthError("accès refusé");
  if (!await canSendMail(runtime) || !runtime?.mailer) throw new AuthError("smtp absent");
  const clean = normalizeEmail(email);
  if (!clean) throw new AuthError("demande refusée");
  if (clean === actor) throw new AuthError("courriel inchangé");
  if ((await roleOf(store, clean)) !== null) throw new AuthError("courriel déjà utilisé");
  await dropPendingCourriel(store, actor, now);
  const raw = newToken(runtime);
  const hash = hashToken(raw);
  await store.put("auth", `courriel:${hash}`, JSON.stringify({
    email: actor,
    nouveau: clean,
    kind: "changement",
    exp: new Date(now.getTime() + EMAIL_CHANGE_MS).toISOString(),
  }));
  const origin = (runtime.publicOrigin ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const url = `${origin}/redaction/#courriel=${encodeURIComponent(raw)}`;
  try {
    await runtime.mailer(
      clean,
      "Confirmer votre nouveau courriel",
      `Bonjour,\n\nPour confirmer cette adresse comme courriel de l’espace de rédaction, suivez ce lien (il expire dans une heure, et ne sert qu’une fois) :\n\n${url}\n\nSi vous n’avez pas demandé ce changement, ignorez ce message.\n`,
    );
  } catch {
    await store.delete("auth", `courriel:${hash}`);
    throw new AuthError("smtp absent");
  }
}

export async function confirmEmailChange(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  token: unknown,
  actor: string | null,
): Promise<string> {
  if (!actor) throw new AuthError("accès refusé");
  if (typeof token !== "string" || !token) throw new AuthError("lien inconnu");
  const hash = hashToken(token);
  const row = await store.get("auth", `courriel:${hash}`);
  if (!row) throw new AuthError("lien inconnu");
  await store.delete("auth", `courriel:${hash}`);
  const parsed = JSON.parse(row) as { email?: string; nouveau?: string; exp?: string };
  if (!parsed.email || !parsed.nouveau || !parsed.exp || Date.parse(parsed.exp) <= now.getTime()) {
    throw new AuthError("lien expiré");
  }
  if (parsed.email !== actor) throw new AuthError("lien inconnu");
  const self = parsed.nouveau === parsed.email;
  if (!self && (await roleOf(store, parsed.nouveau)) !== null) throw new AuthError("courriel déjà utilisé");
  const role = await roleOf(store, parsed.email);
  if (!role) throw new AuthError("accès refusé");
  if (self) {
    await markEmailConfirmed(store, parsed.email, now);
    await forgetExpired(store, now);
    return parsed.email;
  }
  const password = await store.get("auth", `password:${parsed.email}`);
  const scope = await store.get("auth", `scope:${parsed.email}`);
  const profil = await store.get("auth", `profil:${parsed.email}`);
  await store.put("auth", `member:${parsed.nouveau}`, role);
  if (password) await store.put("auth", `password:${parsed.nouveau}`, password);
  if (scope) await store.put("auth", `scope:${parsed.nouveau}`, scope);
  if (profil) await store.put("auth", `profil:${parsed.nouveau}`, storedProfileJson(parseStoredProfile(profil)));
  await store.delete("auth", `member:${parsed.email}`);
  await store.delete("auth", `password:${parsed.email}`);
  await store.delete("auth", `scope:${parsed.email}`);
  await store.delete("auth", `profil:${parsed.email}`);
  await store.delete("auth", `tries:${parsed.email}`);
  await store.delete("auth", `courriel-ok:${parsed.email}`);
  await rewriteSessionEmail(store, parsed.email, parsed.nouveau);
  await markEmailConfirmed(store, parsed.nouveau, now);
  await forgetExpired(store, now);
  return parsed.nouveau;
}


export async function startOwnEmailConfirmation(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  actor: string | null,
): Promise<void> {
  if (!actor) throw new AuthError("accès refusé");
  if (!(await roleOf(store, actor))) throw new AuthError("accès refusé");
  if (await emailIsConfirmed(store, actor)) throw new AuthError("courriel inchangé");
  if (!await canSendMail(runtime) || !runtime?.mailer) throw new AuthError("smtp absent");
  await dropPendingCourriel(store, actor, now);
  const raw = newToken(runtime);
  const hash = hashToken(raw);
  await store.put("auth", `courriel:${hash}`, JSON.stringify({
    email: actor,
    nouveau: actor,
    kind: "confirmation",
    exp: new Date(now.getTime() + EMAIL_CHANGE_MS).toISOString(),
  }));
  const origin = (runtime.publicOrigin ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const url = `${origin}/redaction/#courriel=${encodeURIComponent(raw)}`;
  try {
    await runtime.mailer(
      actor,
      "Confirmer votre courriel",
      `Bonjour,\n\nPour confirmer cette adresse comme courriel de l’espace de rédaction, suivez ce lien (il expire dans une heure, et ne sert qu’une fois) :\n\n${url}\n\nSi vous n’avez pas demandé ce message, ignorez-le.\n`,
    );
  } catch {
    await store.delete("auth", `courriel:${hash}`);
    throw new AuthError("smtp absent");
  }
}

export async function resendPendingCourriel(
  store: SocleStore,
  runtime: AuthRuntime | undefined,
  now: Date,
  actor: string | null,
): Promise<void> {
  if (!actor) throw new AuthError("accès refusé");
  if (!(await roleOf(store, actor))) throw new AuthError("accès refusé");
  const pending = await findPendingCourriel(store, actor, now);
  if (!pending) throw new AuthError("demande absente");
  if (pending.nouveau === actor) {
    await startOwnEmailConfirmation(store, runtime, now, actor);
    return;
  }
  await startEmailChange(store, runtime, now, actor, pending.nouveau);
}

export async function cancelPendingCourriel(
  store: SocleStore,
  now: Date,
  actor: string | null,
): Promise<ProfileRecord> {
  if (!actor) throw new AuthError("accès refusé");
  if (!(await roleOf(store, actor))) throw new AuthError("accès refusé");
  const pending = await findPendingCourriel(store, actor, now);
  if (!pending) throw new AuthError("demande absente");
  await dropPendingCourriel(store, actor, now);
  return loadProfile(store, actor, now);
}

/** Sans vérificateur injecté, le jeton Access n'est pas décodé et n'ouvre pas de session. */
export function rejectAccess(_token: string): Promise<null> {
  return Promise.resolve(null);
}

function requireMode(runtime: AuthRuntime | undefined, expected: AuthMode): asserts runtime is AuthRuntime {
  if (runtime?.mode !== expected) throw new AuthError("mode inconnu");
}

export function normalizeEmail(value: unknown): string | null {
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
    if (
      !row.key.startsWith("magic:")
      && !row.key.startsWith("state:")
      && !row.key.startsWith("session:")
      && !row.key.startsWith("reset:")
      && !row.key.startsWith("courriel:")
    ) continue;
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
