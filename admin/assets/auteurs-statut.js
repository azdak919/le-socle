/**
 * Statut d’un auteur : actif ou ancien. Les articles déjà signés gardent
 * le nom ; un ancien n’est plus proposé pour un nouvel article.
 * Rétrocompatible : `active: false` (fichiers existants) vaut « ancien » ;
 * l’absence de statut vaut « actif ».
 */

export const STATUT_AUTEUR_ACTIF = 'active';
export const STATUT_AUTEUR_ANCIEN = 'former';

export function statutAuteur(auteur) {
  const statut = auteur?.status;
  if (statut === STATUT_AUTEUR_ANCIEN || statut === 'ancien') return STATUT_AUTEUR_ANCIEN;
  if (statut === STATUT_AUTEUR_ACTIF || statut === 'actif') return STATUT_AUTEUR_ACTIF;
  if (auteur?.active === false) return STATUT_AUTEUR_ANCIEN;
  return STATUT_AUTEUR_ACTIF;
}

export function estAuteurAncien(auteur) {
  return statutAuteur(auteur) === STATUT_AUTEUR_ANCIEN;
}

export function normaliserAuteur(auteur) {
  if (!auteur || typeof auteur !== 'object') return auteur;
  const status = statutAuteur(auteur);
  return { ...auteur, status, active: status === STATUT_AUTEUR_ACTIF };
}

export function articlesDeLauteur(auteur, articles) {
  const identifiant = auteur?.slug;
  if (!identifiant) return [];
  return (articles || []).filter((article) => (article.authors || []).includes(identifiant));
}

export function auteurPeutEtreSupprime(auteur, articles) {
  return articlesDeLauteur(auteur, articles).length === 0;
}
