import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer as createNet } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttp, type Server } from "node:http";
import test from "node:test";

import { buildSiteZip, emptySiteZip } from "../src/archive.ts";
import { stringifyConfig, type SocleConfig } from "../src/config.ts";
import { MODULES } from "../src/modules.ts";
import { createSocleServer } from "../src/server.ts";
import { openSqliteFile } from "../src/sqlite.ts";
import { unzip } from "../src/zip.ts";
import { NOW as REDACTION_NOW, scenario, type Call } from "./redaction-parcours.ts";

const REPO = join(import.meta.dirname, "..");
const IMAGE = "docker.io/library/php:8.4-cli";
const NOW = "2026-11-17T04:30:00.000Z";

function has(bin: string): boolean {
  const found = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() !== "";
}

function usePodman(): boolean {
  if (has("php") && process.env.SOCLE_PHP_PODMAN !== "1") return false;
  if (process.env.CI) throw new Error("php absent");
  if (!has("podman")) throw new Error("php absent");
  return true;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNet();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function mapWork(work: string, value: string, podman: boolean): string {
  if (!podman) return value;
  if (value.startsWith(work)) return "/work" + value.slice(work.length);
  return value;
}

async function startPhp(work: string, env: Record<string, string>): Promise<{ url: string; stop: () => Promise<void> }> {
  const tree = join(work, "tree");
  mkdirSync(tree, { recursive: true });
  cpSync(join(REPO, "php"), join(tree, "php"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(tree, "package.json"));
  cpSync(join(REPO, "admin"), join(tree, "admin"), { recursive: true });
  const port = await freePort();
  const podman = usePodman();
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) mapped[key] = mapWork(work, value, podman);
  const name = `socle-php-${port}`;
  const child: ChildProcess = podman
    ? spawn("podman", [
        "run", "--rm", "--name", name, "--network=host",
        "-v", `${work}:/work:z`, "-w", "/work/tree",
        ...Object.entries(mapped).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "-e", `TZ=${process.env.TZ ?? "America/Toronto"}`,
        IMAGE, "php", "-S", `127.0.0.1:${port}`,
        "-t", "/work/tree/php/public", "/work/tree/php/public/index.php",
      ], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn("php", ["-S", `127.0.0.1:${port}`, "-t", join(tree, "php/public"), join(tree, "php/public/index.php")], {
        cwd: tree,
        env: { ...process.env, ...mapped },
        stdio: ["ignore", "pipe", "pipe"],
      });
  let logs = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-4000);
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(logs || "php arrêté");
    try {
      const response = await fetch(url + "/v1/health");
      if (response.status > 0) {
        up = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!up) throw new Error(logs || "php muet");
  return {
    url,
    stop: () => new Promise((resolve) => {
      if (podman) spawnSync("podman", ["kill", name]);
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    }),
  };
}

function runPhp(work: string, script: string, args: string[], env: Record<string, string>, input?: Buffer): Buffer {
  const tree = join(work, "tree");
  mkdirSync(tree, { recursive: true });
  if (!existsSync(join(tree, "php"))) {
    cpSync(join(REPO, "php"), join(tree, "php"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(tree, "package.json"));
  }
  const podman = usePodman();
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) mapped[key] = mapWork(work, value, podman);
  const result = podman
    ? spawnSync("podman", [
        "run", "--rm", "--network=host", "-i",
        "-v", `${work}:/work:z`, "-w", "/work/tree",
        ...Object.entries(mapped).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "-e", `TZ=${process.env.TZ ?? "America/Toronto"}`,
        IMAGE, "php", script, ...args,
      ], { input, encoding: "buffer" })
    : spawnSync("php", [script, ...args], {
        cwd: tree,
        env: { ...process.env, ...mapped },
        input,
        encoding: "buffer",
      });
  if (result.status !== 0) {
    throw new Error((result.stderr ?? Buffer.from("")).toString() || "php cli");
  }
  return result.stdout ?? Buffer.from("");
}

function config(flags: Partial<Record<(typeof MODULES)[number], boolean>>): SocleConfig {
  const modules = {} as SocleConfig["modules"];
  for (const name of MODULES) modules[name] = flags[name] ?? false;
  return { modules };
}

function writeConfig(path: string, flags: Partial<Record<(typeof MODULES)[number], boolean>>): void {
  writeFileSync(path, stringifyConfig(config(flags)));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("PHP sert le contrat figé, et le statique quand la base manque", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-php-"));
  const db = join(work, "socle.sqlite");
  const stat = join(work, "static");
  mkdirSync(stat);
  writeFileSync(join(stat, "bonjour.html"), "<p>bonjour</p>");
  writeFileSync(join(stat, "secret.txt"), "secret");
  const php = await startPhp(work, {
    SOCLE_DB: db,
    SOCLE_STATIC: stat,
    SOCLE_NOW: NOW,
    SOCLE_BACKUP_DIR: join(work, "sauvegardes"),
    SOCLE_VERSION_FILE: join(work, "version"),
  });
  const node = createSocleServer(config({}), {
    store: openSqliteFile(join(work, "node.sqlite")),
    now: () => new Date(NOW),
    release: () => null,
    version: () => "1.0.0",
    setVersion: async () => {},
    backupDir: join(work, "node-backups"),
  });
  const port = await listen(node);
  try {
    const health = await fetch(php.url + "/v1/health");
    const nodeHealth = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), await nodeHealth.text());
    assert.equal(health.headers.get("content-type"), "application/json; charset=utf-8");
    const denied = await fetch(php.url + "/v1/health", { method: "POST" });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get("allow"), "GET, HEAD");
    const head = await fetch(php.url + "/v1/health", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(php.url + "/v1/export")).status, 404);
    assert.equal((await fetch(php.url + "/v1/audience/event", { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(php.url + "/v1/auth/lien", { method: "POST", body: "{}" })).status, 404);
    const home = await fetch(php.url + "/admin");
    const nodeHome = await fetch(`http://127.0.0.1:${port}/admin`);
    assert.equal(home.status, 200);
    assert.equal(await home.text(), await nodeHome.text());
    const page = await fetch(php.url + "/bonjour.html");
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<p>bonjour</p>");
    assert.equal((await fetch(php.url + "/%2e%2e%2fsecret.txt")).status, 404);
    const probe = openSqliteFile(db);
    assert.deepEqual(await probe.applied(), []);
    await probe.close();
  } finally {
    await closeServer(node);
    await php.stop();
  }

  const bare = mkdtempSync(join(tmpdir(), "socle-php-nodb-"));
  const bareStatic = join(bare, "static");
  mkdirSync(bareStatic);
  writeFileSync(join(bareStatic, "index.html"), "<p>lu</p>");
  const noDb = await startPhp(bare, { SOCLE_NO_DB: "1", SOCLE_STATIC: bareStatic, SOCLE_DB: join(bare, "absent.sqlite") });
  try {
    assert.equal((await fetch(noDb.url + "/v1/health")).status, 404);
    assert.equal((await fetch(noDb.url + "/admin")).status, 404);
    assert.equal(await (await fetch(noDb.url + "/")).text(), "<p>lu</p>");
    assert.equal(existsSync(join(bare, "absent.sqlite")), false);
  } finally {
    await noDb.stop();
  }

  const inside = mkdtempSync(join(tmpdir(), "socle-php-doc-"));
  const insideStatic = join(inside, "static");
  mkdirSync(insideStatic);
  writeFileSync(join(insideStatic, "index.html"), "<p>reste</p>");
  const trapped = join(inside, "tree/php/public/bad.sqlite");
  const docroot = await startPhp(inside, { SOCLE_DB: trapped, SOCLE_STATIC: insideStatic });
  try {
    assert.equal((await fetch(docroot.url + "/v1/health")).status, 404);
    assert.equal(await (await fetch(docroot.url + "/")).text(), "<p>reste</p>");
    assert.equal(existsSync(trapped), false);
  } finally {
    await docroot.stop();
  }
});

