# Publier une version

Une **version** (étiquette `vX.Y.Z` et Release GitHub) est ce que les journaux
installés reçoivent : le paquet PHP `le-socle-php.zip` et, par le Kiosque, la
mise à jour en un clic. Tant qu'une PR est seulement fusionnée dans `main`,
aucun journal ne la voit.

## Quand publier

L'issue **« Prochaine version »** (étiquette `prochaine-version`) se tient à
jour toute seule à chaque fusion dans `main` : elle liste les PR fusionnées
depuis la dernière étiquette et affiche un avis quand des changements
**visibles** attendent (rédaction, pages sans JavaScript, serveur, paquet).

Publiez quand :

- un correctif touche les journaux installés (erreur, perte de données,
  sécurité) : **le jour même** ;
- des changements visibles s'accumulent depuis plus d'une semaine, ou un
  ensemble cohérent est prêt (par exemple une demande de Charles terminée) ;
- le Kiosque a besoin d'épingler ce socle pour sa propre version.

Pas besoin de publier pour des changements internes seulement (tests,
documentation, CI) : l'issue le dit.

## Numéro

- **correctif** (1.2.2 → 1.2.3) : rien ne change pour l'utilisateur, sauf ce qui était cassé ;
- **nouveautés** (1.2.3 → 1.3.0) : nouvel écran, nouveau réglage, nouveau texte d'aide important ;
- **changement majeur** (1.3.0 → 2.0.0) : un journal installé doit faire une opération à la main (rare ; à annoncer).

## Liste de contrôle

1. **CI entièrement verte** sur `main` : toutes les tâches, pas seulement « test ».
2. **Captures avant/après** jointes aux PR qui changent ce que l'on voit
   (ordinateur et mobile, clair et sombre).
3. **Nouveautés rédigées** dans `CHANGELOG.md`, rubrique « Non publié », en
   français clair, du point de vue de la rédaction (pas de noms de fichiers
   quand des mots suffisent).
4. **PR de version** : `npm version X.Y.Z --no-git-tag-version`, le même numéro dans `src/version.ts` (met
   `package.json` et `package-lock.json` à jour) et une ligne
   « Version X.Y.Z. » en tête de « Non publié » dans `CHANGELOG.md`. CI verte,
   fusion locale signée, comme toute PR.
5. **Bouton de publication** : onglet *Actions* → **Publier une version** →
   *Run workflow* → tapez le numéro (`1.2.3`). Le workflow refuse si la CI
   n'est pas verte sur `main`, si le numéro tapé n'est pas celui de
   `package.json`, si `CHANGELOG.md` ne le mentionne pas ou si l'étiquette
   existe déjà. Sinon, il pose l'étiquette `vX.Y.Z` et lance le workflow
   **Release**, qui joint `le-socle-php.zip`.
6. **Vérification sans compte** :
   `curl -sIL https://github.com/azdak919/le-socle/releases/latest/download/le-socle-php.zip`
   doit finir par `200`.
7. **Le Kiosque** : épinglez le nouveau socle (`node tools/maj-socle.mjs <sha>`)
   et publiez une version du Kiosque (voir son `RELEASING.md`) pour que les
   paquets complets la reçoivent.

L'issue « Prochaine version » se ferme toute seule quand tout est publié.

## À la main (si le bouton est indisponible)

```sh
git checkout main && git pull
git tag -a vX.Y.Z -m "Version X.Y.Z"
git push origin vX.Y.Z      # déclenche le workflow Release
```

Ne jamais déplacer ni supprimer une étiquette publiée : publiez plutôt la
version suivante.
