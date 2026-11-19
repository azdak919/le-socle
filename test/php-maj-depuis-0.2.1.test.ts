/**
 * Compatibilité : un paquet au format actuel (dossier kiosque-journal/ +
 * marqueur INSTALLER-A-LA-RACINE.txt) doit s'installer avec le code réel
 * de le-socle v1.2.2, l'installateur embarqué dans Kiosque 0.2.1.
 * donnees/ reste intact, les fichiers vont là où le site est déjà.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { textFile, zipStore } from "../src/zip.ts";

const REPO = join(import.meta.dirname, "..");
const INSTALLER = join(REPO, "test/fixtures/installateur-0.2.1/installer.php");
const hasPhp = spawnSync("bash", ["-lc", "command -v php"], { encoding: "utf8" }).status === 0;
const MARQUEUR = "INSTALLER-A-LA-RACINE.txt";
const WRAP = "kiosque-journal";

function makeZip(): Buffer {
  const files = [
    textFile(`${WRAP}/index.php`, "<?php echo '0.3.1';"),
    textFile(`${WRAP}/paquet.json`, '{"version":"0.3.1"}'),
    textFile(`${WRAP}/php/src/bootstrap.php`, "<?php // bootstrap"),
    textFile(`${WRAP}/site/index.html`, "<p>accueil</p>"),
    textFile(`${WRAP}/admin/assets/admin.js`, "/* admin */"),
    textFile(`${WRAP}/donnees/secret.txt`, "ne-pas-ecraser"),
    textFile(`${WRAP}/${MARQUEUR}`, "Ce dossier s'installe à la racine du site.\n"),
    textFile(`${WRAP}/LISEZMOI.txt`, "mode d'emploi"),
  ];
  return Buffer.from(zipStore(files));
}

function php(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const ran = spawnSync("php", args, { encoding: "utf8" });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

test("mise à jour depuis l'installateur 0.2.1 (Socle 1.2.2) : dossier kiosque-journal/", { skip: !hasPhp && !process.env.CI ? "php absent" : false }, () => {
  const work = mkdtempSync(join(tmpdir(), "maj-021-"));
  const zipPath = join(work, "kiosque-journal.zip");
  writeFileSync(zipPath, makeZip());

  const unpacked = php([INSTALLER, "unpack", zipPath]);
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const names: string[] = JSON.parse(unpacked.stdout);
  assert.ok(names.includes("index.php"));
  assert.ok(names.includes("paquet.json"));
  assert.ok(names.includes("php/src/bootstrap.php"));
  assert.ok(names.includes("site/index.html"));
  assert.ok(names.includes("LISEZMOI.txt"));
  assert.ok(!names.some((n) => n.startsWith("kiosque-journal/")), "l'installateur 0.2.1 retire le dossier enveloppant");
  assert.ok(!names.some((n) => n.startsWith("donnees/")), "donnees/ du ZIP n'est pas installé");
  // L'installateur 0.2.1 peut recopier le marqueur (il ne le connaît pas) : ce n'est pas bloquant.

  const dest = join(work, "site-0.2.1");
  mkdirSync(join(dest, "donnees"), { recursive: true });
  mkdirSync(join(dest, "site"), { recursive: true });
  writeFileSync(join(dest, "index.php"), "<?php echo '0.2.1';");
  writeFileSync(join(dest, "donnees", "articles.txt"), "mes-articles");
  writeFileSync(join(dest, "site", "ancien.html"), "à-retirer-si-vide-le-dossier");

  const applied = php([INSTALLER, "apply", zipPath, dest]);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  assert.equal(readFileSync(join(dest, "index.php"), "utf8"), "<?php echo '0.3.1';");
  assert.equal(readFileSync(join(dest, "donnees", "articles.txt"), "utf8"), "mes-articles");
  assert.ok(!existsSync(join(dest, "donnees", "secret.txt")), "le donnees/ du ZIP n'écrase pas celui du journal");
  assert.ok(!existsSync(join(dest, WRAP)), "rien n'est installé dans un sous-dossier kiosque-journal/");
  assert.ok(existsSync(join(dest, "site", "index.html")));
  assert.ok(existsSync(join(dest, "php", "src", "bootstrap.php")));
  // 0.2.1 vide site/ puis réécrit : ancien.html disparaît, c'est le comportement historique.
  assert.ok(!existsSync(join(dest, "site", "ancien.html")));
});

test("l'installateur actuel accepte le même ZIP et installe au même endroit", { skip: !hasPhp && !process.env.CI ? "php absent" : false }, () => {
  const work = mkdtempSync(join(tmpdir(), "maj-actuel-"));
  const zipPath = join(work, "kiosque-journal.zip");
  writeFileSync(zipPath, makeZip());
  const script = join(work, "actuel.php");
  writeFileSync(script, `<?php
require ${JSON.stringify(join(REPO, "php/src/zip.php"))};
require ${JSON.stringify(join(REPO, "php/src/maj.php"))};
$files = socle_paquet_files((string) file_get_contents($argv[1]));
echo json_encode(array_keys($files), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\\n";
`);
  const ran = php([script, zipPath]);
  assert.equal(ran.status, 0, ran.stderr);
  const names: string[] = JSON.parse(ran.stdout);
  assert.deepEqual(names.filter((n) => n === MARQUEUR), [], "le marqueur n'est pas installé par l'installateur actuel");
  assert.ok(names.includes("index.php"));
  assert.ok(names.includes("php/src/bootstrap.php"));
  assert.ok(!names.some((n) => n.startsWith("donnees/") || n.startsWith("kiosque-journal/")));
});