test("PHP reprend un fichier SQLite migré par Node", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-php-audience-"));
  const db = join(work, "socle.sqlite");
  const nodeDb = join(work, "node.sqlite");
  writeConfig(join(work, "socle.config.json"), { audience: true });
  for (const path of [db, nodeDb]) {
    const store = openSqliteFile(path);
    await store.migrate(["audience"]);
    await store.put("audience", "day:2026-08-17:article:vieux", "4");
    await store.put("audience", "day:2026-08-18:article:vieux", "2");
    await store.close();
  }
  const php = await startPhp(work, {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: NOW,
    SOCLE_BACKUP_DIR: join(work, "sauvegardes"),
  });
  const nodeStore = openSqliteFile(nodeDb);
  await nodeStore.resume();
  const node = createSocleServer(config({ audience: true }), {
    store: nodeStore,
    now: () => new Date(NOW),
    release: () => null,
    version: () => "1.0.0",
    setVersion: async () => {},
    backupDir: join(work, "node-backups"),
  });
  const port = await listen(node);
  const body = JSON.stringify({ name: "article", contexte: "limite" });
  try {
    const posted = await fetch(php.url + "/v1/audience/event", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body,
    });
    const nodePosted = await fetch(`http://127.0.0.1:${port}/v1/audience/event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body,
    });
    assert.equal(posted.status, 204);
    assert.equal(await posted.text(), "");
    assert.equal(nodePosted.status, 204);
    const extra = await fetch(php.url + "/v1/audience/event", {
      method: "POST",
      body: JSON.stringify({ name: "article", contexte: "limite", ip: "203.0.113.8" }),
    });
    assert.equal(extra.status, 400);
    assert.equal(await extra.text(), "demande refusée");
    const page = await fetch(php.url + "/admin/audience?lang=en");
    const nodePage = await fetch(`http://127.0.0.1:${port}/admin/audience?lang=en`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), await nodePage.text());
    assert.match(await (await fetch(php.url + "/admin/audience")).text(), /Totaux du jour/);
  } finally {
    await closeServer(node);
    await nodeStore.close();
    await php.stop();
  }
  const saved = openSqliteFile(db);
  await saved.resume();
  const rows = await saved.list("audience");
  await saved.close();
  const keys = rows.map((row) => row.key).join("\n");
  assert.match(keys, /day:2026-11-16:article:limite/);
  assert.equal(rows.find((row) => row.key === "day:2026-11-16:article:limite")?.value, "1");
  assert.equal(rows.some((row) => row.key.startsWith("day:2026-08-17:")), false);
  assert.equal(rows.find((row) => row.key === "day:2026-08-18:article:vieux")?.value, "2");
  assert.equal(rows.find((row) => row.key.startsWith("week:"))?.value, "4");
  assert.equal(keys.includes("203.0.113.8"), false);
  assert.equal(rows.some((row) => row.value.includes("203.0.113.8")), false);
});

