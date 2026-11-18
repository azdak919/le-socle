// Fabrique le paquet du socle pour un hébergement PHP mutualisé :
// dist/le-socle-php.zip, un dossier « socle/ » à déposer tel quel.
// Usage : node tools/paquet-php.mjs [--sortie dist/le-socle-php.zip]
//   [--racine journal] [--site chemin/du/site] [--paquet '{"nom":…}']
// Le paquet complet du Kiosque passe --racine journal --site <site construit> :
// le même programme sert alors aussi le site du journal (site/).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { zipStore } from "../src/zip.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = opt("--sortie") ?? join(root, "dist", "le-socle-php.zip");
const folder = opt("--racine") ?? "socle";
const site = opt("--site");
const paquet = opt("--paquet");
if (!/^[a-z0-9-]+$/.test(folder)) throw new Error("--racine : lettres minuscules, chiffres, tirets");

const files = [];
const add = (name, data) => files.push({ name: `${folder}/${name}`, data: typeof data === "string" ? new TextEncoder().encode(data) : data });
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
// Le paquet complet (site + rédaction) a son propre mode d'emploi.
add("LISEZMOI.txt", readFileSync(join(m, site ? "LISEZMOI-journal.txt" : "LISEZMOI.txt")));
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
if (site) walk(site, "site/", (name) => name.startsWith("."));
// Fiche du paquet : d'où viennent les mises à jour en un clic (php/src/maj.php).
if (paquet) add("paquet.json", `${JSON.stringify(JSON.parse(paquet), null, 2)}\n`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zipStore(files));
console.log(`${relative(process.cwd(), out)} : ${files.length} fichiers`);
