let backendPromise;

function manifest() {
  const value = window.KIOSQUE_EDITORIAL;
  if (!value) throw new Error('Le manifeste éditorial local est absent.');
  return value;
}

export async function readConfiguratorBootstrap() {
  const config = manifest();
  return new Promise((resolve) => {
    const request = indexedDB.open('kiosque-configurateur', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('bootstraps');
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const tx = request.result.transaction('bootstraps', 'readonly');
      const get = tx.objectStore('bootstraps').get(config.databaseKey);
      get.onerror = () => resolve(null);
      get.onsuccess = () => resolve(get.result || null);
      tx.oncomplete = () => request.result.close();
    };
  });
}

/**
 * La base de la démo (sql.js, ≈ 0,7 Mo de wasm) ne se charge que pour /admin/ ou pour un
 * navigateur qui a déjà ouvert l’admin (ou le configurateur) : les lecteurs
 * reçoivent le HTML statique, identique au rendu initial.
 */
export function editorialFlagKey() {
  return `kiosque-editorial-actif:${manifest().databaseKey}`;
}

export function markEditorialActive() {
  try { localStorage.setItem(editorialFlagKey(), '1'); } catch (_) { /* stockage bloqué */ }
}

export async function editorialNeeded() {
  if (manifest().mode === 'socle') return false;
  if (/\/admin(\/|$)/.test(location.pathname)) return true;
  try { if (localStorage.getItem(editorialFlagKey())) return true; } catch (_) { return true; }
  return Boolean(await readConfiguratorBootstrap());
}

export async function getBackend() {
  markEditorialActive();
  if (!backendPromise) {
    backendPromise = (async () => {
      const config = manifest();
      if (config.mode === 'socle') {
        // Mode serveur : l'admin écrit dans le socle par /v1/redaction/, à la
        // même adresse que la page. sql.js n’est jamais chargé.
        const { SocleBackend } = await import('./socle-backend.js');
        const backend = new SocleBackend();
        await backend.init({ apiBase: config.apiBase ?? '' });
        return backend;
      }
      // Mode navigateur (démo) : SQLite (sql.js) dans ce navigateur, gardé dans IndexedDB.
      const { DemoBackendNavigateur } = await import('./demo-backend.js');
      const backend = new DemoBackendNavigateur();
      await backend.init({
        basePath: config.publicBasePath,
        publicationSlug: config.publicationSlug,
        databaseName: config.databaseKey,
        assetsBase: config.assetsBase,
        seedUrl: config.seedUrl,
        bootstrap: await readConfiguratorBootstrap(),
      });
      return backend;
    })();
  }
  return backendPromise;
}

export function slugify(input) {
  return String(input || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
}

export function download(name, content, type = 'application/octet-stream') {
  const href = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
