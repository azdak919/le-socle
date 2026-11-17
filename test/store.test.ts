import assert from "node:assert/strict";
import test from "node:test";

import { openD1Memory } from "../src/d1.ts";
import { openPgliteMemory } from "../src/pglite.ts";
import { openSqliteMemory } from "../src/sqlite.ts";
import { ModuleOffError, type SocleStore } from "../src/store.ts";

async function conformance(open: () => Promise<SocleStore> | SocleStore): Promise<void> {
  const store = await open();
  try {
    assert.deepEqual(await store.applied(), []);
    await store.resume();
    await store.migrate([]);
    assert.equal(await store.tableReady("export"), false);
    await assert.rejects(() => store.put("export", "a", "1"), ModuleOffError);
    await assert.rejects(() => store.get("export", "a"), ModuleOffError);

    await store.migrate(["export"]);
    assert.equal(await store.tableReady("export"), true);
    assert.equal(await store.tableReady("auth"), false);
    await assert.rejects(() => store.put("auth", "a", "1"), ModuleOffError);

    await store.put("export", "a", "1");
    assert.equal(await store.get("export", "a"), "1");
    assert.equal(await store.get("export", "absent"), null);
    await store.put("export", "a", "2");
    assert.equal(await store.get("export", "a"), "2");
    await store.delete("export", "absent");
    await store.delete("export", "a");
    assert.equal(await store.get("export", "a"), null);
    await store.put("export", "a", "2");
    assert.deepEqual(await store.list("export"), [{ key: "a", value: "2" }]);
    assert.deepEqual(await store.applied(), ["export"]);

    await store.rollback();
    await assert.rejects(() => store.get("export", "a"), ModuleOffError);
    assert.equal(await store.tableReady("export"), true);
    await store.migrate(["export"]);
    assert.equal(await store.get("export", "a"), "2");

    await store.migrate(["export"]);
    assert.equal(await store.get("export", "a"), "2");

    await store.migrate([]);
    await assert.rejects(() => store.get("export", "a"), ModuleOffError);
    await assert.rejects(() => store.put("editorial", "a", "1"), ModuleOffError);
  } finally {
    await store.close();
  }
}

test("node:sqlite écrit, relit, et refuse un module éteint", async () => {
  await conformance(openSqliteMemory);
});

test("PGlite écrit, relit, et refuse un module éteint", async () => {
  await conformance(openPgliteMemory);
});

test("D1 écrit, relit, et refuse un module éteint", async () => {
  await conformance(openD1Memory);
});
