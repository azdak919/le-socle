/**
 * Vérifie le jeton de Cloudflare Access (`Cf-Access-Jwt-Assertion`) : signature
 * RS256 contre les clés publiques de l'équipe, émetteur, audience, échéance.
 * WebCrypto seulement : même code dans Node et dans le Worker.
 *
 * - `team` : le domaine de l'équipe, par exemple `journal.cloudflareaccess.com`.
 * - `aud` : l'étiquette d'audience (AUD) de l'application Access.
 */
type Jwk = JsonWebKey & { kid?: string };

export type AccessCheck = {
  team: string;
  aud: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
};

const KEYS_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; keys: Jwk[] }>();

function decodePart(part: string): Uint8Array {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodePart(part))) as Record<string, unknown>;
}

async function teamKeys(check: AccessCheck, refresh: boolean): Promise<Jwk[]> {
  const hit = cache.get(check.team);
  const now = Date.now();
  if (hit && !refresh && now - hit.at < KEYS_MS) return hit.keys;
  const response = await (check.fetch ?? fetch)(`https://${check.team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("clés Access introuvables");
  const body = await response.json() as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cache.set(check.team, { at: now, keys });
  return keys;
}

/** Rend une fonction qui donne l'adresse du jeton, ou `null` s'il est refusé. */
export function accessVerifier(check: AccessCheck): (token: string) => Promise<string | null> {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(check.team) || !check.aud) {
    return async () => null;
  }
  return async (token) => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, signature] = parts as [string, string, string];
    const header = decodeJson(head);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    let keys = await teamKeys(check, false);
    if (!keys.some((key) => key.kid === header.kid)) keys = await teamKeys(check, true);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(signature), new TextEncoder().encode(`${head}.${body}`));
    if (!ok) return null;
    const claims = decodeJson(body);
    const seconds = Math.floor((check.now?.() ?? new Date()).getTime() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(check.aud)) return null;
    if (claims.iss !== `https://${check.team}`) return null;
    if (typeof claims.exp !== "number" || claims.exp <= seconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return null;
    return typeof claims.email === "string" ? claims.email : null;
  };
}
