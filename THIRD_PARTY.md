# Code tiers

Le socle est sous GPL-2.0-only. Le code repris ci-dessous l'est sous une licence compatible.

| Code | Licence | Usage | Fichiers |
|---|---|---|---|
| Admin de rédaction de [LE KIOSQUE](https://github.com/azdak919/le-kiosque) | GPL-2.0-only, même auteur | Interface d'administration, déplacée ici pour se développer à un seul endroit | `admin/` |
| [marked](https://github.com/markedjs/marked) 18.2.0 © MarkedJS, Christopher Jeffrey | MIT | Aperçu Markdown dans l'éditeur | `admin/assets/marked.esm.js` (copie telle quelle, en-tête de licence gardé) |
| [Basecoat](https://github.com/hunvreus/basecoat) (`basecoat-css` 1.1.0) © hunvreus | MIT | Jetons et composants (bouton, badge, carte, alerte, kbd) | `admin/ui/vendor/basecoat-subset.css` (extrait généré), `admin/assets/admin.css` |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) 4.3.5 © Tailwind Labs | MIT | Compilation de la feuille de l'admin (outil de développement) | `admin/assets/admin.css` |

Les textes de licence MIT de Basecoat et Tailwind CSS sont fournis avec leurs paquets npm (`node_modules/basecoat-css/LICENSE.md`, `node_modules/tailwindcss/LICENSE`).