test("PHP refuse un lien sans mode, sans SMTP, ou avec un mot de passe", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-php-auth-"));
  const db = join(work, "socle.sqlite");
  writeConfig(join(work, "socle.config.json"), { auth: true });
  const store = openSqliteFile(db);
  await store.migrate(["auth"]);
  await store.close();
  const php = await startPhp(work, {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: NOW,
  });
  try {
    const unknown = await fetch(php.url + "/v1/auth/lien", {
      method: "POST",
      body: JSON.stringify({ email: "ada@journal.example" }),
    });
    assert.equal(unknown.status, 409);
    assert.equal(await unknown.text(), "mode inconnu");
  } finally {
    await php.stop();
  }
  const magic = await startPhp(work, {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: NOW,
    SOCLE_AUTH_MODE: "magic",
  });
  try {
    const password = await fetch(magic.url + "/v1/auth/lien", {
      method: "POST",
      body: JSON.stringify({ email: "ada@journal.example", password: "secret" }),
    });
    assert.equal(password.status, 400);
    assert.equal(await password.text(), "demande refusée");
    const missing = await fetch(magic.url + "/v1/auth/lien", {
      method: "POST",
      body: JSON.stringify({ email: "ada@journal.example" }),
    });
    assert.equal(missing.status, 409);
    assert.equal(await missing.text(), "smtp absent");
    const access = await fetch(magic.url + "/v1/auth/access", { headers: { "cf-access-jwt-assertion": "pas-un-jeton" } });
    assert.equal(access.status, 409);
  } finally {
    await magic.stop();
  }
  const saved = openSqliteFile(db);
  await saved.resume();
  const rows = await saved.list("auth");
  await saved.close();
  assert.deepEqual(rows, []);
});

