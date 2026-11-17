import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Miniflare } from "miniflare";

import { createModuleStore, type SqlDb } from "./sql.ts";
import type { SocleStore } from "./store.ts";

type D1Prepared = {
  bind(...values: readonly unknown[]): D1Prepared;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
};

type D1Database = {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): D1Prepared;
};

export async function openD1Memory(): Promise<SocleStore> {
  const dir = await mkdtemp(join(tmpdir(), "socle-d1-"));
  const mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: { DB: "00000000-0000-0000-0000-000000000001" },
    d1Persist: dir,
  });
  const db = await mf.getD1Database("DB") as D1Database;
  return createModuleStore(wrapD1(db, async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }));
}

function wrapD1(db: D1Database, close: () => Promise<void>): SqlDb {
  return {
    exec: (sql) => db.exec(sql).then(() => undefined),
    run: (sql, params) => db.prepare(sql).bind(...params).run().then(() => undefined),
    async get(sql, params) {
      const row = await db.prepare(sql).bind(...params).first<Record<string, unknown>>();
      return row ?? undefined;
    },
    close,
  };
}
