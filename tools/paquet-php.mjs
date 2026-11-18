// Fabrique le paquet du socle pour un hébergement PHP mutualisé :
// dist/le-socle-php.zip, un dossier « socle/ » à déposer tel quel.
// Usage : node tools/paquet-php.mjs [--sortie dist/le-socle-php.zip]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { zipStore } from "../src/zip.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const out = args.includes("--sortie") ? args[args.indexOf("--sortie") + 1] : join(root, "dist", "le-socle-php.zip");

const files = [];
const add = (name, data) => files.push({ name: `socle/${name}`, data: typeof data === "string" ? new TextEncoder().encode(data) : data });
const walk = (dir, prefix, skip = () => false) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (skip(entry)) continue;
    if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`, skip);
    else add(`${prefix}${entry}`, readFileSync(full));
  }
};

const m = join(root, "php", "mutualise");
add("index.php", readFileSync(join(m, "index.php")));
add(".htaccess", readFileSync(join(m, ".htaccess")));
add(".user.ini", readFileSync(join(root, "php", "public", ".user.ini")));
add("LISEZMOI.txt", readFileSync(join(m, "LISEZMOI.txt")));
add("donnees/socle.config.json", readFileSync(join(m, "socle.config.json")));
add("donnees/.htaccess", readFileSync(join(m, "deny.htaccess")));
add("php/.htaccess", readFileSync(join(m, "deny.htaccess")));
walk(join(root, "php", "src"), "php/src/");
add("admin/serveur.html", readFileSync(join(root, "admin", "serveur.html")));
// sql.js ne sert qu'à la démonstration dans le navigateur : pas sur un serveur.
walk(join(root, "admin", "assets"), "admin/assets/", (name) => /^sql-wasm|^sqljs-db|^demo-backend/.test(name));
add("LICENSE", readFileSync(join(root, "LICENSE")));
// Le socle PHP y lit sa version.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
add("package.json", `${JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license }, null, 2)}\n`);
add("THIRD_PARTY.md", readFileSync(join(root, "THIRD_PARTY.md")));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zipStore(files));
console.log(`${relative(process.cwd(), out)} : ${files.length} fichiers`);
