# Extensions du Socle — contrat 1

Une extension ajoute des pages, des réglages, des rôles, des tâches et des cartes à l’espace de rédaction d’un journal, sans toucher au code du Socle. Elle vit dans son propre dossier, sous `extensions/`, et survit aux mises à jour.

Ce document décrit le **contrat d’extensions, version 1** (`api: 1`). Il fait partie du Socle à partir de la version 1.5.0. L’extension d’exemple, [`examples/extension-bonjour/`](../examples/extension-bonjour/), sert de modèle et d’essai.

## En bref

- Une extension = un dossier `extensions/<id>/` avec un manifeste `extension.json` et un fichier PHP qui **renvoie une fonction**.
- L’administrateur l’active dans la page **Extensions** de l’espace de rédaction (lien visible par l’administrateur seulement).
- La mise à jour du Socle ne touche jamais à `extensions/`. Le dossier est compris dans la copie faite avant chaque mise à jour, et le retour arrière le remet tel quel.
- L’état des extensions (activée ou non, coupée, rôles choisis, dernières tâches) est rangé dans `donnees/extensions.json`. Leurs données sont dans la base du journal, dans une table à leur nom.
- Une extension incompatible ou en erreur est mise de côté toute seule : le reste de l’espace de rédaction continue de fonctionner, et un message clair dit quoi faire.
- Les extensions ne fonctionnent qu’avec le Socle PHP. Elles ne sont jamais chargées pour le site public.

## Installer une extension

1. Déposez le dossier de l’extension dans `extensions/` sur le serveur (FTP, SFTP ou gestionnaire de fichiers de l’hébergeur). Le nom du dossier doit être l’identifiant de l’extension : `extensions/bonjour/`.
2. Ouvrez l’espace de rédaction, page **Extensions**, en tant qu’administrateur.
3. Vérifiez la fiche : version, version du Socle demandée, licence, secrets attendus, rôles. Choisissez qui détient chaque rôle de l’extension.
4. Cliquez sur **Activer**.

Sur Apache ou LiteSpeed, le Socle écrit `extensions/.htaccess` (« Require all denied ») pour fermer le dossier au public. Sur nginx seul, demandez au service informatique de fermer `extensions/`, comme `donnees/` et `php/`.

Pour retirer une extension : **Désactiver**, puis supprimer son dossier. Sa table de données reste dans la base (rien n’est effacé sans vous).

## Le manifeste `extension.json`

```json
{
  "id": "bonjour",
  "nom": "Bonjour",
  "version": "1.0.0",
  "description": "Extension d’exemple.",
  "auteur": "Le Socle",
  "socle": ">=1.5.0 <2.0.0",
  "api": 1,
  "licence": "GPL-2.0-only",
  "point_entree": "extension.php",
  "secrets": [],
  "roles": [
    { "id": "bonjour-lecteur", "nom": "Lire et écrire les notes de Bonjour", "defaut": ["editeur"] }
  ]
}
```

| Champ | Obligatoire | Règle |
| --- | --- | --- |
| `id` | oui | Minuscules, chiffres et traits d’union, 2 à 40 caractères, commence par une lettre. **Égal au nom du dossier.** |
| `nom` | oui | Le nom affiché dans l’espace de rédaction. |
| `version` | oui | Version de l’extension (`1.0.0`). |
| `description`, `auteur` | non | Texte affiché dans la fiche. |
| `socle` | oui | Versions du Socle acceptées (voir plus bas). |
| `api` | oui | Version du contrat d’extensions. Aujourd’hui : `1`. |
| `licence` | oui | Identifiant SPDX compatible avec la GPL version 2 seulement (voir « Licences »). |
| `point_entree` | non | Fichier PHP chargé, dans le dossier de l’extension. Par défaut `extension.php`. |
| `secrets` | non | **Noms** des secrets dont l’extension a besoin (`SOCLE_GITHUB_JETON`). Jamais leurs valeurs. Majuscules, chiffres et `_`. |
| `roles` | non | Rôles propres à l’extension : `id` (même règle que l’identifiant), `nom` lisible et `defaut`, les rôles du Socle qui le détiennent au départ. |

### Versions du Socle acceptées

Le champ `socle` est une suite de conditions séparées par des espaces, toutes vraies : `>=1.5.0 <2.0.0`. Opérateurs : `>=`, `<=`, `>`, `<`, `=`, `^1.5.0` (même version majeure), `~1.5.0` (même version mineure) et `*` (toutes). Nous recommandons `>=<version testée> <<majeure suivante>`.

