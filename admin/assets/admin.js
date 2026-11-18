import { marked } from './marked.esm.js';
import { markdownFiles, zipStore } from './export.js';
import { download, getBackend, slugify } from './runtime.js';
import { esc } from './util.js';
import { rankLocalMedia } from './stock-photo-match.js';

const config = window.KIOSQUE_EDITORIAL;
const main = document.getElementById('admin-main');
const toast = document.getElementById('toast');
let backend;
let bundle;
let view = 'dashboard';

let notifyTimer = 0;
function notify(message, durationMs = 2200) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(notifyTimer);
  notifyTimer = window.setTimeout(() => toast.classList.remove('visible'), durationMs);
}

function contrastRatio(hex, other = '#ffffff') {
  const luminance = (color) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const first = luminance(hex), second = luminance(other);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Variante claire pour le mode sombre : même règle que le configurateur. */
function darkVariant(accent) {
  const hex = colorInputValue(accent);
  let out = hex;
  for (let mix = 0.45; mix <= 0.9; mix += 0.05) {
    out = '#' + [1, 3, 5].map((offset) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16);
      return Math.round(value + (255 - value) * mix).toString(16).padStart(2, '0');
    }).join('');
    if (contrastRatio(out, '#0e0f12') >= 4.5) break;
  }
  return out;
}

/** Ce qui manque pour que le site public accepte le contenu du socle. */
function missingSettings(publication) {
  const missing = [];
  if (!/^https?:\/\//.test(publication?.siteUrl || '')) missing.push('l’adresse du site public');
  if (!publication?.slug || publication.slug === 'mon-journal') missing.push('le nom court du journal');
  if (!publication?.governance?.owner) missing.push('l’organisme ou la personne responsable');
  if (!publication?.governance?.contact) missing.push('le courriel de la rédaction');
  return missing;
}

/**
 * kiosque-config.json, le fichier du configurateur (dans son ZIP) : nom,
 * adresse, organisme et contacts, couleurs, logo, sections, radio, météo. Rien à
 * ressaisir. Les sections déjà présentes (même nom court) sont gardées.
 */
async function importKiosqueConfig(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('Ce fichier n’est pas lisible.'); }
  return applyKiosqueConfig(data);
}

/** Même fiche que le configurateur : sert aussi à l’assistant d’installation. */
async function applyKiosqueConfig(data) {
  if (data?.format !== 'kiosque-config') throw new Error('Ce fichier n’est pas le kiosque-config.json du configurateur.');
  const journal = data.journal || {}, look = data.apparence || {}, options = data.options || {}, people = data.gouvernance || {};
  const publication = structuredClone(bundle.publication);
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  publication.name = pick(journal.nom, publication.name);
  publication.slug = slugify(pick(journal.slug, publication.slug)) || publication.slug;
  publication.tagline = pick(journal.signature, publication.tagline || '');
  publication.institution = pick(journal.etablissement, publication.institution || '');
  publication.institutionType = ['cegep', 'universite', 'autre'].includes(journal.typeEtablissement) ? journal.typeEtablissement : publication.institutionType;
  publication.region = pick(journal.region, publication.region || '');
  publication.founded = pick(journal.fondation, publication.founded || '');
  publication.license = pick(journal.licence, publication.license || '');
  publication.siteUrl = pick(journal.adresse, publication.siteUrl || '');
  publication.timeZone = pick(journal.fuseau, publication.timeZone || 'America/Toronto');
  publication.lang = pick(journal.langue, publication.lang || 'fr-CA');
  const accent = colorInputValue(pick(look.couleur, publication.theme?.accent));
  publication.theme = { ...publication.theme, accent, accentDark: colorInputValue(pick(look.couleurSombre, darkVariant(accent))), typography: pick(look.typographie, publication.theme?.typography || 'modern-accessible') };
  if (typeof look.logo === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg);base64,/.test(look.logo)) {
    publication.logo = { id: crypto.randomUUID(), kind: 'image', src: look.logo, alt: pick(look.logoAlt, publication.name), mime: look.logo.slice(5, look.logo.indexOf(';')), source: source('media', 'kiosque-config.json') };
  }
  publication.radio = { ...publication.radio, enabled: Boolean(options.radio && options.station), station: pick(options.station, ''), theme: 'dark', position: 'top' };
  const localities = String(options.localites || '').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 4);
  publication.masthead = { ...publication.masthead, weather: { enabled: Boolean(options.meteo && localities.length), localities } };
  if (typeof options.noindex === 'boolean') publication.noindex = options.noindex;
  if (typeof options.fictif === 'boolean') publication.fictif = options.fictif;
  publication.governance = {
    ...publication.governance,
    owner: pick(people.proprietaire, publication.governance?.owner || ''),
    contact: pick(people.contact, publication.governance?.contact || ''),
    repo: pick(people.depot, publication.governance?.repo || ''),
    stewardEntity: pick(people.organisme, publication.governance?.stewardEntity || publication.institution || ''),
  };
  if (Array.isArray(people.contactsRecuperation)) publication.governance.recoveryContacts = people.contactsRecuperation.filter((item) => typeof item === 'string' && item.trim());
  await backend.savePublication(publication);
  let added = 0;
  for (const section of Array.isArray(data.sections) ? data.sections : []) {
    const slug = slugify(section?.slug || section?.nom || '');
    if (!slug || bundle.taxonomies.sections.some((item) => item.slug === slug)) continue;
    await backend.save('section', { id: crypto.randomUUID(), name: String(section.nom || slug), slug, description: String(section.description || ''), order: Number(section.ordre) || bundle.taxonomies.sections.length + added + 1 });
    added++;
  }
  await refresh();
  return added;
}

function importButton() {
  return `<label class="button">Importer un fichier du configurateur<input type="file" data-import-config accept="application/json,.json" hidden></label>`;
}

function bindImport(root) {
  root.querySelectorAll('[data-import-config]').forEach((input) => input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const added = await importKiosqueConfig(file);
      notify(`Configuration du configurateur importée${added ? `, ${added} section(s) ajoutée(s)` : ''}.`, 4000);
      render();
    } catch (error) { notify(error.message, 5000); }
  }));
}

function source(kind, id) {
  return { backend: backend?.id || 'demo-navigateur', backendId: id, fetchedAt: new Date().toISOString() };
}

/** En mode socle, l'admin écrit sur le serveur ; sinon dans ce navigateur. */
const onSocle = () => config.mode === 'socle';
// Adresse de Le Socle (vide à la racine du domaine, un chemin dans un sous-dossier).
const socleRoot = () => String(config.apiBase || '').replace(/\/$/, '');
const authOn = () => onSocle() && Boolean(backend?.state?.modules?.auth);

