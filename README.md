# le-socle

Outil de back-end libre, sous GPL-2.0-only, que **chaque projet installe et fait tourner chez lui**. Ce n'est pas un service central. Un journal sous LE KIOSQUE ne dépend jamais du serveur de LE-RADAR, ni d'aucun autre.

Le plan est **[`docs/plan.md`](docs/plan.md)**. Le guide court est **[`docs/adoption.md`](docs/adoption.md)**.

Le serveur expose `GET /v1/health`. Les interrupteurs sont éteints. Sous `/v1/`, aucune autre route. Le stockage passe la même suite sur `node:sqlite`, PGlite et D1 (Miniflare, en local).

Le back-office sert la sauvegarde ZIP du journal et la page Mise à jour du programme. Rien ne migre au démarrage. `socle migrate` écrit d'abord une archive, du même format que l'export, et s'arrête si ce fichier ne s'écrit pas.

```bash
npm ci
npm test
npm start
node src/cli.ts migrate --backup sauvegardes/avant.zip
node src/cli.ts export --out sauvegardes/journal.zip
```

`npm start` écoute `127.0.0.1:8787`, lit `socle.config.json`, et ouvre `socle.sqlite` sans le migrer. `GET /v1/health` reste la seule route sous `/v1/`. Le back-office est `/admin`.

Le site statique doit rester lisible quand ce serveur est arrêté. Seule l'écriture s'interrompt.
