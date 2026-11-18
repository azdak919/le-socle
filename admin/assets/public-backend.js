/**
 * Lecture publique du socle pour le site du journal (paquet complet) :
 * `GET /v1/editorial/snapshot` ne rend que ce qui est publié. Aucune
 * écriture, aucun compte. Un nouvel appel au plus toutes les 60 secondes.
 */
export class PublicSocleBackend {
  apiBase = '';
  #snapshot = null;
  #at = 0;
  #listeners = new Set();

  async init({ apiBase = '' } = {}) {
    this.apiBase = String(apiBase).replace(/\/+$/, '');
    await this.#load(true);
  }

  async #load(force = false) {
    if (!force && this.#snapshot && Date.now() - this.#at < 60_000) return this.#snapshot;
    const response = await fetch(`${this.apiBase}/v1/editorial/snapshot`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    // Journal pas encore installé : le socle n'a pas de fiche à montrer.
    if (response.status === 400 || response.status === 409) {
      this.#snapshot = { publication: { id: 'journal', slug: 'journal', name: 'Journal en préparation', tagline: 'L’équipe installe le journal.', theme: { accent: '#6c2163' } }, articles: [], authors: [], taxonomies: { sections: [], categories: [], tags: [] } };
      this.#at = Date.now();
      return this.#snapshot;
    }
    if (!response.ok) throw new Error(`Le journal ne répond pas (${response.status}).`);
    this.#snapshot = await response.json();
    this.#at = Date.now();
    return this.#snapshot;
  }

  async getSnapshot() {
    const snapshot = await this.#load();
    const publication = snapshot.publication ?? { name: 'Journal', slug: 'journal', theme: {} };
    return structuredClone({
      publication: { ...publication, theme: { ...(publication.theme ?? {}) } },
      articles: (snapshot.articles ?? []).filter((item) => item.status === 'published' || item.status === 'archived'),
      authors: snapshot.authors ?? [],
      // Les sections dans l'ordre choisi par la rédaction (↑ ↓), pas celui du stockage.
      taxonomies: Object.fromEntries(Object.entries(snapshot.taxonomies ?? { sections: [], categories: [], tags: [] })
        .map(([kind, list]) => [kind, [...(list ?? [])].sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999))])),
      media: snapshot.media ?? [],
      syncedAt: snapshot.syncedAt ?? new Date().toISOString(),
    });
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