async function authCall(method, path, body) {
  const response = await fetch(`${socleRoot()}/v1/auth/${path}`, {
    method, credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    const messages = { 'accès refusé': 'Courriel ou mot de passe incorrect.', "trop d'essais": 'Trop d’essais : attendez 15 minutes.', 'mot de passe trop court': 'Le mot de passe doit avoir au moins 10 caractères.', 'déjà installé': 'Ce journal a déjà un administrateur : connectez-vous.', 'réservé à l’administrateur': 'Réservé à l’administrateur du journal.', 'réservé au responsable': 'Réservé à l’administrateur du journal.', 'rôle inconnu': 'Rôle inconnu.', 'demande refusée': 'Demande refusée : vérifiez le courriel (par exemple vous@exemple.ca).' };
    throw new Error(messages[text] || text || `Le serveur du journal a refusé la demande (code ${response.status}). Réessayez ; si cela continue, prévenez l’administrateur.`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Assistant d’installation (premier passage, mode mot de passe) : le journal
 * et le compte administrateur en un seul formulaire, sans configurateur ni
 * fichier à importer. La fiche est écrite au format du configurateur, gardée
 * le temps de recharger la page avec la session, puis appliquée.
 */
const ASSISTANT_KEY = 'kiosque-assistant';
// Paquet complet : le site du journal est servi par ce même socle (site/).
let siteVivant = false;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Le logo ne peut pas être lu.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Aperçu du mât avant d’enregistrer : le logo (ou le nom) tel que le site l’affichera,
 * sur ordinateur et sur mobile, en thème clair et sombre. Les tailles suivent le thème
 * (logo de 82 px de haut au plus sur ordinateur, réduit de moitié dans le cadre mobile).
 */
function mastPreview({ src = '', name = '', color = '#6c2163', sections = [] } = {}) {
  const title = name || 'Nom du journal';
  const tabs = (sections.length ? sections : ['Campus', 'Culture', 'Sports']).slice(0, 4);
  const longDate = new Intl.DateTimeFormat('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const date = longDate.charAt(0).toUpperCase() + longDate.slice(1);
  const frame = (device, theme, label) => `<figure class="mast-preview" data-device="${device}" data-theme="${theme}" style="--mast-accent:${esc(theme === 'dark' ? darkVariant(color) : color)}">
    <div class="mast-preview-screen"><small class="mast-preview-date">${esc(date)}</small>
    <div class="mast-preview-brand">${src ? `<img class="mast-preview-logo" src="${esc(src)}" alt="${esc(title)}">` : `<strong class="mast-preview-name">${esc(title)}</strong>`}</div>
    <nav class="mast-preview-nav">${tabs.map((tab, index) => `<span${index === 0 ? ' class="current"' : ''}>${esc(tab)}</span>`).join('')}</nav></div>
    <figcaption>${label}</figcaption></figure>`;
  return `<div class="mast-previews" role="group" aria-label="Aperçu du mât avant d’enregistrer">
    <p class="mast-previews-title">Aperçu du mât${src ? '' : ' (sans logo, le nom s’affiche en texte)'}</p>
    ${frame('desktop', 'light', 'Ordinateur, thème clair')}${frame('desktop', 'dark', 'Ordinateur, thème sombre')}
    ${frame('mobile', 'light', 'Mobile, clair')}${frame('mobile', 'dark', 'Mobile, sombre')}
    <p class="media-quality mast-previews-note">Rien n’est enregistré tant que vous n’avez pas validé le formulaire. Si le logo disparaît sur fond sombre, choisissez une version avec un fond ou un contour clair.</p></div>`;
}

const LOGO_TYPES = ['image/svg+xml', 'image/png', 'image/webp', 'image/jpeg'];

/** Relie un champ de fichier à l’aperçu du mât ; renvoie la fonction qui redessine l’aperçu. */
function bindMastPreview(container, { file, name, color, sections = () => [], current = '', maxBytes = 0 }) {
  let url = '';
  const draw = () => {
    const chosen = file.files[0];
    let warning = '';
    if (url) { URL.revokeObjectURL(url); url = ''; }
    if (chosen && !LOGO_TYPES.includes(chosen.type)) warning = 'Format non pris en charge : choisissez un PNG, JPEG, WebP ou SVG.';
    else if (chosen && maxBytes && chosen.size > maxBytes) warning = `Ce fichier pèse ${Math.ceil(chosen.size / 1000)} ko : la limite est de ${Math.round(maxBytes / 1000)} ko.`;
    // Un <img> n’exécute jamais le contenu d’un SVG : l’aperçu est sans risque avant le nettoyage.
    if (chosen && !warning) url = URL.createObjectURL(chosen);
    container.innerHTML = `${warning ? `<p class="notice" role="alert">${esc(warning)}</p>` : ''}${mastPreview({ src: url || (chosen ? '' : current), name: name(), color: color(), sections: sections() })}`;
  };
  file.addEventListener('change', draw);
  draw();
  return draw;
}

/** Signale les champs obligatoires vides (ou mal remplis) près du champ lui-même. */
function flagInvalidFields(form) {
  let first = null;
  for (const field of form.querySelectorAll('input, select, textarea')) {
    if (field.type === 'file' || field.type === 'checkbox' || field.disabled || field.closest('[hidden]')) continue;
    field.setCustomValidity(field.required && !String(field.value).trim() ? 'Ce champ est obligatoire.' : '');
    const label = field.closest('label') || field.parentElement;
    label.querySelector(':scope > .field-error')?.remove();
    field.removeAttribute('aria-invalid');
    if (field.checkValidity()) continue;
    field.setAttribute('aria-invalid', 'true');
    const message = document.createElement('small');
    message.className = 'field-error';
    message.id = `${field.name || 'champ'}-erreur`;
    message.textContent = field.validity.valueMissing || field.validity.customError ? 'Ce champ est obligatoire.' : (field.dataset.erreur || field.validationMessage);
    field.setAttribute('aria-describedby', message.id);
    label.append(message);
    first ||= field;
  }
  if (first) first.focus();
  return !first;
}

/** Retire le signalement dès que la personne corrige le champ. */
function bindRequiredFlags(form) {
  form.addEventListener('input', (event) => {
    const field = event.target;
    if (field.getAttribute?.('aria-invalid') !== 'true') return;
    field.setCustomValidity('');
    if (!field.checkValidity() || (field.required && !String(field.value).trim())) return;
    field.removeAttribute('aria-invalid');
    (field.closest('label') || field.parentElement).querySelector(':scope > .field-error')?.remove();
  });
}

function assistantForm() {
  return `<section class="panel assistant" style="max-width:40rem"><h2>Installer le journal</h2>
<p>Ce journal est neuf. Remplissez ce formulaire une fois : le site et la rédaction seront prêts. Tout se change ensuite dans « Configuration ».</p>
<form id="login-form" class="grid" novalidate>
<fieldset class="field full"><legend>Le journal</legend>
<p class="muted">Les exemples en gris pâle disparaissent quand vous écrivez ; un champ laissé vide n’enregistre rien. Les champs marqués « obligatoire » doivent être remplis.</p>
<label>Nom du journal (obligatoire)<input name="nom" required maxlength="80" placeholder="La Vigie"></label>
<label>Établissement (facultatif)<input name="etablissement" maxlength="120" placeholder="Cégep de Sainte-Foy"></label>
<label>Année de fondation (facultatif)<input name="fondation" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" data-erreur="Écrivez l’année en quatre chiffres, par exemple 1971." placeholder="1971"></label>
<label>Organisme responsable du journal (facultatif)<input name="organisme" maxlength="120" placeholder="Association étudiante du Cégep de Sainte-Foy"></label>
<label>Courriel de la rédaction, affiché sur le site (facultatif)<input name="contact" type="email" placeholder="redaction@exemple.ca"></label>
<label>Signature (facultatif)<input name="signature" maxlength="120" placeholder="Le journal étudiant du Cégep de Sainte-Foy"></label>
<label>Sections, séparées par des virgules (obligatoire)<input name="sections" required placeholder="Campus, Culture, Sports"></label>
<label>Droits sur les articles<select name="licence"><option value="">Tous droits réservés (par défaut)</option><option value="CC BY-NC-ND 4.0">Creative Commons BY-NC-ND 4.0 : partage permis, sans modification ni usage commercial</option></select></label>
<small>Affiché au bas de chaque page : « © 2026 Nom du journal. Tous droits réservés. » Avec l’année de fondation : « © 1971–2026 ». L’année courante se met à jour toute seule.</small>
</fieldset>
<fieldset class="field full"><legend>Apparence</legend>
<label>Couleur principale<input name="couleur" type="color" value="#6c2163"></label>
<label>Logo (facultatif : PNG, JPEG, WebP ou SVG, 500 ko au plus)<input name="logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label>
<div data-mast-preview class="full"></div>
</fieldset>
<fieldset class="field full"><legend>Options</legend>
<label><input name="radio" type="checkbox"> Afficher la radio étudiante (barre de LE-RADAR sous le mât)</label>
<label data-station hidden>Station<select name="station" id="assistant-stations"><option value="">Choisir une station</option></select></label>
<label><input name="noindex" type="checkbox" checked> Cacher le journal des moteurs de recherche (conseillé pendant les essais)</label>
<label><input name="fictif" type="checkbox"> Afficher le bandeau « Journal étudiant fictif » (essai ou démonstration)</label>
</fieldset>
<fieldset class="field full"><legend>Compte administrateur</legend>
<p class="muted">Ce compte ajoute ensuite l’équipe (auteurs, photographes, réviseurs…). Son courriel n’est pas affiché sur le site. Notez le mot de passe en lieu sûr.</p>
<label>Courriel (obligatoire)<input name="email" type="email" autocomplete="username" required placeholder="vous@exemple.ca"></label>
<label>Mot de passe (obligatoire, 10 caractères ou plus)<input name="password" type="password" autocomplete="new-password" minlength="10" required placeholder="10 caractères ou plus"></label>
</fieldset>
<div class="actions full"><button class="primary">Installer le journal</button></div>
<p id="login-error" class="notice" role="alert" hidden></p></form></section>`;
}

function bindAssistant() {
  const form = document.getElementById('login-form');
  const radio = form.elements.radio;
  const stationLabel = form.querySelector('[data-station]');
  radio.addEventListener('change', () => {
    stationLabel.hidden = !radio.checked;
    const list = form.querySelector('#assistant-stations');
    if (!radio.checked || list.dataset.loaded) return;
    list.dataset.loaded = '1';
    // Seulement si la radio est cochée : sinon rien ne part vers le-radar.ca.
    fetch('https://le-radar.ca/radios.json', { credentials: 'omit' }).then((r) => (r.ok ? r.json() : [])).then((data) => {
      const items = (Array.isArray(data) ? data : (data?.stations || [])).filter((item) => item?.id);
      list.innerHTML = `<option value="">Choisir une station</option>${items.map((item) => `<option value="${esc(item.id)}">${esc([item.name, item.institution].filter(Boolean).join(' — '))}</option>`).join('')}`;
    }).catch(() => {});
  });
  const preview = form.querySelector('[data-mast-preview]');
  const showPreview = bindMastPreview(preview, {
    file: form.elements.logo,
    name: () => form.elements.nom.value.trim(),
    color: () => form.elements.couleur.value,
    sections: () => String(form.elements.sections.value).split(',').map((item) => item.trim()).filter(Boolean),
    maxBytes: 500_000,
  });
  for (const input of [form.elements.nom, form.elements.couleur, form.elements.sections]) input.addEventListener('input', showPreview);
  bindRequiredFlags(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const error = document.getElementById('login-error');
    const button = form.querySelector('button.primary');
    error.hidden = true;
    if (!flagInvalidFields(form)) return;
    try {
      const file = form.elements.logo.files[0];
      if (file && file.size > 500_000) throw new Error('Le logo dépasse 500 ko : choisissez une image plus légère.');
      const logo = file ? await readAsDataUrl(file) : '';
      const nom = String(data.get('nom')).trim();
      const fiche = {
        format: 'kiosque-config',
        journal: { nom, slug: slugify(nom), etablissement: String(data.get('etablissement') || '').trim(), signature: String(data.get('signature') || '').trim(), fondation: String(data.get('fondation') || '').trim(), licence: String(data.get('licence') || '').trim(), adresse: `${location.origin}${socleRoot()}/` },
        apparence: { couleur: data.get('couleur'), logo, logoAlt: nom },
        options: { radio: Boolean(data.get('radio')), station: String(data.get('station') || ''), noindex: Boolean(data.get('noindex')), fictif: Boolean(data.get('fictif')) },
        gouvernance: (() => {
          const organisme = String(data.get('organisme') || '').trim() || String(data.get('etablissement') || '').trim() || nom;
          // Le courriel du compte reste privé : seul le courriel de la rédaction est public.
          return { proprietaire: organisme, organisme, contact: String(data.get('contact') || '').trim() };
        })(),
        sections: String(data.get('sections') || '').split(',').map((name) => name.trim()).filter(Boolean).slice(0, 12).map((name, index) => ({ nom: name, slug: slugify(name), ordre: index + 1 })),
      };
      if (fiche.options.radio && !fiche.options.station) throw new Error('Choisissez une station, ou décochez la radio.');
      button.disabled = true;
      button.textContent = 'Installation…';
      await authCall('POST', 'installation', { email: String(data.get('email')).trim(), password: data.get('password') });
      sessionStorage.setItem(ASSISTANT_KEY, JSON.stringify(fiche));
      location.reload();
    } catch (failure) {
      button.disabled = false;
      button.textContent = 'Installer le journal';
      error.hidden = false;
      error.textContent = failure.message;
    }
  };
}

/** Après l’installation : applique la fiche de l’assistant, une seule fois. */
async function finishAssistant() {
  const raw = sessionStorage.getItem(ASSISTANT_KEY);
  if (!raw) return false;
  sessionStorage.removeItem(ASSISTANT_KEY);
  try {
    await applyKiosqueConfig(JSON.parse(raw));
    notify('Le journal est installé. Écrivez le premier article, puis ajoutez l’équipe dans « Équipe ».', 8000);
    return true;
  } catch (error) {
    notify(`Le compte est créé, mais la fiche du journal n’a pas pu être enregistrée : ${error.message} Remplissez « Configuration ».`, 10000);
    return false;
  }
}

/** En-tête de la barre latérale : logo ou nom du journal, sinon Le Socle. */
function paintBrand(state) {
  const root = document.querySelector('.admin-brand');
  if (!root) return;
  const pub = bundle?.publication;
  const name = String(pub?.name || '').trim();
  const src = pub?.logo ? mediaSrc(pub.logo) : '';
  const ready = state === 'journal' && name;
  if (ready && src) {
    const alt = esc(pub.logo.alt || name);
    root.dataset.state = 'journal-logo';
    root.innerHTML = `<img class="admin-brand-logo" src="${esc(src)}" alt="${alt}"><span><small>Espace de rédaction</small></span>`;
    return;
  }
  if (ready) {
    root.dataset.state = 'journal-name';
    root.innerHTML = `<span><strong>${esc(name)}</strong><small>Espace de rédaction</small></span>`;
    return;
  }
  root.dataset.state = 'socle';
  root.innerHTML = '<span><strong>Le Socle</strong><small>Espace de rédaction</small></span>';
}

/** Écran de connexion (ou de première installation) quand le socle demande une session. */
async function loginScreen() {
  // Avant la connexion, le menu de la rédaction ne mène nulle part : on le cache.
  document.body.classList.add('signed-out');
  paintBrand('socle');
  let state = null;
  try { state = await authCall('GET', 'etat'); } catch { state = null; }
  const mode = state?.mode;
  if (mode === 'motdepasse') {
    const first = !state.installed;
    if (first) {
      main.innerHTML = assistantForm();
      bindAssistant();
      return;
    }
    main.innerHTML = `<section class="panel" style="max-width:32rem"><h2>${first ? 'Installer la rédaction' : 'Se connecter'}</h2><p>${first ? 'Ce journal est neuf. Créez le compte administrateur : il pourra ensuite ajouter l’équipe. Faites-le tout de suite après la mise en ligne.' : 'Entrez le courriel et le mot de passe que l’administrateur ou l’administratrice du journal vous a donnés. Mot de passe oublié : demandez-lui-en un nouveau (onglet « Équipe »).'}</p><form id="login-form" class="grid" style="margin-top:1rem"><div class="field full"><label>Courriel<input name="email" type="email" autocomplete="username" required placeholder="vous@exemple.ca"></label></div><div class="field full"><label>Mot de passe${first ? ' (10 caractères ou plus)' : ''}<input name="password" type="password" autocomplete="${first ? 'new-password' : 'current-password'}" minlength="${first ? 10 : 1}" required></label></div><div class="actions full"><button class="primary">${first ? 'Créer le compte et ouvrir la rédaction' : 'Se connecter'}</button></div><p id="login-error" class="notice" role="alert" hidden></p></form></section>`;
    document.getElementById('login-form').onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const error = document.getElementById('login-error');
      try { await authCall('POST', first ? 'installation' : 'motdepasse', { email: data.get('email').trim(), password: data.get('password') }); location.reload(); }
      catch (failure) { error.hidden = false; error.textContent = failure.message; }
    };
    return;
  }
  const links = mode === 'github' ? `<a class="button primary" href="${socleRoot()}/v1/auth/github">Se connecter avec GitHub</a>`
    : mode === 'access' ? `<a class="button primary" href="${socleRoot()}/v1/auth/access">Se connecter</a>`
      : mode === 'magic' ? `<form id="magic-form" class="grid"><div class="field full"><label>Courriel<input name="email" type="email" required></label></div><div class="actions full"><button class="primary">Recevoir un lien de connexion</button></div></form>` : '<p>Le mode de connexion du socle n’est pas réglé (SOCLE_AUTH_MODE).</p>';
  main.innerHTML = `<section class="panel" style="max-width:32rem"><h2>Se connecter</h2>${links}<p id="login-error" class="notice" role="status" hidden></p></section>`;
  const magic = document.getElementById('magic-form');
  if (magic) magic.onsubmit = async (event) => { event.preventDefault(); const status = document.getElementById('login-error'); status.hidden = false; try { await fetch(`${socleRoot()}/v1/auth/lien`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: new FormData(magic).get('email').trim() }) }); status.textContent = 'Si cette adresse fait partie de l’équipe, un lien vient de partir.'; } catch { status.textContent = 'Le serveur du journal ne répond pas : réessayez dans un instant.'; } };
}

/** Comptes de la rédaction (mode mot de passe), pour l’administrateur. */
async function fillAccessPanel() {
  const panel = document.getElementById('access-panel');
  if (!panel || !authOn()) return;
  let members = null;
  try { members = await authCall('GET', 'membres'); } catch { members = null; }
  const logout = '<button data-action="logout">Se déconnecter</button>';
  if (!members) { panel.hidden = false; panel.innerHTML = `<div class="toolbar"><h2>Mon accès</h2>${logout}</div>`; bindLogout(panel); return; }
  const password = (await authCall('GET', 'etat').catch(() => null))?.mode === 'motdepasse';
  panel.hidden = false;
  const sections = orderedSections();
  const sectionName = (key) => sections.find((item) => item.slug === key || item.id === key)?.name || key;
  const roleOptions = ACCOUNT_ROLES.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
  const roleHelp = Object.fromEntries(ACCOUNT_ROLES.map(([value, , help]) => [value, help]));
  const memberLine = (member) => {
    const scope = (member.sections || []).map(sectionName);
    const where = SCOPED_ROLES.includes(member.role) ? (scope.length ? `Rubriques : ${scope.join(', ')}` : 'Toutes les rubriques') : '';
    return `<li><div><strong>${esc(member.email)}</strong><small>${esc([ACCOUNT_LABELS[member.role] || member.role, where].filter(Boolean).join(' · '))}</small></div><div><button type="button" data-edit-member="${esc(member.email)}">Modifier</button></div></li>`;
  };
  panel.innerHTML = `<div class="toolbar"><h2>Équipe : comptes et rôles</h2>${logout}</div><p class="notice">Ces comptes ouvrent la rédaction. Le rôle dit ce que chacun peut faire ; le serveur l’applique. Les signatures, plus bas, sont ce que le public voit.</p><ul class="entity-list" id="member-list">${members.map(memberLine).join('')}</ul>
  <form id="member-form" class="grid"><h3 class="full" id="member-form-title">Ajouter une personne</h3>
  <div class="field"><label>Courriel<input name="email" type="email" required autocomplete="off"></label></div>
  <div class="field"><label>Rôle<select name="role">${roleOptions}</select></label><small id="member-role-help"></small></div>
  <fieldset class="field full" id="member-sections"><legend>Rubriques permises</legend><small>Rien de coché : toutes les rubriques.</small><div class="chips">${sections.length ? sections.map((item) => `<label><input type="checkbox" name="sections" value="${esc(item.slug)}"> ${esc(item.name)}</label>`).join(' ') : '<em>Aucune section pour l’instant (Sections et catégories).</em>'}</div></fieldset>
  ${password ? '<div class="field"><label>Mot de passe à lui transmettre (10 caractères ou plus ; pour un compte existant, laissez vide pour le garder)<input name="password" type="text" minlength="10" autocomplete="off"></label></div>' : ''}
  <div class="actions full"><button class="primary">Enregistrer le compte</button><button type="button" data-action="member-new">Nouvelle personne</button></div></form>
  <details class="full"><summary>Qui peut faire quoi ?</summary><ul>${ACCOUNT_ROLES.map(([, label, help]) => `<li><strong>${esc(label)}</strong> : ${esc(help)}</li>`).join('')}</ul></details>`;
  bindLogout(panel);
  const form = panel.querySelector('#member-form');
  const syncRole = () => {
    const role = form.elements.role.value;
    panel.querySelector('#member-role-help').textContent = roleHelp[role] || '';
    panel.querySelector('#member-sections').hidden = !SCOPED_ROLES.includes(role);
  };
  form.elements.role.onchange = syncRole;
  syncRole();
  panel.querySelectorAll('[data-edit-member]').forEach((button) => button.onclick = () => {
    const member = members.find((item) => item.email === button.dataset.editMember);
    if (!member) return;
    form.elements.email.value = member.email;
    form.elements.role.value = member.role === 'responsable' ? 'administrateur' : member.role;
    form.querySelectorAll('input[name="sections"]').forEach((box) => { box.checked = (member.sections || []).includes(box.value); });
    panel.querySelector('#member-form-title').textContent = `Modifier ${member.email}`;
    syncRole();
    form.elements.email.focus();
  });
  panel.querySelector('[data-action="member-new"]').onclick = () => { form.reset(); panel.querySelector('#member-form-title').textContent = 'Ajouter une personne'; syncRole(); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = { email: data.get('email').trim(), role: data.get('role') };
    if (SCOPED_ROLES.includes(body.role)) body.sections = data.getAll('sections');
    if (data.get('password')) body.password = data.get('password');
    try { await authCall('POST', 'membres', body); notify('Compte enregistré.'); fillAccessPanel(); } catch (error) { notify(error.message, 5000); }
  };
}

function bindLogout(root) {
  root.querySelectorAll('[data-action="logout"]').forEach((button) => button.onclick = async () => { try { await authCall('POST', 'deconnexion'); } catch { /* déjà sorti */ } location.reload(); });
}

function sanitizePreview(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,iframe,object,embed,form,style,link,meta').forEach((node) => node.remove());
  template.content.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attribute) => {
    if (/^on/i.test(attribute.name) || ((attribute.name === 'href' || attribute.name === 'src') && /^javascript:/i.test(attribute.value))) node.removeAttribute(attribute.name);
  }));
  return template.innerHTML;
}

function localDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function refresh() {
  bundle = await backend.getSnapshot({ audience: 'editorial', includeDemo: true });
  document.getElementById('publication-name').textContent = bundle.publication.name;
  paintBrand('journal');
}

const VIEWS = ['dashboard', 'articles', 'media', 'authors', 'taxonomies', 'settings', 'exports'];

function setView(next) {
  view = VIEWS.includes(next) ? next : 'dashboard';
  document.querySelectorAll('.admin-nav [data-view]').forEach((link) => {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  // L'adresse garde l'écran : un rechargement ou un lien depuis la page
  // Mise à jour (/admin/#articles) revient au même endroit.
  if (location.hash.slice(1) !== view) history.replaceState(null, '', view === 'dashboard' ? location.pathname : `#${view}`);
  // Avant l'ouverture de la base, on retient seulement l'écran demandé :
  // le rendu arrive dès que les données sont là (un clic trop tôt laissait
  // l'admin figée sur « Ouverture du journal… »).
  if (bundle) render();
}

const ROLE_LABELS = { auteur: 'Auteur ou autrice', reviseur: 'Réviseur ou réviseure', editeur: 'Éditeur ou éditrice' };
/** Rôles des comptes : ce qu'ils donnent, dit simplement (le serveur applique les mêmes règles). */
const ACCOUNT_ROLES = [
  ['auteur', 'Auteur ou autrice', 'Écrit des articles et les envoie en révision. Ne publie pas.'],
  ['photographe', 'Photographe', 'Gère la banque de photos : ajout, crédit, licence, retrait. N’écrit pas d’articles.'],
  ['reviseur', 'Réviseur ou réviseure', 'Relit et publie dans toutes les rubriques.'],
  ['chef-pupitre', 'Chef de pupitre', 'Relit et publie dans ses rubriques seulement.'],
  ['editeur', 'Éditeur ou éditrice', 'Relit et publie partout, règle les sections et le journal.'],
  ['administrateur', 'Administrateur', 'Tout, plus l’équipe, la sauvegarde et la mise à jour.'],
];
const SCOPED_ROLES = ['auteur', 'chef-pupitre'];
// « responsable » : ancien nom du rôle administrateur, encore lu.
const ACCOUNT_LABELS = { ...Object.fromEntries(ACCOUNT_ROLES.map(([value, label]) => [value, label])), responsable: 'Administrateur' };

/** Rubriques permises à ce compte (vide = toutes). */
function myScope() {
  return onSocle() && SCOPED_ROLES.includes(bundle?.role) ? (bundle.scope || []) : [];
}

function sectionAllowed(section) {
  const scope = myScope();
  return !scope.length || scope.includes(section.slug) || scope.includes(section.id);
}

function isAdminRole() {
  return ['administrateur', 'responsable'].includes(bundle?.role);
}

/** Menu selon le rôle : le photographe n'a que les photos ; Configuration, Sauvegarde et Mise à jour sont à l'administrateur. */
function applyRoleNav() {
  if (!onSocle() || !bundle?.role) return;
  const photographer = bundle.role === 'photographe';
  // Configuration, Sauvegarde et Mise à jour : l'administrateur seulement (le serveur refuse aux autres).
  const admin = !authOn() || isAdminRole();
  document.querySelectorAll('.admin-nav [data-view]').forEach((link) => {
    link.hidden = (photographer && !['dashboard', 'media'].includes(link.dataset.view)) || (!admin && link.dataset.view === 'settings');
  });
  document.querySelectorAll('.admin-nav [data-nav="save"], .admin-nav [data-nav="update"]').forEach((link) => { link.hidden = !admin; });
}

/** Licences courantes et leur lien, pour la banque et la photo principale. */
const LICENSES = {
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/deed.fr',
  'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/deed.fr',
  'CC BY 3.0': 'https://creativecommons.org/licenses/by/3.0/deed.fr',
  'CC BY-SA 3.0': 'https://creativecommons.org/licenses/by-sa/3.0/deed.fr',
  'CC BY 2.0': 'https://creativecommons.org/licenses/by/2.0/deed.fr',
  'CC BY-SA 2.0': 'https://creativecommons.org/licenses/by-sa/2.0/deed.fr',
  'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/deed.fr',
  CC0: 'https://creativecommons.org/publicdomain/zero/1.0/deed.fr',
  'Domaine public': '',
  'Tous droits réservés (avec permission)': '',
};
const licenseList = () => `<datalist id="license-list">${Object.keys(LICENSES).map((name) => `<option value="${esc(name)}"></option>`).join('')}</datalist>`;

// Une licence connue remplit son lien, s'il est vide.
document.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.name !== 'license') return;
  const url = input.form?.elements?.licenseUrl;
  if (url && !url.value && LICENSES[input.value.trim()]) url.value = LICENSES[input.value.trim()];
});

/** Un lien collé à la suite du lien rempli tout seul : on garde le dernier. */
function cleanLicenseUrl(value) {
  const text = String(value || '').trim();
  const starts = [...text.matchAll(/https?:\/\//g)].map((match) => match.index);
  return starts.length > 1 ? text.slice(starts[starts.length - 1]) : text;
}

function articleDate(article) {
  const value = article.publishedAt || article.scheduledAt || article.updatedAt;
  if (!value) return '';
  try { return new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: bundle.publication?.timeZone || 'America/Toronto' }).format(new Date(value)); } catch { return ''; }
}

function statusLabel(status) {
  return { draft: 'Brouillon', 'in-review': 'En révision', scheduled: 'Programmé', published: 'Publié', archived: 'Archivé', retracted: 'Retiré' }[status] || status;
}

function dashboard() {
  const counts = Object.fromEntries(['draft', 'in-review', 'scheduled', 'published'].map((status) => [status, bundle.articles.filter((item) => item.status === status).length]));
  return `<section class="panel"><h2>Tableau de bord</h2>
    <div class="grid stats"><article><h3>${counts.draft}</h3><p>Brouillons, invisibles du public.</p></article><article><h3>${counts['in-review']}</h3><p>Articles en révision, invisibles du public.</p></article><article><h3>${counts.published}</h3><p>Articles publiés dans le journal.</p></article>${counts.scheduled ? `<article><h3>${counts.scheduled}</h3><p>Articles programmés, publiés à leur heure.</p></article>` : ''}<article><h3>${bundle.authors.length}</h3><p>Signatures : les noms affichés sous les titres.</p></article></div>
    <div class="actions"><button class="primary" data-action="new-article">Créer un article</button><a class="button" href="${config.publicBasePath}/">Voir le journal</a></div>
    ${onSocle() && missingSettings(bundle.publication).length ? `<div class="notice" role="status" style="margin-top:2rem"><p><strong>Avant la première publication</strong> : il manque ${esc(missingSettings(bundle.publication).join(', '))}. ${missingSettings(bundle.publication).length > 1 ? 'Sans ces renseignements' : 'Sans ce renseignement'}, le site public refuse le contenu.</p><div class="actions">${importButton()}<button data-action="settings-view">Remplir la configuration</button></div></div>` : ''}
    ${onSocle() ? `<p class="notice" style="margin-top:2rem">Rédaction en ligne${bundle.role ? ` — votre rôle : <strong>${esc(ACCOUNT_LABELS[bundle.role] || bundle.role)}</strong>` : ''}. ${siteVivant ? 'Le site du journal montre un article dès qu’il est publié.' : 'Le journal publié se reconstruit à la prochaine synchronisation.'}${authOn() ? ' <button data-action="logout">Se déconnecter</button>' : ''}</p>` : `<h3 style="margin-top:2rem">Données d’exemple</h3><label><input id="demo-visible" type="checkbox" ${bundle.demoVisible !== false ? 'checked' : ''}> Afficher les exemples publiés sur le site</label>
    <div class="actions"><button data-action="remove-demo">Supprimer les exemples non modifiés</button><button data-action="reset-demo">Restaurer Le Quorum</button></div>`}
  </section>`;
}

function articles() {
  return `<section class="panel"><div class="toolbar"><div><h2>Articles</h2><p>Seuls les articles « Publiés » paraissent dans le journal.</p></div><button class="primary" data-action="new-article">Nouvel article</button></div>${bundle.articles.length ? '' : '<p class="empty-state">Aucun article pour l’instant. Cliquez sur « Nouvel article » pour écrire le premier.</p>'}<ul class="entity-list">${bundle.articles.map((article) => `<li><div><strong>${esc(article.title)}</strong>${article.isDemo ? ' <small>Exemple local' + (article.isUserModified ? ' modifié' : '') + '</small>' : ''}<small><span class="status-pill status-${esc(article.status)}">${statusLabel(article.status)}</span> · ${esc(articleDate(article))}${article.authors?.length ? ` · ${esc(article.authors.map((slug) => bundle.authors.find((author) => author.slug === slug)?.name || slug).join(', '))}` : ' · sans signature'}</small></div><div><button data-edit-article="${esc(article.id)}">Modifier</button> <button class="danger" data-delete-article="${esc(article.id)}">Supprimer</button></div></li>`).join('')}</ul></section>`;
}

const MEDIA_USAGE_LABELS = {
  exterior: 'Extérieur', interior: 'Intérieur', sport: 'Sport', masthead: 'Mât illustré', article: 'Article',
};

function mediaSrc(media) {
  const src = String(media?.src || '');
  if (backend?.displaySrc && src.startsWith('/media/')) return backend.displaySrc(src);
  return src.startsWith('/') ? `${config.publicBasePath}${src}` : src;
}

/** Une photo ajoutée par la rédaction (et non une photo libre du Quorum). */
function ownPhoto(media) {
  return media?.bank === 'redaction' || media?.source?.backend === 'socle';
}

function usageCount(media) {
  return bundle.articles.filter((article) => article.lead?.src === media.src || (article.media || []).some((item) => item.src === media.src)).length;
}

function cropFrames(media, prefix) {
  if (!media) return `<p class="media-quality" data-empty-crop>Aucune photo sélectionnée.</p>`;
  const position = `${media.focalPoint?.x ?? 50}% ${media.focalPoint?.y ?? 50}%`;
  return `<div class="crop-previews" data-crop-prefix="${esc(prefix)}" style="--crop-position:${esc(position)}">
    <figure class="crop-preview crop-desktop"><img src="${esc(mediaSrc(media))}" alt=""><figcaption>Ordinateur</figcaption></figure>
    <figure class="crop-preview crop-tablet"><img src="${esc(mediaSrc(media))}" alt=""><figcaption>Tablette</figcaption></figure>
    <figure class="crop-preview crop-mobile"><img src="${esc(mediaSrc(media))}" alt=""><figcaption>Mobile</figcaption></figure>
  </div>`;
}

function mediaCards(selectable = false) {
  return (bundle.media || []).map((media) => `<article class="media-card" data-media-card data-search="${esc([media.institution, media.campus, media.alt, media.credit, ...(media.keywords || [])].join(' ').toLowerCase())}" data-usages="${esc((media.usages || []).join(' '))}">
    <img src="${esc(mediaSrc(media))}" alt="${esc(media.alt)}" loading="lazy" style="object-position:${media.focalPoint?.x ?? 50}% ${media.focalPoint?.y ?? 50}%">
    <div class="media-card-body">${ownPhoto(media) ? '<p class="status-pill status-in-review">Banque de la rédaction</p>' : ''}<h3>${esc(media.institution || media.alt)}</h3><p>${esc(media.campus || media.caption || '')}</p><p class="media-tags">${(media.usages || []).map((usage) => esc(MEDIA_USAGE_LABELS[usage] || usage)).join(' · ')}</p>
    <p>${media.creditUrl ? `<a href="${esc(media.creditUrl)}" target="_blank" rel="noopener">Photo : ${esc(media.credit)}</a>` : `Photo : ${esc(media.credit || 'crédit à compléter')}`}${media.license ? ` · ${media.licenseUrl ? `<a href="${esc(media.licenseUrl)}" target="_blank" rel="noopener">${esc(media.license)}</a>` : esc(media.license)}` : ''}</p>
    ${selectable ? `<button type="button" class="primary" data-select-media="${esc(media.id)}">Choisir cette photo</button>`
      : ownPhoto(media) ? `<p class="media-quality">${usageCount(media) ? `Utilisée dans ${usageCount(media)} article(s).` : 'Pas encore utilisée.'}</p><div class="actions"><button type="button" data-edit-photo="${esc(media.id)}">Modifier la fiche</button><button type="button" class="danger" data-remove-photo="${esc(media.id)}">Retirer</button></div>`
      : media.sourceUrl ? `<a href="${esc(media.sourceUrl)}" target="_blank" rel="noopener">Voir la source</a>` : ''}</div>
  </article>`).join('');
}

function mediaFilters() {
  return `<div class="media-filters"><label>Rechercher une photo (lieu, sujet, mot-clé)<input type="search" data-media-search placeholder="Ex. : Jonquière, sport, intérieur"></label><label>Usage<select data-media-usage><option value="">Tous</option>${Object.entries(MEDIA_USAGE_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label></div>`;
}

function bindMediaFilters(host) {
  const search = host.querySelector('[data-media-search]');
  const usage = host.querySelector('[data-media-usage]');
  const filter = () => {
    const needle = search.value.trim().toLowerCase();
    host.querySelectorAll('[data-media-card]').forEach((card) => {
      card.hidden = Boolean((needle && !card.dataset.search.includes(needle)) || (usage.value && !card.dataset.usages.split(' ').includes(usage.value)));
    });
  };
  search.addEventListener('input', filter);
  usage.addEventListener('change', filter);
}

function photoFields(media = {}) {
  return `<div class="field"><label>Description accessible <small>(obligatoire)</small><input name="alt" required value="${esc(media.alt || '')}" placeholder="Ce que montre la photo"></label></div>
    <div class="field"><label>Crédit <small>(obligatoire)</small><input name="credit" required value="${esc(media.credit || '')}" placeholder="Prénom Nom ou agence"></label></div>
    <div class="field"><label>Licence<input name="license" list="license-list" value="${esc(media.license || '')}" placeholder="CC BY-SA 4.0, Tous droits réservés…"></label>${licenseList()}</div>
    <div class="field"><label>Lien de la licence<input name="licenseUrl" type="url" value="${esc(media.licenseUrl || '')}" placeholder="Se remplit pour une licence Creative Commons"></label></div>
    <div class="field"><label>Lien du crédit<input name="creditUrl" type="url" value="${esc(media.creditUrl || '')}" placeholder="https://"></label></div>
    <div class="field full"><label>Mots-clés, séparés par des virgules<input name="keywords" value="${esc((media.keywords || []).join(', '))}" placeholder="Ex. : cafétéria, rentrée, sport"></label></div>
    <fieldset class="field full"><legend>Usages</legend>${Object.entries(MEDIA_USAGE_LABELS).map(([value, label]) => `<label><input type="checkbox" name="usages" value="${value}" ${(media.usages || ['article']).includes(value) ? 'checked' : ''}> ${label}</label>`).join('')}</fieldset>`;
}

