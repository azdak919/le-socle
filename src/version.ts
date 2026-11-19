/**
 * Version du socle. Écrite ici plutôt que lue dans package.json au
 * chargement : le Worker (Cloudflare) n'a pas de système de fichiers. Un test
 * vérifie qu'elle suit package.json.
 */
export const VERSION: string = "1.3.1";
