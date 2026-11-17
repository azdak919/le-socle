# AGENTS.md

Lire [`docs/plan.md`](docs/plan.md) avant d'écrire du code. Tant que ce plan n'est pas accepté, on n'ajoute ni module, ni dépendance, ni workflow.

## Git

La source de vérité, quand le clone est sous `VisualCode/`, est `../GIT-AND-TEST-SAFETY.md`.

- Branche, vérification locale, pull request, lien cliquable. Pas de commit direct sur `main`.
- Identité des commits : **Azdak** `<azdak-qc@proton.me>`. Jamais d'autre nom ni d'autre courriel.
- Pour se mettre à jour : fusionner `main` dans la branche. Pas de force-push, pas de réécriture d'un historique déjà poussé.
- Ne pas fusionner une pull request. Le propriétaire le fait.
- La première pull request de code, après l'accord, copie `VisualCode/templates/new-github-project/` et obtient une CI verte (workflow Vérification, job `test`) avant tout module.

## Invariants déjà décidés dans le plan

- Chacun héberge le sien. Pas de service partagé entre projets.
- La lecture statique survit à l'arrêt du serveur.
- Les modules sont désactivés par défaut.
- Aucun secret dans le dépôt.
- Le build de LE KIOSQUE n'importe pas ce dépôt.
