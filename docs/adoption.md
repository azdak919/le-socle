# Brancher le socle

Ce guide est pour qui installe **sa** copie. Un client du Kiosque passe par le configurateur, pas par ces commandes. Compter moins d'une heure. On n'allume un module que lorsqu'on en a besoin. Les modules 4, 5 et 6 ne font encore rien.

1. Choisir la machine. Pour essayer : ce dépôt, Node 22.18 ou plus récent, le fichier SQLite à côté. PGlite sert aux tests. D1 se vérifie en local avec Miniflare. La cible PHP n'existe pas encore : en attendant, le site statique du Kiosque suffit. Pas de service central, pas de compte partagé.

2. Copier `socle.config.json`. Tout laisser à `false`. Aucun secret dans ce fichier. Le mode (`SOCLE_AUTH_MODE`), le SMTP (`SOCLE_SMTP_HOST`, `SOCLE_SMTP_FROM`), le client GitHub et `SOCLE_RESPONSABLE` se posent à côté, pas dedans.

3. Lancer la migration. Elle écrit d'abord une archive et refuse de continuer si le fichier n'est pas écrit.

   ```bash
   npm ci
   node src/cli.ts migrate --backup sauvegardes/avant.zip
   ```

   Lire le ZIP. Il contient `index.html`. Ouvrir cette page montre ce qui a été gardé. Avec l'export éteint, l'archive est vide d'articles. `node src/cli.ts migrate --down --backup sauvegardes/retour.zip` retire la dernière migration. La table reste. Rien de tout cela ne part au démarrage de `npm start`.

4. Allumer un seul module, dans `socle.config.json`, puis relancer `migrate` avec une nouvelle archive. `export` fait l'archive. `editorial` fait les articles, contre le contrat du Kiosque épinglé dans `src/kiosque-pin.ts`. `media` garde les fichiers d'origine et leur crédit. `auth` ouvre une porte : lien magique, GitHub, ou Cloudflare Access. Le jeton n'est stocké qu'en hachage. Le bouton Mettre à jour est au responsable. Les autres modules ne font encore rien.

5. Le Kiosque ne s'importe pas ici. `npm start` ne reconstruit pas le site. Le build du journal ne doit pas importer ce dépôt. Cette vérification se rejoue dans la pull request d'intégration.

6. Exporter, puis constater que l'archive se lit sans le serveur.

   ```bash
   node src/cli.ts export --out sauvegardes/journal.zip
   ```

   Le ZIP ne contient pas de ligne de jeton, de mot de passe ou de clé. Il n'est pas publié. Le remettre plus tard se fait par le back-office, en envoyant le fichier à `/admin/sauvegarde/restaurer`. La réponse dit les années absentes. Une archive de session ne remplace que ses articles.

7. Mettre à jour : ouvrir `/admin/mise-a-jour`. La page dit la version en place. Elle ne contacte pas le réseau : sans version proposée, elle n'affiche que celle qui est installée. Quand une version est proposée, le bouton s'appelle « Mettre à jour ». Avant, la page nomme un fichier `socle-<ancienne>-vers-<nouvelle>.json`. Ce fichier ne contient pas le journal. Si l'écriture de la version échoue, l'ancienne reste. « Revenir à la sauvegarde » remet cette ancienne version. Une majeure attend une case de plus. Si `auth` est allumé, le bouton n'est montré qu'au responsable. Sans responsable, il répond 403.

La notice du back-office reste tant que la sauvegarde est éteinte ou qu'aucune archive n'a été téléchargée. Elle ne bloque pas l'écriture. Le fichier doit quitter la machine.
