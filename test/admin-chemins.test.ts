/**
 * `/admin` et `/admin/` mènent à `/redaction/`. Les pages Sauvegarde et
 * Mise à jour acceptent une barre finale. Même résultat, connecté ou non.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalAdminPath, handleAdmin, type AdminDeps } from "../src/admin.ts";
import { handleAuth } from "../src/auth-http.ts";
import { ensureResponsable } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteMemory } from "../src/sqlite.ts";

test("canonicalAdminPath retire seulement la barre finale des pages /admin", () => {
  assert.equal(canonicalAdminPath("/admin"), "/admin");
  assert.equal(canonicalAdminPath("/admin/"), "/admin");
  assert.equal(canonicalAdminPath("/admin/sauvegarde/"), "/admin/sauvegarde");
  assert.equal(canonicalAdminPath("/admin/mise-a-jour/"), "/admin/mise-a-jour");
  assert.equal(canonicalAdminPath("/admin/sauvegarde/site.zip"), "/admin/sauvegarde/site.zip");
  assert.equal(canonicalAdminPath("/redaction/"), "/redaction/");
  assert.equal(canonicalAdminPath("/"), "/");
});

test("/admin, /admin/, /admin/sauvegarde/ et /admin/mise-a-jour/, connecté ou non", async () => {
  const store = openSqliteMemory();
  await store.migrate(["auth", "editorial", "export"]);
  const config = defaultConfig();
  config.modules.auth = true;
  config.modules.editorial = true;
  config.modules.export = true;
  let n = 0;
  const issued: string[] = [];
  const deps: AdminDeps = {
    store,
    now: () => new Date("2026-11-18T18:00:00.000Z"),
    backupDir: mkdtempSync(join(tmpdir(), "socle-admin-chemins-")),
    release: () => null,
    version: () => "1.3.1",
    setVersion: async () => {},
    auth: {
      mode: "magic",
      publicOrigin: "http://127.0.0.1:8787",
      randomBytes: () => {
        n += 1;
        const bytes = new Uint8Array(32);
        bytes.fill(n);
        issued.push(Buffer.from(bytes).toString("base64url"));
        return bytes;
      },
      mailer: async () => {},
    },
  };
  await ensureResponsable(store, "ada@journal.test");
  await handleAuth("POST", "/v1/auth/lien", config, deps, Buffer.from(JSON.stringify({ email: "ada@journal.test" })));
  const session = await handleAuth("GET", `/v1/auth/lien?token=${encodeURIComponent(issued[0] ?? "")}`, config, deps, new Uint8Array());
  const cookie = (session.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  assert.match(cookie, /^socle_session=/);

  const slashHome = await handleAdmin("GET", "/admin/", config, deps, new Uint8Array(), "ada@journal.test");
  assert.equal(slashHome.status, 303);
  assert.equal(slashHome.headers.location, "/redaction/");

  const server = createSocleServer(config, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ["/admin", "/admin/", "/admin/sauvegarde/", "/admin/mise-a-jour/"]) {
      const anon = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(anon.status, 303, `sans session : ${path}`);
      assert.equal(anon.headers.get("location"), "/redaction/", `sans session : ${path}`);
    }
    for (const path of ["/admin", "/admin/"]) {
      const page = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(page.status, 303, `connecté : ${path}`);
      assert.equal(page.headers.get("location"), "/redaction/", `connecté : ${path}`);
    }
    for (const path of ["/admin/sauvegarde", "/admin/sauvegarde/", "/admin/mise-a-jour", "/admin/mise-a-jour/"]) {
      const page = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(page.status, 200, `connecté : ${path}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