test("le lien magique PHP part par SMTP et n'enregistre que le hachage", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-php-smtp-"));
  const db = join(work, "socle.sqlite");
  writeConfig(join(work, "socle.config.json"), { auth: true });
  const prepared = openSqliteFile(db);
  await prepared.migrate(["auth"]);
  await prepared.close();
  const mails: string[] = [];
  const smtp = createNet();
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const address = smtp.address();
  assert.ok(address && typeof address === "object");
  smtp.on("connection", (socket) => {
    let buffer = "";
    socket.write("220 ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\r\n")) return;
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        mails.push(line);
        if (line.startsWith("EHLO")) socket.write("250 ok\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n");
        else if (line.startsWith("RCPT TO")) socket.write("250 ok\r\n");
        else if (line === "DATA") socket.write("354 go\r\n");
        else if (line === ".") socket.write("250 queued\r\n");
        else if (line === "QUIT") socket.end("221 bye\r\n");
      }
    });
  });
  const php = await startPhp(work, {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: NOW,
    SOCLE_AUTH_MODE: "magic",
    SOCLE_PUBLIC_ORIGIN: "https://journal.example",
    SOCLE_SMTP_HOST: "127.0.0.1",
    SOCLE_SMTP_PORT: String(address.port),
    SOCLE_SMTP_FROM: "redaction@journal.example",
  });
  try {
    const sent = await fetch(php.url + "/v1/auth/lien", {
      method: "POST",
      body: JSON.stringify({ email: "Ada@Journal.example" }),
    });
    assert.equal(sent.status, 202);
    assert.equal(await sent.text(), "");
    const url = mails.find((line) => line.includes("https://journal.example/v1/auth/lien?token="));
    assert.ok(url);
    const token = new URL(url.slice(url.indexOf("https://"))).searchParams.get("token") ?? "";
    assert.equal(token.length > 20, true);
    const saved = openSqliteFile(db);
    await saved.resume();
    const rows = await saved.list("auth");
    await saved.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.key, "magic:" + createHash("sha256").update(token).digest("hex"));
    assert.equal(rows[0]?.value.includes(token), false);
    assert.match(rows[0]?.value ?? "", /ada@journal\.example/);
    const back = await fetch(php.url + "/v1/auth/lien?token=" + encodeURIComponent(token), { redirect: "manual" });
    assert.equal(back.status, 303);
    assert.match(back.headers.get("set-cookie") ?? "", /^socle_session=.+; HttpOnly; Path=\/; SameSite=Lax; Max-Age=43200$/);
    assert.equal((await fetch(php.url + "/v1/auth/lien?token=" + encodeURIComponent(token), { redirect: "manual" })).status, 400);
  } finally {
    await php.stop();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  }
});

