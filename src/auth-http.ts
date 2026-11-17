import type { AdminDeps } from "./admin.ts";
import {
  AuthError,
  accessLogin,
  consumeMagic,
  emailFromCookie,
  githubFinish,
  githubStart,
  saveMember,
  sessionCookie,
  startMagic,
} from "./auth.ts";
import type { SocleConfig } from "./config.ts";

type Result = { status: number; body: string; headers: Record<string, string> };

const TEXT = { "content-type": "text/plain; charset=utf-8" };

export async function handleAuth(
  method: string,
  url: string,
  config: SocleConfig,
  deps: AdminDeps,
  rawBody: Uint8Array,
  headers: Record<string, string | undefined> = {},
): Promise<Result> {
  if (!config.modules.auth) return { status: 404, body: "", headers: {} };
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname;
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
      return redirect("/admin", session);
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
      return redirect("/admin", session);
    }
    if (path === "/v1/auth/access" && method === "GET") {
      const assertion = headers["cf-access-jwt-assertion"] || cookieValue(headers.cookie, "CF_Authorization") || undefined;
      const session = await accessLogin(deps.store, deps.auth, deps.now(), assertion);
      return redirect("/admin", session);
    }
    if (path === "/v1/auth/membres" && method === "POST") {
      const body = objectBody(rawBody);
      if (!body || Object.keys(body).sort().join(",") !== "email,role") throw new AuthError("demande refusée");
      if (typeof body.email !== "string" || typeof body.role !== "string") throw new AuthError("demande refusée");
      const actor = await emailFromCookie(deps.store, deps.now, headers.cookie);
      await saveMember(deps.store, actor, body.email, body.role);
      return { status: 204, body: "", headers: {} };
    }
    return { status: 404, body: "", headers: {} };
  } catch (error) {
    if (error instanceof AuthError) return fail(error);
    throw error;
  }
}

function requireKnownMode(deps: AdminDeps): void {
  const mode = deps.auth?.mode;
  if (mode !== "magic" && mode !== "github" && mode !== "access") throw new AuthError("mode inconnu");
}

function fail(error: AuthError): Result {
  const message = error.message;
  const status = message === "réservé au responsable" ? 403
    : message === "accès refusé" ? 401
    : message === "github refusé" ? 502
    : message === "mode inconnu" || message === "smtp absent" || message === "client absent" || message === "réseau absent" ? 409
    : 400;
  return { status, body: message, headers: TEXT };
}

function redirect(location: string, session: string): Result {
  return {
    status: 303,
    body: "",
    headers: { location, "set-cookie": sessionCookie(session) },
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
