/**
 * Page de l'admin de rédaction, écrite à un seul endroit : le socle.
 *
 * Deux modes, une seule interface :
 * - `navigateur` : la démo (Le Quorum). Les données restent dans ce
 *   navigateur (SQLite par sql.js, gardé dans IndexedDB). Le Kiosque construit
 *   cette page dans son site.
 * - `serveur` : un vrai journal. Le socle sert cette page sous `/redaction/`
 *   et l'admin écrit par `/v1/redaction/`, à la même adresse.
 *
 * JavaScript simple (pas de TypeScript) : Node ne retire pas les types d'un
 * fichier placé dans node_modules, et le Kiosque importe ce fichier depuis
 * sa dépendance.
 */
import { createRequire } from 'node:module';

import { SOCLE_ICON_URI, socleFavicons } from './marque.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);

/** Même numéro que package.json et src/version.ts, lu ici pour la coquille HTML. */
export const SOCLE_VERSION = createRequire(import.meta.url)('../package.json').version;
export const SOCLE_SITE = 'https://azdak919.github.io/le-socle/';

/** En-tête de la barre : le logo et le nom du Socle tant que le journal n’est pas configuré. */
export function adminBrand(className = 'admin-brand') {
  const hidden = className === 'admin-brand' ? '' : ' aria-hidden="true"';
  return `<div class="${className}" data-state="socle"${hidden}><img class="admin-brand-logo" src="${SOCLE_ICON_URI}" alt="" width="32" height="32"><span><strong>Le Socle</strong><small>Espace de rédaction</small></span></div>`;
}

export { socleFavicons };

/** Ligne discrète en bas de la barre, avec la version et le lien vers la page du Socle. */
export function adminSidebarFoot(version = SOCLE_VERSION) {
  const ver = version ? ` ${esc(version)}` : '';
  return `<p class="admin-sidebar-foot">Propulsé par <a href="${SOCLE_SITE}">Le Socle</a>${ver}</p>`;
}

/** Fichiers de l'admin, tous sous `admin/assets/`. */
export const ADMIN_ASSETS = Object.freeze([
  'admin.js', 'admin.css', 'runtime.js', 'util.js', 'export.js',
  'marked.esm.js', 'socle-backend.js', 'public-backend.js', 'demo-backend.js', 'sqljs-db.js', 'sql-wasm.js', 'sql-wasm.wasm',
  'filepond-banque.js', 'filepond.esm.min.js', 'filepond.min.css', 'filepond-locale-fr-fr.js',
  'filepond-plugin-image-preview.esm.min.js', 'filepond-plugin-image-preview.min.css',
  'filepond-plugin-image-resize.esm.min.js', 'filepond-plugin-image-transform.esm.min.js',
  'filepond-plugin-image-exif-orientation.esm.min.js',
  'filepond-plugin-file-validate-type.esm.min.js',
  'filepond-plugin-file-validate-size.esm.min.js',
  // Restauration en deux temps des pages /admin/sauvegarde (insérée par PHP et Node).
  'restauration.js',
]);

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  articles: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5M8 13h8M8 17h5"/>',
  media: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  authors: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  taxonomies: '<path d="M12 2H2v10l9.3 9.3a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7" cy="7" r="1.5"/>',
  settings: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  exports: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  update: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
};

const VIEWS = [
  ['dashboard', 'Tableau de bord'],
  ['articles', 'Articles'],
  ['media', 'Photos'],
  ['authors', 'Équipe'],
  ['taxonomies', 'Sections et catégories'],
  ['settings', 'Configuration'],
  ['exports', 'Exporter'],
];

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/**
 * Une seule barre de navigation pour l'admin et pour la page Mise à jour.
 * Chaque entrée est un vrai lien : sans JavaScript ou depuis une autre page,
 * il mène au bon écran ; dans l'admin, admin.js l'intercepte.
 */
export function adminNav(adminBasePath, active, updateHref = `${adminBasePath}/mise-a-jour/`, saveHref = '') {
  const items = VIEWS.map(([view, label]) => `<a href="${adminBasePath}/#${view}" data-view="${view}"${view === active ? ' aria-current="page"' : ''}>${icon(view)}${esc(label)}</a>`);
  if (saveHref) items.push(`<a href="${esc(saveHref)}" data-nav="save"${active === 'save' ? ' aria-current="page"' : ''}>${icon('exports')}Sauvegarde</a>`);
  items.push(`<a href="${esc(updateHref)}" data-nav="update"${active === 'update' ? ' aria-current="page"' : ''}>${icon('update')}Mise à jour</a>`);
  return `<nav class="admin-nav" aria-label="Administration">${items.join('')}</nav>`;
}