test("l'échéance PHP publie comme Node, et le snapshot public aussi", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-php-review-"));
  const db = join(work, "socle.sqlite");
  const nodeDb = join(work, "node.sqlite");
  writeConfig(join(work, "socle.config.json"), { review: true, editorial: true });
  const article = {
    id: "a1",
    slug: "bonjour",
    publication: "journal",
    title: "Bonjour",
    excerpt: "",
    body: { format: "markdown", raw: "Texte" },
    media: [],
    authors: ["ada"],
    section: "une",
    categories: [],
    tags: [],
    lang: "fr",
    status: "scheduled",
    updatedAt: "2026-11-16T12:00:00.000Z",
    scheduledAt: "2026-11-16T12:00:00.000Z",
    canonicalUrl: "https://journal.example/bonjour",
    source: { backend: "socle", backendId: "a1", fetchedAt: "2026-11-16T12:00:00.000Z" },
  };
  const publication = {
    id: "pub",
    slug: "journal",
    name: "Le Journal",
    institution: "Cégep",
    institutionType: "cegep",
    lang: "fr",
    siteUrl: "https://journal.example",
    timeZone: "America/Toronto",
    theme: { accent: "#111" },
    governance: { owner: "Ada", contact: "ada@journal.example" },
  };
  for (const path of [db, nodeDb]) {
    const store = openSqliteFile(path);
    await store.migrate(["editorial", "review"]);
    await store.put("editorial", "publication", JSON.stringify(publication));
    await store.put("editorial", "article:a1", JSON.stringify(article));
    await store.close();
  }
  const php = await startPhp(work, {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: "2026-11-17T15:00:00.000Z",
  });
  const nodeStore = openSqliteFile(nodeDb);
  await nodeStore.resume();
  const node = createSocleServer(config({ review: true, editorial: true }), {
    store: nodeStore,
    now: () => new Date("2026-11-17T15:00:00.000Z"),
    release: () => null,
    version: () => "1.0.0",
    setVersion: async () => {},
    backupDir: join(work, "node-backups"),
  });
  const port = await listen(node);
  try {
    const due = await fetch(php.url + "/v1/review/echeance", { method: "POST" });
    const nodeDue = await fetch(`http://127.0.0.1:${port}/v1/review/echeance`, { method: "POST" });
    assert.equal(due.status, 200);
    const dueBody = await due.text();
    assert.equal(dueBody, await nodeDue.text());
    assert.equal(dueBody, '{"published":1}');
    const shot = await fetch(php.url + "/v1/editorial/snapshot");
    const nodeShot = await fetch(`http://127.0.0.1:${port}/v1/editorial/snapshot`);
    const left = await shot.json() as { syncedAt?: string; articles: Array<{ status: string; publishedAt?: string }> };
    const right = await nodeShot.json() as { syncedAt?: string; articles: Array<{ status: string }> };
    delete left.syncedAt;
    delete right.syncedAt;
    assert.equal(shot.status, 200);
    assert.deepEqual(left, right);
    assert.equal(left.articles[0]?.status, "published");
    assert.equal(left.articles[0]?.publishedAt, "2026-11-16T12:00:00.000Z");
  } finally {
    await closeServer(node);
    await nodeStore.close();
    await php.stop();
  }
});

test("migrate PHP écrit la même archive vide, puis la même archive de site", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-php-zip-"));
  mkdirSync(join(work, "tree"), { recursive: true });
  const db = join(work, "socle.sqlite");
  writeConfig(join(work, "socle.config.json"), {});
  const backup = join(work, "avant.zip");
  runPhp(work, "php/bin/migrate.php", ["--backup", usePodman() ? "/work/avant.zip" : backup, "--db", usePodman() ? "/work/socle.sqlite" : db, "--config", usePodman() ? "/work/socle.config.json" : join(work, "socle.config.json")], {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: NOW,
  });
  const files = unzip(new Uint8Array(readFileSync(backup)));
  const expected = unzip(emptySiteZip());
  assert.deepEqual([...files.keys()], [...expected.keys()]);
  for (const [name, bytes] of expected) assert.equal(Buffer.from(files.get(name) ?? new Uint8Array()).toString(), Buffer.from(bytes).toString());

  const siteDb = join(work, "site.sqlite");
  const seeded = openSqliteFile(siteDb);
  await seeded.migrate(["export"]);
  await seeded.close();
  const siteZip = join(work, "site.zip");
  runPhp(work, "php/bin/migrate.php", ["--backup", usePodman() ? "/work/site.zip" : siteZip], {
    SOCLE_DB: siteDb,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: "2026-11-17T15:00:00.000Z",
  });
  const oracle = openSqliteFile(join(work, "oracle.sqlite"));
  await oracle.migrate(["export"]);
  await oracle.resume();
  const wanted = unzip(await buildSiteZip(oracle, new Date("2026-11-17T15:00:00.000Z")));
  await oracle.close();
  const got = unzip(new Uint8Array(readFileSync(siteZip)));
  assert.deepEqual([...got.keys()], [...wanted.keys()]);
  for (const [name, bytes] of wanted) assert.equal(Buffer.from(got.get(name) ?? new Uint8Array()).toString(), Buffer.from(bytes).toString());
});

