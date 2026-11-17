# AGENTS.md

Lire [`docs/plan.md`](docs/plan.md) avant d'écrire du code. Le plan est accepté. En place : squelette, pilote D1, archive (module 7), éditorial (module 2, contrat épinglé dans `src/kiosque-pin.ts`), médias et crédits (module 3). Le module suivant est l'identité, dans une pull request à part.

## Git

La source de vérité, quand le clone est sous `VisualCode/`, est `../GIT-AND-TEST-SAFETY.md`.

- Branche, vérification locale, pull request, lien cliquable. Pas de commit direct sur `main`.
- Identité des commits : **Azdak** `<azdak-qc@proton.me>`. Jamais d'autre nom ni d'autre courriel.
- Pour se mettre à jour : fusionner `main` dans la branche. Pas de force-push, pas de réécriture d'un historique déjà poussé.
- Ne pas fusionner une pull request. Le propriétaire le fait.
- Vérification locale avant push : `npm test`.
- Workflow : `.github/workflows/verification.yml`, nom **Vérification**, job **`test`**.
- Sous `/v1/`, `GET /v1/health` est la seule route tant que les modules sont éteints. `GET /v1/editorial/snapshot` n'existe que si `editorial` est allumé. `/admin` sert la sauvegarde, la mise à jour, les articles, la relecture et la file des crédits manquants, chacun seulement si son module est allumé. Les modules restent éteints dans `socle.config.json`.

## Invariants déjà décidés dans le plan

- Chacun héberge le sien. Pas de service partagé entre projets.
- La lecture statique survit à l'arrêt du serveur.
- Les modules sont désactivés par défaut.
- Aucun secret dans le dépôt.
- Le build de LE KIOSQUE n'importe pas ce dépôt.
