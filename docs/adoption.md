# Brancher le socle

Ce guide est pour qui installe **sa** copie. Un client du Kiosque passe par le configurateur, pas par ces commandes. Compter moins d'une heure. On n'allume un module que lorsqu'on en a besoin.

1. Choisir la machine. Pour essayer et pour les tests, avec Node : ce dépôt, Node 22.18 ou plus récent, le fichier SQLite à côté. Pour un hébergement qui reçoit un dossier : le contrôleur est `php/public/index.php`, la base est `php/data/socle.sqlite`, hors de la racine web. Sans SQLite, les pages déjà exportées restent servies. `SOCLE_UPLOAD_DIR` nomme le dossier déjà utilisé ; le bouton de mise à jour prépare la sauvegarde et ce dossier. Pas de service central, pas de compte partagé.

2. Copier `socle.config.json`. Tout laisser à `false`. Aucun secret dans ce fichier. Le mode (`SOCLE_AUTH_MODE`), le SMTP (`SOCLE_SMTP_HOST`, `SOCLE_SMTP_FROM`), les clés push (`SOCLE_VAPID_PUBLIC`, `SOCLE_VAPID_PRIVATE`), le client GitHub et `SOCLE_ADMINISTRATEUR` (ancien nom `SOCLE_RESPONSABLE` encore lu) se posent à côté, pas dedans.

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

4. Allumer un seul module, dans `socle.config.json`, puis relancer `migrate` avec une nouvelle archive. `export` fait l'archive. `editorial` fait les articles, contre le contrat du Kiosque épinglé dans `src/kiosque-pin.ts`. `media` garde les fichiers d'origine et leur crédit. `auth` ouvre une porte : mot de passe (le cas habituel d’un journal), lien magique, GitHub, ou Cloudflare Access. Le jeton n'est stocké qu'en hachage. Le bouton Mettre à jour est à l’administrateur. `review` donne la file : publier, programmer, ou renvoyer. Une correction proposée ne remplace pas le texte. À l'heure, la lecture suivante publie l'article, sans réécrire le site statique. `audience` compte un nom et un contexte, à la date de Toronto, sans adresse. Le détail tient 90 jours, puis une ligne de semaine. Le poids sportif ne s'allume pas. `notify` inscrit un courriel ou un push, et le retire par un lien. Le courriel utilise `SOCLE_SMTP_HOST` et `SOCLE_SMTP_FROM`. Le push utilise `SOCLE_VAPID_PUBLIC` et `SOCLE_VAPID_PRIVATE`, des clés que le projet génère. Elles ne vont pas dans `socle.config.json`. Il n'y a pas de service d'envoi tiers.

5. Le Kiosque ne s'importe pas ici. `npm start` ne reconstruit pas le site. Le build du journal ne doit pas importer ce dépôt. Cette vérification se rejoue dans la pull request d'intégration.

6. Exporter, puis constater que l'archive se lit sans le serveur.

   ```bash
   node src/cli.ts export --out sauvegardes/journal.zip
   php php/bin/migrate.php export --db php/data/socle.sqlite --config socle.config.json --out sauvegardes/journal.zip
   ```

   Le ZIP ne contient pas de ligne de jeton, de mot de passe ou de clé. Il n'est pas publié. Le remettre plus tard se fait par le back-office, en envoyant le fichier à `/admin/sauvegarde/restaurer`. La réponse dit les années absentes. Une archive de session ne remplace que ses articles.

7. Mettre à jour : ouvrir `/admin/mise-a-jour`. La page dit la version en place. Elle ne contacte pas le réseau : sans version proposée, elle n'affiche que celle qui est installée. Quand une version est proposée, le bouton s'appelle « Mettre à jour ». Avant, la page nomme un fichier `socle-<ancienne>-vers-<nouvelle>.json`. Ce fichier ne contient pas le journal. Si l'écriture de la version échoue, l'ancienne reste. « Revenir à la sauvegarde » remet cette ancienne version. Une majeure attend une case de plus. Si `auth` est allumé, le bouton n'est montré qu'à l’administrateur. Sans administrateur, il répond 403.

8. Écrire : allumer `editorial` (et `media` pour la banque de photos), puis ouvrir `/redaction/`. Dans « Photos », « Ajouter une photo à la banque » garde vos photos avec leur crédit (obligatoire) ; « Choisir une photo » les réutilise dans un article ou le mât. Le socle sert l'admin lui-même ; une mise à jour du socle apporte la nouvelle admin. `SOCLE_STATIC` peut en plus servir le site construit à la même adresse. L'admin parle à `/v1/redaction/`, à la même adresse. Sans `auth`, ouvrir la page depuis la machine du socle (par exemple un tunnel SSH vers `127.0.0.1:8787`) : derrière nginx ou Cloudflare, la requête est refusée tant que `auth` est éteint. Pour une rédaction de plusieurs personnes, allumer `auth` et donner les rôles.

La notice du back-office reste tant que la sauvegarde est éteinte ou qu'aucune archive n'a été téléchargée. Elle ne bloque pas l'écriture. Le fichier doit quitter la machine.

9. Mot de passe, profil et courriels. En mode `motdepasse`, la page `/redaction/` présente une carte de connexion au nom du journal. « Mot de passe oublié » envoie un lien unique, valable une heure, seulement si l’envoi de courriel est réglé : soit dans « Configuration » (préréglages : courriel de l’hébergeur, Gmail, Outlook ou serveur personnalisé), soit par les variables `SOCLE_SMTP_*`. La réponse à l’écran est la même, que le compte existe ou non. Sans SMTP, la page demande d’écrire à l’administrateur. Une fois connecté, l’onglet « Mon profil » permet de modifier le nom, le nom d’affichage, le mot de passe (l’actuel est exigé) et le courriel. L’état de l’adresse (« Confirmée », « Non confirmée » ou « En attente de confirmation ») vient du serveur ; un compte déjà créé n’est jamais présenté comme confirmé s’il ne l’a pas été. Un lien unique, valable une heure, confirme une nouvelle adresse ou l’adresse actuelle. L’adresse publique `SOCLE_PUBLIC_ORIGIN` doit être celle du journal en HTTPS : c’est elle qui est écrite dans les courriels. La liste de contrôle pour une mise en ligne réelle est dans [`docs/deploiement-production.md`](deploiement-production.md).