test("le push PHP se déchiffre, et le dossier mutualisé est nommé", async () => {
  const client = createECDH("prime256v1");
  client.generateKeys();
  const auth = randomBytes(16);
  const pair = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { generatePushKeys } from ${JSON.stringify(join(REPO, "src/notify.ts"))};
    process.stdout.write(JSON.stringify(generatePushKeys()));
  `], { encoding: "utf8", cwd: REPO });
  assert.equal(pair.status, 0, pair.stderr);
  const keys = JSON.parse(pair.stdout) as { publicKey: string; privateKey: string };
  const work = mkdtempSync(join(tmpdir(), "socle-php-push-"));
  mkdirSync(join(work, "tree"), { recursive: true });
  const body = runPhp(work, "php/bin/push-body.php", [], {}, Buffer.from(JSON.stringify({
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: "mailto:redaction@journal.example",
    now: NOW,
    text: "bonjour",
    target: {
      address: "https://push.example/recevoir",
      p256dh: client.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  })));
  const salt = body.subarray(0, 16);
  const idLen = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + idLen);
  const encrypted = body.subarray(21 + idLen);
  const shared = client.computeSecret(serverPublic);
  const clientPublic = client.getPublicKey();
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([
    Buffer.from("WebPush: info\0"),
    clientPublic,
    serverPublic,
  ]), 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const tag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  assert.equal(plain.subarray(0, -1).toString(), "bonjour");

  const folder = mkdtempSync(join(tmpdir(), "socle-php-folder-"));
  const db = join(folder, "socle.sqlite");
  const version = join(folder, "version");
  writeFileSync(version, "1.0.0\n");
  writeFileSync(join(folder, "release.json"), JSON.stringify({ version: "1.0.1", notes: "Corrige un lien." }));
  writeConfig(join(folder, "socle.config.json"), {});
  const upload = join(folder, "public_html");
  mkdirSync(upload);
  const php = await startPhp(folder, {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(folder, "socle.config.json"),
    SOCLE_NOW: NOW,
    SOCLE_VERSION_FILE: version,
    SOCLE_BACKUP_DIR: join(folder, "sauvegardes"),
    SOCLE_RELEASE_FILE: join(folder, "release.json"),
    SOCLE_UPLOAD_DIR: upload,
  });
  try {
    const page = await fetch(php.url + "/admin/mise-a-jour");
    const html = await page.text();
    // Journal pas encore configuré : l'en-tête montre le logo du Socle, et l'onglet son icône.
    assert.match(html, /<a class="brand" href="\/admin"><img class="logo" src="data:image\/svg\+xml;base64,[^"]+" alt="" width="32" height="32"><span><strong>Le Socle<\/strong>/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" sizes="any"/);
    const shownUpload = mapWork(folder, upload, usePodman());
    assert.match(html, new RegExp(shownUpload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const updated = await fetch(php.url + "/admin/mise-a-jour", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=1",
    });
    assert.equal(updated.status, 200);
    assert.match(await updated.text(), /La mise à jour a réussi/);
    assert.equal(readFileSync(version, "utf8").trim(), "1.0.1");
    const backup = JSON.parse(readFileSync(join(folder, "sauvegardes/socle-1.0.0-vers-1.0.1.json"), "utf8")) as { line: string; from: string; to: string };
    assert.deepEqual({ line: backup.line, from: backup.from, to: backup.to }, { line: "socle", from: "1.0.0", to: "1.0.1" });
    assert.equal(existsSync(join(folder, "sauvegardes/socle-1.0.0-vers-1.0.1/public/index.php")), true);
    assert.equal(existsSync(join(folder, "sauvegardes/socle-1.0.0-vers-1.0.1/src/bootstrap.php")), true);
  } finally {
    await php.stop();
  }
});

function httpCall(base: string, extra: Record<string, string> = {}): Call {
  return async (method, path, body, type) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...extra, ...(body === undefined ? {} : { "content-type": type ?? "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const ctype = response.headers.get("content-type") ?? "";
    return { status: response.status, bytes, type: ctype, json: ctype.startsWith("application/json") ? JSON.parse(bytes.toString("utf8") || "null") : null };
  };
}

test("l'API de rédaction PHP suit le même parcours que Node", async () => {
  const work = mkdtempSync(join(tmpdir(), "socle-php-redaction-"));
  const db = join(work, "socle.sqlite");
  writeConfig(join(work, "socle.config.json"), { editorial: true, media: true });
  const store = openSqliteFile(db);
  await store.migrate(["editorial", "media"]);
  await store.close();
  const php = await startPhp(work, {
    SOCLE_DB: db,
    SOCLE_CONFIG: join(work, "socle.config.json"),
    SOCLE_NOW: REDACTION_NOW,
    SOCLE_BACKUP_DIR: join(work, "sauvegardes"),
  });
  const nodeStore = openSqliteFile(join(work, "node.sqlite"));
  await nodeStore.migrate(["editorial", "media"]);
  const node = createSocleServer(config({ editorial: true, media: true }), {
    store: nodeStore,
    now: () => new Date(REDACTION_NOW),
    release: () => null,
    version: () => "1.0.0",
    setVersion: async () => {},
    backupDir: join(work, "node-backups"),
  });
  const nodePort = await listen(node);
  try {
    const fromPhp = await scenario(httpCall(php.url));
    const fromNode = await scenario(httpCall(`http://127.0.0.1:${nodePort}`));
    assert.deepEqual(fromPhp, fromNode);
    const proxied = await fetch(php.url + "/v1/redaction/etat", { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(proxied.status, 403);
    // L'admin elle-même : mêmes octets, mêmes refus, en PHP et en Node.
    for (const path of ["/redaction/", "/redaction/assets/admin.js", "/redaction/assets/admin.css", "/redaction/assets/socle-backend.js", "/redaction/assets/demo-backend.js", "/redaction/assets/inconnu.js", "/redaction/assets/%2e%2e/page.js"]) {
      const [a, b] = await Promise.all([fetch(php.url + path, { redirect: "manual" }), fetch(`http://127.0.0.1:${nodePort}` + path, { redirect: "manual" })]);
      assert.equal(a.status, b.status, path);
      if (a.status === 200) assert.equal(a.headers.get("content-type"), b.headers.get("content-type"), path);
      assert.equal(Buffer.compare(Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())), 0, path);
    }
    assert.equal((await fetch(php.url + "/redaction/")).status, 200);
    for (const path of ["/admin", "/admin/"]) {
      const [phpAdmin, nodeAdmin] = await Promise.all([
        fetch(php.url + path, { redirect: "manual" }),
        fetch(`http://127.0.0.1:${nodePort}` + path, { redirect: "manual" }),
      ]);
      assert.equal(phpAdmin.status, 303, path);
      assert.equal(phpAdmin.headers.get("location"), "/redaction/", path);
      assert.equal(nodeAdmin.status, 303, path);
      assert.equal(nodeAdmin.headers.get("location"), "/redaction/", path);
    }
    assert.equal((await fetch(php.url + "/redaction/assets/demo-backend.js")).status, 404);
  } finally {
    await closeServer(node);
    await nodeStore.close();
    await php.stop();
  }
});