function photoDetails(form) {
  const data = new FormData(form);
  return {
    alt: String(data.get('alt') || '').trim(),
    credit: String(data.get('credit') || '').trim(),
    license: String(data.get('license') || '').trim(),
    licenseUrl: cleanLicenseUrl(data.get('licenseUrl')),
    creditUrl: String(data.get('creditUrl') || '').trim(),
    keywords: String(data.get('keywords') || '').split(',').map((item) => item.trim()).filter(Boolean),
    usages: data.getAll('usages').map(String),
  };
}

function mediaLibrary() {
  const own = (bundle.media || []).filter(ownPhoto).length;
  return `<section class="panel"><div class="toolbar"><div><h2>Photos</h2><p>La banque du journal : vos photos, réutilisables dans tous les articles et le mât, avec leur crédit. ${onSocle() ? 'Elles sont gardées sur le serveur du journal.' : 'En démonstration, elles restent dans ce navigateur. Les photos libres du Quorum montrent de vrais campus, pas l’établissement fictif du journal.'}</p></div></div>
    <details class="photo-add" ${own ? '' : 'open'}><summary>Ajouter une photo à la banque</summary><form id="photo-form" class="grid"><div class="field full"><label>Photo JPEG, PNG ou WebP, 8 Mo au plus<input name="file" type="file" accept="image/jpeg,image/png,image/webp" required></label><div id="photo-file-preview"></div></div>${photoFields()}<div class="actions full"><button class="primary" type="submit">Ajouter à la banque</button></div></form><p class="media-quality">Sans crédit, une photo ne va pas dans la banque. Vérifiez que vous avez le droit de la publier.</p></details>
    ${mediaFilters()}<div class="media-grid">${mediaCards()}</div>${(bundle.media || []).length ? '' : '<p class="empty-state">La banque est vide. Ajoutez une première photo avec le formulaire ci-dessus : elle servira ensuite dans les articles et le mât.</p>'}</section>`;
}

function photoEditor(media) {
  const dialog = document.createElement('dialog');
  dialog.className = 'media-picker';
  dialog.innerHTML = `<div class="toolbar"><h2>Fiche de la photo</h2><button type="button" data-close-media aria-label="Fermer">×</button></div><form class="grid" method="dialog"><img class="full" src="${esc(mediaSrc(media))}" alt="" style="max-height:220px;object-fit:contain">${photoFields(media)}<div class="actions full"><button class="primary" type="submit">Enregistrer la fiche</button></div></form>`;
  document.body.append(dialog);
  dialog.querySelector('[data-close-media]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const details = photoDetails(event.currentTarget);
    if (!details.credit || !details.alt) { notify('La description et le crédit sont obligatoires.'); return; }
    try {
      await backend.save('media', { ...media, ...details });
      dialog.close();
      await refresh();
      render();
      notify('Fiche enregistrée.');
    } catch (error) { notify(error.message); }
  };
  dialog.showModal();
}

async function imageSize(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => resolve({}); image.src = url; });
  } finally { URL.revokeObjectURL(url); }
}

function bindMediaLibrary() {
  const form = document.getElementById('photo-form');
  let previewUrl = '';
  form.elements.file.addEventListener('change', async () => {
    const chosen = form.elements.file.files[0];
    const box = document.getElementById('photo-file-preview');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    if (!chosen) { box.innerHTML = ''; return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(chosen.type)) { box.innerHTML = '<p class="notice" role="alert">Format non pris en charge : choisissez un JPEG, PNG ou WebP.</p>'; return; }
    previewUrl = URL.createObjectURL(chosen);
    const size = await imageSize(chosen).catch(() => ({}));
    box.innerHTML = `<p class="media-quality">Aperçu avant l’ajout${size.width ? ` : ${size.width} × ${size.height} px` : ''}, ${Math.ceil(chosen.size / 1000)} ko${chosen.size > 8_000_000 ? ' — trop lourd, 8 Mo au plus' : ''}.</p>${cropFrames({ src: previewUrl }, 'photo')}`;
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const file = form.elements.file.files[0];
    const details = photoDetails(form);
    if (!file) { notify('Choisissez une photo.'); return; }
    if (!details.alt || !details.credit) { notify('La description et le crédit sont obligatoires.'); return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await backend.uploadPhoto({ asset: { id: crypto.randomUUID(), ...details, ...await imageSize(file), focalPoint: { x: 50, y: 50 } }, file, bank: true });
      await refresh();
      render();
      notify('Photo ajoutée à la banque.');
    } catch (error) { notify(error.message, 5000); button.disabled = false; }
  };
  main.querySelectorAll('[data-edit-photo]').forEach((button) => button.onclick = () => photoEditor(bundle.media.find((item) => item.id === button.dataset.editPhoto)));
  main.querySelectorAll('[data-remove-photo]').forEach((button) => button.onclick = async () => {
    if (!confirm('Retirer cette photo de la banque?')) return;
    try { await backend.removePhoto(button.dataset.removePhoto); await refresh(); render(); notify('Photo retirée.'); } catch (error) { notify(error.message, 6000); }
  });
}

function chooseSharedMedia(onSelect, usage = '', suggestContext = null) {
  const dialog = document.createElement('dialog');
  dialog.className = 'media-picker';
  const suggestBar = suggestContext
    ? `<div class="media-suggest" data-media-suggest>
        <button type="button" class="primary" data-suggest-media>Suggérer selon le texte de l’article</button>
        <p class="media-suggest-status" data-suggest-status hidden></p>
      </div>`
    : '';
  dialog.innerHTML = `<div class="toolbar"><h2>Choisir une photo</h2><button type="button" data-close-media aria-label="Fermer">×</button></div><p>Cliquez sur une photo pour l’utiliser. Son crédit et sa licence la suivent.</p>${suggestBar}${mediaFilters()}<div class="media-grid">${mediaCards(true)}</div>`;
  document.body.appendChild(dialog);
  if (usage) dialog.querySelector('[data-media-usage]').value = usage;
  bindMediaFilters(dialog);
  dialog.querySelector('[data-media-usage]').dispatchEvent(new Event('change'));
  dialog.querySelector('[data-close-media]').onclick = () => dialog.close();
  const grid = dialog.querySelector('.media-grid');
  const paintCards = (idsInOrder = null) => {
    const cards = [...dialog.querySelectorAll('[data-media-card]')];
    if (idsInOrder) {
      const byId = new Map(cards.map((c) => [c.querySelector('[data-select-media]')?.dataset.selectMedia, c]));
      grid.innerHTML = '';
      for (const id of idsInOrder) {
        const card = byId.get(id);
        if (card) {
          card.hidden = false;
          grid.appendChild(card);
        }
      }
      // Reste de la banque en bas, masqué par défaut si suggestion.
      for (const [id, card] of byId) {
        if (!idsInOrder.includes(id)) {
          card.hidden = true;
          grid.appendChild(card);
        }
      }
    }
    dialog.querySelectorAll('[data-select-media]').forEach((button) => {
      button.onclick = () => {
        const media = bundle.media.find((item) => item.id === button.dataset.selectMedia);
        if (media) onSelect(structuredClone(media));
        dialog.close();
      };
    });
  };
  paintCards();
  const suggestBtn = dialog.querySelector('[data-suggest-media]');
  if (suggestBtn && suggestContext) {
    suggestBtn.onclick = () => {
      const ranked = rankLocalMedia(suggestContext(), bundle.media || [], { usage: usage || 'article', minScore: 40, limit: 8 });
      const status = dialog.querySelector('[data-suggest-status]');
      if (!ranked.length) {
        status.hidden = false;
        status.textContent = 'Aucune photo de la banque ne colle assez au contenu. Élargissez le titre ou parcourez la liste.';
        return;
      }
      status.hidden = false;
      status.textContent = `${ranked.length} suggestion${ranked.length > 1 ? 's' : ''} (meilleure : score ${Math.round(ranked[0].score)}). Cliquez pour choisir.`;
      // Badge score sur les cartes suggérées
      for (const hit of ranked) {
        const btn = dialog.querySelector(`[data-select-media="${hit.id}"]`);
        const card = btn?.closest('[data-media-card]');
        if (!card) continue;
        let badge = card.querySelector('[data-score-badge]');
        if (!badge) {
          badge = document.createElement('p');
          badge.dataset.scoreBadge = '1';
          badge.className = 'media-tags';
          card.querySelector('.media-card-body')?.prepend(badge);
        }
        badge.textContent = `Correspondance ${Math.round(hit.score)}`;
      }
      paintCards(ranked.map((r) => r.id));
      dialog.querySelector('[data-media-search]').value = '';
      dialog.querySelector('[data-media-usage]').value = usage || '';
    };
  }
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

async function readArticleImage(file, details = {}) {
  const allowed = ['image/png', 'image/webp', 'image/jpeg'];
  if (!allowed.includes(file.type)) throw new Error('Utilisez une photo JPEG, PNG ou WebP.');
  if (file.size > 10 * 1024 * 1024) throw new Error('La photo dépasse 10 Mo.');
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
  const dimensions = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = reject; image.src = data; });
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const checksum = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  return { id: crypto.randomUUID(), kind: 'image', src: data, alt: details.alt || '', caption: details.caption || '', credit: details.credit || '', license: details.license || '', mime: file.type, checksum, ...dimensions, source: source('media', file.name) };
}

function askForm({ title, fields, submitLabel }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'media-picker';
    dialog.style.width = 'min(28rem, calc(100vw - 2rem))';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };
    const inputs = fields.map((field) => `<div class="field"><label for="ask-${esc(field.name)}">${esc(field.label)}</label><input id="ask-${esc(field.name)}" name="${esc(field.name)}" type="text" ${field.required ? 'required' : ''} value="${esc(field.value || '')}" placeholder="${esc(field.placeholder || '')}"></div>`).join('');
    dialog.innerHTML = `<form class="grid"><h2>${esc(title)}</h2>${inputs}<div class="actions full"><button class="primary" type="submit">${esc(submitLabel)}</button><button type="button" data-cancel>Annuler</button></div></form>`;
    main.appendChild(dialog);
    dialog.querySelector('form').onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const result = {};
      for (const field of fields) result[field.name] = String(data.get(field.name) || '').trim();
      finish(result);
    };
    dialog.querySelector('[data-cancel]').onclick = () => finish(null);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    dialog.querySelector('input')?.focus();
  });
}