## Le point d’entrée

Le fichier PHP **renvoie une fonction** qui reçoit l’objet `SocleExtension` et y déclare tout ce que l’extension apporte :

```php
<?php
declare(strict_types=1);

return function (SocleExtension $ext): void {
    $ext->menu('Bonjour');
    $ext->page('', fn (SocleRequete $req): string => '<p>Bonjour.</p>');
};
```

Règles :

- **Aucune fonction ni classe nommée au premier niveau** du fichier (ni dans les fichiers qu’il inclut). Un nom en double avec le Socle ou une autre extension est une erreur fatale de PHP. Utilisez des fonctions anonymes, ou des classes dans un espace de noms à vous (`namespace Radar\Bonjour;`).
- Les déclarations se font pendant ce chargement seulement. Ensuite, l’objet est figé.
- Les fonctions du Socle (`socle_…`) ne font pas partie du contrat et peuvent changer sans avertissement. Seuls les points d’accroche décrits ici sont stables.

## Points d’accroche (contrat 1)

Les rôles du Socle sont `auteur`, `photographe`, `reviseur`, `chef-pupitre`, `editeur` et `administrateur`. Partout où une liste `$roles` est demandée, on peut mêler rôles du Socle et rôles de l’extension. L’administrateur a toujours accès. Par défaut, `$roles` vaut `['administrateur']`.

### Menu

```php
$ext->menu(string $libelle, string $chemin = '', array $roles = ['administrateur']);
```

Ajoute une entrée au menu de l’espace de rédaction, avant « Sauvegarde ». Elle mène à `/admin/x/<id>/<chemin>`. Seules les personnes qui ont l’un des rôles voient l’entrée.

### Pages

```php
$ext->page(string $chemin, callable $gestionnaire, array $roles = ['administrateur'], array $methodes = ['GET']);
```

Sert `/admin/x/<id>/<chemin>` dans la mise en page de l’espace de rédaction (en-tête, menu, sous-menu de l’extension). Le gestionnaire reçoit une `SocleRequete` et renvoie :

- une chaîne : le HTML du corps de page (à échapper avec `SocleExtension::echapper()`) ;
- ou une `SocleReponse` : `SocleReponse::page($titre, $corps)`, `SocleReponse::redirection($adresse)` (adresse relative au site seulement), `SocleReponse::json($donnees, $statut)` ou `SocleReponse::texte($statut, $texte)`.

Les formulaires envoyés en `POST` doivent venir de la même origine que l’espace de rédaction ; sinon, la demande est refusée.

### API

```php
$ext->api(string $methode, string $chemin, callable $gestionnaire, array $roles = ['administrateur']);
```

Sert `/v1/x/<id>/<chemin>` en JSON. Le gestionnaire renvoie un tableau (converti en JSON) ou une `SocleReponse`. En `POST`, le corps doit être du JSON (`$req->json()`).

### La requête (`SocleRequete`)

Propriétés : `methode`, `chemin`, `acteur` (courriel de la personne connectée, ou `null`), `role` (son rôle dans le Socle), `langue`. Méthodes : `parametre($nom)` (adresse), `champ($nom)` et `champs($nom)` (formulaire), `json()`, `peut($role)` (la personne détient-elle ce rôle ?) et `adresse($chemin)` (adresse d’une page de l’extension).

### Réglages

```php
$ext->reglages([
    ['cle' => 'salutation', 'libelle' => 'Salutation', 'type' => 'texte', 'defaut' => 'Bonjour', 'aide' => 'Affichée en tête.'],
    ['cle' => 'maximum', 'libelle' => 'Nombre de notes', 'type' => 'nombre', 'defaut' => 20],
]);
$valeur = $ext->reglage('salutation');
```

Types : `texte`, `nombre`, `case` (vrai ou faux) et `choix` (avec la liste des valeurs permises : `'choix' => ['quotidien', 'hebdomadaire']`). Le formulaire est fait par le Socle, dans la page Extensions → **Réglages** (administrateur). Les valeurs sont rangées dans la table de l’extension.

### Rôles

Les rôles se déclarent dans le manifeste. L’administrateur choisit, dans la fiche de l’extension, quels rôles du Socle détiennent chaque rôle de l’extension (au départ : `defaut`). Dans le code : `$req->peut('bonjour-lecteur')`, ou `$ext->detient($roleSocle, 'bonjour-lecteur')`.