test("PHP avec GD : miniatures, EXIF retiré, et repli sans GD", async () => {
  const png = readFileSync(join(REPO, "test/fixtures/photo-large.png"));
  const jpeg = readFileSync(join(REPO, "test/fixtures/photo-exif-gps.jpg"));
  assert.match(jpeg.toString("latin1"), /TestPhone/);
  const work = mkdtempSync(join(tmpdir(), "socle-php-gd-"));
  const db = join(work, "socle.sqlite");
  writeConfig(join(work, "socle.config.json"), { editorial: true, media: true });
  const store = openSqliteFile(db);
  await store.migrate(["editorial", "media"]);
  await store.close();
  const jpegOk = spawnSync("php", ["-r", "echo function_exists('imagejpeg') && !empty(gd_info()['JPEG Support']) ? '1' : '0';"], { encoding: "utf8" }).stdout.trim() === "1";

  async function withPhp(env: Record<string, string>) {
    const php = await startPhp(work, {
      SOCLE_DB: db,
      SOCLE_CONFIG: join(work, "socle.config.json"),
      SOCLE_NOW: REDACTION_NOW,
      SOCLE_BACKUP_DIR: join(work, "sauvegardes"),
      ...env,
    });
    return { call: httpCall(php.url), stop: php.stop };
  }

  const session = await withPhp({});
  try {
    const photo = await session.call("POST", "/v1/redaction/photo", {
      asset: { id: "pgd", alt: "La cour en hiver", credit: "Léa Roy", width: 3200, height: 1800 },
      data: png.toString("base64"),
    });
    assert.equal(photo.status, 200, JSON.stringify(photo.json));
    assert.equal(photo.json.asset.src, "/media/banque/pgd.png");
    assert.deepEqual(photo.json.asset.variants.map((item: { width: number }) => item.width), [480, 960, 1600]);
    assert.deepEqual(photo.json.asset.variants.map((item: { height: number }) => item.height), [270, 540, 900]);
    const publication = { id: "11111111-1111-4111-8111-111111111111", slug: "la-gazette", name: "La Gazette", institution: "Cégep du Nord", institutionType: "cegep", lang: "fr-CA", siteUrl: "https://gazette.exemple", timeZone: "America/Toronto", theme: { accent: "#8a1538" }, governance: { owner: "Association", contact: "redaction@gazette.exemple" } };
    assert.equal((await session.call("POST", "/v1/redaction/publication", { publication })).status, 200);
    assert.equal((await session.call("POST", "/v1/redaction/entite", { kind: "author", entity: { id: "a1", name: "Léa Roy", slug: "lea-roy" } })).status, 200);
    assert.equal((await session.call("POST", "/v1/redaction/entite", { kind: "section", entity: { id: "s1", name: "Campus", slug: "campus" } })).status, 200);
    const lead = { id: "pgd", kind: "image", src: "/media/banque/pgd.png", alt: "La cour en hiver", credit: "Léa Roy" };
    const published = await session.call("POST", "/v1/redaction/article", { article: { id: "art-gd", slug: "photo-gd", title: "Photo GD", body: { format: "markdown", raw: "x" }, authors: ["lea-roy"], status: "published", section: "campus", publishedAt: REDACTION_NOW, lead } });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    for (const width of [480, 960, 1600]) {
      const variant = await session.call("GET", `/media/banque/pgd-${width}.png`);
      assert.equal(variant.status, 200, `${width}`);
      assert.equal(variant.type, "image/png");
    }
    if (jpegOk) {
      const exif = await session.call("POST", "/v1/redaction/photo", {
        asset: { id: "pexif", alt: "La cour avec EXIF", credit: "Léa Roy" },
        data: jpeg.toString("base64"),
      });
      assert.equal(exif.status, 200, JSON.stringify(exif.json));
      assert.deepEqual(exif.json.asset.variants.map((item: { width: number }) => item.width), [480, 960, 1600]);
      const stored = await session.call("GET", "/v1/redaction/fichier?src=%2Fmedia%2Fbanque%2Fpexif.jpg");
      assert.equal(stored.status, 200);
      assert.doesNotMatch(stored.bytes.toString("latin1"), /TestPhone/);
    }
  } finally {
    await session.stop();
  }

  const disabled = await withPhp({ SOCLE_DISABLE_GD: "1" });
  try {
    const photo = await disabled.call("POST", "/v1/redaction/photo", {
      asset: { id: "pgd-off", alt: "Sans miniature", credit: "Léa Roy" },
      data: png.toString("base64"),
    });
    assert.equal(photo.status, 200, JSON.stringify(photo.json));
    assert.deepEqual(photo.json.asset.variants ?? [], []);
  } finally {
    await disabled.stop();
  }
});
