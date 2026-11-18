// Compile la feuille de l'admin (Tailwind CSS v4 + Basecoat, MIT) et écrit
// la page servie sous /redaction/, et copie sql.js pour la démo. On ne garde de Basecoat que les
// composants utilisés. Usage : npm run ui
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { serverPage } from '../admin/page.js';

const root = path.resolve(import.meta.dirname, '..');
const bc = path.join(root, 'node_modules/basecoat-css/dist');
const wanted = ['Button', 'Badge', 'Card', 'Alert', 'Kbd'];
const vega = await readFile(path.join(bc, 'styles/vega.css'), 'utf8');
const sections = vega.split(/\n(?=  \/\* [A-Z][^*]*\*\/\n)/);
const kept = sections.filter((s) => wanted.some((w) => s.startsWith(`  /* ${w} */`)));
const components = await Promise.all(wanted.map((w) => readFile(path.join(bc, `components/${w.toLowerCase()}.css`), 'utf8')));
const version = JSON.parse(await readFile(path.join(root, 'node_modules/basecoat-css/package.json'), 'utf8')).version;
const out = `/* Extrait généré de basecoat-css ${version} (MIT, © hunvreus — github.com/hunvreus/basecoat).
   Ne pas éditer : régénéré par tools/build-ui.mjs. */
${await readFile(path.join(bc, 'base/base.css'), 'utf8')}
${components.join('\n')}
@layer components {
${kept.join('\n')}
}
`;
await mkdir(path.join(root, 'admin/ui/vendor'), { recursive: true });
await writeFile(path.join(root, 'admin/ui/vendor/basecoat-subset.css'), out);
execFileSync(path.join(root, 'node_modules/.bin/tailwindcss'), ['-i', 'admin/ui/admin.css', '-o', 'admin/assets/admin.css', '--minify'], { cwd: root, stdio: 'inherit' });
await writeFile(path.join(root, 'admin/serveur.html'), serverPage());
// Base de la démo en mode navigateur : sql.js (MIT), copié tel quel.
const sqljs = path.join(root, 'node_modules/sql.js/dist');
await copyFile(path.join(sqljs, 'sql-wasm-browser.js'), path.join(root, 'admin/assets/sql-wasm.js'));
await copyFile(path.join(sqljs, 'sql-wasm-browser.wasm'), path.join(root, 'admin/assets/sql-wasm.wasm'));

