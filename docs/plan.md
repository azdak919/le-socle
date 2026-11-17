# Plan — le-socle

Statut : **proposition**. Aucun module n'est écrit. Cette pull request ne contient que de la documentation. Le travail de code commence après l'accord.

Date des constats : 16 novembre 2026. Les dépôts lus sont `azdak919/le-kiosque` (main `8d7b602`) et `azdak919/le-radar` (lecture seule). `CHANTIERS.md` n'existe dans aucun des deux. Le registre du Kiosque est la section « Registre officiel de livraison » de son `AGENTS.md` (`SUITE.md` n'est qu'un pointeur). Le registre du Radar est son `AGENTS.md`, avec `docs/agent-playbook.md` et `docs/maintenance.md`.

Le nom retenu est **le-socle**. Court, libre sur le compte, et il dit ce que c'est : un outil qu'on pose sous un projet, pas un produit de plus.

## 1. À quoi sert l'outil

Une bibliothèque et un serveur, versionnés ici, que chaque projet lance **dans son propre hébergement**. Les données d'un journal ne passent jamais par le serveur d'un autre.

```
écriture (le-socle, peut s'arrêter)
        │
        │  sync, seulement si on l'a demandé
        ▼
miroir portable (Markdown, JSON, médias, dans Git ou sur une clé)
        │
        │  build, sans réseau et sans ce dépôt
        ▼
site statique, qui continue d'être lu
```

C'est déjà la règle du Kiosque : `packages/pipeline/src/build.ts` n'importe aucun adaptateur, et un test le vérifie. Le socle s'y branche comme une source de plus. Le build reste celui du Kiosque. La machine du journal peut servir les pages construites en plus de l'écriture.

Les sept modules, chacun avec un interrupteur, tous **éteints** par défaut :

1. Authentification et rôles, par organisation (un média, une rédaction).
2. Données éditoriales, qui réalisent `EditorialBackend`.
3. Médias, avec leurs crédits.
4. Audience anonyme. Le sport est le premier cas (annexe du 16 novembre 2026, 23 h 11, Montréal). Le même compteur sert aux articles et aux autres événements qu'un projet choisit d'allumer.
5. Abonnements et notifications.
6. File de relecture et publication programmée.
7. Export complet. Une archive ZIP du site : Markdown, JSON, médias, plus un `index.html` pour lire l'archive sans serveur. L'installateur du Kiosque peut restaurer cette archive.

## 2. Ce que le code fait déjà

### LE KIOSQUE

Le paquet racine `kiosque` est privé, version 0.1.0, sans publication npm. `@kiosque/core` exporte le modèle par chemin (`packages/core/package.json`), et le pipeline l'importe en relatif. Deux dépendances de production : `yaml` 2.9.0 et `marked` 18.0.7. Node exécute le TypeScript tel quel (≥ 22.18), sans compilation. PGlite 0.5.4 et Playwright 1.62.0 sont des dépendances de développement.

Le modèle (`packages/core/src/model.ts`) a déjà les pièces utiles :

