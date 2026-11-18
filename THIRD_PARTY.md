# Code tiers

Le socle est sous GPL-2.0-only. Le code repris ci-dessous l'est sous une licence compatible.

| Code | Licence | Usage | Fichiers |
|---|---|---|---|
| Admin de rédaction de [LE KIOSQUE](https://github.com/azdak919/le-kiosque) | GPL-2.0-only, même auteur | Interface d'administration, déplacée ici pour se développer à un seul endroit | `admin/` |
| [marked](https://github.com/markedjs/marked) 18.2.0 © MarkedJS, Christopher Jeffrey | MIT | Aperçu Markdown dans l'éditeur | `admin/assets/marked.esm.js` (copie telle quelle, en-tête de licence gardé) |
| [Basecoat](https://github.com/hunvreus/basecoat) (`basecoat-css` 1.1.0) © hunvreus | MIT | Jetons et composants (bouton, badge, carte, alerte, kbd) | `admin/ui/vendor/basecoat-subset.css` (extrait généré), `admin/assets/admin.css` |
| [sql.js](https://github.com/sql-js/sql.js) 1.16.0 © 2017 sql.js authors (SQLite : domaine public) | MIT | Base SQLite de la démo en mode navigateur, gardée dans IndexedDB | `admin/assets/sql-wasm.js`, `admin/assets/sql-wasm.wasm` (copies telles quelles de `dist/sql-wasm-browser.*`) |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) 4.3.5 © Tailwind Labs | MIT | Compilation de la feuille de l'admin (outil de développement) | `admin/assets/admin.css` |

Les textes de licence MIT de Basecoat, sql.js et Tailwind CSS sont fournis avec leurs paquets npm (`node_modules/basecoat-css/LICENSE.md`, `node_modules/sql.js/LICENSE`, `node_modules/tailwindcss/LICENSE`). Les fichiers de sql.js copiés dans `admin/assets/` n'ont pas d'en-tête : sa licence est recopiée ci-dessous.

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
