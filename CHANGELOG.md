# Journal

## Non publié

- Module 7, éteint par défaut. Archive ZIP du site (années courante et précédente, brouillons, médias et crédits, `index.html`). Archive d'une session, articles seulement, y compris une période nommée. Restauration depuis le Markdown, le JSON et les médias. Notice tant que l'archive n'est pas téléchargée. `socle migrate` écrit d'abord la même archive et `socle migrate --down` retire la dernière migration sans effacer la table. Page Mise à jour : la sauvegarde du programme est nommée avant, le contenu du journal n'y est pas, un échec garde la version, une majeure attend un oui de plus.
- Pilote D1 local, Miniflare `4.20260730.0`. Même suite que `node:sqlite` : écrire, relire, module éteint.
- Squelette `0.0.0` : `GET /v1/health`, interrupteurs tous éteints, `SocleStore` sur `node:sqlite` et PGlite 0.5.4. Aucune route métier. Rien ne migre au démarrage.
- Plan d'architecture (`docs/plan.md`).
