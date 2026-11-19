# Code tiers

Le socle est sous GPL-2.0-only. Le code repris ci-dessous l'est sous une licence compatible.

| Code | Licence | Usage | Fichiers |
|---|---|---|---|
| Admin de rédaction de [LE KIOSQUE](https://github.com/azdak919/le-kiosque) | GPL-2.0-only, même auteur | Interface d'administration, déplacée ici pour se développer à un seul endroit | `admin/` |
| [marked](https://github.com/markedjs/marked) 18.2.0 © MarkedJS, Christopher Jeffrey | MIT | Aperçu Markdown dans l'éditeur | `admin/assets/marked.esm.js` (copie telle quelle, en-tête de licence gardé) |
| [FilePond](https://github.com/pqina/filepond) 4.32.14 © Rik Schennink / PQINA, et greffons officiels [image-preview](https://github.com/pqina/filepond-plugin-image-preview) 4.6.12, [image-resize](https://github.com/pqina/filepond-plugin-image-resize) 2.0.10, [image-transform](https://github.com/pqina/filepond-plugin-image-transform) 3.8.8, [image-exif-orientation](https://github.com/pqina/filepond-plugin-image-exif-orientation) 1.0.11, [file-validate-type](https://github.com/pqina/filepond-plugin-file-validate-type) 1.2.9, [file-validate-size](https://github.com/pqina/filepond-plugin-file-validate-size) 2.2.8, locale française `fr-fr` | MIT | Téléversement par glisser-déposer dans l'espace de rédaction : plusieurs photos, aperçu, réduction et réencodage dans le navigateur | `admin/assets/filepond.esm.min.js`, `admin/assets/filepond.min.css`, `admin/assets/filepond-locale-fr-fr.js`, `admin/assets/filepond-plugin-*.js` / `.css`, `admin/assets/filepond-banque.js` (adaptateur maison vers `/v1/redaction/photo`) |
| [Basecoat](https://github.com/hunvreus/basecoat) (`basecoat-css` 1.1.0) © hunvreus | MIT | Jetons et composants (bouton, badge, carte, alerte, kbd) | `admin/ui/vendor/basecoat-subset.css` (extrait généré), `admin/assets/admin.css` |
| [sql.js](https://github.com/sql-js/sql.js) 1.16.0 © 2017 sql.js authors (SQLite : domaine public) | MIT | Base SQLite de la démo en mode navigateur, gardée dans IndexedDB | `admin/assets/sql-wasm.js`, `admin/assets/sql-wasm.wasm` (copies telles quelles de `dist/sql-wasm-browser.*`) |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) 4.3.5 © Tailwind Labs | MIT | Compilation de la feuille de l'admin (outil de développement) | `admin/assets/admin.css` |

## Images

| Image | Licence | Usage | Fichiers |
|---|---|---|---|
| Logo du Socle : emoji « brique » (U+1F9F1) de [Twemoji](https://github.com/jdecked/twemoji) (dépôt `jdecked/twemoji`, commit `b6b55fef1e`), © Twitter, Inc. et autres contributeurs | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fr) | Logo et icône d'onglet du Socle : barre de l'espace de rédaction tant qu'aucun journal n'est configuré, pages Sauvegarde et Mise à jour, page de présentation, README. Jamais sur le site public d'un journal. | `site/assets/logo/`, `admin/marque.js`, `php/src/lib.php` (copie en ligne) |

Modification : le dessin est posé, sans retouche, sur le carreau sombre de [LE-RADAR](https://le-radar.ca) (même auteur que le Socle), avec un filet clair en mode sombre ; il est réduit en 16, 32, 180 et 512 px. La licence CC BY 4.0 est compatible avec la GPL ; elle demande cette mention de l'auteur, de la source et de la licence.

Les textes de licence MIT de FilePond et de ses greffons sont dans l'en-tête de chaque fichier copié (`Licensed under MIT`). Dans `admin/assets/filepond.esm.min.js`, le séparateur décimal de la taille affichée, fixé à un point dans FilePond 4.32, est remplacé par une virgule, pour respecter `labelDecimalSeparator` (« 1,1 Mo »). Les textes de licence MIT de Basecoat, sql.js et Tailwind CSS sont fournis avec leurs paquets npm (`node_modules/basecoat-css/LICENSE.md`, `node_modules/sql.js/LICENSE`, `node_modules/tailwindcss/LICENSE`). Les fichiers de sql.js copiés dans `admin/assets/` n'ont pas d'en-tête : sa licence est recopiée ci-dessous.

## Licence de sql.js

```
MIT license
===========

Copyright (c) 2017 sql.js authors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.



# Some portions of the Makefile taken from:
Copyright 2017 Ryusei Yamaguchi

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