### Tâches

```php
$ext->tache(string $id, int $minutes, callable $gestionnaire);
```

Une tâche revient toutes les `$minutes` (de 5 minutes à 7 jours). Le gestionnaire reçoit la `SocleExtension` et peut renvoyer une courte phrase de résultat (« 3 notes »). La page Extensions montre la dernière exécution, son résultat et un bouton **Lancer maintenant**.

Le Socle lance les tâches dues quand on appelle `POST /v1/taches`. Sur un hébergement mutualisé, ajoutez une tâche planifiée (cron) toutes les 5 ou 15 minutes :

```sh
curl -fsS -X POST -H "Authorization: Bearer $SOCLE_TACHES_JETON" https://votre-journal.com/redaction/v1/taches
```

`SOCLE_TACHES_JETON` est un secret d’au moins 24 caractères (voir « Secrets »). Depuis la machine du Socle elle-même, le jeton n’est pas demandé.

### Cartes du tableau de bord

```php
$ext->carte('resume', fn (SocleExtension $ext): array => [
    'titre' => 'Bonjour',
    'lignes' => ['3 notes.'],
    'lien' => '/admin/x/bonjour',
    'etat' => 'ok', // ok, attention ou alerte
], $roles);
```

La carte paraît dans le tableau de bord pour les personnes qui ont l’un des rôles. Au plus 6 lignes de 200 caractères ; le Socle les échappe. Une carte en erreur affiche « Cette carte n’a pas pu se charger » et compte comme une erreur de l’extension.

### Données

```php
$ext->donnees()->ecrire('notes', json_encode($liste));
$texte = $ext->donnees()->lire('notes');   // ou null
$ext->donnees()->effacer('notes');
$tout  = $ext->donnees()->tout();          // [clé => valeur]
```

Chaque extension a sa table clé-valeur dans la base du journal (`ext_<id>`), comprise dans la sauvegarde de la base. Le contrat 1 ne propose pas de migrations SQL : rangez du JSON dans les valeurs.

### Secrets

```php
$jeton = $ext->secret('SOCLE_GITHUB_JETON'); // ou null
```

Une extension ne lit que les secrets **déclarés dans son manifeste**. Tant qu’un secret déclaré manque, l’extension est « en attente d’un secret » et ne se charge pas ; la page Extensions donne le nom du secret, jamais sa valeur.

Le Socle cherche un secret dans les variables d’environnement, puis dans `donnees/secrets.php`, fermé au public :

```php
<?php
return [
    'SOCLE_GITHUB_JETON' => '…',
    'SOCLE_TACHES_JETON' => '…',
];
```

Ne mettez jamais de secret dans le dossier de l’extension ni dans son dépôt.

### Accès GitHub fourni par le Socle

```php
$gh = $ext->github();                     // secret SOCLE_GITHUB_JETON par défaut
$gh->declencher('organisme/depot', 'publier.yml', 'main', ['edition' => '42']);
$runs = $gh->executions('organisme/depot', 'publier.yml', 5);
$fichier = $gh->lireFichier('organisme/depot', 'donnees/liste.json'); // ['contenu' => …, 'sha' => …] ou null
$pr = $gh->proposerPR('organisme/depot', 'main', 'radar/mise-a-jour-42', 'Titre', 'Description', [
    'donnees/liste.json' => $nouveauContenu,
]);                                        // ['numero' => 12, 'lien' => 'https://github.com/…']
```

- `declencher` lance un workflow GitHub Actions (`workflow_dispatch`), avec ses entrées.
- `executions` donne les dernières exécutions d’un workflow (état, conclusion, lien).
- `proposerPR` crée une **nouvelle branche**, y écrit les fichiers et ouvre une demande de fusion (PR). Il refuse d’écrire sur la branche de base, sur `main` et sur `master` : une extension propose, une personne fusionne.
- Une erreur de GitHub lève `SocleGitHubErreur` (avec le code HTTP dans `statut`). Le jeton n’apparaît jamais dans les messages.
- Déclarez `SOCLE_GITHUB_JETON` (ou le nom choisi) dans `secrets`. Un jeton à grain fin, limité aux dépôts et aux droits utiles (Actions, Contents, Pull requests), suffit.

### Divers