function articleEditor(article) {
  // Un auteur ne publie pas (le serveur refuse) : on ne lui propose pas.
  const authorOnly = onSocle() && bundle.role === 'auteur';
  const current = article || {
    id: crypto.randomUUID(), slug: '', title: '', excerpt: '', subtitle: '', dek: '', authors: [], section: orderedSections().find(sectionAllowed)?.slug || '', categories: [], tags: [], lang: bundle.publication.lang || 'fr-CA', status: 'draft', body: { format: 'markdown', raw: '' }, media: [], publication: bundle.publication.slug, updatedAt: new Date().toISOString(), canonicalUrl: '', source: source('article', 'local'),
  };
  main.innerHTML = `<section class="panel"><div class="toolbar"><h2>${article ? 'Modifier' : 'Créer'} un article</h2><button data-action="articles">Retour à la liste</button></div><form id="article-form" class="grid" novalidate>
    <input type="hidden" name="id" value="${esc(current.id)}"><div class="field"><label for="article-title">Titre (obligatoire)</label><input id="article-title" name="title" required placeholder="La cafétéria passe au local" value="${esc(current.title)}"></div><div class="field"><label for="article-slug">Adresse de l’article</label><input id="article-slug" name="slug" required value="${esc(current.slug)}"><small>Se remplit toute seule à partir du titre.</small></div>
    <div class="field full"><label for="article-excerpt">Résumé (obligatoire)</label><textarea id="article-excerpt" name="excerpt" required placeholder="Une ou deux phrases qui donnent envie de lire, affichées sous le titre dans les listes.">${esc(current.excerpt)}</textarea></div>
    <div class="field"><label for="article-section">Section</label><select id="article-section" name="section">${orderedSections().filter((item) => sectionAllowed(item) || item.slug === current.section).map((item) => `<option value="${esc(item.slug)}" ${item.slug === current.section ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="article-status">Statut</label><select id="article-status" name="status"><option value="draft" ${current.status === 'draft' ? 'selected' : ''}>Brouillon</option><option value="in-review" ${current.status === 'in-review' ? 'selected' : ''}>En révision</option><option value="scheduled" ${current.status === 'scheduled' ? 'selected' : (authorOnly ? 'disabled' : '')}>Programmé</option><option value="published" ${current.status === 'published' ? 'selected' : (authorOnly ? 'disabled' : '')}>Publié</option><option value="archived" ${current.status === 'archived' ? 'selected' : (authorOnly ? 'disabled' : '')}>Archivé</option></select><small>${authorOnly ? 'Mettez « En révision » quand c’est prêt : un réviseur, un éditeur ou l’administrateur publie.' : 'Programmé : publié tout seul à l’heure choisie. Archivé : la page reste, l’article quitte les listes.'}</small></div>
    <div class="field" data-scheduled-field ${current.status === 'scheduled' ? '' : 'hidden'}><label for="article-scheduled-at">Programmer pour</label><input id="article-scheduled-at" name="scheduledAt" type="datetime-local" value="${esc(localDateTime(current.scheduledAt))}"></div>
    <div class="field full"><label for="article-published-at">Date et heure de publication</label><input id="article-published-at" name="publishedAt" type="datetime-local" value="${esc(localDateTime(current.publishedAt))}"><small>Heure locale du journal.</small></div>
    <fieldset class="field"><legend>Signatures</legend>${bundle.authors.length ? '' : '<p class="media-quality">Aucune signature : créez-en dans « Équipe ».</p>'}${bundle.authors.map((author) => `<label><input type="checkbox" name="authors" value="${esc(author.slug)}" ${current.authors.includes(author.slug) ? 'checked' : ''}> ${esc(author.name)}</label>`).join('')}</fieldset>
    <fieldset class="field"><legend>Catégories</legend>${bundle.taxonomies.categories.length ? '' : '<p class="media-quality">Aucune catégorie (facultatif, voir « Sections et catégories »).</p>'}${bundle.taxonomies.categories.map((item) => `<label><input type="checkbox" name="categories" value="${esc(item.slug)}" ${current.categories.includes(item.slug) ? 'checked' : ''}> ${esc(item.name)}</label>`).join('')}</fieldset>
    <fieldset class="field full"><legend>Mots-clés</legend>${bundle.taxonomies.tags.length ? '' : '<p class="media-quality">Aucun mot-clé (facultatif, voir « Sections et catégories »).</p>'}${bundle.taxonomies.tags.map((item) => `<label><input type="checkbox" name="tags" value="${esc(item.slug)}" ${current.tags.includes(item.slug) ? 'checked' : ''}> ${esc(item.name)}</label>`).join('')}</fieldset>
    <fieldset class="field full media-editor"><legend>Photo principale</legend><label>Photo JPEG, PNG ou WebP<input id="article-lead-file" type="file" accept="image/jpeg,image/png,image/webp"></label><label><input type="checkbox" name="leadToBank"> Ajouter aussi cette photo à la banque (crédit obligatoire)</label><button type="button" data-action="choose-lead-media">Choisir une photo</button><button type="button" data-action="suggest-lead-media">Suggérer une photo de la banque</button><label>Description accessible (obligatoire avec une photo)<input name="leadAlt" placeholder="Ce que montre la photo" value="${esc(current.lead?.alt || '')}"></label><label>Crédit (obligatoire pour l’ajouter à la banque)<input name="leadCredit" placeholder="Prénom Nom ou agence" value="${esc(current.lead?.credit || '')}"></label><label>Légende<input name="leadCaption" value="${esc(current.lead?.caption || '')}"></label><label>Licence<input name="leadLicense" list="license-list" value="${esc(current.lead?.license || '')}"></label>${licenseList()}<label>Cadrage horizontal<input name="leadFocalX" type="range" min="0" max="100" value="${current.lead?.focalPoint?.x ?? 50}"></label><label>Cadrage vertical<input name="leadFocalY" type="range" min="0" max="100" value="${current.lead?.focalPoint?.y ?? 50}"></label><div id="article-lead-preview" class="full">${cropFrames(current.lead, 'article')}</div>${current.lead ? `<p class="media-quality">Photo actuelle : ${current.lead.width || '?'} × ${current.lead.height || '?'} px${current.lead.width && (current.lead.width < 720 || current.lead.height < 405) ? ' — résolution faible pour la vedette' : ''}.</p>` : ''}</fieldset>
    <div class="field full"><label for="article-format">Format du texte</label><select id="article-format" name="bodyFormat"><option value="markdown" ${current.body?.format !== 'html' ? 'selected' : ''}>Texte simple (Markdown)</option><option value="html" ${current.body?.format === 'html' ? 'selected' : ''}>Texte mis en forme</option></select></div>
    <div class="field full editor-shell"><div class="editor-toolbar"><button type="button" data-editor-mode="visual">Visuel</button><button type="button" data-editor-mode="source">Source</button><span data-html-tools><button type="button" data-command="bold"><strong>G</strong></button><button type="button" data-command="italic"><em>I</em></button><button type="button" data-command="formatBlock" data-value="h2">Titre</button><button type="button" data-command="createLink">Lien</button></span><label class="button">Téléverser une photo<input id="article-inline-file" type="file" accept="image/jpeg,image/png,image/webp" hidden></label><button type="button" data-action="inline-bank">Photo de la banque</button></div><p class="media-quality" data-visual-note hidden>En mode Visuel, le texte est enregistré mis en forme.</p><label for="article-body" class="sr-only">Texte de l’article</label><textarea class="body" id="article-body" name="body">${esc(current.body?.raw || '')}</textarea><div id="article-visual" class="visual-editor" contenteditable="true"></div><p class="media-quality">${onSocle() ? 'Les photos téléversées sont gardées sur le serveur du journal.' : 'Les photos téléversées restent dans ce navigateur et seront incluses dans les exports.'} Recommandation : 720 × 405 px pour une vedette.</p></div>
    <div class="actions full"><button class="primary" type="submit">Enregistrer</button><button type="button" data-action="preview">Prévisualiser sans publier</button></div></form><div id="article-preview"></div></section>`;
  const title = document.getElementById('article-title');
  const slug = document.getElementById('article-slug');
  title.addEventListener('input', () => { if (!article && !slug.dataset.touched) slug.value = slugify(title.value); });
  slug.addEventListener('input', () => { slug.dataset.touched = 'true'; });
  const format = document.getElementById('article-format');
  const body = document.getElementById('article-body');
  const visual = document.getElementById('article-visual');
  const articleForm = document.getElementById('article-form');
  const scheduledField = articleForm.querySelector('[data-scheduled-field]');
  articleForm.elements.status.addEventListener('change', () => { scheduledField.hidden = articleForm.elements.status.value !== 'scheduled'; });
  const refreshLeadCrop = () => {
    const x = Number(articleForm.elements.leadFocalX.value), y = Number(articleForm.elements.leadFocalY.value);
    articleForm.querySelector('.crop-previews')?.style.setProperty('--crop-position', `${x}% ${y}%`);
  };
  articleForm.elements.leadFocalX.addEventListener('input', refreshLeadCrop);
  articleForm.elements.leadFocalY.addEventListener('input', refreshLeadCrop);
  const applyLeadMedia = (media, msg = 'Photo sélectionnée.') => {
    current.lead = media;
    for (const [name, value] of [['leadAlt', media.alt], ['leadCredit', media.credit], ['leadCaption', media.caption], ['leadLicense', media.license]]) articleForm.elements[name].value = value || '';
    articleForm.elements.leadFocalX.value = media.focalPoint?.x ?? 50;
    articleForm.elements.leadFocalY.value = media.focalPoint?.y ?? 50;
    document.getElementById('article-lead-preview').innerHTML = cropFrames(media, 'article');
    notify(msg);
  };
  const suggestContext = () => {
    const bodyEl = document.getElementById('article-body');
    return {
      title: articleForm.elements.title?.value || '',
      excerpt: articleForm.elements.excerpt?.value || '',
      body: bodyEl?.value || '',
    };
  };
  main.querySelector('[data-action="choose-lead-media"]').onclick = () => chooseSharedMedia(applyLeadMedia, 'article', suggestContext);
  main.querySelector('[data-action="suggest-lead-media"]').onclick = () => {
    const ranked = rankLocalMedia(suggestContext(), bundle.media || [], { usage: 'article', minScore: 40, limit: 1 });
    if (!ranked.length) {
      chooseSharedMedia(applyLeadMedia, 'article', suggestContext);
      notify('Aucune suggestion nette — parcourez la banque ou affinez le titre.');
      return;
    }
    applyLeadMedia(structuredClone(ranked[0]), `Suggestion appliquée (score ${Math.round(ranked[0].score)}).`);
  };
  let editorMode = current.body?.format === 'html' ? 'visual' : 'source';
  visual.innerHTML = current.body?.format === 'html' ? sanitizePreview(current.body.raw || '') : sanitizePreview(marked.parse(current.body?.raw || '', { async: false }));
  // Ce qu'on tape en mode Visuel est du texte mis en forme : il devient le
  // texte de l'article (format HTML), au lieu d'être perdu à l'enregistrement.
  let visualDirty = false;
  let visualRange = null;
  let sourceSelection = null;
  // Les photos d'un brouillon ne sont pas encore publiques : on les montre
  // par l'adresse privée de l'admin, et on garde l'adresse du journal.
  const showVisualImages = () => visual.querySelectorAll('img[src^="/media/"]').forEach((image) => { image.dataset.src = image.getAttribute('src'); image.src = mediaSrc({ src: image.dataset.src }); });
  showVisualImages();
  const visualHtml = () => {
    // Un <template> est inerte : changer src n'y lance aucun chargement.
    const copy = document.createElement('template');
    copy.innerHTML = visual.innerHTML;
    copy.content.querySelectorAll('img[data-src]').forEach((image) => { image.setAttribute('src', image.dataset.src); image.removeAttribute('data-src'); });
    // La première ligne tapée reste un texte nu : on la range dans un <p>, comme les suivantes.
    let paragraph = null;
    for (const node of [...copy.content.childNodes]) {
      const inline = node.nodeType === 3 ? Boolean(paragraph) || node.textContent.trim() !== '' : node.nodeType === 1 && /^(A|B|BR|CODE|EM|I|MARK|S|SMALL|SPAN|STRONG|SUB|SUP|U)$/.test(node.nodeName);
      if (!inline) { paragraph = null; continue; }
      if (!paragraph) { paragraph = document.createElement('p'); copy.content.insertBefore(paragraph, node); }
      paragraph.appendChild(node);
    }
    copy.content.querySelectorAll('p').forEach((item) => { if (!item.textContent.trim() && !item.querySelector('img')) item.remove(); });
    return sanitizePreview(copy.innerHTML);
  };
  const keepVisual = () => {
    if (!visualDirty && format.value !== 'html') return;
    if (format.value !== 'html') format.value = 'html';
    body.value = visualHtml();
  };
  const syncEditor = (next = editorMode) => {
    if (editorMode === 'visual' && next === 'source') keepVisual();
    if (editorMode === 'source' && next === 'visual') { visual.innerHTML = format.value === 'html' ? sanitizePreview(body.value) : sanitizePreview(marked.parse(body.value, { async: false })); showVisualImages(); }
    editorMode = next;
    body.hidden = next !== 'source';
    visual.hidden = next !== 'visual';
    main.querySelector('[data-html-tools]').hidden = next !== 'visual';
    main.querySelector('[data-visual-note]').hidden = next !== 'visual' || format.value === 'html';
    main.querySelectorAll('[data-editor-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.editorMode === next)));
  };
  visual.addEventListener('input', () => { visualDirty = true; });
  visual.addEventListener('focus', () => { try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {} });
  const rememberRange = () => {
    const selection = document.getSelection();
    if (selection?.rangeCount && visual.contains(selection.getRangeAt(0).commonAncestorContainer)) visualRange = selection.getRangeAt(0).cloneRange();
  };
  ['keyup', 'mouseup', 'input', 'focusout'].forEach((type) => visual.addEventListener(type, rememberRange));
  const rememberSource = () => { sourceSelection = [body.selectionStart, body.selectionEnd]; };
  ['keyup', 'mouseup', 'input', 'blur'].forEach((type) => body.addEventListener(type, rememberSource));
  /** Insère une photo à l'endroit du curseur (à la fin s'il n'y en a pas). */
  const insertInlinePhoto = (media) => {
    const caption = media.credit ? `Photo : ${media.credit}${media.license ? ` (${media.license})` : ''}` : '';
    const figure = `<figure class="post-figure"><img src="${esc(media.src)}" alt="${esc(media.alt)}"><figcaption>${esc(caption)}</figcaption></figure><p></p>`;
    if (editorMode === 'visual') {
      const shown = figure.replace(`src="${esc(media.src)}"`, `src="${esc(mediaSrc(media))}" data-src="${esc(media.src)}"`);
      visual.focus();
      const selection = document.getSelection();
      selection.removeAllRanges();
      if (visualRange) selection.addRange(visualRange);
      else { const end = document.createRange(); end.selectNodeContents(visual); end.collapse(false); selection.addRange(end); }
      document.execCommand('insertHTML', false, shown);
      visualDirty = true;
      rememberRange();
      return;
    }
    const [start, end] = sourceSelection || [body.value.length, body.value.length];
    const insertion = format.value === 'html' ? `\n${figure}\n` : `\n\n![${media.alt}](${media.src})${caption ? `\n\n*${caption}*` : ''}\n\n`;
    body.setRangeText(insertion, start, end, 'end');
    rememberSource();
  };
  main.querySelectorAll('[data-editor-mode]').forEach((button) => button.onclick = () => syncEditor(button.dataset.editorMode));
  format.onchange = () => { if (editorMode === 'visual') { visual.innerHTML = format.value === 'html' ? visual.innerHTML : sanitizePreview(marked.parse(body.value, { async: false })); } syncEditor(format.value === 'html' ? 'visual' : 'source'); };
  main.querySelectorAll('[data-command]').forEach((button) => button.onclick = async () => {
    visual.focus();
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    let value = button.dataset.value || null;
    if (button.dataset.command === 'createLink') {
      const answer = await askForm({ title: 'Adresse du lien', submitLabel: 'Insérer', fields: [{ name: 'href', label: 'Adresse', placeholder: 'https://…', required: true }] });
      if (!answer?.href) return;
      value = answer.href;
      visual.focus();
      if (range) {
        const next = document.getSelection();
        next.removeAllRanges();
        next.addRange(range);
      }
    }
    if (value !== null) document.execCommand(button.dataset.command, false, value);
  });
  document.getElementById('article-inline-file').onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const answer = await askForm({ title: 'Photo dans le texte', submitLabel: 'Ajouter', fields: [{ name: 'alt', label: 'Ce que montre la photo', required: true }, { name: 'credit', label: 'Crédit photo (qui l’a prise)', required: true }, { name: 'license', label: 'Licence, facultative', placeholder: 'CC BY-SA 4.0, Tous droits réservés…' }] });
    if (!answer?.alt || !answer?.credit) { notify('La description et le crédit sont obligatoires.'); return; }
    try {
      const details = { alt: answer.alt, credit: answer.credit, license: answer.license || '', licenseUrl: LICENSES[answer.license] || '' };
      const media = onSocle()
        ? await backend.uploadPhoto({ asset: { id: crypto.randomUUID(), ...details, ...await imageSize(file) }, file, bank: false })
        : await readArticleImage(file, details);
      current.media.push({ ...media, license: details.license || media.license });
      insertInlinePhoto({ ...media, license: details.license || media.license });
      notify(media.width < 640 || media.height < 360 ? 'Photo ajoutée — résolution faible.' : 'Photo ajoutée.');
    } catch (error) { notify(error.message); }
  };
  main.querySelector('[data-action="inline-bank"]').onclick = () => chooseSharedMedia((media) => {
    if (!current.media.some((item) => item.src === media.src)) current.media.push(structuredClone(media));
    // Après la fermeture de la fenêtre de choix : le curseur revient au texte.
    setTimeout(() => insertInlinePhoto(media), 50);
    notify('Photo de la banque insérée.');
  }, '', suggestContext);
  bindRequiredFlags(document.getElementById('article-form'));
  document.getElementById('article-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!flagInvalidFields(event.currentTarget)) { notify('Remplissez les champs signalés.'); return; }
    if (editorMode === 'visual') keepVisual();
    const form = new FormData(event.currentTarget);
    let lead = current.lead;
    const leadFile = document.getElementById('article-lead-file').files[0];
    let autoStockNote = '';
    if (leadFile) {
      const details = { alt: form.get('leadAlt').trim(), credit: form.get('leadCredit').trim(), caption: form.get('leadCaption').trim(), license: form.get('leadLicense').trim() };
      const focalPoint = { x: Number(form.get('leadFocalX')), y: Number(form.get('leadFocalY')) };
      const toBank = form.get('leadToBank') === 'on';
      if (toBank && !details.credit) { notify('Pour ajouter la photo à la banque, indiquez son crédit (ou décochez la case).', 5000); return; }
      if (!details.alt) { notify('Décrivez ce que montre la photo principale.'); return; }
      try {
        if (toBank || onSocle()) {
          const saved = await backend.uploadPhoto({ asset: { id: crypto.randomUUID(), ...details, licenseUrl: LICENSES[details.license] || '', ...await imageSize(leadFile), usages: ['article'], focalPoint }, file: leadFile, bank: toBank });
          lead = { ...saved, license: details.license || saved.license || '', licenseUrl: LICENSES[details.license] || saved.licenseUrl || '', caption: details.caption, focalPoint };
        } else {
          lead = { ...await readArticleImage(leadFile, details), focalPoint };
        }
      } catch (error) { notify(error.message, 5000); return; }
    }
    else if (lead) lead = { ...lead, alt: form.get('leadAlt').trim(), credit: form.get('leadCredit').trim(), caption: form.get('leadCaption').trim(), license: form.get('leadLicense').trim(), licenseUrl: LICENSES[form.get('leadLicense').trim()] || (form.get('leadLicense').trim() === lead.license ? lead.licenseUrl : '') || '', focalPoint: { x: Number(form.get('leadFocalX')), y: Number(form.get('leadFocalY')) } };
    // Option journal : algo stock si aucune photo principale (ne remplace jamais une photo fournie).
    if (!lead?.src && bundle.publication?.media?.autoStockPhoto) {
      const ranked = rankLocalMedia(
        {
          title: form.get('title').trim(),
          excerpt: form.get('excerpt').trim(),
          body: body.value,
        },
        (bundle.media || []).filter((m) => (m.usages || []).includes('article') || (m.src || '').includes('/articles/')),
        { usage: 'article', minScore: 50, limit: 1 },
      );
      if (ranked[0]) {
        const pick = structuredClone(ranked[0]);
        delete pick.score;
        lead = {
          ...pick,
          alt: form.get('leadAlt').trim() || pick.alt || '',
          credit: form.get('leadCredit').trim() || pick.credit || '',
          caption: form.get('leadCaption').trim() || pick.caption || '',
          license: form.get('leadLicense').trim() || pick.license || '',
          focalPoint: pick.focalPoint || { x: 50, y: 48 },
        };
        autoStockNote = ` Photo libre proposée (score ${Math.round(ranked[0].score)}).`;
        articleForm.elements.leadAlt.value = lead.alt;
        articleForm.elements.leadCredit.value = lead.credit || '';
        articleForm.elements.leadCaption.value = lead.caption || '';
        articleForm.elements.leadLicense.value = lead.license || '';
        document.getElementById('article-lead-preview').innerHTML = cropFrames(lead, 'article');
      }
    }
    if (form.get('status') === 'published' && lead && !lead.alt.trim()) { notify('La description de la photo principale est obligatoire.'); return; }
    let scheduledAt = current.status === 'scheduled' ? current.scheduledAt : undefined;
    if (form.get('status') === 'scheduled') {
      const requested = form.get('scheduledAt');
      if (!requested) { notify('Choisissez la date et l’heure de publication programmée.'); return; }
      scheduledAt = new Date(requested).toISOString();
      if (Date.parse(scheduledAt) <= Date.now()) { notify('L’heure programmée est déjà passée : choisissez Publié, ou une heure à venir.', 5000); return; }
    } else scheduledAt = undefined;
    const requestedPublication = form.get('publishedAt');
    const enteredPublication = requestedPublication ? new Date(requestedPublication).toISOString() : undefined;
    const saved = {
      ...current, id: form.get('id'), title: form.get('title').trim(), slug: slugify(form.get('slug')), excerpt: form.get('excerpt').trim(), section: form.get('section'), status: form.get('status'), authors: form.getAll('authors'), categories: form.getAll('categories'), tags: form.getAll('tags'), body: { format: format.value, raw: body.value }, lead, media: current.media, publishedAt: enteredPublication || (['published', 'archived'].includes(form.get('status')) ? (current.publishedAt || new Date().toISOString()) : current.publishedAt), scheduledAt, updatedAt: new Date().toISOString(), canonicalUrl: `${String(bundle.publication.siteUrl || '').replace(/\/$/, '')}/articles/${slugify(form.get('slug'))}/`, source: current.source || source('article', form.get('id')),
    };
    try { await backend.save('article', saved); } catch (error) { notify(error.message, 6000); return; }
    await refresh(); notify(`Article enregistré.${autoStockNote}`); setView('articles');
  });
  main.querySelector('[data-action="preview"]').addEventListener('click', () => {
    if (editorMode === 'visual') keepVisual();
    const html = format.value === 'html' ? sanitizePreview(body.value) : sanitizePreview(marked.parse(body.value, { async: false }));
    document.getElementById('article-preview').innerHTML = `<article class="preview-frame"><p class="status-pill">Prévisualisation privée</p><h1>${esc(title.value)}</h1>${html}</article>`;
    document.querySelectorAll('#article-preview img[src^="/media/"]').forEach((image) => { image.src = mediaSrc({ src: image.getAttribute('src') }); });
  });
  syncEditor(editorMode);
  main.querySelector('[data-action="articles"]').onclick = () => setView('articles');
}

function authors() {
  return `${onSocle() ? '<section class="panel" id="access-panel" hidden></section>' : ''}<section class="panel"><div class="toolbar"><h2>Signatures</h2><button class="primary" data-action="new-author">Nouvelle signature</button></div><div class="notice">Une signature est le nom affiché sous le titre d’un article, avec sa fonction et sa biographie. Elle ne donne aucun accès à la rédaction : pour cela, ajoutez un compte dans « Équipe : comptes et rôles », plus haut.</div>${bundle.authors.length ? '' : '<p class="empty-state">Aucune signature pour l’instant. Créez-en une par personne qui écrit.</p>'}<ul class="entity-list">${bundle.authors.map((author) => `<li><div><strong>${esc(author.name)}</strong><small>${esc([author.role, ROLE_LABELS[author.editorialRole || 'auteur'] || author.editorialRole].filter(Boolean).join(' · '))}</small></div><div><button data-edit-author="${esc(author.id)}">Modifier</button> <button class="danger" data-delete-author="${esc(author.id)}">Supprimer</button></div></li>`).join('')}</ul></section>`;
}

function authorEditor(author) {
  const current = author || { id: crypto.randomUUID(), name: '', slug: '', role: '', editorialRole: 'auteur', bio: '', cohort: '', active: true, source: source('author', 'local') };
  main.innerHTML = `<section class="panel"><h2>${author ? 'Modifier' : 'Créer'} une signature</h2><form id="author-form" class="grid"><div class="field"><label>Nom<input name="name" required value="${esc(current.name)}"></label></div><div class="field"><label>Nom court, dans les adresses<input name="slug" value="${esc(current.slug)}" placeholder="Se remplit à partir du nom"></label></div><div class="field"><label>Fonction affichée<input name="role" value="${esc(current.role || '')}"></label></div><div class="field"><label>Rôle informatif<select name="editorialRole">${Object.entries(ROLE_LABELS).map(([value, label]) => `<option value="${value}" ${(current.editorialRole || 'auteur') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><div class="field full"><label>Biographie<textarea name="bio">${esc(current.bio || '')}</textarea></label></div><div class="actions full"><button class="primary">Enregistrer</button><button type="button" data-action="authors">Annuler</button></div></form></section>`;
  main.querySelector('form').onsubmit = async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); await backend.save('author', { ...current, name: data.get('name').trim(), slug: slugify(data.get('slug')), role: data.get('role').trim(), editorialRole: data.get('editorialRole'), bio: data.get('bio').trim() }); await refresh(); notify('Signature enregistrée.'); setView('authors'); };
  main.querySelector('[data-action="authors"]').onclick = () => setView('authors');
}

function taxonomies() {
  const group = (title, kind, values, withColor = false) => `<section><div class="toolbar"><h3>${title}</h3><button data-add-taxonomy="${kind}">Ajouter</button></div><p class="media-quality">${{ section: 'Les rubriques du menu du site. Les flèches changent leur ordre ; « Modifier » change le nom, la description et la couleur de la pastille (sans pastille propre, elle prend la couleur du journal).', category: 'Facultatif : des étiquettes transversales (ex. Entrevue, Enquête) affichées sur les articles.', tag: 'Facultatif : des mots-clés pour regrouper les articles sur un même sujet.' }[kind] || ''}</p>${values.length ? '' : `<p class="empty-state">${kind === 'section' ? 'Aucune section : ajoutez-en au moins une avant de publier.' : 'Aucun pour l’instant.'}</p>`}<ul class="entity-list">${values.map((item) => {
    const picker = withColor
      ? `<label style="display:inline-flex;align-self:center"><span class="sr-only">Couleur : ${esc(item.name)}</span><input type="color" data-taxonomy-color="${kind}:${esc(item.id)}" value="${esc(colorInputValue(item.color || bundle.publication.theme?.accent))}"></label>`
      : '';
    return `<li><div>${picker}<strong>${esc(item.name)}</strong><small data-taxonomy-code>/${esc(item.slug)}${item.color ? ` · ${esc(item.color)}` : withColor ? ' · couleur du journal' : ''}</small></div><div>${kind === 'section' ? `<button data-move-section="${esc(item.id)}:-1" aria-label="Monter ${esc(item.name)}" title="Monter">↑</button> <button data-move-section="${esc(item.id)}:1" aria-label="Descendre ${esc(item.name)}" title="Descendre">↓</button> ` : ''}<button data-edit-taxonomy="${kind}:${esc(item.id)}">Modifier</button> <button class="danger" data-delete-taxonomy="${kind}:${esc(item.id)}">Supprimer</button></div></li>`;
  }).join('')}</ul></section>`;
  return `<section class="panel"><h2>Sections et catégories</h2>${group('Sections', 'section', orderedSections(), true)}${group('Catégories', 'category', bundle.taxonomies.categories, true)}${group('Mots-clés', 'tag', bundle.taxonomies.tags, false)}</section>`;
}

/** Les sections dans l'ordre du menu du journal. */
function orderedSections() {
  return [...bundle.taxonomies.sections].sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999) || a.name.localeCompare(b.name, 'fr'));
}

