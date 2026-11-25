import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function extraireCode(text: string): string {
  const match = text.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  if (!match) throw new Error(`code d’installation introuvable dans : ${text.slice(0, 200)}`);
  return match[0];
}

/** Après GET /v1/auth/etat, lit le code dans le magasin (essais en mémoire). */
export async function codeDepuisMagasin(store: { get: (collection: string, key: string) => Promise<string | null | undefined> }): Promise<string> {
  const code = await store.get("auth", "install-code");
  if (!code) throw new Error("code d’installation absent du magasin");
  return code;
}

/** Cherche donnees/code-installation.txt sous une racine de journal (ou à côté de la base). */
export function trouverFichierCode(root: string, dbPath?: string): string | null {
  const candidats = [
    dbPath ? join(dirname(dbPath), "code-installation.txt") : "",
    join(root, "donnees", "code-installation.txt"),
    join(root, "journal", "donnees", "code-installation.txt"),
    join(root, "journal", "socle", "donnees", "code-installation.txt"),
    join(root, "socle", "donnees", "code-installation.txt"),
    join(root, "code-installation.txt"),
  ].filter(Boolean);
  for (const file of candidats) if (existsSync(file)) return file;
  return null;
}

export async function codeDepuisServeur(baseUrl: string, root?: string, dbPath?: string): Promise<string> {
  const base = baseUrl.replace(/\/$/, "");
  await fetch(`${base}/v1/auth/etat`);
  const file = root ? trouverFichierCode(root, dbPath) : (dbPath ? join(dirname(dbPath), "code-installation.txt") : null);
  if (file && existsSync(file)) return extraireCode(readFileSync(file, "utf8"));
  throw new Error(`code d’installation introuvable (base ${base}, racine ${root ?? "—"})`);
}

export function corpsInstallation(email: string, password: string, code: string, extra: Record<string, string> = {}): string {
  return JSON.stringify({ email, password, code, ...extra });
}