/**
 * Coquille commune (barre, en-tête, note). Options : lang, title,
 * publicationName, publicBasePath, adminBasePath, cssHref, active, note,
 * main, scripts, updateHref.
 */
export function adminShell(options) {
  return `<!doctype html>
<html lang="${esc(options.lang)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(options.title)} — ${esc(options.publicationName)}</title>${socleFavicons()}<link rel="stylesheet" href="${options.cssHref}"></head>
<body>
<a class="admin-skip" href="#admin-main">Aller au contenu</a>
<div class="admin-app">
  <aside class="admin-sidebar">
    ${adminBrand()}
    ${adminNav(options.adminBasePath, options.active, options.updateHref, options.saveHref)}
    ${adminSidebarFoot(options.version ?? SOCLE_VERSION)}
  </aside>
  <div class="admin-column">
    <header class="admin-header">${adminBrand('admin-header-brand')}<h1 id="admin-page-title">${esc(options.heading ?? options.title)}</h1><a class="btn" data-variant="outline" data-size="sm" href="${options.publicBasePath}/">Voir le journal ↗</a></header>
    <div class="local-warning" role="note">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'}<span>${options.note}</span></div>
    <main id="admin-main" tabindex="-1">${options.main}</main>
  </div>
</div><div id="toast" role="status" aria-live="polite"></div>

${options.scripts ?? ''}
</body></html>`;
}

/**
 * La page de l'admin. Options :
 * - mode : 'navigateur' (démo, défaut) ou 'serveur' (socle) ;
 * - publicationName, lang, publicBasePath, adminBasePath, assetsBase ;
 * - navigateur seulement : seedUrl, publicationSlug, databaseKey ;
 * - serveur seulement : apiBase (adresse du socle, vide = même adresse) ;
 * - updateHref : la page Mise à jour.
 */
export function adminPage(options) {
  const serveur = options.mode === 'serveur';
  const manifest = JSON.stringify(serveur ? {
    mode: 'socle',
    publicBasePath: options.publicBasePath,
    adminBasePath: options.adminBasePath,
    assetsBase: options.assetsBase,
    apiBase: options.apiBase ?? '',
    databaseKey: options.databaseKey ?? 'socle',
    version: options.version ?? SOCLE_VERSION,
  } : {
    mode: 'demo-local',
    publicBasePath: options.publicBasePath,
    adminBasePath: options.adminBasePath,
    assetsBase: options.assetsBase,
    seedUrl: options.seedUrl,
    publicationSlug: options.publicationSlug,
    databaseKey: options.databaseKey,
    version: options.version ?? SOCLE_VERSION,
  }).replace(/</g, '\\u003c');
  return adminShell({
    lang: options.lang,
    title: 'Espace de rédaction',
    // Le titre de l’écran s’inscrit dès que les données sont là (admin.js).
    heading: '',
    publicationName: options.publicationName,
    publicBasePath: options.publicBasePath,
    adminBasePath: options.adminBasePath,
    cssHref: `${options.assetsBase}/admin.css`,
    active: 'dashboard',
    updateHref: options.updateHref,
    saveHref: options.saveHref,
    note: serveur
      ? 'Rédaction du journal — chaque enregistrement est écrit sur le serveur du journal.'
      : 'Mode démonstration local — données conservées dans ce navigateur.',
    main: '<div class="loading"><h2>Ouverture du journal…</h2><p>Un instant, on prépare votre espace de rédaction.</p></div>',
    scripts: `<script>window.KIOSQUE_EDITORIAL=${manifest};</script><script type="module" src="${options.assetsBase}/admin.js"></script>`,
  });
}

/** La page du mode serveur, servie par le socle sous `/redaction/` (même adresse que l'API). */
export function serverPage() {
  return adminPage({
    mode: 'serveur',
    publicationName: 'votre journal',
    lang: 'fr-CA',
    publicBasePath: '',
    adminBasePath: '/redaction',
    assetsBase: '/redaction/assets',
    apiBase: '',
    updateHref: '/admin/mise-a-jour',
    saveHref: '/admin/sauvegarde',
  });
}
