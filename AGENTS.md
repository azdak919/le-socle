# AGENTS.md

Lire [`docs/plan.md`](docs/plan.md) avant d'écrire du code. Le plan est accepté. En place : squelette, pilote D1, archive (module 7), éditorial (module 2, contrat épinglé dans `src/kiosque-pin.ts`), médias et crédits (module 3), identité (module 1), relecture et publication programmée (module 6), audience anonyme (module 4). Le module suivant est les abonnements (module 5), dans une pull request à part.

## Git

La source de vérité, quand le clone est sous `VisualCode/`, est `../GIT-AND-TEST-SAFETY.md`.

- Branche, vérification locale, pull request, lien cliquable. Pas de commit direct sur `main`.
- Identité des commits : **Azdak** `<azdak-qc@proton.me>`. Jamais d'autre nom ni d'autre courriel.
- Pour se mettre à jour : fusionner `main` dans la branche. Pas de force-push, pas de réécriture d'un historique déjà poussé.
- Ne pas fusionner une pull request. Le propriétaire le fait.
- Vérification locale avant push : `npm test`.
- Workflow : `.github/workflows/verification.yml`, nom **Vérification**, job **`test`**.
- Sous `/v1/`, `GET /v1/health` est la seule route tant que les modules sont éteints. `GET /v1/editorial/snapshot` n'existe que si `editorial` est allumé. `/v1/auth` n'existe que si `auth` est allumé. `POST /v1/review/echeance` n'existe que si `review` est allumé : elle publie les articles dont l'heure est passée, sans réécrire le site statique. `POST /v1/audience/event` n'existe que si `audience` est allumé. Le compte est une somme, datée au jour civil de Toronto. Pas d'adresse, pas d'identifiant de personne. Le détail tient 90 jours, puis une ligne de semaine. Le poids sportif n'est pas allumé. Les noms d'événements ne sont pas dans `socle.config.json`. Le mode, le SMTP, le client GitHub et l'adresse du responsable ne sont pas dans `socle.config.json`. Le bouton de mise à jour reste ouvert tant que `auth` est éteint ; allumé, il est réservé au responsable. La décision de relecture est au réviseur, à l'éditeur ou au responsable quand `auth` est allumé. `/admin` sert la sauvegarde, la mise à jour, les articles, la relecture, la file des crédits manquants et les totaux d'audience, chacun seulement si son module est allumé. Les modules restent éteints dans `socle.config.json`.

## Invariants déjà décidés dans le plan

- Chacun héberge le sien. Pas de service partagé entre projets.
- La lecture statique survit à l'arrêt du serveur.
- Les modules sont désactivés par défaut.
- Aucun secret dans le dépôt.
- Le build de LE KIOSQUE n'importe pas ce dépôt.
