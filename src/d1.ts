import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Miniflare } from "miniflare";

import { wrapD1, type D1Database } from "./d1-store.ts";
import { createModuleStore } from "./sql.ts";
import type { SocleStore } from "./store.ts";

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
