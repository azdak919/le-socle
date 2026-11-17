import { emptySiteZip, buildSiteZip } from "./archive.ts";
import type { ModuleName } from "./modules.ts";
import type { SocleStore } from "./store.ts";

export async function runMigrate(options: {
  store: SocleStore;
  enabled: readonly ModuleName[];
  now: Date;
  down: boolean;
  writeBackup: (bytes: Uint8Array) => void;
}): Promise<{ removed: string | null }> {
  await options.store.resume();
  const applied = await options.store.applied();
  const bytes = applied.includes("export")
    ? await buildSiteZip(options.store, options.now)
    : emptySiteZip();
  options.writeBackup(bytes);
  if (options.down) {
    return { removed: await options.store.rollback() };
  }
  await options.store.migrate(options.enabled);
  return { removed: null };
}
