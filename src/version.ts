import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { version: string };

export const VERSION: string = parsed.version;