- statuts `draft`, `in-review`, `scheduled`, `published`, `archived`, `retracted` ;
- seul `published` entre dans une liste ; `published` et `archived` gardent une page ; `retracted` disparaît ;
- `Author.editorialRole` vaut `auteur`, `reviseur` ou `editeur`, et le commentaire dit que ce n'est **pas** un contrôle d'accès (l'accès réel est celui du dépôt Git) ;
- `MediaAsset` porte `credit`, `creditUrl`, `license`, `licenseUrl`, `sourceUrl`, `checksum`, `focalPoint` ;
- un article a `submittedAt`, `reviewedAt`, `reviewedBy`, et le commentaire dit qu'aucune mécanique ne s'en sert encore ;
- il n'y a pas de champ `scheduledAt`, et le mot « correction » n'apparaît nulle part.

`ContentSource` (`source.ts`) est la seule frontière réseau du `sync`. `EditorialBackend` (`editorial.ts`) est le contrat d'une interface de rédaction : `init`, `getSnapshot`, `save`, `remove`, `savePublication`, démo, `createBackup`, `restoreBackup`. Les deux contrats sont distincts. Le build ne reçoit qu'un `ContentBundle` déjà chargé.

`PocketBaseBackend` (`editorial-backends.ts`) ne se connecte à rien. Chaque méthode lève « PocketBase est une option future ». Le test `tests/editorial-backends.test.ts` verrouille cette absence de connexion. Le mode `external` du build affiche une page « backend indisponible », dont le nom par défaut est PocketBase (`build.ts`).

Le choix se fait dans `kiosque.config.ts` :

- `source.adapter` : seul `markdown` est enregistré ; l'entrée WordPress est commentée, et l'adaptateur lève « non implémenté » ;
- `editorial.mode` : `demo-local`, `git-sveltia`, ou `external`. Le gabarit ne pose pas le mode, donc le build retombe sur Sveltia. La vitrine amont est en `demo-local`.

La démo PGlite tourne dans le navigateur (IndexedDB). Son `CHECK` SQL n'accepte que `draft`, `in-review` et `published`. Le menu Sveltia non plus. `scheduled`, `archived` et `retracted` existent dans le type, pas dans l'admin.

Le jalon 4 est livré dans le code et dans le registre `AGENTS.md` : `kiosque doctor`, `kiosque adopt`, `kiosque export` (copie `content/`, `media/`, `kiosque.config.ts` vers `export-kiosque/`), `kiosque deploy-hint`. La feuille de route du README dit encore « à venir ». C'est une doc en retard, pas un trou de code. L'admin navigateur a un second export, ZIP Markdown et JSON (`packages/theme-radar/assets/editorial/export.js`), distinct de la commande.

`runConformanceSuite` (`testkit.ts`) est le critère d'un adaptateur : hors ligne, `fetch` injecté, publication valide, auteurs, taxonomies, articles, identifiants stables, `source.backend` égal à l'id de l'adaptateur, média en `Uint8Array`, et un `since` futur qui ne renvoie pas plus que la lecture complète. `health()` ne lève jamais.

La clé USB et l'hébergement mutualisé, dans le Kiosque aujourd'hui, désignent le **site statique**. `deploy-hint.ts` dit de copier `dist/` sur la clé. Le build écrit un `.htaccess` pour Apache. Le mot PHP n'apparaît pas. Un client peut aussi poser le journal entier sur son serveur : pages publiques et rédaction. C'est la section 6.

La ligne du registre « Fédération, API distante, stockage, rôles et DAM » est bloquée tant que les responsabilités ne sont pas définies. Ce plan est cette définition. Le Kiosque continue de n'héberger personne.

### LE-RADAR

Le site public est statique (GitHub Pages). Les workflows écrivent du JSON dans Git, puis le navigateur lit ces fichiers. Si un workflow rate, le snapshot précédent reste en ligne. C'est le même principe : la lecture survit.

Les quatre Workers (`workers/bg-rotation`, `nowplaying-cache`, `translate-cache`, `weather-cache`) n'ont ni KV, ni D1, ni R2. Ils se servent du cache HTTP de Cloudflare. Aucun ne lit l'adresse IP. `bg-rotation` renvoie `cf.colo` et `cf.country` dans sa réponse d'entropie, sans les stocker. Les quatre ont les journaux d'invocation **persistants** (`observability.logs.persist = true`). Ce réglage ne sera pas repris pour l'audience.

Umami est chargé sur l'accueil, Pomo et Solitaire seulement, pas sur `/sports/`. Aucun `umami.track` dans le dépôt. Il compte des pages, pas des sports. Il ne sert pas au module 4, et cette proposition ne le retire pas.

Les trois fichiers souvent cités comme « files de correction » sont des **rapports de bot**, commités par `update-news.yml` :

| Fichier | Écrit par | Lu par |
|---|---|---|
| `author-qc.json` | `scripts/verify-authors.js` | `scripts/maintain.js` |
| `lead-image-qc.json` | `scripts/ensure-lead-images.js` | idem |
| `photo-credit-qc.json` | `scripts/verify-photo-credits.js` | idem |

Avec `--update`, ces scripts corrigent `news.json` eux-mêmes, puis écrivent des compteurs et des échantillons. `pending` dans le rapport photo est un nombre d'articles à revérifier au prochain passage, pas une boîte de réception. Le navigateur ne lit pas ces fichiers. Au 6 septembre 2026 (date interne des fichiers lus) : crédits `ok: false` avec 14 en attente et 0 manchette manquante ; auteurs `ok: true` avec 5 écarts sans source d'auteur.

L'ordre du bandeau sportif est dans `radar-sports-cta.js` : `renderSportsStrip` → `pickInitialSportsVisible` → `sportsOpenOrderSlides`, comparateur `sportsCompareOpenOrder`. L'ordre vivant est : direct, ce soir, dernière heure, hier, demain, à venir dans les 7 jours civils, scores des jours −2 à −5, puis le reste. `team.priority` ne sert qu'à départager avant ce re-tri. `localStorage['radar-sports-favorites-v1']` choisit quelle face d'un match miroir garder, pas la place dans le bandeau.

`SPORTS_POPULARITY` (hockey, football, soccer, …) n'est lu que par `sportsOrderedKeys`, qui n'a aucun appelant. Ce n'est pas l'ordre publié. On ne le « branche » pas. Le signal approuvé viendra en plus, en dernier recours, dans un seau de cartes déjà comparables.

La revue du matin et du soir du Radar est déjà une revue de presse, dans la pull request [438](https://github.com/azdak919/le-radar/pull/438), publication éteinte. Deux textes par jour, tirés des articles, des radios et des matchs, avec les liens et les auteurs. Le socle ne la refait pas et ne s'y branche pas. Les robots du fil et des sports continuent à leurs heures. `dev/photo-lab/` est un labo local, hors de ça.

Données répétées, qui restent où elles sont pour l'instant :

- établissements : `institutions.json`, pages générées, acronymes, table SEO dérivée ;
- banques photo : `data/photo-bank.json` et ses tranches, plus les JS générés ;
- signatures : `data/byline-ledger.json`, que le bot ne doit pas écraser quand la page ne montre que « Admin » ;
- popularité des **journaux** : un entier éditorial dans `news-sources.json`, sans lien avec les clics.

Hors de cet outil, et hors des pull requests Radar qui suivront : `affiches/` (le constructeur d'affiches), `scripts/fetch-social.js` et `social-feed.json`. Il n'y a pas de dossier `stories/`. Toute publication de Stories ou de réseaux rencontrée plus tard reste intouchée. Le checkout local `VisualCode/le-radar` est détaché et sale : les futures branches Radar partent d'un worktree propre, pas de celui-là.

## 3. Partage du modèle

Les deux envies tiennent ensemble, et elles ne portent pas sur le même objet.

Le site publié reste indépendant. `packages/core` est le dossier du Kiosque qui dit ce qu'est un article, un auteur, une photo. Il reste dans le Kiosque. Réafficher un site déjà en ligne ne demande pas le socle. Si plus personne ne maintient le Kiosque, `npm ci && kiosque build` reconstruit quand même depuis le miroir.

Le serveur, lui, se développe à un seul endroit : ce dépôt. Le Kiosque, le Radar et les autres ne gardent pas une copie du code du serveur. Une amélioration (compteur, export, rôles) profite à toutes les installations qui suivent la ligne 1.x, sans que personne ouvre leur dépôt pour y coller des fichiers.

La page Mise à jour est dans le Kiosque, dans la démo, et dans le Radar. Chez un client du Kiosque elle a deux lignes : le socle, et le Kiosque. Le détail est en section 9.

Chaque ligne dit la version en place, la version proposée, et ce qui change. Un bouton lance la mise à jour. Avant, une sauvegarde. Si ça échoue, la version d'avant continue. Une version majeure est à part et attend un oui de plus.

Une mise à jour du Kiosque remplace les fichiers de la plateforme et reconstruit le site. Elle ne touche pas `content/`, `media/`, `theme/tokens.css`, `kiosque.config.ts`, ni `OWNERS.md`. Un journal sans serveur reçoit ces améliorations par `maj-plateforme.yml`, en pull request.

Le déplacer (`packages/core` vers ici) forcerait chaque journal à dépendre de ce dépôt pour **reconstruire** son site. Le Kiosque s'interdit ça : deux dépendances de production, zéro réseau au build, reconstruction dans dix ans depuis le miroir seul.

Ce que fait le socle à la place :

- il parle les types déjà publics (`Article`, `Author`, `MediaAsset`, `Publication`, `EditorialStatus`, `EditorialBackend`, `ContentSource`) ;
- il garde une **copie figée** du contrat, datée, dans `contrat/` (à créer avec le module éditorial, pas maintenant) ;
- sa CI vérifie cette copie contre le plus ancien Kiosque pris en charge, par un clone du tag épinglé, et fait passer `runConformanceSuite` à l'adaptateur ;
- le Kiosque, le jour de l'intégration, n'importe le socle que dans `sync` et dans l'admin, derrière la config, et un test confirme que `build.ts` ne le voit toujours pas.

Le premier tag de Kiosque épinglé sera pris **à l'ouverture** de la pull request éditoriale, pas dans ce document : `main` bouge. Candidat au 16 novembre 2026 : `8d7b602`.

`EditorialRole` reste informatif dans le miroir. Le contrôle d'accès ne s'applique qu'aux routes du socle, quand le module 1 est allumé. Éteint, l'accès continue d'être celui de Git, comme aujourd'hui.

Les champs qui manquent au modèle et qui vivent **dans le socle**, pas dans le build :

- `scheduledAt` pour le statut `scheduled` déjà défini ;
- une file de relecture qui remplit enfin `submittedAt`, `reviewedAt`, `reviewedBy` ;
- une correction (texte proposé, URL, état), qui n'existe pas encore ;
- les compteurs d'audience, qui ne sont pas des articles.

Au `sync`, un article `scheduled` entre dans le miroir et le build actuel n'en fait ni liste ni page. Quand l'heure arrive, le socle passe l'article à `published` et le sync suivant met le miroir à jour. Si le socle est arrêté, le site publié ne change pas.

Crédit : une photo de bibliothèque sans crédit est refusée, comme `validateSharedMedia`. Une image d'article sans crédit est un avertissement, comme `validateMedia`, et une entrée de la file, pas un blocage du miroir.

## 4. Architecture

SQLite, c'est un seul fichier de base de données posé à côté du projet. Pas un logiciel à maintenir à part. Les brouillons y vivent. Le site publié, lui, reste des pages.

PGlite, c'est la même idée dans le navigateur. Le Kiosque s'en sert déjà pour la démo Le Quorum. Les tests du socle s'en servent aussi, pour ne pas inventer une deuxième démo.

Un seul cœur, en TypeScript effaçable (pas d'`enum`, pas de `namespace`, pas de propriété de paramètre), Node ≥ 22.18. Les modules appellent une interface `SocleStore`. Ils ne parlent pas SQL. Les pilotes portent le SQL.

Pilotes prévus :

| Pilote | Où | Dialecte |
|---|---|---|
| `node:sqlite` | ordinateur de la rédaction, serveur de l'établissement, petit VPS | SQLite |
| D1 | Cloudflare Workers | SQLite, sous-ensemble D1 |
| PDO SQLite | hébergement PHP | le même SQLite |
| PGlite 0.5.4 | démo et tests, comme le Kiosque | Postgres |

Postgres sur la VM n'est pas un pilote de la version 1. SQLite y suffit, et ça évite une troisième grammaire plus une dépendance `pg`. Le mot « ou Postgres » du mandat est tenu par PGlite pour la démo et les tests. Un pilote Postgres serveur serait une pull request plus tard, s'il y a un besoin réel.

Le SQL commun à D1, à `node:sqlite` et à PHP tient dans un sous-ensemble : pas de `ATTACH`, paramètres liés sous la limite D1 (100), requêtes qui passent aussi le plafond de 50 requêtes par invocation sur le forfait gratuit. PGlite a son propre fichier SQL. Les tests ne lisent pas le SQL. Ils observent le même comportement sur chaque pilote.

La cible PHP ne partage pas le code TypeScript. Elle réalise la même interface HTTP, une fois le contrat figé. Avant ça, l'hébergement mutualisé et la clé USB sont le site statique, déjà produit par le Kiosque (`.htaccess`, copie de `dist/`). Le module 7 rend ce dossier depuis le socle aussi.

Le socle et le Kiosque se mettent à jour depuis la même page (sections 3 et 9). Un journal sans serveur reçoit le Kiosque par `maj-plateforme.yml`. Le contenu du journal n'est pas écrasé.

Secrets : variables d'environnement, jamais le fichier de config commité. Même règle que `SourceContext.secrets` du Kiosque.

### Schéma (version 1, encore indicative)

Tout est rattaché à une organisation. Une organisation est un média ou une rédaction, pas une personne.

| Table | Rôle | Renseignement personnel |
|---|---|---|
| `org` | slug, nom, langue | non |
| `member` | organisation, sujet, rôle | oui : courriel ou identifiant GitHub, le temps du mandat |
| `session` | jeton **haché**, échéance | oui, éphémère |
| `article`, `author`, `media`, `section`, `category`, `tag` | le modèle du Kiosque | le courriel d'auteur seulement s'il est déjà dans le modèle |
| `correction` | cible, texte, état, auteur de la demande | le demandeur, si on le connaît |
| `review_item` | entité, état, `scheduled_at` | le réviseur |
| `media_blob` | empreinte, crédit, chemin local ou clé R2 | non, si le crédit est un nom de photographe publié |
| `audience_day` | jour de Montréal, sport, contexte, clics | **non** |
| `audience_week` | semaine, sport, contexte, total | **non** |
| `subscription` | organisation, canal, adresse | oui |
| `schema_migration` | version appliquée | non |

Le module 4 n'écrit que dans `audience_day` et `audience_week`. Pas de colonne d'adresse, d'en-tête, d'identifiant de carte, ni de personne. Les tables des modules 1 et 5 sont un fichier de renseignements personnels au sens de la Loi 25 : finalité, accès, durée, et elles sont dans l'export pour que le journal parte avec. On ne les mélange pas avec l'audience. Un module éteint n'a pas de table consultable de l'extérieur ; les migrations de ce module ne s'appliquent que lorsqu'on l'allume.

Rôles : `auteur`, `reviseur`, `editeur`, plus `responsable` pour les deux personnes qui peuvent récupérer l'accès (le champ `recoveryContacts` de `Governance` en a déjà l'idée). Le rôle ne donne des droits que sur l'API du socle.

### API

Préfixe `/v1/`. Rien d'autre que `GET /v1/health` tant que tous les modules sont éteints. La réponse dit la version et quels interrupteurs sont allumés.

Interrupteurs, dans `socle.config.json`, tous à `false` :

```json
{
  "modules": {
    "auth": false,
    "editorial": false,
    "media": false,
    "audience": false,
    "notify": false,
    "review": false,
    "export": false
  }
}
```

Routes ajoutées seulement par le module allumé. Esquisse, à figer en 1.0.0 :

- auth : lien magique (`POST` puis consommation du jeton), début et retour GitHub, session lue depuis l'en-tête JWT de Cloudflare Access quand c'est le mode choisi ;
- éditorial : les opérations de `EditorialBackend`, plus un adaptateur `ContentSource` pour `kiosque sync` ;
- médias : envoi du binaire et de son crédit ;
- audience : `POST /v1/audience/event` avec un nom (`article`, `sport`, ou un nom que le projet a allumé) et `contexte`, réponse vide. Le serveur pose la date. Un champ en plus est refusé ;
- file : liste, décision, heure de publication ;
- notifications : abonnement, désabonnement par lien ;
- export : pas une route publique. L'admin télécharge une archive ZIP (module 7). La commande `socle export` sert au guide technique.

Une version mineure peut ajouter un champ. Elle n'en retire pas, n'en change pas le sens, et n'exige pas un client nouveau. Une rupture est une version majeure : l'ancienne majeure reste installable, avec un guide et une migration réversible.

`socle migrate` refuse de partir s'il n'a pas d'abord écrit une sauvegarde (le même format que l'export). `socle migrate --down` revient d'un cran. Rien ne migre au démarrage.

### Identité, sans mot de passe et sans OAuth maison

Trois portes, au choix de l'organisation, une suffit :

1. Lien magique. Le journal fournit son propre SMTP, ou, sur la VM Oracle, le service Email Delivery inclus (3 000 messages par mois, port 25 fermé tant qu'une demande de limite n'est pas acceptée). Le socle ne stocke que le hachage du jeton, avec une échéance courte. Aucun fournisseur d'envoi à essai gratuit.
2. GitHub, pour les rédactions qui ont déjà un dépôt. Application OAuth GitHub, gratuite. Le socle ne devient pas un serveur d'autorisation.
3. Cloudflare Access, forfait gratuit jusqu'à 50 personnes. La 51e est refusée, elle n'est pas facturée, d'après le forum Cloudflare du 5 novembre 2026. À revérifier sur la page des forfaits au moment du module. Ne pas activer le forfait payant ni un ajout comme Log Explorer. Les journaux Access du forfait gratuit durent 24 heures et concernent les rédacteurs, pas les lecteurs.

## 5. Module 4 — audience anonyme

Même idée qu'Umami : compter sans dossier de lecteur, sur la machine du projet, pas chez un régie publicitaire. Umami est un logiciel libre à part (licence MIT), avec ses comptes, ses pays, ses navigateurs, ses référents. On ne l'embarque pas : ce serait un deuxième produit à tenir pendant des années. On reprend l'usage, en plus petit, dans le socle.

Un événement a un nom (`article`, `sport`, ou un autre nom que le projet allume), un contexte court, et la date du jour posée par le serveur. On additionne. On ne garde pas l'adresse, le navigateur, le pays, le référent, ni un identifiant de personne. Le script Umami déjà présent sur l'accueil du Radar (Pomo, Solitaire) n'est pas le canal de ces comptes, et cette proposition ne l'enlève pas.

L'annexe du 16 novembre 2026 reste la règle du sport. Ici, la façon de la tenir, élargie aux autres événements.

Le navigateur envoie un clic ou un tapotement sur une carte du bandeau. Pas un survol, pas une impression, pas un défilement. Le corps contient le code de sport (voile et `sailing` déjà unifiés comme dans le Radar) et le contexte `accueil` ou `page sports`. **Le serveur** pose la date civile de Montréal (`America/Toronto`) et refuse un corps qui contiendrait autre chose. On ne fait pas confiance à l'horloge du téléphone, et on n'offre pas de champ libre où un identifiant pourrait se glisser.

Le serveur incrémente `audience_day`. Il ne écrit pas de journal de la requête : pas d'adresse, pas d'en-têtes, pas d'URL complète, pas d'identifiant de carte. Le plafond anti-rafale tient dans la mémoire du processus, quelques minutes, puis il est oublié. Sur Workers, cette mémoire est un Durable Object qui **n'écrit pas** la clé dans SQLite : un redémarrage remet le plafond à zéro, ce qui limite la casse sans créer de dossier. Pas de KV pour ça. KV ne permet que 1 000 écritures par jour, et une clé dérivée de l'adresse serait un identifiant qu'on aurait conservé.

Conservation : 90 jours de détail, ou la saison scolaire si elle est plus courte (le calendrier scolaire est une donnée que le Radar devra fournir ; en attendant, 90 jours). Ensuite une ligne hebdomadaire, puis l'effacement du détail. Aucun envoi vers Umami cloud, un réseau publicitaire, ou un autre sous-traitant.

Le même tableau sert un article, une carte sportive, ou un autre nom d'événement. Le poids dans le bandeau sportif reste un cas particulier, en dernier recours, et il ne s'allume pas avec le compteur. Les autres projets lisent leurs totaux. Ils n'héritent pas des règles du bandeau.

Le site statique ne lit pas le compteur en direct à chaque visite : ça brûlerait le quota de requêtes et ça rendrait la lecture dépendante du serveur. Une fois par jour, le workflow qui met déjà `sports.json` à jour **peut** télécharger l'agrégat et le committer. Tant que l'interrupteur est éteint, il ne le fait pas. Le bandeau continue de se trier comme aujourd'hui.

Le poids ne s'applique qu'après coup, dans `sportsCompareOpenOrder`, entre des cartes du même seau, jamais à la place des règles déjà en vigueur (directs non exclusifs, un sport avant la répétition, universitaire d'abord à la une, puis le plus récent). Conditions reprises de l'annexe : quatre à huit semaines de saison, un minimum de clics par sport, moyenne lissée, plafond pour qu'un sport n'occupe pas toutes les places restantes, aucun poids inventé sous le seuil. L'été et les creux gèlent le poids. Pas de tableau public.

Deux tests de non-régression accompagnent la première intégration Radar : l'ordre actuel reste le même quand l'interrupteur est éteint, et il reste le même quand les données sont sous le seuil. Le branchement du poids est une pull request **plus tard**, encore réversible.

Avant d'allumer l'interrupteur en production, une personne vérifie qu'aucun identifiant n'est resté dans les journaux ou les en-têtes conservés. Ce n'est pas un contrôle qu'on peut déclarer fait depuis le code : les Workers du Radar persistent aujourd'hui leurs journaux d'invocation, et la plateforme peut garder une trace courte même si l'application n'écrit rien. Le Worker d'audience aura `observability.logs` désactivé, et il ne réutilise pas les Workers existants. La phrase à ajouter à la politique de confidentialité, le jour où l'interrupteur s'allume et pas avant :

> Nous comptons, sans vous identifier, les ouvertures d'articles et les clics que le projet a choisi de mesurer, pour voir ce qui est lu. Sur le Radar, les clics des cartes sportives servent en plus à varier ce qui est mis de l'avant.

## Module 7 — archive ZIP du site

Décision du 17 novembre 2026. Le module reste éteint tant qu'un admin ne l'allume pas. Tant qu'il est éteint, une notice reste affichée dans le back-office pour les admins. Elle dit d'allumer la sauvegarde, de télécharger l'archive, et, si le serveur est perdu, de réinstaller avec le configurateur du Kiosque en choisissant cette archive. La notice ne bloque pas l'écriture. Elle disparaît une fois le module allumé et une archive téléchargée.

L'archive est un seul fichier ZIP. Elle doit quitter le serveur : une copie qui reste seulement sur la machine ne sert plus si la machine est morte. L'installateur du Kiosque gagne l'option « Restaurer à partir d'une sauvegarde ». On lui donne le ZIP. Il remet ce que l'archive contient. Il dit quelles années ne sont pas dans le fichier.

Deux archives :

- **Le site.** Les fichiers du journal (`kiosque.config.ts`, `theme/tokens.css`, `OWNERS.md`), les articles des années choisies, leurs médias et leurs crédits. Les brouillons et les textes en relecture de ces années sont dans le même fichier : un arrêt ne doit pas les effacer.
- **Une session, articles seulement.** Automne, hiver, été, ou la période que le journal a nommée. Pas le reste du site. La restaurer est une option : elle remet ces articles dans un journal déjà en place, sans remplacer les autres années.

Paramètres, modifiables, et mémorisés comme défaut du journal :

- L'année en cours et l'année précédente sont cochées.
- Les années plus anciennes sont décochées. On suppose qu'une archive antérieure les a déjà. Le produit ne peut pas le vérifier. La page le dit.
- L'admin peut recocher une année ancienne, ou retirer l'année précédente, et garder ce choix.

Dans le ZIP, à côté des fichiers de données : un `index.html` et les pages HTML des articles inclus. On ouvre `index.html` dans un navigateur et on parcourt le contenu de cette archive. Ces pages servent à lire. La restauration lit le Markdown, le JSON et les médias, pas le HTML.

Le ZIP ne contient pas de secret (mot de passe, jeton, clé). Il n'est pas publié sur le site. Les courriels des membres, si le module 1 est allumé, sont un renseignement personnel : l'archive reste chez le journal.

Cette archive n'est pas la sauvegarde d'une mise à jour de version. La page Mise à jour garde la sienne, pour revenir au programme d'avant. Ici, c'est le contenu du journal.

La démo produit la même archive depuis la copie du navigateur. Le Radar n'a pas cette archive : ce n'est pas un journal client.

## 6. Cibles gratuites

Ce chapitre dit où **un journal** peut installer **sa** copie, sans payer. Ce n'est pas un branchement sur ce qui existe déjà.

- Pas les Workers déjà en ligne du Radar (météo, titres à l'antenne, traduction, fonds). Ils restent où ils sont. Le socle n'écrit pas dedans.
- Pas la machine Oracle des parties SS14. On n'y déploie rien, on n'y lit rien, on ne la cite pas comme hébergement de cet outil.

Certains clients hébergent le journal en entier sur leur serveur : les pages que le public lit, et l'endroit où la rédaction écrit. Un petit serveur suffit pour ça. C'est un cas normal, pas un supplément.

Ce que cette machine porte :

- le site public ;
- les brouillons, à plusieurs en même temps ;
- la file de relecture et l'heure de publication ;
- le compteur anonyme et les totaux du jour ;
- les photos et leurs crédits ;
- qui a le droit de publier ;
- les mises à jour du socle et du Kiosque ;
- l'archive ZIP du site, à télécharger.

Si cette machine est le seul exemplaire du site, son arrêt éteint aussi la lecture. Une copie (export, Pages) reste possible quand les questions d'installation l'ont prévue. `build.ts` n'importe pas le serveur. La machine sert les pages déjà construites.

Deux serveurs, qui ne sont pas le même. Un serveur personnel sert les projets de la collection : le Radar, un journal à soi. Il ne reçoit pas les journaux des clients. Chaque client apporte le sien : établissement, mutualisé, ordinateur de la rédaction, petit VPS. Le Kiosque n'en propose pas une à lui.

L'ordre pour une rédaction étudiante :

1. **Pas de serveur.** GitHub Pages, l'espace web de l'établissement, une clé USB, un hébergement qui ne fait que servir des fichiers. Chemin actuel du Kiosque (`docs/installation.md`). Les mises à jour du Kiosque passent par `maj-plateforme.yml`.
2. **Leur serveur, journal entier.** L'ordinateur de la rédaction, le serveur de l'établissement, une machine à la maison, un petit VPS. Les pages publiques et la rédaction sont sur cette machine. Un fichier SQLite.
3. **L'hébergement mutualisé pas cher** qu'ils ont souvent déjà (Hostinger et les offres du même genre, parfois via l'association étudiante). Le journal entier y tourne si l'hébergeur a PHP et SQLite. Sinon il sert les pages statiques, et l'écriture reste dans Git.
4. **Cloudflare ou une VM Always Free**, seulement si quelqu'un veut vraiment s'en servir. Ce n'est pas le conseil par défaut. Ce n'est pas la machine SS14. Ce n'est pas les Workers du Radar.

Chiffres relevés le 16 novembre 2026. Ils bougent. La pull request du pilote correspondant les revérifie. Aucune de ces cibles ne demande une carte qui se met à facturer toute seule : le dépassement du forfait Workers gratuit **échoue**, il ne bascule pas sur le payant. On ne crée pas les ressources d'essai (crédit Oracle de 300 $, Workers payant à 5 $ US, Cloudflare Images, forfait Zero Trust payant).

### Cloudflare Workers, forfait gratuit

Source : documentation Pricing, mise à jour le 13 novembre 2026, et limites D1 / KV, mise à jour le 30 octobre 2026.

| Ressource | Plafond gratuit | Conséquence ici |
|---|---|---|
| Requêtes Workers | 100 000 / jour | Les clics y passent. La lecture du site n'y passe pas. |
| CPU | 10 ms par invocation | Pas de redimensionnement d'image. Le fichier original et son crédit seulement. |
| Journaux Workers | 200 000 événements / jour, 3 jours | Éteints sur la route d'audience. À partir du 1er décembre 2026, ces journaux suivent le tarif Observability : une raison de plus de ne pas les allumer. |
| D1 | 10 bases, 500 Mo chacune, 5 Go sur le compte, 5 millions de lignes lues / jour, 100 000 lignes écrites / jour, 50 requêtes par invocation | Les compteurs et le modèle éditorial. Une écriture de clic = une ligne. Largement assez pour un journal, pas pour tous les journaux du Québec sur **le même** compte. Chacun son compte. |
| KV | 100 000 lectures / jour, 1 000 écritures / jour, 1 Go | Pas pour les clics. Inutile à la version 1. |
| R2 | 10 Go-mois, 1 million d'opérations de classe A / mois, 10 millions de classe B, sortie gratuite | Les originaux. 10 Go est le plafond à surveiller pour une photothèque. |
| Durable Objects SQLite | inclus sur le gratuit ; 100 000 requêtes / jour, durée 13 000 Go-s / jour | Le plafond anti-rafale en mémoire, sans écrire l'adresse. |

### VM Oracle Always Free

Source : documentation Oracle « Always Free Resources », lue le 16 novembre 2026.

| Ressource | Inclus |
|---|---|
| Ampere A1 | 1 500 heures d'OCPU et 9 000 heures de Go par mois, soit 2 OCPU et 12 Go, dans la région d'origine |
| AMD micro | 2 × VM.Standard.E2.1.Micro (1/8 d'OCPU, 1 Go) |
| Disque | 200 Go, volume d'amorçage d'au moins 47 Go, souvent 50 Go par défaut |
| Sortie | 10 To / mois |
| Stockage objet, compte toujours gratuit seulement | 20 Go et 50 000 requêtes API / mois |
| Courriel | 3 000 messages / mois, port 25 fermé par défaut |

La région d'origine est permanente. Pour Montréal, il faut la choisir à la création du compte (`ca-montreal-1`). Une VM oisive peut être reprise : sur 7 jours, si le 95e centile du CPU est sous 20 %, le réseau sous 20 %, et la mémoire sous 20 % pour les formes A1. Un journal qui publie peu peut perdre la VM. Le site statique continue. On ne contourne pas la règle d'oisiveté par une charge artificielle. On documente le risque, et on tient l'export à jour.

Le crédit d'essai de 300 $ n'est pas le plan. Si le compte est encore dans l'essai, la VM doit déjà être à la forme Always Free avant la fin, sinon Oracle retire les instances au-dessus du quota.

### PHP mutualisé et clé USB

Pas de chiffre universel : le délai par requête, la présence de SQLite et le cron dépendent de l'hébergeur. Le socle dynamique, le jour où il existe en PHP, est un contrôleur sans démon, base SQLite hors de la racine web. Un hébergeur sans SQLite sert quand même le site statique. La clé USB, c'est `dist/` ou le dossier d'export, lisible sans Node et sans PHP.

### PGlite

Même version que le Kiosque (0.5.4), en dépendance de développement, pour la démo et les tests. Pas dans le build Git d'un journal. Pas chargé depuis un CDN.

### Ce qu'il faut surveiller une fois que ça tourne

- R2 à l'approche de 10 Go.
- 100 000 lignes D1 écrites dans la journée (un import massif, pas le clic ordinaire).
- 100 000 requêtes Workers dans la journée.
- 50 personnes sur Access.
- 3 000 courriels Oracle dans le mois.
- La reprise d'une VM oisive.
- Les 90 jours d'audience, pour que le résumé hebdomadaire parte avant l'effacement.

## 7. Inventaire des dépôts azdak919

Liste obtenue avec `gh repo list azdak919 --limit 200` le 16 novembre 2026. Quatorze dépôts, pas un de plus. Un dépôt « ne pas adopter » n'est pas modifié.

| Dépôt | Aujourd'hui | Verdict | Modules |
|---|---|---|---|
| `le-kiosque` | Miroir Git, build statique, démo PGlite, stub PocketBase, export, doctor, adopt. Pas de serveur. | **Adopter**, en premier, interrupteur éteint. | 1, 2, 3, 6, 7. Le 5 plus tard, s'il sert à prévenir une rédaction. Pas le 4 : un journal n'a pas le bandeau sportif du Radar. |
| `le-radar` | Pages statiques, bots qui commitent le JSON, quatre Workers de cache, Umami cloud sur trois pages, rapports QC. La revue de presse est la pull request 438. | **Adopter**, plus tard, pour le compteur anonyme seulement, éteint. | 4. Pas la revue de presse. Pas 1 ni 5 tant que les suivis restent dans le navigateur. Pas 2 : le Radar n'est pas une rédaction. |
| `kiosque-essai-gabarit` | Copie jetable du gabarit, démo PGlite, Pages. | **Ne pas adopter.** Le gabarit suivra le Kiosque le jour où quelqu'un refera un essai. | aucun |
| `mutua` | Hub statique, données reçues par pull requests. | **Ne pas adopter.** | aucun |
| `mutua-studio` | Pages statiques. Deux Workers de cache (géocodage, traduction), sans base. Le proxy de traduction n'est plus appelé par le client. | **Ne pas adopter.** Un cache d'adresses n'est pas un back-office, et les documents restent chez la personne. | aucun |
| `mutua-ops` | Bots et Actions qui écrivent dans les autres dépôts Mutua. | **Ne pas adopter.** | aucun |
| `mutua-jurisdictions` | Feuilles de droit dans Git. | **Ne pas adopter.** | aucun |
| `mutua-spec` | Archivé le 29 octobre 2026, contenu repris dans `mutua`. | **Ne pas adopter.** | aucun |
| `mutua-terrain` | Observatoire statique, scripts Python, aucune écriture visiteur. | **Ne pas adopter.** | aucun |
| `a-hauteur-deau-kiamika` | Carnet statique, médias déjà dans Git. | **Ne pas adopter.** | aucun |
| `focus-group` | Sessions et verdicts en fichiers, sans compte. | **Ne pas adopter.** | aucun |
| `claw-kit` | Kit local d'installation, pas une application publique. | **Ne pas adopter.** | aucun |
| `rate-my-fonctionnaire` | MVP déjà doté de sa base, de sessions d'administration, d'une file de modération et d'une sauvegarde. Démo statique à part. | **Adopter plus tard.** Le brancher maintenant remplacerait un modèle qui n'est pas celui d'un journal. On y reviendra seulement si l'admin, l'audience anonyme, la file ou l'export y ont encore une place, sans y ajouter un compte lecteur. | à revoir : 1 (admin seul), 4, 6, 7. Pas 2 ni 3. |
| `secondbrain` | Coffre de notes privé. Pas une application. | **Ne pas adopter.** | aucun |

Les dépôts privés sont décrits ici au niveau d'un verdict. Pas de secret, pas de contenu de coffre, pas de schéma interne.

## 8. Ajustements le jour de l'intégration

On modifie un dépôt quand le socle lui retire du travail réel. Le propriétaire a laissé ce jugement. Au 16 novembre 2026 : le Kiosque oui. Le Radar, plus tard, seulement pour compter des clics sur les cartes sportives, interrupteur éteint, sans changer l'ordre des cartes, et sans toucher à la revue de presse (pull request 438). Les autres dépôts n'ont pas ce travail : les modifier n'apporterait rien. `rate-my-fonctionnaire` a déjà son propre serveur : pas maintenant.

### LE KIOSQUE

- La valeur du Kiosque pour un client, c'est le configurateur. Il pose les questions nécessaires, en quelques étapes : le nom, la langue, où le journal est hébergé (leur serveur pour le site entier, ou des pages seules), qui publie. Après ces réponses, le journal est en place. On ne refait pas le questionnaire pour une mise à jour. Le Kiosque ne fournit pas d'hébergement : la machine est la leur. Les secrets ne sont pas dans les réponses.
- Le configurateur propose aussi « Restaurer à partir d'une sauvegarde ». Le fichier est l'archive ZIP du module 7. Une archive « session, articles seulement » se restaure à part, dans un journal déjà là.
- `kiosque.config.ts` gagne un adaptateur `socle`, absent du gabarit. Le défaut reste Sveltia ou la démo, selon le projet.
- L'import du paquet est dynamique, limité à `sync` et à la page d'admin. `build.ts` ne change pas d'imports. Le test existant reste vert.
- `packages/core` reste ici. PocketBase reste un stub qui ne se connecte pas.
- Le dépôt du journal ne contient pas une copie du serveur. La page Mise à jour (section 9) avance le socle et le Kiosque.
- La démo (Le Quorum, PGlite dans le navigateur) a la même page. Le bouton s'applique à la copie du navigateur. Rien n'est envoyé ailleurs.
- `AGENTS.md`, `CHANGELOG.md`, et la feuille de route du README (jalon 4 déjà fait) sont mis à jour dans la même pull request.
- Le guide d'une heure est `docs/adopter-le-socle.md` **dans le socle**, lié depuis le Kiosque. Il n'existe pas encore : les commandes n'existent pas. Son sommaire est en section 10.

### LE-RADAR

- Pas de pull request tant que le compteur n'existe pas dans le socle. Le jour où elle s'ouvre : un clic sur une carte sportive envoie le sport et la page, rien d'autre. L'ordre des cartes ne change pas. L'interrupteur naît éteint. `radar-sports-cta.js` est du shell : s'il change, `npm run sw:bump` fait partie de la branche. La politique de confidentialité ne change pas tant que l'interrupteur n'est pas allumé pour de vrai.
- La même page de mise à jour est dans le Radar, pour le socle, même si le Radar n'allume que le compteur. Ce n'est pas une fonction du sport.
- La revue du matin et du soir reste la pull request 438. Le socle n'ouvre pas une deuxième revue, et il ne stocke pas ces textes.
- Worktree propre, à partir de `origin/main`. Pas le checkout détaché de `VisualCode/le-radar`.
- `AGENTS.md`, `CHANGELOG.md`, `docs/maintenance.md` mis à jour dans cette branche. Rien dans `affiches/`, rien sur les réseaux.

La dépendance est à part : le dépôt du journal ne contient pas le code du serveur. La page avance le socle et, chez un client, le Kiosque. `content/`, `media/`, `theme/tokens.css`, `kiosque.config.ts` et `OWNERS.md` restent au journal. Un journal sans serveur reçoit le Kiosque par `maj-plateforme.yml`.

## 9. Administration

Livrée avec les modules qui ont une écriture humaine (éditorial d'abord), pas dans une pull request cosmétique à la fin.

- Français et anglais : un dictionnaire de chaînes, `lang` sur la page, le contenu du journal dans sa langue à lui.
- HTML servi par le serveur, sans framework et sans bundler. Les mêmes gabarits, réduits au contrat HTTP, pour la cible PHP.
- WCAG AA : champs étiquetés, focus visible, contraste des jetons, navigation clavier, lien d'évitement. Un passage Playwright sur ces points. Une relecture humaine avant de dire la page conforme, parce qu'un test de jetons ne voit pas une page.
- Impression : une feuille `@media print` et des pages nommées Lettre, Légal, Tabloïd, A4 et A3. Le chrome d'admin (navigation, boutons) ne s'imprime pas. Le texte, les crédits et l'état de la file s'impriment. Même idée que l'article du Kiosque, qui a déjà un `@media print` pour la lecture, pas pour l'admin.

### Page Mise à jour

Même écran dans le Kiosque, dans la démo, et dans le Radar.

- Chez un client du Kiosque, deux lignes : Socle, Kiosque. Le Radar n'a que la ligne Socle.
- Chaque ligne dit la version en place, s'il en existe une plus récente sur la même majeure, et trois ou quatre lignes sur ce qui change.
- Le bouton s'appelle « Mettre à jour ». Avant, la page nomme la sauvegarde. Après, elle dit si ça a marché. Si ça échoue, la version d'avant tourne encore.
- « Revenir à la sauvegarde » défait la dernière mise à jour de cette ligne. Le contenu du journal (`content/`, `media/`, `theme/tokens.css`, `kiosque.config.ts`, `OWNERS.md`) n'est pas dans la mise à jour.
- Une mise à jour du Kiosque reconstruit le site sur la machine qui l'héberge.
- Une version majeure est montrée à part, avec ce qui casse, et un deuxième oui. Le premier bouton ne la lance pas.
- Quand les rôles existent, le bouton est au responsable. Les autres rôles voient la version. Tant que le module 1 est éteint, le bouton est à qui peut déjà ouvrir la page.
- Pour savoir s'il existe une version plus récente, la page lit seulement le numéro public. Elle n'envoie pas le contenu du journal. Sans réseau, elle affiche la version en place.
- Sur leur serveur (ordinateur, établissement, petit VPS), le bouton remplace le programme et, pour la ligne Kiosque, reconstruit le site.
- Sur un hébergement où l'on ne peut qu'envoyer un dossier (souvent le mutualisé PHP), le bouton prépare la sauvegarde et le dossier, et indique l'endroit déjà utilisé.
- La démo fait le même écran sur sa base dans le navigateur.
- La page ne demande pas de mot de passe, et elle n'envoie pas la base vers le dépôt du socle.

## 10. Guide d'adoption — sommaire

Ce sommaire est pour qui branche le socle. Le chemin d'un client du Kiosque est le configurateur (section 8), pas ce guide.

Le guide réel s'écrit avec la première pull request de code, quand les commandes existent. Il tient en moins d'une heure. Il dira, dans cet ordre :

1. Choisir une cible (Workers, VM, PHP statique, ou PGlite pour essayer).
2. Copier `socle.config.json`, tout laisser éteint, poser les secrets dans l'environnement.
3. Lancer les migrations, lire la sauvegarde produite avant.
4. Allumer un seul module.
5. Brancher le Kiosque par la config, lancer `sync`, lancer `build`, constater que le build n'a pas appelé le serveur.
6. Exporter, effacer le serveur, reconstruire le site depuis l'export.
7. Mettre à jour : la page, ligne Socle et ligne Kiosque. Sauvegarde, puis la nouvelle version. Un journal sans serveur reçoit le Kiosque par `maj-plateforme.yml`.

## 11. Risques

| Risque | Parade |
|---|---|
| Le build du Kiosque se met à importer le socle | Test déjà là, à rejouer dans la pull request d'intégration. Revue humaine du diff d'imports. |
| Deux grammaires SQL qui divergent | Tests de comportement identiques, SQL illisible par les tests, sous-ensemble D1 comme contrainte du fichier SQLite. |
| L'audience conserve une adresse malgré le schéma | Tests : le corps en trop est rejeté, aucune colonne d'identité, journaux applicatifs absents. Contrôle humain des journaux de plateforme avant l'allumage. |
| Le poids des clics casse l'ordre approuvé du bandeau | Interrupteur éteint, puis tests sous le seuil. Le poids est une pull request séparée. |
| Un compte Cloudflare unique pour plusieurs journaux dépasse le gratuit | Un compte par projet. Documenté dans le guide. |
| La VM Oracle est reprise pour oisiveté | Le site statique reste. L'export est la copie de secours. |
| Access à 50 personnes, ou un ajout payant coché par erreur | Le guide dit de ne pas ouvrir le forfait payant. Le module refuse de démarrer si la config demande un mode qu'on n'a pas implémenté. |
| PHP réécrit mal le contrat | Il n'est pas écrit avant que `/v1` soit figé, et la même suite HTTP le juge. |
| Le README du Kiosque et le code divergent (jalon 4) | Corrigé dans la pull request d'intégration, pas ici. |
| Ce dépôt est public et nomme les dépôts privés | Les verdicts restent courts. Si la liste doit sortir, on la retire avant la fusion. |
| `node:sqlite` change d'API | Version de Node épinglée, la même que le Kiosque (22.18). Pas de module natif tiers. |
| La page de mise à jour remplace le programme | Bouton réservé au responsable. Sauvegarde nommée avant. Échec = rester sur l'ancienne version. Aucun envoi de la base. |
| L'archive ZIP reste sur le serveur qui va tomber | La notice demande de la télécharger. La restauration part du fichier que l'admin a gardé. |

## 12. Pull requests à venir

Après l'accord seulement. Une par une. CI verte avant la suivante. Pas de fusion par l'agent.

0. **Celle-ci.** Documentation. Pas de CI : il n'y a rien à exécuter. C'est voulu.
1. Squelette. Copier `VisualCode/templates/new-github-project/` (workflow Vérification, job `test`). Santé `/v1/health`, interrupteurs, interface de stockage, pilotes PGlite et `node:sqlite`, suite de conformité minimale (écrire, relire, éteindre un module). Aucune route métier. Mettre à jour la carte `VisualCode/AGENTS.md`. CI verte **avant** le premier module.
2. Pilote D1, même suite, en local (Miniflare, dépendance de développement épinglée).
3. Module 7, archive ZIP (années par défaut, session d'articles, `index.html`), migration avec sauvegarde, et la page Mise à jour (version, bouton, retour arrière). Tôt, pour qu'aucune donnée ne soit prisonnière et que le geste existe avant les modules d'écriture.
4. Module 2, éditorial, contre le contrat épinglé du Kiosque. `scheduledAt` et la file minimale pour les champs de révision déjà prévus. Admin français et anglais, impression, accès clavier.
5. Module 3, médias et crédits.
6. Module 1, les trois portes d'identité, rôles par organisation.
7. Module 6, relecture et publication programmée, complet.
8. Module 4, audience, tests d'absence d'identifiant, rétention 90 jours, résumé hebdomadaire.
9. Module 5, abonnements. Courriel par le SMTP du projet, push par des clés que le projet génère. Pas de service tiers.
10. Cible PHP, la même suite HTTP, une fois `/v1` figé par la 1.0.0.
11. **Intégration Kiosque**, interrupteur éteint, test anti-import dans `build.ts`, docs du dépôt. Le configurateur pose les questions, installe le journal, et peut restaurer une archive ZIP. La notice de sauvegarde, la page Mise à jour (socle et Kiosque) et l'archive sont dans l'admin et dans la démo.
12. **Intégration Radar, clics**, interrupteur éteint, ordre inchangé, bump du service worker si le shell change. La page Mise à jour y couvre le socle. Pas les affiches, pas les réseaux, pas la revue de presse.

La 1.0.0 est posée quand la suite passe sur PGlite, SQLite et D1, et que l'adaptateur passe `runConformanceSuite` du Kiosque épinglé. Avant ça, les versions sont 0.x et peuvent encore casser. On ne demande à personne d'épingler un 0.x en production.

Le guide d'adoption (section 10) est écrit à la pull request 1 et complété à chaque module, en français.

## 13. Ce qui est décidé

Le nom `le-socle` est gardé. Le propriétaire l'a accepté le 16 novembre 2026.

Il a aussi laissé le choix des dépôts à modifier : seulement ceux pour qui c'est utile. Le détail est en section 8.

Décisions du 17 novembre 2026, à la relecture :

- Le site reste indépendant : `packages/core` demeure dans le Kiosque. Le serveur se développe seulement ici. La rédaction ne colle pas de fichiers dans son dépôt.
- Le compteur anonyme vaut pour les articles et les autres événements qu'on allume, pas seulement le sport. Même usage qu'Umami, sans embarquer Umami. La revue de presse du Radar (deux textes, pull request 438) est comprise et laissée là où elle est.

Précision du même jour :

- La page Mise à jour est dans le Kiosque, la démo et le Radar. Chez un client elle couvre le socle et le Kiosque. Sauvegarde avant, retour si ça échoue. Une majeure attend un oui de plus. `content/`, `media/`, les jetons, la config et `OWNERS.md` restent au journal.
- L'installation client est le configurateur : les questions nécessaires, quelques étapes, puis le journal est en place. Certains hébergent le journal entier sur leur serveur. Un serveur personnel sert la collection. Les clients apportent le leur.
- L'archive du site est un ZIP à télécharger. Année en cours et année précédente cochées par défaut, années plus anciennes décochées. Une session peut être archivée en articles seulement, et restaurée en option. `index.html` dans l'archive permet de lire le contenu. Le configurateur restaure ce ZIP. Une notice reste affichée aux admins tant que ce n'est pas en place.
