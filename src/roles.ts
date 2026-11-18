/**
 * Droits de la rédaction, au même endroit pour Node et le Worker (le PHP a
 * le miroir dans `php/src/roles.php`).
 *
 * - auteur : écrit et modifie des articles non publics ; s'il a des
 *   rubriques, seulement dans celles-ci ;
 * - photographe : gère la banque de photos (ajout, fiche, retrait) ; aucun
 *   article ;
 * - reviseur, editeur, administrateur : relisent et publient partout ;
 * - chef-pupitre : relit et publie dans ses rubriques seulement (toutes si
 *   aucune n'est choisie) ;
 * - sections, catégories, étiquettes, réglages du journal : reviseur,
 *   editeur, administrateur ; l'équipe : administrateur.
 *
 * Une rubrique est une section ; on la reconnaît par son identifiant ou son
 * nom court.
 */

export const ROLES = ["auteur", "photographe", "reviseur", "chef-pupitre", "editeur", "administrateur"] as const;
export type OrgRole = (typeof ROLES)[number];

/** Peuvent relire et publier partout, régler sections et journal. */
export const EDITORS: readonly OrgRole[] = ["reviseur", "editeur", "administrateur"];

/** Rôles que l'on peut restreindre à des rubriques. */
export const SCOPED: readonly OrgRole[] = ["auteur", "chef-pupitre"];

export type Scope = readonly string[];

export function isEditor(role: OrgRole | null): boolean {
  return role !== null && EDITORS.includes(role);
}

export function writesArticles(role: OrgRole | null): boolean {
  return role !== null && role !== "photographe";
}

export function managesBank(role: OrgRole | null): boolean {
  return role === "photographe" || isEditor(role);
}

/** Une liste vide veut dire « toutes les rubriques ». */
export function inScope(scope: Scope, section: string | undefined, sectionSlug?: string): boolean {
  if (!scope.length) return true;
  if (!section && !sectionSlug) return false;
  return scope.includes(section ?? "") || (sectionSlug !== undefined && scope.includes(sectionSlug));
}

/** `sectionInScope` : la rubrique de l'article est dans celles du compte (`inScope`). */
export function publishesIn(role: OrgRole | null, sectionInScope: boolean): boolean {
  if (isEditor(role)) return true;
  return role === "chef-pupitre" && sectionInScope;
}

/** Nettoie une liste de rubriques reçue (noms courts ou identifiants). */
export function cleanScope(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim().slice(0, 96);
    if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(clean) && !out.includes(clean)) out.push(clean);
    if (out.length >= 50) break;
  }
  return out;
}
