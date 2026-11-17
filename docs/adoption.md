# Brancher le socle

Ce guide est pour qui installe **sa** copie. Un client du Kiosque passe par le configurateur, pas par ces commandes. Compter moins d'une heure. Les modules 1 à 6 ne sont pas encore là : on ne les allume pas.

1. Choisir la machine. Pour essayer : ce dépôt, Node 22.18 ou plus récent, le fichier SQLite à côté. PGlite sert aux tests. D1 se vérifie en local avec Miniflare. La cible PHP n'existe pas encore : en attendant, le site statique du Kiosque suffit. Pas de service central, pas de compte partagé.

2. Copier `socle.config.json`. Tout laisser à `false`. Aucun secret dans ce fichier. Il n'y a pas encore de secret à poser.

3. Lancer la migration. Elle écrit d'abord une archive et refuse de continuer si le fichier n'est pas écrit.

   ```bash
   npm ci
   node src/cli.ts migrate --backup sauvegardes/avant.zip
   ```

   Lire le ZIP. Il contient `index.html`. Ouvrir cette page montre ce qui a été gardé. Avec l'export éteint, l'archive est vide d'articles. `node src/cli.ts migrate --down --backup sauvegardes/retour.zip` retire la dernière migration. La table reste. Rien de tout cela ne part au démarrage de `npm start`.

4. Allumer un seul module, dans `socle.config.json`, puis relancer `migrate` avec une nouvelle archive. Aujourd'hui le seul module qui fait quelque chose est `export`.

5. Le Kiosque ne s'importe pas ici. `npm start` ne reconstruit pas le site. Le build du journal ne doit pas importer ce dépôt. Cette vérification se rejoue dans la pull request d'intégration.

6. Exporter, puis constater que l'archive se lit sans le serveur.

   ```bash
   node src/cli.ts export --out sauvegardes/journal.zip
   ```

   Le ZIP ne contient pas de ligne de jeton, de mot de passe ou de clé. Il n'est pas publié. Le remettre plus tard se fait par le back-office, en envoyant le fichier à `/admin/sauvegarde/restaurer`. La réponse dit les années absentes. Une archive de session ne remplace que ses articles.

7. Mettre à jour : ouvrir `/admin/mise-a-jour`. La page dit la version en place. Elle ne contacte pas le réseau : sans version proposée, elle n'affiche que celle qui est installée. Quand une version est proposée, le bouton s'appelle « Mettre à jour ». Avant, la page nomme un fichier `socle-<ancienne>-vers-<nouvelle>.json`. Ce fichier ne contient pas le journal. Si l'écriture de la version échoue, l'ancienne reste. « Revenir à la sauvegarde » remet cette ancienne version. Une majeure attend une case de plus.

La notice du back-office reste tant que la sauvegarde est éteinte ou qu'aucune archive n'a été téléchargée. Elle ne bloque pas l'écriture. Le fichier doit quitter la machine.
