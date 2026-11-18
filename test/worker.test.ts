import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { accessVerifier } from "../src/access.ts";
import { d1MigrationSql } from "../src/d1-migrate.ts";
import { VERSION } from "../src/version.ts";
import { PUBLICATION, scenario, type Call } from "./redaction-parcours.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEAM = "gazette.cloudflareaccess.com";
const AUD = "aud-de-test";
const RESPONSABLE = "responsable@gazette.exemple";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "cle-1", alg: "RS256", use: "sig" };

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function jwt(claims: Record<string, unknown>, kid = "cle-1"): string {
  const head = `${b64(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(head).sign(privateKey);
  return `${head}.${b64(signature)}`;
}

function goodClaims(email = RESPONSABLE): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], email, iss: `https://${TEAM}`, iat: now, exp: now + 600 };
}

async function certs(input: string): Promise<Response> {
  assert.equal(input, `https://${TEAM}/cdn-cgi/access/certs`);
  return Response.json({ keys: [JWK] });
}

/** Les modules du Worker, sans types, comme les donnerait `wrangler` (esbuild). */
function workerModules(): { type: "ESModule"; path: string; contents: string }[] {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const code = stripTypeScriptTypes(readFileSync(file, "utf8"));
    seen.set(file, code);
    for (const match of code.matchAll(/from "(\.\/[^"]+)"/g)) visit(join(dirname(file), match[1]!));
  };
  visit(join(ROOT, "src", "worker.ts"));
  return [...seen].map(([file, contents]) => ({ type: "ESModule", path: join(ROOT, relative(ROOT, file)), contents }));
}

test("la version suit package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("Access : signature, audience, émetteur et échéance vérifiés", async () => {
  const verify = accessVerifier({ team: TEAM, aud: AUD, fetch: certs });
  assert.equal(await verify(jwt(goodClaims())), RESPONSABLE);
  assert.equal(await verify(jwt({ ...goodClaims(), aud: ["autre"] })), null);
  assert.equal(await verify(jwt({ ...goodClaims(), iss: "https://autre.cloudflareaccess.com" })), null);
  assert.equal(await verify(jwt({ ...goodClaims(), exp: 1 })), null);
  assert.equal(await verify(jwt(goodClaims(), "inconnue")), null);
  const [head, body] = jwt(goodClaims()).split(".");
  const forged = `${head}.${b64(JSON.stringify({ ...goodClaims(), email: "intrus@exemple" }))}.${jwt(goodClaims()).split(".")[2]}`;
  assert.equal(await verify(forged), null);
  assert.ok(body);
  assert.equal(await accessVerifier({ team: "", aud: AUD })(jwt(goodClaims())), null);
});

test("Worker D1 : santé, page de rédaction, connexion Access, parcours complet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "socle-worker-"));
  const modules = { auth: true, editorial: true, media: true };
  const mf = new Miniflare({
    modules: workerModules(),
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "00000000-0000-0000-0000-000000000002" },
    d1Persist: dir,
    bindings: {
      SOCLE_CONFIG: JSON.stringify({ modules }),
      SOCLE_RESPONSABLE: RESPONSABLE,
      SOCLE_ACCESS_TEAM: TEAM,
      SOCLE_ACCESS_AUD: AUD,
    },
    serviceBindings: {
      async ASSETS(request) {
        const name = new URL(request.url).pathname.slice(1);
        try {
          return new Response(readFileSync(join(ROOT, "admin", name)));
        } catch {
          return new Response("", { status: 404 });
        }
      },
    },
    outboundService: async (request) => certs(request.url),
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec(d1MigrationSql(["auth", "editorial", "media"]).replace(/\n/g, " "));
    // Rejouer la migration ne change rien.
    await db.exec(d1MigrationSql(["auth", "editorial", "media"]).replace(/\n/g, " "));
    const seq = await db.prepare("SELECT COUNT(*) AS n FROM schema_migration").first<{ n: number }>();
    assert.equal(seq?.n, 3);

    const base = "https://gazette.exemple";
    const health = await mf.dispatchFetch(`${base}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { version: string }).version, VERSION);

    const page = await mf.dispatchFetch(`${base}/admin/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal((await mf.dispatchFetch(`${base}/admin/assets/admin.js`)).status, 200);
    assert.equal((await mf.dispatchFetch(`${base}/admin/assets/sql-wasm.wasm`)).status, 404);
    assert.equal((await mf.dispatchFetch(`${base}/admin/assets/demo-backend.js`)).status, 404);
    assert.equal((await mf.dispatchFetch(`${base}/redaction`, { redirect: "manual" })).status, 301);

    // Sans session : refus. Derrière Cloudflare, rien n'est « local ».
    const anonymous = await mf.dispatchFetch(`${base}/v1/redaction/etat`);
    assert.ok(anonymous.status === 401 || anonymous.status === 403, String(anonymous.status));
    const forged = await mf.dispatchFetch(`${base}/v1/auth/access`, {
      headers: { "cf-access-jwt-assertion": jwt({ ...goodClaims(), aud: ["autre"] }) },
      redirect: "manual",
    });
    assert.equal(forged.headers.get("set-cookie"), null);

    const login = await mf.dispatchFetch(`${base}/v1/auth/access`, {
      headers: { "cf-access-jwt-assertion": jwt(goodClaims()) },
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.match(cookie, /^socle_session=/);

    const call: Call = async (method, path, body, type) => {
      const response = await mf.dispatchFetch(`${base}${path}`, {
        method,
        headers: { cookie, "content-type": type ?? "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const ctype = response.headers.get("content-type") ?? "";
      return { status: response.status, bytes, type: ctype, json: ctype.startsWith("application/json") ? JSON.parse(bytes.toString("utf8") || "null") : null };
    };
    await scenario(call);
    const etat = await call("GET", "/v1/redaction/etat");
    assert.equal(etat.status, 200);
    assert.equal(etat.json.publication.slug, PUBLICATION.slug);
    assert.equal(etat.json.role, "administrateur");
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
