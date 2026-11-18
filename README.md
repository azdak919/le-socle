# le-socle

Outil de back-end libre, sous GPL-2.0-only, que **chaque projet installe et fait tourner chez lui**. Ce n'est pas un service central. Un journal sous LE KIOSQUE ne dépend jamais du serveur de LE-RADAR, ni d'aucun autre.

Le plan est **[`docs/plan.md`](docs/plan.md)**. Le guide court est **[`docs/adoption.md`](docs/adoption.md)**.

Le serveur expose `GET /v1/health`. Les interrupteurs sont éteints. Sous `/v1/`, aucune autre route tant qu'un module n'est pas allumé. La version 1.0.0 fige ce contrat. Le stockage et l'adaptateur du Kiosque passent la même suite sur `node:sqlite`, PGlite et D1 (Miniflare, en local).

PHP sert le même contrat, sans démon. Le contrôleur est `php/public/index.php`. La base est `php/data/socle.sqlite`, hors de la racine web. Sans SQLite, les pages déjà exportées restent servies. Sur un hébergement qui reçoit un dossier, `SOCLE_UPLOAD_DIR` nomme l'endroit déjà utilisé.

Le back-office sert la sauvegarde ZIP du journal et la page Mise à jour du programme. Rien ne migre au démarrage. `socle migrate` écrit d'abord une archive, du même format que l'export, et s'arrête si ce fichier ne s'écrit pas.

Le module éditorial, éteint par défaut, parle le contrat de LE KIOSQUE épinglé dans `src/kiosque-pin.ts`. L'adaptateur se teste hors ligne. `GET /v1/editorial/snapshot` n'existe que si le module est allumé.

L'admin du Kiosque écrit par `/v1/redaction/`, qui n'existe que si `editorial` est allumé. La banque de photos (avec crédit obligatoire) s'y ajoute si `media` l'est. Sans `auth`, cette API ne répond qu'à la machine du socle. `SOCLE_STATIC` sert le site construit et l'admin sous `/redaction/`, à la même adresse que l'API.

Le module d'identité, éteint par défaut, a trois portes : un lien magique, GitHub, ou Cloudflare Access. Il ne garde pas de mot de passe. Le jeton de session est haché. `POST /v1/auth/lien` n'existe que si le module est allumé. Tant qu'il est éteint, le bouton de mise à jour reste à qui ouvre la page. Allumé, le bouton est au responsable.

Le module de relecture, éteint par défaut, décide : publier, programmer, ou renvoyer. La correction proposée reste à côté du texte. Quand l'heure est passée, la lecture suivante publie l'article. Le site déjà construit ne change pas tout seul.

Le module d'audience, éteint par défaut, compte un nom et un contexte. La date civile est posée à Toronto. `POST /v1/audience/event` n'existe que si le module est allumé. Les totaux sont des sommes. Le détail tient 90 jours, puis une ligne par semaine. Aucune adresse, aucun identifiant de personne. Le poids des cartes sportives ne s'allume pas avec ce compteur.

Le module d'abonnements, éteint par défaut, inscrit un courriel ou un navigateur, et le retire par un lien. `POST /v1/notify/abonnement` n'existe que si le module est allumé. Le courriel part par le SMTP du projet. Le push est signé par des clés que le projet génère. Aucun service d'envoi tiers. L'adresse reste dans l'archive du journal. Elle n'est pas dans les pages HTML. La clé privée n'est pas dans l'archive.

```bash
npm ci
npm test
npm start
node src/cli.ts migrate --backup sauvegardes/avant.zip
node src/cli.ts export --out sauvegardes/journal.zip
```

`npm start` écoute `127.0.0.1:8787`, lit `socle.config.json`, et ouvre `socle.sqlite` sans le migrer. `GET /v1/health` reste la seule route sous `/v1/`. Le back-office est `/admin`.

Le site statique doit rester lisible quand ce serveur est arrêté. Seule l'écriture s'interrompt.
