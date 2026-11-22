/**
 * Code d’installation à usage unique, et avis si le dossier des données
 * se trouve dans l’espace Web.
 */
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import type { SocleStore } from "./sqlite.ts";

export const INSTALL_CODE_KEY = "install-code";
export const INSTALL_CODE_FILE = "code-installation.txt";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function inventerCodeInstallation(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Dossier des données : à côté de la base, ou donnees/ du répertoire courant. */
export function dossierDesDonnees(): string {
  const explicit = process.env.SOCLE_INSTALL_CODE_FILE;
  if (explicit) return dirname(explicit);
  const db = process.env.SOCLE_DB;
  if (db && !db.includes(":") && db !== ":memory:") return dirname(resolve(db));
  return resolve(process.cwd(), "donnees");
}

function cheminFichierCode(): string {
  const explicit = process.env.SOCLE_INSTALL_CODE_FILE;
  if (explicit) return explicit;
  return join(dossierDesDonnees(), INSTALL_CODE_FILE);
}

function peutEcrireFichierCode(): boolean {
  if (process.env.SOCLE_INSTALL_CODE_FILE) return true;
  const db = process.env.SOCLE_DB;
  if (db === ":memory:" || (db && (db.includes("://") || db === ":memory:"))) return false;
  // Sans SOCLE_DB : on n’écrit pas à la racine du dépôt pendant les essais en mémoire.
  if (!db) return false;
  return true;
}

function ecrireFichierCode(code: string): void {
  if (!peutEcrireFichierCode()) return;
  const file = cheminFichierCode();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = `Code d’installation du journal (à usage unique)

Ce code est demandé à la première ouverture de l’espace de rédaction,
pour créer le compte administrateur. Ne le mettez pas dans un dossier
visible du Web. Après l’installation, ce fichier est retiré.

${code}
`;
  writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
}

/** Crée le code s’il manque, le recopie dans le fichier, et le renvoie. */
export async function assurerCodeInstallation(store: SocleStore): Promise<{ code: string; created: boolean }> {
  const known = await store.get("auth", INSTALL_CODE_KEY);
  if (known && known.trim()) {
    const code = known.trim();
    if (!existsSync(cheminFichierCode())) {
      try { ecrireFichierCode(code); } catch { /* le fichier est un aide-mémoire */ }
    }
    return { code, created: false };
  }
  const fromEnv = process.env.SOCLE_INSTALL_CODE?.trim();
  const code = fromEnv && /^[A-Z0-9-]{6,20}$/i.test(fromEnv) ? fromEnv.toUpperCase() : inventerCodeInstallation();
  await store.put("auth", INSTALL_CODE_KEY, code);
  try { ecrireFichierCode(code); } catch { /* idem */ }
  return { code, created: true };
}

export async function verifierCodeInstallation(store: SocleStore, brut: unknown): Promise<void> {
  const { code } = await assurerCodeInstallation(store);
  const donne = String(brut ?? "").trim().toUpperCase();
  if (!donne || donne !== code.toUpperCase()) {
    throw new Error("Ce code d’installation n’est pas le bon. Il se trouve dans le fichier donnees/code-installation.txt, sur le serveur.");
  }
}

export async function retirerCodeInstallation(store: SocleStore): Promise<void> {
  await store.delete("auth", INSTALL_CODE_KEY);
  try {
    if (existsSync(cheminFichierCode())) unlinkSync(cheminFichierCode());
  } catch { /* déjà absent */ }
}

/**
 * Avis si la base pourrait être téléchargeable. Vide si le dossier est hors
 * de l’espace Web, ou si le routeur du serveur intégré de PHP est en service.
 */
export function avisDonneesExposees(options: {
  dataDir: string;
  webRoot: string;
  viaRouteur?: boolean;
  htaccess?: boolean;
  sapi?: string;
}): string | null {
  const data = resolve(options.dataDir);
  const web = resolve(options.webRoot);
  const inside = data === web || data.startsWith(web + sep);
  if (!inside) return null;
  if (options.viaRouteur) return null;
  if (options.sapi === "cli-server") {
    return "Le dossier des données est dans l’espace Web, et le serveur intégré de PHP tourne sans le fichier routeur.php : la base pourrait être téléchargeable. Arrêtez le serveur et, dans le dossier du journal, lancez : php -S 127.0.0.1:8080 routeur.php";
  }
  if (options.htaccess === false) {
    return "Le dossier des données est dans l’espace Web, mais le fichier qui l’interdit au public (.htaccess) est absent. Placez les données hors de la racine web, ou remettez ce fichier, ou demandez à l’informatique de fermer ce dossier.";
  }
  return null;
}

export function viaRouteur(): boolean {
  return process.env.SOCLE_ROUTEUR === "1";
}
