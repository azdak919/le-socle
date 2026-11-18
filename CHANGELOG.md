# Journal

## Non publié

- AGENTS : règle de fusion écrite telle qu'elle s'applique (CI verte, accord du propriétaire, squash).
- API de rédaction `/v1/redaction/`, en Node et en PHP, pour que l'admin du Kiosque écrive dans le socle : articles, auteurs, sections, catégories, étiquettes, publication, et une banque de photos réutilisable avec crédit obligatoire. Sans `auth`, seulement depuis la machine du socle (un mandataire est refusé). Avec `auth`, les gestes de publication sont aux réviseurs, éditeurs et responsable. Même parcours testé sur SQLite, PGlite, D1, Node et PHP.
- Node sert aussi `SOCLE_STATIC`, comme PHP : le site construit et l'admin sous `/redaction/`.

## 1.0.0

- Le contrat `/v1` est celui de cette version. La même suite passe sur `node:sqlite`, PGlite et D1. L'adaptateur passe la suite du Kiosque épinglé.
- Même contrat en PHP, sans démon. Le contrôleur est `php/public/index.php`. La base SQLite est hors de cette racine. Sans SQLite, l'export statique reste lisible. `SOCLE_UPLOAD_DIR` nomme le dossier déjà utilisé : le bouton prépare la sauvegarde et ce dossier.
- Module 5, éteint par défaut. Abonnement par courriel ou par push, retrait par un lien. Le courriel part par le SMTP du projet. Le push est signé par des clés que le projet génère. Pas de service tiers. L'adresse est dans l'archive du journal, pas dans ses pages HTML. La clé privée n'y est pas.
- Module 4, éteint par défaut. `POST /v1/audience/event` compte un nom et un contexte. La date est celle de Toronto. Pas d'adresse ni d'identifiant. Le détail tient 90 jours, puis une ligne de semaine. Le poids sportif ne s'allume pas.
- Module 6, éteint par défaut. Décision de relecture : publier, programmer, renvoyer. Une correction proposée ne réécrit pas l'article. À l'heure, l'article passe à publié. Le site statique n'est pas réécrit.
- Module 1, éteint par défaut. Trois portes : lien magique, GitHub, Cloudflare Access. Aucun mot de passe. Le jeton n'est stocké qu'en hachage. Le bouton Mettre à jour est au responsable quand le module est allumé. Les courriels des membres sont dans l'archive du journal, pas dans ses pages HTML.
- Module 3, éteint par défaut. Une photo de banque sans crédit est refusée. Une photo d'article sans crédit reste dans le miroir et entre dans une file. Les octets d'origine sont gardés tels quels.
- Module 2, éteint par défaut. Adaptateur `socle` contre le Kiosque `8d7b602f42f7`. Articles, auteurs, taxonomies, médias en octets. `scheduledAt` exigé pour le statut programmé. File de relecture : `submittedAt`, `reviewedAt`, `reviewedBy`. Pages français et anglais. Le rôle éditorial n'est pas un contrôle d'accès.
- Module 7, éteint par défaut. Archive ZIP du site (années courante et précédente, brouillons, médias et crédits, `index.html`). Archive d'une session, articles seulement, y compris une période nommée. Restauration depuis le Markdown, le JSON et les médias. Notice tant que l'archive n'est pas téléchargée. `socle migrate` écrit d'abord la même archive et `socle migrate --down` retire la dernière migration sans effacer la table. Page Mise à jour : la sauvegarde du programme est nommée avant, le contenu du journal n'y est pas, un échec garde la version, une majeure attend un oui de plus.
- Pilote D1 local, Miniflare `4.20260730.0`. Même suite que `node:sqlite` : écrire, relire, module éteint.
- Squelette `0.0.0` : `GET /v1/health`, interrupteurs tous éteints, `SocleStore` sur `node:sqlite` et PGlite 0.5.4. Aucune route métier. Rien ne migre au démarrage.
- Plan d'architecture (`docs/plan.md`).
