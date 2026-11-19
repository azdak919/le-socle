/**
 * Même interface que DemoBackendNavigateur, mais chaque geste part au socle par
 * `/v1/redaction/` (même adresse que la page : le cookie de session suit,
 * sans CORS). Rien n'est gardé dans le navigateur, sauf la dernière lecture.
 */
const CAPABILITIES = Object.freeze({
  writable: true,
  preview: true,
  media: true,
  persistent: 'server',
  authentication: true,
  collaboration: true,
  remoteBackup: true,
  remotePublishing: false,
});

const KINDS = new Set(['article', 'author', 'section', 'category', 'tag', 'media']);

// Les messages du serveur sont courts et techniques ; on les dit en mots simples.
const FRIENDLY_ERRORS = {
  'un article publié doit être signé': 'Pour publier, cochez au moins une signature. Sans signature, créez-en une dans « Équipe ».',
  'un article publié doit avoir une section': 'Pour publier, choisissez une section.',
  'un article publié ne peut pas être vide': 'L’article est vide : écrivez son texte avant de publier.',
  'date de publication requise': 'Indiquez la date et l’heure de publication.',
  'titre requis': 'Donnez un titre à l’article.',
  'corps requis': 'Écrivez le texte de l’article.',
  'slug invalide': 'L’adresse de l’article ne peut contenir que des lettres minuscules, des chiffres et des tirets.',
  'statut inconnu': 'Choisissez un statut dans la liste.',
};

function friendlyError(message) {
  if (!message) return '';
  return FRIENDLY_ERRORS[message] || message;
}

export class SocleBackendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function base64(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary);
}

function starterPublication(name) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `journal-${Date.now()}`,
    slug: 'mon-journal',
    name: name || 'Mon journal',
    institution: '',
    institutionType: 'cegep',
    lang: 'fr-CA',
    siteUrl: '',
    timeZone: 'America/Toronto',
    theme: { accent: '#8a1538' },
    governance: { owner: '', contact: '' },
    radio: { enabled: false, station: '' },
  };
}

export class SocleBackend {
  id = 'socle';
  capabilities = CAPABILITIES;
  context = null;
  listeners = new Set();
  state = null;
  role = null;

  async init(context = {}) {
    this.context = context;
    this.apiBase = String(context.apiBase ?? '').replace(/\/$/, '');
    this.fetch = context.fetch ?? globalThis.fetch.bind(globalThis);
    await this.#load();
  }

  async #request(method, path, body) {
    let response;
    try {
      response = await this.fetch(`${this.apiBase}/v1/redaction/${path}`, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new SocleBackendError('Le serveur du journal ne répond pas. Le site publié reste lisible ; réessayez dans un instant.', 0);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const fallback = response.status === 401 ? 'Votre session a expiré : reconnectez-vous pour écrire.'
        : response.status === 404 ? 'La rédaction est éteinte sur ce serveur : prévenez l’administrateur.'
          : `Le serveur du journal a refusé la demande (code ${response.status}).`;
      throw new SocleBackendError(friendlyError(data?.error) || fallback, response.status);
    }
    return data;
  }

  async #load() {
    const state = await this.#request('GET', 'etat');
    if (state?.format !== 'socle-redaction') throw new SocleBackendError('Le serveur du journal a répondu de façon inattendue : rechargez la page.', 500);
    // Socle neuf : une fiche de départ, écrite au premier enregistrement de
    // la configuration. Rien n'est envoyé avant.
    if (!state.publication) {
      state.publication = starterPublication(this.context.publicationName);
      state.firstRun = true;
    }
    this.state = state;
    this.role = state.role;
    return state;
  }

  /** Adresse affichable d'un fichier gardé par le socle. */
  displaySrc(src) {
    const value = String(src || '');
    return value.startsWith('/media/') ? `${this.apiBase}/v1/redaction/fichier?src=${encodeURIComponent(value)}` : value;
  }

  async getSnapshot(options = { audience: 'editorial' }) {
    const state = await this.#load();
    const articles = options.audience === 'public' ? state.articles.filter((item) => item.status === 'published') : state.articles;
    return structuredClone({
      publication: state.publication,
      articles,
      authors: state.authors,
      taxonomies: state.taxonomies,
      media: state.media,
      syncedAt: state.syncedAt,
      demoVisible: state.demoVisible,
      role: state.role,
      scope: state.scope || [],
      modules: state.modules,
      // Socle neuf : la fiche est provisoire tant que la configuration n’est pas enregistrée.
      firstRun: Boolean(state.firstRun),
    });
  }

  async save(kind, input) {
    if (!KINDS.has(kind)) throw new Error(`Type éditorial inconnu : ${kind}`);
    let saved;
    if (kind === 'article') saved = (await this.#request('POST', 'article', { article: input })).article;
    else if (kind === 'media') saved = (await this.#request('POST', 'photo/fiche', { asset: input })).asset;
    else saved = (await this.#request('POST', 'entite', { kind, entity: input })).entity;
    this.#emit({ kind, id: saved.id });
    return saved;
  }

  async remove(kind, id) {
    if (!KINDS.has(kind)) throw new Error(`Type éditorial inconnu : ${kind}`);
    if (kind === 'media') await this.#request('POST', 'photo/supprimer', { id });
    else await this.#request('POST', 'supprimer', { kind, id });
    this.#emit({ kind, id });
  }

  /**
   * Envoie une photo. `bank: true` l'ajoute à la banque (crédit exigé) ;
   * `false` la garde pour un seul article (sans crédit, elle entre dans la
   * file des crédits manquants du socle).
   */
  async uploadPhoto({ asset, file, bank = true }) {
    const data = base64(await file.arrayBuffer());
    const payload = await this.#request('POST', 'photo', { asset, data, bank });
    const saved = { ...payload.asset };
    if (payload.duplicate) saved.duplicate = payload.duplicate;
    this.#emit({ kind: 'media', id: saved.id });
    return saved;
  }

  async removePhoto(id) {
    return this.remove('media', id);
  }

  async savePublication(publication) {
    const saved = (await this.#request('POST', 'publication', { publication })).publication;
    this.#emit({ kind: 'publication', id: saved.id });
    return saved;
  }

  async setDemoVisibility(visible) {
    await this.#request('POST', 'exemples', { visible: Boolean(visible) });
    this.#emit({ kind: 'demo-visibility' });
  }

  async removeDemo() {
    throw new SocleBackendError('Il n’y a pas d’exemples à retirer ici : supprimez les articles un par un.', 400);
  }

  async resetDemo() {
    throw new SocleBackendError('Restaurer Le Quorum n’existe qu’en démonstration.', 400);
  }

  async createBackup(options = {}) {
    const bundle = await this.getSnapshot({ audience: 'editorial' });
    delete bundle.role;
    delete bundle.scope;
    delete bundle.modules;
    const filter = options.filter || 'all';
    if (filter !== 'all') {
      bundle.articles = bundle.articles.filter((item) => !item.isDemo || item.isUserModified);
      bundle.authors = bundle.authors.filter((item) => !item.isDemo || item.isUserModified);
    }
    return { format: 'kiosque-editorial-backup', version: 1, exportedAt: new Date().toISOString(), filter, bundle };
  }

  async restoreBackup() {
    throw new SocleBackendError('Sur le socle, la restauration passe par sa page Sauvegarde (/admin), qui garde une copie avant d’écrire.', 400);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async close() {
    this.listeners.clear();
  }
}
