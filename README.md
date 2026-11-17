# le-socle

Outil de back-end libre, sous GPL-2.0-only, que **chaque projet installe et fait tourner chez lui**. Ce n'est pas un service central. Un journal sous LE KIOSQUE ne dépend jamais du serveur de LE-RADAR, ni d'aucun autre.

Le plan est **[`docs/plan.md`](docs/plan.md)**. Cette branche n'a que le squelette : `GET /v1/health`, les interrupteurs, et deux pilotes de stockage (`node:sqlite`, PGlite). Aucune route métier. Les sept modules restent éteints.

```bash
npm ci
npm test
npm start
```

`npm start` écoute `127.0.0.1:8787` et lit `socle.config.json`. La seule réponse utile est `GET /v1/health`.

Le site statique doit rester lisible quand ce serveur est arrêté. Seule l'écriture s'interrompt.