function colorInputValue(value) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) return `#${raw.slice(1).split('').map((digit) => digit + digit).join('')}`;
  return '#6c2163';
}

function taxonomyEditor(kind, current) {
  const withColor = kind === 'section' || kind === 'category';
  const label = kind === 'section' ? 'une section' : kind === 'category' ? 'une catégorie' : 'un mot-clé';
  const color = colorInputValue(current?.color);
  main.innerHTML = `<section class="panel"><h2>${current ? 'Modifier' : 'Ajouter'} ${label}</h2><form id="taxonomy-form" class="grid"><div class="field"><label for="taxonomy-name">Nom</label><input id="taxonomy-name" name="name" required value="${esc(current?.name || '')}"></div>${kind === 'section' ? `<div class="field full"><label for="taxonomy-description">Description, affichée sur la page de la section</label><textarea id="taxonomy-description" name="description">${esc(current?.description || '')}</textarea></div>` : ''}${withColor ? `<div class="field"><label><input name="ownColor" type="checkbox" ${current?.color ? 'checked' : ''}> Pastille de cette couleur</label><label for="taxonomy-color">Couleur</label><input id="taxonomy-color" name="color" type="color" value="${esc(color)}"></div><p class="media-quality full">Sans pastille propre, l’étiquette suit la couleur de marque du journal.</p>` : ''}<div class="actions full"><button class="primary" type="submit">Enregistrer</button><button type="button" data-action="taxonomies">Annuler</button></div></form></section>`;
  main.querySelector('[data-action="taxonomies"]').onclick = () => setView('taxonomies');
  document.getElementById('taxonomy-form').onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') || '').trim();
    if (!name) return;
    let color;
    if (withColor && data.has('ownColor')) {
      color = colorInputValue(data.get('color'));
    }
    const next = {
      ...current,
      id: current?.id || crypto.randomUUID(),
      name,
      slug: current?.slug || slugify(name),
      order: current?.order ?? (kind === 'section' ? bundle.taxonomies.sections.length + 1 : undefined),
    };
    if (kind === 'section') next.description = String(data.get('description') || '').trim();
    if (color) next.color = color;
    else delete next.color;
    await backend.save(kind, next);
    await refresh();
    notify(current ? 'Entrée enregistrée.' : 'Entrée ajoutée.');
    setView('taxonomies');
  };
}


function detectedSiteUrl() {
  return `${location.origin}${socleRoot()}/`;
}