- `$ext->journal($message)` écrit une ligne dans le journal d’erreurs du serveur, préfixée de l’identifiant de l’extension.
- `SocleExtension::versionSocle()` donne la version du Socle.
- `SocleExtension::echapper($texte)` échappe un texte pour le HTML.

## Isolation : ce qui arrive quand ça va mal

| Situation | Statut dans la page Extensions | Ce que fait le Socle |
| --- | --- | --- |
| Manifeste illisible ou refusé (identifiant, licence…) | **Invalide** | Ne charge pas l’extension, donne la raison. Impossible de l’activer. |
| Version du Socle ou contrat non compatibles | **Incompatible** | Ne charge pas l’extension. Elle se rallume d’elle-même dès qu’une version compatible est installée. |
| Secret déclaré absent | **En attente d’un secret** | Ne charge pas l’extension, nomme le secret manquant. |
| Exception au chargement, dans une page, une API, une tâche ou une carte | Active, puis **Coupée** | Affiche une page d’erreur claire (HTTP 500) sans toucher au reste. Après 3 erreurs de suite, l’extension est coupée. |
| Erreur fatale de PHP (nom en double, mémoire…) | **Coupée** | L’extension est coupée tout de suite ; la page suivante s’ouvre normalement. |

Une extension coupée le reste jusqu’à ce que l’administrateur clique sur **Réactiver**. Le tableau de bord montre à l’administrateur un avis pour chaque extension coupée, avec un lien vers la page Extensions. Les messages n’affichent ni chemin du serveur ni secret.

## Mises à jour du Socle

- La mise à jour remplace le programme (`php/`, `admin/`, `site/`…), jamais `extensions/` ni `donnees/`. Un paquet qui contiendrait des fichiers sous `extensions/` est refusé pour ces fichiers.
- Avant de remplacer quoi que ce soit, le Socle copie le programme **et** `extensions/` dans `donnees/mises-a-jour/programme-*.zip` (les 3 dernières copies sont gardées).
- Le retour arrière remet le programme et `extensions/` exactement comme avant.
- **Avant le clic**, la page Mise à jour lit la version proposée et prévient si une extension activée ne sera pas compatible : « Attention : après cette mise à jour, ces extensions seront coupées… ». On peut attendre une nouvelle version de l’extension, ou mettre à jour quand même : l’extension sera mise de côté sans rien casser.

## Licences

Le Socle est sous GPL version 2 seulement. Une extension chargée par le Socle doit avoir une licence compatible : `GPL-2.0-only`, `GPL-2.0-or-later`, `LGPL-2.1-only`, `LGPL-2.1-or-later`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `Zlib` ou `CC0-1.0`. Une licence absente de cette liste (par exemple `Apache-2.0`, incompatible avec la GPL version 2) rend l’extension invalide.

## Essai de contrat en intégration continue

`test/php-extensions.test.ts` vérifie le contrat à chaque changement du Socle :

- **contrat** : chaque extension de la liste `SOCLE_EXTENSIONS_CONTRAT` (dossiers séparés par `:`, par défaut l’exemple Bonjour) doit être valide, s’activer, se charger et répondre sur ses pages sans erreur ;
- **Bonjour** : menu, page, réglage, rôle, API, carte et tâche de l’exemple ;
- **isolation** : extensions invalide, incompatible, en attente d’un secret, et cassées (exception au chargement, erreur fatale, page qui échoue) ; elles sont mises de côté et le reste répond ;
- **mise à jour** : une mise à jour jouée avec une extension installée ; l’extension survit, l’avertissement paraît avant le clic, le retour arrière la remet ;
- **accès GitHub** : workflow, exécutions et PR sur une nouvelle branche, contre un faux GitHub local ; le jeton n’est jamais affiché.

Pour essayer vos propres extensions contre une version du Socle :

```sh
SOCLE_EXTENSIONS_CONTRAT=/chemin/vers/mon-extension:/chemin/vers/autre npm test
```

Une extension externe (celles du Radar, par exemple) peut être épinglée dans `.github/workflows/verification.yml` en remplissant `SOCLE_EXTENSIONS_CONTRAT`.

## Évolution du contrat

- Un ajout compatible (nouveau point d’accroche, nouveau champ facultatif) garde `api: 1` et paraît dans le journal des changements.
- Un changement incompatible passe à `api: 2`. Le Socle annonce le changement une version à l’avance et, quand c’est possible, accepte les deux versions pendant une période de transition.
