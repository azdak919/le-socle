import type { AdminDeps } from "./admin.ts";
import {
  AuthError,
  accessLogin,
  authState,
  changeOwnPassword,
  clearSessionCookie,
  confirmEmailChange,
  consumeMagic,
  consumePasswordReset,
  cookieSecure,
  emailFromCookie,
  githubFinish,
  githubStart,
  listMembers,
  logout,
  passwordInstall,
  passwordLogin,
  readProfile,
  saveMember,
  sessionCookie,
  startEmailChange,
  startMagic,
  startPasswordReset,
  updateProfile,
} from "./auth.ts";
import type { SocleConfig } from "./config.ts";
import { readPublication } from "./editorial.ts";

type Result = { status: number; body: string; headers: Record<string, string> };

const TEXT = { "content-type": "text/plain; charset=utf-8" };

const JSON_TYPE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function handleAuth(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
  headers: Record<string, string | undefined> = {},
  client: { ip?: string } = {},
): Promise<Result> {
  if (!config.modules.auth) return { status: 404, body: "", headers: {} };
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname;
  const secure = cookieSecure(deps.auth);
  try {
    if (path === "/v1/auth/lien" && method === "POST") {
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "email" || typeof body.email !== "string") {
        requireKnownMode(deps);
        throw new AuthError("demande refusée");
      }
      await startMagic(deps.store, deps.auth, deps.now(), body.email);
      return { status: 202, body: "", headers: {} };
    }
    if (path === "/v1/auth/lien" && method === "GET") {
      const session = await consumeMagic(deps.store, deps.auth, deps.now(), parsed.searchParams.get("token") ?? "");
      return redirect("/admin", session, secure);
    }
    if (path === "/v1/auth/github" && method === "GET") {
      const location = await githubStart(deps.store, deps.auth, deps.now());
      return { status: 302, body: "", headers: { location } };
    }
    if (path === "/v1/auth/github/retour" && method === "GET") {
      const session = await githubFinish(
        deps.store,
        deps.auth,
        deps.now(),
        parsed.searchParams.get("code") ?? "",
        parsed.searchParams.get("state") ?? "",
      );
      return redirect("/admin", session, secure);
    }
    if (path === "/v1/auth/access" && method === "GET") {
      const assertion = headers["cf-access-jwt-assertion"] || cookieValue(headers.cookie, "CF_Authorization") || undefined;
      const session = await accessLogin(deps.store, deps.auth, deps.now(), assertion);
      return redirect("/admin", session, secure);
    }
    if (path === "/v1/auth/etat" && method === "GET") {
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      let journal: string | null = null;
      if (config.modules.editorial) {
        try {
          const name = (await readPublication(deps.store))?.name;
          journal = typeof name === "string" && name.trim() ? name.trim() : null;
        } catch {
          journal = null;
        }
      }
      return { status: 200, body: JSON.stringify(await authState(deps.store, deps.auth, actor, journal)), headers: JSON_TYPE };
    }
    if ((path === "/v1/auth/installation" || path === "/v1/auth/motdepasse") && method === "POST") {
      // JSON seulement : un formulaire d'un autre site ne peut pas l'envoyer.
      if (!String(headers["content-type"] ?? "").startsWith("application/json")) throw new AuthError("demande refusée");
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "email,password") throw new AuthError("demande refusée");
      const session = path === "/v1/auth/installation"
        ? await passwordInstall(deps.store, deps.auth, deps.now(), body.email, body.password)
        : await passwordLogin(deps.store, deps.auth, deps.now(), body.email, body.password);
      return { status: 204, body: "", headers: { "set-cookie": sessionCookie(session, secure) } };
    }
    if (path === "/v1/auth/deconnexion" && method === "POST") {
      await logout(deps.store, headers.cookie);
      return { status: 204, body: "", headers: { "set-cookie": clearSessionCookie(secure) } };
    }
    if (path === "/v1/auth/membres" && method === "GET") {
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      return { status: 200, body: JSON.stringify(await listMembers(deps.store, actor)), headers: JSON_TYPE };
    }
    if (path === "/v1/auth/membres" && method === "POST") {
      const body = objectBody(rawBody);
      const allowed = ["email", "password", "role", "sections"];
      if (!body || Object.keys(body).some((key) => !allowed.includes(key))) throw new AuthError("demande refusée");
      if (body.sections !== undefined && !Array.isArray(body.sections)) throw new AuthError("demande refusée");
      if (typeof body.email !== "string" || typeof body.role !== "string") throw new AuthError("demande refusée");
      if (body.password !== undefined && deps.auth?.mode !== "motdepasse") throw new AuthError("demande refusée");
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      await saveMember(deps.store, actor, body.email, body.role, body.password as string | undefined, body.sections);
      return { status: 204, body: "", headers: {} };
    }
    if (path === "/v1/auth/reinitialiser" && method === "POST") {
      if (!String(headers["content-type"] ?? "").startsWith("application/json")) throw new AuthError("demande refusée");
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "email" || typeof body.email !== "string") {
        throw new AuthError("demande refusée");
      }
      await startPasswordReset(deps.store, deps.auth, deps.now(), body.email, client.ip);
      return { status: 202, body: "", headers: {} };
    }
    if (path === "/v1/auth/reinitialiser/confirmer" && method === "POST") {
      if (!String(headers["content-type"] ?? "").startsWith("application/json")) throw new AuthError("demande refusée");
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "password,token") throw new AuthError("demande refusée");
      const session = await consumePasswordReset(deps.store, deps.auth, deps.now(), body.token, body.password);
      return { status: 204, body: "", headers: { "set-cookie": sessionCookie(session, secure) } };
    }
    if (path === "/v1/auth/profil" && method === "GET") {
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      return { status: 200, body: JSON.stringify(await readProfile(deps.store, actor)), headers: JSON_TYPE };
    }
    if (path === "/v1/auth/profil" && method === "POST") {
      if (!String(headers["content-type"] ?? "").startsWith("application/json")) throw new AuthError("demande refusée");
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "nom,nomAffiche") throw new AuthError("demande refusée");
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      const profile = await updateProfile(deps.store, actor, body.nom, body.nomAffiche);
      return { status: 200, body: JSON.stringify(profile), headers: JSON_TYPE };
    }
    if (path === "/v1/auth/profil/motdepasse" && method === "POST") {
      if (!String(headers["content-type"] ?? "").startsWith("application/json")) throw new AuthError("demande refusée");
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "actuel,nouveau") throw new AuthError("demande refusée");
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      await changeOwnPassword(deps.store, deps.auth, deps.now(), actor, body.actuel, body.nouveau, headers.cookie);
      return { status: 204, body: "", headers: {} };
    }
    if (path === "/v1/auth/profil/courriel" && method === "POST") {
      if (!String(headers["content-type"] ?? "").startsWith("application/json")) throw new AuthError("demande refusée");
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "courriel" || typeof body.courriel !== "string") {
        throw new AuthError("demande refusée");
      }
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      await startEmailChange(deps.store, deps.auth, deps.now(), actor, body.courriel);
      return { status: 202, body: "", headers: {} };
    }
    if (path === "/v1/auth/profil/courriel/confirmer" && method === "POST") {
      if (!String(headers["content-type"] ?? "").startsWith("application/json")) throw new AuthError("demande refusée");
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "token") throw new AuthError("demande refusée");
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      const email = await confirmEmailChange(deps.store, deps.auth, deps.now(), body.token, actor);
      return { status: 200, body: JSON.stringify({ email }), headers: JSON_TYPE };
    }
    return { status: 404, body: "", headers: {} };
  } catch (error) {
    if (error instanceof AuthError) return fail(error);
    throw error;
  }
}

function requireKnownMode(deps: AdminDeps): void {
  const mode = deps.auth?.mode;
  if (mode !== "magic" && mode !== "github" && mode !== "access" && mode !== "motdepasse") throw new AuthError("mode inconnu");
}

function fail(error: AuthError): Result {
  const message = error.message;
  const status = message === "réservé à l’administrateur" ? 403
    : message === "accès refusé" ? 401
    : message === "trop d'essais" ? 429
    : message === "déjà installé" ? 409
    : message === "github refusé" ? 502
    : message === "mode inconnu" || message === "smtp absent" || message === "client absent" || message === "réseau absent" ? 409
    : message === "lien inconnu" || message === "lien expiré" ? 400
    : 400;
  return { status, body: message, headers: TEXT };
}

function redirect(location: string, session: string, secure = false): Result {
  return {
    status: 303,
    body: "",
    headers: { location, "set-cookie": sessionCookie(session, secure) },
  };
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

function cookieValue(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}