function parseScoreLine(line, teamId) {
  const parts = String(line || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const date = parts[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const score = parts[2].match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (!score) return null;
  const venue = (parts[3] || '').toLowerCase();
  const home = venue.startsWith('dom') ? true : (venue.startsWith('ext') ? false : undefined);
  const forScore = Number(score[1]);
  const against = Number(score[2]);
  const result = forScore > against ? 'W' : forScore < against ? 'L' : 'D';
  return { date, opponent: parts[1], scoreFor: forScore, scoreAgainst: against, result, home, teamId };
}

function parseNextLine(line, teamId) {
  const parts = String(line || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const date = parts[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = parts[1] && /^\d{1,2}:\d{2}$/.test(parts[1]) ? parts[1] : '';
  const opponent = time ? (parts[2] || '') : parts[1];
  if (!opponent) return null;
  const venue = (time ? parts[3] : parts[2] || '').toLowerCase();
  const home = venue.startsWith('dom') ? true : (venue.startsWith('ext') ? false : undefined);
  const next = { date, opponent, teamId };
  if (time) next.time = time;
  if (home !== undefined) next.home = home;
  return next;
}

function formatScoreLine(game) {
  if (!game) return '';
  const venue = game.home === true ? 'domicile' : game.home === false ? 'extérieur' : '';
  return [game.date, game.opponent, `${game.scoreFor}-${game.scoreAgainst}`, venue].filter(Boolean).join(', ');
}

function formatNextLine(game) {
  if (!game) return '';
  const venue = game.home === true ? 'domicile' : game.home === false ? 'extérieur' : '';
  return [game.date, game.time, game.opponent, venue].filter(Boolean).join(', ');
}

function sportsTeamsFromPublication(publication) {
  const sports = publication?.masthead?.sports || {};
  if (Array.isArray(sports.teams) && sports.teams.length) return sports.teams;
  return sports.team ? [sports.team] : [];
}

function sportsTeamFields(team = {}) {
  const results = (team.results || []).map(formatScoreLine).filter(Boolean).join('\n');
  const next = formatNextLine(team.nextGame);
  return `<fieldset class="field full" data-sports-team>
    <input type="hidden" data-team-id value="${esc(team.id || '')}">
    <label>Nom de l’équipe<input data-team-name placeholder="Les Hiboux" value="${esc(team.name || '')}"></label>
    <label>Code court, 2 à 4 lettres<input data-team-code maxlength="4" placeholder="HIB" value="${esc(team.code || '')}"></label>
    <label>Sport<input data-team-sport placeholder="Hockey" value="${esc(team.sport || '')}"></label>
    <label>Établissement<input data-team-institution placeholder="Cégep de Sainte-Foy" value="${esc(team.institution || '')}"></label>
    <label>Résultats, un par ligne<textarea data-team-results rows="3" placeholder="2026-11-12, Carabins, 4-2, domicile">${esc(results)}</textarea></label>
    <small>Format : date (AAAA-MM-JJ), adversaire, vos points-leurs points, domicile ou extérieur.</small>
    <label>Prochain match<input data-team-next placeholder="2026-11-20, 19:00, Carabins, domicile" value="${esc(next)}"></label>
    <small>Format : date, heure facultative, adversaire, domicile ou extérieur.</small>
    <div class="actions"><button type="button" data-remove-team>Retirer cette équipe</button></div>
  </fieldset>`;
}

function readSportsForm(form) {
  const teams = [];
  form.querySelectorAll('[data-sports-team]').forEach((block) => {
    const name = block.querySelector('[data-team-name]').value.trim();
    const sport = block.querySelector('[data-team-sport]').value.trim();
    if (!name && !sport) return;
    const id = block.querySelector('[data-team-id]').value.trim() || (crypto.randomUUID ? crypto.randomUUID() : `equipe-${teams.length + 1}`);
    const code = block.querySelector('[data-team-code]').value.trim().toUpperCase();
    const institution = block.querySelector('[data-team-institution]').value.trim();
    const results = block.querySelector('[data-team-results]').value.split('\n').map((line) => parseScoreLine(line, id)).filter(Boolean);
    const nextGame = parseNextLine(block.querySelector('[data-team-next]').value, id);
    const team = { id, name: name || sport || 'Équipe', code, sport: sport || 'Sport' };
    if (institution) team.institution = institution;
    if (results.length) team.results = results;
    if (nextGame) team.nextGame = nextGame;
    teams.push(team);
  });
  return { enabled: form.elements.sportsEnabled.checked, teams };
}

function bindSportsForm(form) {
  const list = form.querySelector('[data-sports-teams]');
  form.querySelector('[data-add-team]').addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', sportsTeamFields());
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-team]');
    if (!button) return;
    button.closest('[data-sports-team]')?.remove();
  });
}

function settings() {
  const publication = bundle.publication;
  const masthead = publication.masthead || {};
  const governance = publication.governance || {};
  const missing = missingSettings(publication);
  return `<section class="panel"><div class="toolbar"><h2>Configuration du journal</h2>${importButton()}</div>${missing.length ? `<p class="notice" role="status">À remplir avant de publier : ${esc(missing.join(', '))}.</p>` : ''}<form id="settings-form" class="grid" novalidate>
    <p class="media-quality full">Les exemples en gris pâle disparaissent quand vous écrivez ; ils ne sont jamais enregistrés.</p>
    <div class="field"><label>Nom (obligatoire)<input name="name" required placeholder="La Vigie" value="${esc(publication.name)}"></label></div>
    <fieldset class="field full"><legend>Adresse, organisme et contacts</legend>
      <label>Adresse du site public<input name="siteUrl" type="url" placeholder="https://votre-journal.com/" value="${esc(publication.siteUrl || detectedSiteUrl())}"></label><small>${(() => { const detected = detectedSiteUrl(); const current = String(publication.siteUrl || '').replace(/\/+$/, ''); return !onSocle() || !current || current === detected.replace(/\/+$/, '') ? `Détectée automatiquement : ${esc(detected)}` : `L’adresse enregistrée ne correspond plus à l’emplacement actuel du site (${esc(detected)}). Enregistrez pour la mettre à jour, ou corrigez-la.`; })()}</small>
      <label>Nom court du journal, utilisé dans les adresses (obligatoire)<input name="slug" required placeholder="la-vigie" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="${esc(publication.slug === 'mon-journal' ? slugify(publication.name || '') : publication.slug || '')}"></label><small>Lettres minuscules, chiffres et tirets, par exemple la-boussole.</small>
      <label>Organisme ou personne responsable<input name="owner" placeholder="Association étudiante du Cégep de Sainte-Foy" value="${esc(governance.owner || '')}"></label>
      <label>Courriel de la rédaction<input name="contact" type="email" placeholder="redaction@exemple.ca" value="${esc(governance.contact || '')}"></label>
      <label>Dépôt GitHub du journal, facultatif<input name="repo" placeholder="organisation/journal" value="${esc(governance.repo || '')}"></label>
      <label><input name="noindex" type="checkbox" ${publication.noindex ? 'checked' : ''}> Cacher le journal des moteurs de recherche (journal d’essai ou fictif)</label><label><input name="fictif" type="checkbox" ${publication.fictif ? 'checked' : ''}> Afficher le bandeau « Journal étudiant fictif »</label>
    </fieldset><div class="field"><label>Signature<input name="tagline" placeholder="Le journal étudiant du Cégep de Sainte-Foy" value="${esc(publication.tagline || '')}"></label></div><div class="field"><label>Établissement<input name="institution" placeholder="Cégep de Sainte-Foy" value="${esc(publication.institution || '')}"></label></div><div class="field"><label>Année de fondation (facultatif)<input name="founded" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" data-erreur="Écrivez l’année en quatre chiffres, par exemple 1971." placeholder="1971" value="${esc(publication.founded || '')}"></label><small>Au bas des pages : « © 1971–${new Date().getFullYear()} ». Vide : seulement l’année courante.</small></div><div class="field"><label>Droits sur les articles<select name="license"><option value="" ${/by-nc-nd/i.test(publication.license || '') ? '' : 'selected'}>Tous droits réservés (par défaut)</option><option value="CC BY-NC-ND 4.0" ${/by-nc-nd/i.test(publication.license || '') ? 'selected' : ''}>Creative Commons BY-NC-ND 4.0 : partage permis, sans modification ni usage commercial</option></select></label></div><div class="field"><label>Typographie<select name="typography"><option value="modern-accessible">Moderne accessible</option><option value="editorial-classic" ${publication.theme?.typography === 'editorial-classic' ? 'selected' : ''}>Éditoriale classique</option><option value="institutional" ${publication.theme?.typography === 'institutional' ? 'selected' : ''}>Institutionnelle</option></select></label></div>
    <div class="field"><label>Fuseau horaire<select name="timeZone"><option value="America/Toronto" ${publication.timeZone !== 'America/Blanc-Sablon' ? 'selected' : ''}>Heure de l’Est — majorité du Québec</option><option value="America/Blanc-Sablon" ${publication.timeZone === 'America/Blanc-Sablon' ? 'selected' : ''}>Heure de l’Atlantique — Blanc-Sablon</option></select></label></div>
    <div class="field"><label>Couleur principale<input name="accent" type="color" value="${esc(publication.theme?.accent || '#6c2163')}"></label></div><div class="field"><label>Couleur sombre<input name="accentDark" type="color" value="${esc(publication.theme?.accentDark || '#cf7ec1')}"></label></div><div id="admin-contrast" class="notice full" role="status"></div>
    <fieldset class="field full"><legend>Mât illustré</legend><label><input name="backgroundsEnabled" type="checkbox" ${masthead.backgrounds?.enabled !== false ? 'checked' : ''}> Afficher les images de fond</label><label>Ajouter mes propres images<input id="background-files" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><div class="actions"><button type="button" data-action="choose-masthead-media">Choisir une photo</button><button type="button" data-action="clear-backgrounds">Retirer toutes les images</button></div><p>${masthead.backgrounds?.images?.length || 0} image(s) enregistrée(s). Un nouvel envoi les ajoute à la rotation.</p><label>Cadrage horizontal<input name="mastheadFocalX" type="range" min="0" max="100" value="${masthead.backgrounds?.images?.[0]?.focalPoint?.x ?? 50}"></label><label>Cadrage vertical<input name="mastheadFocalY" type="range" min="0" max="100" value="${masthead.backgrounds?.images?.[0]?.focalPoint?.y ?? 50}"></label><label>Assombrir l’image derrière le titre<input name="overlayStrength" type="range" min="0" max="0.9" step="0.05" value="${masthead.overlayStrength ?? 0.55}"></label><label>Alignement du titre<select name="textAlignment"><option value="left">Gauche</option><option value="center" ${masthead.textAlignment === 'center' ? 'selected' : ''}>Centre</option><option value="right" ${masthead.textAlignment === 'right' ? 'selected' : ''}>Droite</option></select></label><div id="masthead-crop-preview">${cropFrames(masthead.backgrounds?.images?.[0], 'masthead')}</div></fieldset>
    <fieldset class="field"><legend>Météo</legend><label><input name="weatherEnabled" type="checkbox" ${masthead.weather?.enabled ? 'checked' : ''}> Afficher la météo</label><label>Localités, séparées par des virgules<input name="weatherLocalities" value="${esc((masthead.weather?.localities || []).join(', '))}" placeholder="Québec"></label><small>Maximum quatre.</small></fieldset>
    <fieldset class="field full"><legend>Sports — Au tableau</legend>
      <label><input name="sportsEnabled" type="checkbox" ${(masthead.sports?.enabled !== false && sportsTeamsFromPublication(publication).length) || masthead.sports?.enabled ? 'checked' : ''}> Afficher les scores dans le mât et la page « Au tableau »</label>
      <p class="muted">Ajoutez à la main les équipes du cégep, leurs résultats et le prochain match. La page « Au tableau » n’apparaît que si au moins une équipe est enregistrée.</p>
      <div data-sports-teams>${sportsTeamsFromPublication(publication).map((team) => sportsTeamFields(team)).join('') || sportsTeamFields()}</div>
      <div class="actions"><button type="button" data-add-team>Ajouter une équipe</button></div>
    </fieldset>
    <fieldset class="field"><legend>Outils</legend><label><input name="pomodoro" type="checkbox" ${masthead.tools?.pomodoro !== false ? 'checked' : ''}> Pomodoro LE-RADAR.ca</label><label><input name="solitaire" type="checkbox" ${masthead.tools?.solitaire !== false ? 'checked' : ''}> Solitaire LE-RADAR.ca</label></fieldset>
    <fieldset class="field full"><legend>Radio étudiante</legend><label><input name="radioEnabled" type="checkbox" ${publication.radio?.enabled !== false ? 'checked' : ''}> Afficher la barre radio sous le mât</label><label>Station<select name="station" id="radar-stations"><option value="">Choisir une station</option>${publication.radio?.station ? `<option value="${esc(publication.radio.station)}" selected>${esc(publication.radio.station)}</option>` : ''}</select></label><small>La barre est le module de LE-RADAR : ses stations et son lecteur se mettent à jour chez LE-RADAR, sans toucher au journal. Éteinte, la barre n’existe pas et rien ne part vers le-radar.ca.</small></fieldset>
    <fieldset class="field full"><legend>Photos d’articles</legend>
      <label><input name="autoStockPhoto" type="checkbox" ${publication.media?.autoStockPhoto ? 'checked' : ''}> Proposer une photo libre si aucune n’est fournie</label>
      <small>Le Kiosque choisit, dans la banque du journal, la photo la plus proche du titre et du texte. Une photo choisie ou téléversée manuellement n’est jamais remplacée. Désactivez pour exiger une photo soumise à chaque article.</small>
    </fieldset>
    <div class="field full"><label>Logo local (SVG, PNG, WebP ou JPEG)<input id="logo-file" type="file" accept="image/svg+xml,image/png,image/webp,image/jpeg"></label><label>Texte alternatif<input name="logoAlt" placeholder="${esc(publication.name || 'La Vigie')}" value="${esc(publication.logo?.alt || '')}"></label><small>Vide : le nom du journal sert de texte alternatif. Vérifiez vos droits d’utilisation pour chaque image téléversée.</small><div id="logo-preview"></div></div>
    <div class="actions full"><button class="primary">Enregistrer</button><button type="button" data-action="recommended-theme">Réinitialiser le thème recommandé</button></div></form></section>`;
}

async function readLogo(file, alt) {
  const allowed = ['image/svg+xml', 'image/png', 'image/webp', 'image/jpeg'];
  if (!allowed.includes(file.type)) throw new Error('Format de logo non pris en charge.');
  const limit = file.type === 'image/svg+xml' ? 512 * 1024 : 2 * 1024 * 1024;
  if (file.size > limit) throw new Error('Le logo dépasse la taille maximale permise.');
  let data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
  if (file.type === 'image/svg+xml') {
    const raw = await file.text();
    const documentSvg = new DOMParser().parseFromString(raw, 'image/svg+xml');
    documentSvg.querySelectorAll('script,foreignObject').forEach((node) => node.remove());
    documentSvg.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attribute) => { if (/^on/i.test(attribute.name) || /^(?:https?:|javascript:)/i.test(attribute.value)) node.removeAttribute(attribute.name); }));
    data = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(documentSvg.documentElement))))}`;
  }
  return { id: crypto.randomUUID(), kind: 'image', src: data, alt: alt || bundle.publication.name, mime: file.type, source: source('media', file.name) };
}

function exportsView() {
  if (onSocle()) {
    return `<section class="panel"><h2>Exporter mon journal</h2><p>Le journal est déjà gardé sur le serveur. Ces boutons en téléchargent une copie de plus sur cet ordinateur ; elle ne contient aucun mot de passe.</p><input id="export-filter" type="hidden" value="all"><div class="actions"><button class="primary" data-action="export-zip">Télécharger les articles (fichiers texte Markdown)</button><button data-action="export-json">Télécharger une copie des données (JSON)</button></div><p class="notice">Pour restaurer une archive, ouvrez la page <a href="${socleRoot()}/admin/sauvegarde">Sauvegarde</a>.</p></section>`;
  }
  return `<section class="panel"><h2>Exporter mon journal</h2><p>Les archives sont créées dans ce navigateur. Elles ne contiennent aucun mot de passe, jeton ou secret.</p><div class="field"><label>Contenu de l’export<select id="export-filter"><option value="all">Tout, exemples compris</option><option value="without-demo">Exclure les exemples</option><option value="user-content">Créé ou modifié par moi</option></select></label></div><div class="actions"><button class="primary" data-action="export-zip">Télécharger le journal Markdown</button><button data-action="export-json">Télécharger la sauvegarde JSON</button><button data-action="import-json">Importer une sauvegarde</button><input id="import-file" type="file" accept="application/json" hidden></div><hr><h2>Après la démonstration</h2><div class="post-demo"><article><h3>1. Exporter mon journal</h3><p>Gardez le ZIP Markdown et une sauvegarde JSON.</p></article><article><h3>2. Passer à Sveltia + GitHub</h3><p>Créez un dépôt avec « Use this template », copiez l’export, puis activez Actions et Pages. Cette étape est manuelle et demande les droits GitHub du dépôt.</p><a href="https://github.com/azdak919/le-kiosque/generate">Créer le dépôt</a></article><article><h3>3. Future option PocketBase</h3><p>Point d’extension prévu, mais aucun backend PocketBase, compte ou hébergement n’est offert actuellement.</p></article></div><section class="panel danger-zone"><h3>Réinitialiser Le Quorum</h3><p>La réinitialisation complète efface les changements locaux de ce navigateur. Exportez-les d’abord.</p><button class="danger" data-action="full-reset">Réinitialiser Le Quorum</button></section></section>`;
}

function bindCommon() {
  main.querySelectorAll('[data-action="new-article"]').forEach((button) => button.onclick = () => articleEditor());
  main.querySelectorAll('[data-action="articles"]').forEach((button) => button.onclick = () => setView('articles'));
  main.querySelectorAll('[data-action="authors"]').forEach((button) => button.onclick = () => setView('authors'));
  main.querySelectorAll('[data-edit-article]').forEach((button) => button.onclick = () => articleEditor(bundle.articles.find((item) => item.id === button.dataset.editArticle)));
  main.querySelectorAll('[data-delete-article]').forEach((button) => button.onclick = async () => { if (!confirm('Supprimer cet article de ce navigateur?')) return; await backend.remove('article', button.dataset.deleteArticle); await refresh(); render(); });
  main.querySelectorAll('[data-edit-author]').forEach((button) => button.onclick = () => authorEditor(bundle.authors.find((item) => item.id === button.dataset.editAuthor)));
  main.querySelectorAll('[data-delete-author]').forEach((button) => button.onclick = async () => { if (!confirm('Supprimer cette signature?')) return; await backend.remove('author', button.dataset.deleteAuthor); await refresh(); render(); });
  main.querySelector('[data-action="new-author"]')?.addEventListener('click', () => authorEditor());
  main.querySelectorAll('[data-action="settings-view"]').forEach((button) => button.onclick = () => setView('settings'));
  bindImport(main);
}

function render() {
  applyRoleNav();
  if (onSocle() && bundle.role === 'photographe' && !['dashboard', 'media'].includes(view)) { view = 'media'; history.replaceState(null, '', '#media'); }
  if (onSocle() && authOn() && bundle.role && !isAdminRole() && view === 'settings') { view = 'dashboard'; history.replaceState(null, '', '#dashboard'); }
  main.innerHTML = ({ dashboard, articles, media: mediaLibrary, authors, taxonomies, settings, exports: exportsView }[view] || dashboard)();
  bindLogout(main);
  if (view === 'authors') fillAccessPanel();
  bindCommon();
  if (view === 'media') bindMediaLibrary();
  if (view === 'dashboard' && !onSocle()) {
    document.getElementById('demo-visible').onchange = async (event) => { await backend.setDemoVisibility(event.target.checked); await refresh(); notify('Affichage des exemples mis à jour.'); };
    main.querySelector('[data-action="remove-demo"]').onclick = async () => { if (!confirm('Supprimer uniquement les exemples jamais modifiés? Vos contenus seront conservés.')) return; await backend.removeDemo(); await refresh(); render(); };
    main.querySelector('[data-action="reset-demo"]').onclick = async (event) => {
      if (!confirm('Restaurer une copie propre des exemples du Quorum? La configuration et vos contenus seront conservés.')) return;
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Restauration en cours…';
      try {
        await backend.resetDemo();
        await refresh();
        render();
        // Après render() : toast plus long (import banque lent) pour les tests e2e / lecture humaine.
        notify('Les exemples du Quorum sont restaurés.', 8000);
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Restaurer Le Quorum';
        notify(error?.message || 'Échec de la restauration des exemples.');
      }
    };
  }
  if (view === 'taxonomies') {
    main.querySelectorAll('[data-add-taxonomy]').forEach((button) => button.onclick = () => taxonomyEditor(button.dataset.addTaxonomy));
    main.querySelectorAll('[data-move-section]').forEach((button) => button.onclick = async () => {
      const [id, step] = button.dataset.moveSection.split(':');
      const list = orderedSections();
      const from = list.findIndex((item) => item.id === id);
      const to = from + Number(step);
      if (from < 0 || to < 0 || to >= list.length) return;
      [list[from], list[to]] = [list[to], list[from]];
      try {
        // On renumérote tout : des ordres égaux ou absents ne bloquent plus.
        for (const [index, item] of list.entries()) if (Number(item.order) !== index + 1) await backend.save('section', { ...item, order: index + 1 });
        await refresh(); render(); notify('Ordre des sections enregistré.');
      } catch (error) { notify(error?.message || 'L’ordre n’a pas été enregistré.'); }
    });
    main.querySelectorAll('[data-edit-taxonomy]').forEach((button) => button.onclick = () => {
      const [kind, id] = button.dataset.editTaxonomy.split(':');
      const values = kind === 'section' ? bundle.taxonomies.sections : kind === 'category' ? bundle.taxonomies.categories : bundle.taxonomies.tags;
      taxonomyEditor(kind, values.find((item) => item.id === id));
    });
    main.querySelectorAll('[data-delete-taxonomy]').forEach((button) => button.onclick = async () => { const [kind, id] = button.dataset.deleteTaxonomy.split(':'); if (!confirm('Supprimer cette entrée?')) return; await backend.remove(kind, id); await refresh(); render(); });
    main.querySelectorAll('[data-taxonomy-color]').forEach((input) => input.addEventListener('change', async () => {
      const [kind, id] = input.dataset.taxonomyColor.split(':');
      const values = kind === 'section' ? bundle.taxonomies.sections : bundle.taxonomies.categories;
      const current = values.find((item) => item.id === id);
      if (!current) return;
      const color = colorInputValue(input.value);
      try {
        await backend.save(kind, { ...current, color });
        await refresh();
        const code = input.closest('li')?.querySelector('[data-taxonomy-code]');
        if (code) code.textContent = `/${current.slug} · ${color}`;
        notify('Couleur enregistrée.');
      } catch (error) {
        notify(error?.message || 'La couleur n’a pas été enregistrée.');
      }
    }));
  }
  if (view === 'media') bindMediaFilters(main);
  if (view === 'settings') {
    // Liste des stations : lue chez LE-RADAR, seulement si la radio est
    // allumée (éteinte, rien ne part vers le-radar.ca). Sans réponse, le
    // champ reste un texte libre.
    const stationList = main.querySelector('#radar-stations');
    const fillStations = () => {
      if (stationList.dataset.loaded || !main.querySelector('[name="radioEnabled"]')?.checked) return;
      stationList.dataset.loaded = '1';
      const chosen = stationList.value;
      fetch('https://le-radar.ca/radios.json', { credentials: 'omit' }).then((r) => (r.ok ? r.json() : [])).then((list) => {
        const items = (Array.isArray(list) ? list : (list?.stations || [])).filter((item) => item?.id);
        if (!items.length) return;
        stationList.innerHTML = `<option value="">Choisir une station</option>${items.map((item) => `<option value="${esc(item.id)}" ${item.id === chosen ? 'selected' : ''}>${esc([item.name, item.institution].filter(Boolean).join(' — '))}</option>`).join('')}`;
      }).catch(() => {});
    };
    main.querySelector('[name="radioEnabled"]')?.addEventListener('change', fillStations);
    fillStations();
    const form = document.getElementById('settings-form');
    let selectedMasthead = structuredClone(bundle.publication.masthead?.backgrounds?.images?.[0] || null);
    let clearMastheadImages = false;
    const refreshMastheadCrop = () => {
      const x = Number(form.elements.mastheadFocalX.value), y = Number(form.elements.mastheadFocalY.value);
      form.querySelector('#masthead-crop-preview .crop-previews')?.style.setProperty('--crop-position', `${x}% ${y}%`);
    };
    form.elements.mastheadFocalX.addEventListener('input', refreshMastheadCrop);
    form.elements.mastheadFocalY.addEventListener('input', refreshMastheadCrop);
    main.querySelector('[data-action="choose-masthead-media"]').onclick = () => chooseSharedMedia((media) => {
      selectedMasthead = media;
      clearMastheadImages = false;
      form.elements.mastheadFocalX.value = media.focalPoint?.x ?? 50;
      form.elements.mastheadFocalY.value = media.focalPoint?.y ?? 50;
      document.getElementById('masthead-crop-preview').innerHTML = cropFrames(media, 'masthead');
      form.elements.backgroundsEnabled.checked = true;
      notify('Photo du mât sélectionnée.');
    }, 'masthead');
    const updateContrast = () => { const ratio = contrastRatio(form.elements.accent.value); document.getElementById('admin-contrast').textContent = ratio >= 4.5 ? `Contraste AA avec du texte blanc : ${ratio.toFixed(2)}:1.` : `Avertissement : contraste de ${ratio.toFixed(2)}:1 avec du texte blanc. La sauvegarde reste permise.`; };
    form.elements.accent.addEventListener('input', updateContrast); updateContrast();
    // La couleur sombre suit la principale, tant qu'on ne la choisit pas soi-même.
    let darkTouched = Boolean(bundle.publication.theme?.accentDark) && bundle.publication.theme.accentDark !== darkVariant(bundle.publication.theme?.accent || '#6c2163');
    form.elements.accentDark.addEventListener('input', () => { darkTouched = true; });
    form.elements.accent.addEventListener('input', () => { if (!darkTouched) form.elements.accentDark.value = darkVariant(form.elements.accent.value); });
    const showLogo = bindMastPreview(document.getElementById('logo-preview'), {
      file: document.getElementById('logo-file'),
      current: bundle.publication.logo?.src ? mediaSrc(bundle.publication.logo) : '',
      name: () => form.elements.name.value.trim(),
      color: () => form.elements.accent.value,
      sections: () => [...bundle.taxonomies.sections].sort((a, b) => (a.order || 0) - (b.order || 0)).map((item) => item.name),
      maxBytes: 2 * 1024 * 1024,
    });
    form.elements.name.addEventListener('input', showLogo); form.elements.accent.addEventListener('input', showLogo);
    document.getElementById('background-files').addEventListener('change', (event) => {
      const chosen = event.target.files[0];
      if (!chosen) return;
      document.getElementById('masthead-crop-preview').innerHTML = cropFrames({ src: URL.createObjectURL(chosen), focalPoint: { x: Number(form.elements.mastheadFocalX.value), y: Number(form.elements.mastheadFocalY.value) } }, 'masthead');
    });
    bindRequiredFlags(form);
    bindSportsForm(form);
    form.onsubmit = async (event) => { event.preventDefault(); if (!flagInvalidFields(form)) { notify('Remplissez les champs signalés.'); return; } const data = new FormData(form); const publication = structuredClone(bundle.publication); publication.name = data.get('name').trim(); publication.tagline = data.get('tagline').trim(); publication.institution = data.get('institution').trim(); publication.founded = String(data.get('founded') || '').trim(); publication.license = String(data.get('license') || ''); publication.timeZone = data.get('timeZone'); publication.siteUrl = data.get('siteUrl').trim(); publication.slug = slugify(data.get('slug')) || publication.slug; publication.governance = { ...publication.governance, owner: data.get('owner').trim(), contact: data.get('contact').trim(), repo: data.get('repo').trim() }; publication.noindex = data.has('noindex'); publication.fictif = data.has('fictif'); publication.theme = { accent: data.get('accent'), accentDark: data.get('accentDark'), typography: data.get('typography') }; publication.radio = { ...publication.radio, enabled: data.has('radioEnabled'), station: String(data.get('station') || '').trim().toLowerCase(), theme: 'dark', position: 'top' }; delete publication.radio.stream; delete publication.radio.name; delete publication.radio.frequency; delete publication.radio.website; publication.media = { ...publication.media, autoStockPhoto: data.has('autoStockPhoto') }; const localities = data.get('weatherLocalities').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 4); const priorImages = clearMastheadImages ? [] : (publication.masthead?.backgrounds?.images || []); const selected = selectedMasthead ? { ...selectedMasthead, focalPoint: { x: Number(data.get('mastheadFocalX')), y: Number(data.get('mastheadFocalY')) } } : null; publication.masthead = { backgrounds: { enabled: data.has('backgroundsEnabled'), images: selected ? [selected, ...priorImages.filter((item) => item.id !== selected.id)] : priorImages }, weather: { enabled: data.has('weatherEnabled'), localities }, sports: readSportsForm(form), tools: { pomodoro: data.has('pomodoro'), solitaire: data.has('solitaire') }, overlayStrength: Math.min(0.9, Math.max(0, Number(data.get('overlayStrength')))), textAlignment: data.get('textAlignment') }; for (const file of document.getElementById('background-files').files) publication.masthead.backgrounds.images.push({ ...await readArticleImage(file, { alt: `Arrière-plan du journal ${publication.name}` }), focalPoint: { x: 50, y: 50 } }); const logoFile = document.getElementById('logo-file').files[0]; if (logoFile) publication.logo = await readLogo(logoFile, data.get('logoAlt').trim()); else if (publication.logo) publication.logo.alt = data.get('logoAlt').trim() || publication.name; await backend.savePublication(publication); await refresh(); notify('Configuration enregistrée.'); render(); };
    main.querySelector('[data-action="clear-backgrounds"]').onclick = () => { selectedMasthead = null; clearMastheadImages = true; form.elements.backgroundsEnabled.checked = false; document.getElementById('masthead-crop-preview').innerHTML = cropFrames(null, 'masthead'); notify('Les images seront retirées à l’enregistrement.'); };
    main.querySelector('[data-action="recommended-theme"]').onclick = () => { form.elements.typography.value = 'modern-accessible'; form.elements.accent.value = '#6c2163'; form.elements.accentDark.value = '#cf7ec1'; };
  }
  if (view === 'exports') {
    const backup = () => backend.createBackup({ filter: document.getElementById('export-filter').value });
    main.querySelector('[data-action="export-json"]').onclick = async () => download(`${bundle.publication.slug}-sauvegarde.json`, JSON.stringify(await backup(), null, 2), 'application/json');
    main.querySelector('[data-action="export-zip"]').onclick = async () => { const data = await backup(); download(`${bundle.publication.slug}-journal.zip`, zipStore(await markdownFiles(data, config.publicBasePath, { privateFile: backend.displaySrc ? (src) => backend.displaySrc(src) : null }))); };
    if (onSocle()) return;
    const input = document.getElementById('import-file'); main.querySelector('[data-action="import-json"]').onclick = () => input.click(); input.onchange = async () => { const file = input.files[0]; if (!file) return; const data = JSON.parse(await file.text()); if (!confirm(`Importer la sauvegarde « ${data.bundle?.publication?.name || file.name} »? Les données locales actuelles seront remplacées.`)) return; await backend.restoreBackup(data); await refresh(); notify('Sauvegarde importée.'); setView('dashboard'); };
    main.querySelector('[data-action="full-reset"]').onclick = async () => { if (!confirm('Réinitialiser complètement Le Quorum et effacer tous les changements locaux? Cette action est irréversible sans sauvegarde.')) return; await backend.resetDemo({ full: true }); await refresh(); notify('Le Quorum a été réinitialisé.'); setView('dashboard'); };
  }
}

document.querySelectorAll('.admin-nav [data-view]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  setView(link.dataset.view);
  main.focus({ preventScroll: true });
}));
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
setView(location.hash.slice(1));

if (onSocle()) siteVivant = await fetch(`${socleRoot()}/kiosque-vivant.json`, { cache: 'no-store' }).then((r) => r.ok).catch(() => false);

try {
  backend = await getBackend();
  backend.subscribe(async () => { await refresh(); if (!main.querySelector('form')) render(); });
  await refresh();
  if (await finishAssistant()) location.hash = 'dashboard';
  render();
} catch (error) {
  if (onSocle() && error.status === 401) await loginScreen();
  else {
  console.error(error);
  main.innerHTML = `<section class="panel"><h2>${onSocle() ? 'Impossible de joindre le serveur du journal' : 'Impossible d’ouvrir les données locales'}</h2><p>${esc(error.message)}</p><div class="actions"><button onclick="location.reload()">Réessayer</button><a class="button" href="${config.publicBasePath}/">Utiliser le journal statique</a></div></section>`;
  }
}
