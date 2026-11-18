# Brancher le socle

Ce guide est pour qui installe **sa** copie. Un client du Kiosque passe par le configurateur, pas par ces commandes. Compter moins d'une heure. On n'allume un module que lorsqu'on en a besoin.

1. Choisir la machine. Pour essayer avec Node : ce dépôt, Node 22.18 ou plus récent, le fichier SQLite à côté. PGlite sert aux tests. D1 se vérifie en local avec Miniflare. Pour un hébergement qui reçoit un dossier : le contrôleur est `php/public/index.php`, la base est `php/data/socle.sqlite`, hors de la racine web. Sans SQLite, les pages déjà exportées restent servies. `SOCLE_UPLOAD_DIR` nomme le dossier déjà utilisé ; le bouton de mise à jour prépare la sauvegarde et ce dossier. Pas de service central, pas de compte partagé.

2. Copier `socle.config.json`. Tout laisser à `false`. Aucun secret dans ce fichier. Le mode (`SOCLE_AUTH_MODE`), le SMTP (`SOCLE_SMTP_HOST`, `SOCLE_SMTP_FROM`), les clés push (`SOCLE_VAPID_PUBLIC`, `SOCLE_VAPID_PRIVATE`), le client GitHub et `SOCLE_RESPONSABLE` se posent à côté, pas dedans.

3. Lancer la migration. Elle écrit d'abord une archive et refuse de continuer si le fichier n'est pas écrit.

   ```bash
   npm ci
   node src/cli.ts migrate --backup sauvegardes/avant.zip
   ```

   Le même geste en PHP, avec `php-cli`, `php-sqlite3` et `php-mbstring` :

   ```bash
   php php/bin/migrate.php --db php/data/socle.sqlite --config socle.config.json --backup sauvegardes/avant.zip
   ```

   Lire le ZIP. Il contient `index.html`. Ouvrir cette page montre ce qui a été gardé. Avec l'export éteint, l'archive est vide d'articles. `node src/cli.ts migrate --down --backup sauvegardes/retour.zip` retire la dernière migration. La table reste. Rien de tout cela ne part au démarrage de `npm start`.

4. Allumer un seul module, dans `socle.config.json`, puis relancer `migrate` avec une nouvelle archive. `export` fait l'archive. `editorial` fait les articles, contre le contrat du Kiosque épinglé dans `src/kiosque-pin.ts`. `media` garde les fichiers d'origine et leur crédit. `auth` ouvre une porte : lien magique, GitHub, ou Cloudflare Access. Le jeton n'est stocké qu'en hachage. Le bouton Mettre à jour est au responsable. `review` donne la file : publier, programmer, ou renvoyer. Une correction proposée ne remplace pas le texte. À l'heure, la lecture suivante publie l'article, sans réécrire le site statique. `audience` compte un nom et un contexte, à la date de Toronto, sans adresse. Le détail tient 90 jours, puis une ligne de semaine. Le poids sportif ne s'allume pas. `notify` inscrit un courriel ou un push, et le retire par un lien. Le courriel utilise `SOCLE_SMTP_HOST` et `SOCLE_SMTP_FROM`. Le push utilise `SOCLE_VAPID_PUBLIC` et `SOCLE_VAPID_PRIVATE`, des clés que le projet génère. Elles ne vont pas dans `socle.config.json`. Il n'y a pas de service d'envoi tiers.

5. Le Kiosque ne s'importe pas ici. `npm start` ne reconstruit pas le site. Le build du journal ne doit pas importer ce dépôt. Cette vérification se rejoue dans la pull request d'intégration.

6. Exporter, puis constater que l'archive se lit sans le serveur.

   ```bash
   node src/cli.ts export --out sauvegardes/journal.zip
   php php/bin/migrate.php export --db php/data/socle.sqlite --config socle.config.json --out sauvegardes/journal.zip
   ```

   Le ZIP ne contient pas de ligne de jeton, de mot de passe ou de clé. Il n'est pas publié. Le remettre plus tard se fait par le back-office, en envoyant le fichier à `/admin/sauvegarde/restaurer`. La réponse dit les années absentes. Une archive de session ne remplace que ses articles.

7. Mettre à jour : ouvrir `/admin/mise-a-jour`. La page dit la version en place. Elle ne contacte pas le réseau : sans version proposée, elle n'affiche que celle qui est installée. Quand une version est proposée, le bouton s'appelle « Mettre à jour ». Avant, la page nomme un fichier `socle-<ancienne>-vers-<nouvelle>.json`. Ce fichier ne contient pas le journal. Si l'écriture de la version échoue, l'ancienne reste. « Revenir à la sauvegarde » remet cette ancienne version. Une majeure attend une case de plus. Si `auth` est allumé, le bouton n'est montré qu'au responsable. Sans responsable, il répond 403.

8. Écrire depuis l'admin du Kiosque : construire le journal en mode socle, poser `SOCLE_STATIC` sur le dossier construit, puis ouvrir `/redaction/`. L'admin parle à `/v1/redaction/`, à la même adresse. Sans `auth`, ouvrir la page depuis la machine du socle (par exemple un tunnel SSH vers `127.0.0.1:8787`) : derrière nginx ou Cloudflare, la requête est refusée tant que `auth` est éteint. Pour une rédaction de plusieurs personnes, allumer `auth` et donner les rôles.

La notice du back-office reste tant que la sauvegarde est éteinte ou qu'aucune archive n'a été téléchargée. Elle ne bloque pas l'écriture. Le fichier doit quitter la machine.
