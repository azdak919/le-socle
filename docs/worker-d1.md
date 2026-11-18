# Le socle sur Cloudflare (Worker et D1)

Troisième façon d'installer le socle, à côté de Node et de PHP. Le
programme tourne dans un Worker, la base est une base D1. Pas de serveur à
garder allumé.

## Ce que le Worker fait

- `GET /v1/health`, comme ailleurs.
- `/redaction/` : la page de rédaction et ses fichiers, pris dans `admin/`.
  La démo en mode navigateur (sql.js) n'est jamais servie.
- `/v1/redaction/`, `/v1/editorial`, `/v1/auth` : mêmes règles que Node et
  PHP, sur la même suite de tests.
- Ce qui écrit sur un disque reste à Node et PHP : la sauvegarde du
  programme et le bouton de mise à jour. Sur Cloudflare, on met à jour avec
  Wrangler.

## La porte d'entrée

Derrière Cloudflare, aucune requête n'est « de la machine du socle ». La
rédaction demande donc le module `auth`. La porte prévue est Cloudflare
Access : Access vérifie la personne, le Worker vérifie la signature du
jeton (clés de l'équipe, audience, émetteur, échéance), puis ouvre une
session. Le responsable est nommé par `SOCLE_RESPONSABLE` ; il invite
ensuite les autres membres.

## Installer, pas à pas

1. Copier `wrangler.toml.exemple` en `wrangler.toml` (ce fichier n'est pas
   suivi par Git) et remplir les valeurs entre `< >`.
2. Créer la base : `wrangler d1 create socle-journal`, puis recopier son
   identifiant dans `wrangler.toml`.
3. Écrire les tables des modules allumés :
   `node src/cli.ts d1-sql --config socle.config.json > migration.sql`,
   puis `wrangler d1 execute DB --remote --file migration.sql`. Le fichier
   se rejoue sans effet. Sur une base qui sert déjà, d'abord la sauvegarde :
   `wrangler d1 export DB --remote --output sauvegarde.sql`.
4. Dans Cloudflare Zero Trust, créer une application Access sur
   `/redaction/` et `/v1/` (sauf `/v1/health`), puis recopier l'équipe et
   l'étiquette AUD dans `wrangler.toml`.
5. `wrangler deploy`.

Pour essayer sans compte : `wrangler d1 execute DB --local --file
migration.sql`, puis `wrangler dev`. Les tests (`test/worker.test.ts`) font
le même chemin dans Miniflare, avec une fausse équipe Access.

## Avec un site sur GitHub Pages

Le site du Kiosque peut rester sur GitHub Pages ; le Worker garde la base et
l'admin. La rédaction s'ouvre à l'adresse du Worker (`/redaction/`), sur la
même origine que son API : pas de partage d'origine à régler.
