/**
 * FilePond pour la banque de photos du Socle.
 * Glisser-déposer, envoi de plusieurs photos, réduction dans le navigateur
 * (long côté 2400 px), réencodage qui retire EXIF et GPS, orientation corrigée.
 * L'envoi passe par l'API JSON /v1/redaction/photo (pas un formulaire multipart).
 */
import * as FilePond from './filepond.esm.min.js';
import FilePondPluginImagePreview from './filepond-plugin-image-preview.esm.min.js';
import FilePondPluginImageResize from './filepond-plugin-image-resize.esm.min.js';
import FilePondPluginImageTransform from './filepond-plugin-image-transform.esm.min.js';
import FilePondPluginImageExifOrientation from './filepond-plugin-image-exif-orientation.esm.min.js';
import FilePondPluginFileValidateType from './filepond-plugin-file-validate-type.esm.min.js';
import FilePondPluginFileValidateSize from './filepond-plugin-file-validate-size.esm.min.js';
import fr from './filepond-locale-fr-fr.js';

FilePond.registerPlugin(
  FilePondPluginFileValidateType,
  FilePondPluginFileValidateSize,
  FilePondPluginImageExifOrientation,
  FilePondPluginImagePreview,
  FilePondPluginImageResize,
  FilePondPluginImageTransform,
);

FilePond.setOptions({
  ...fr,
  labelIdle: 'Faites glisser vos photos ou <span class="filepond--label-action">parcourir</span>',
  labelFileSizeBytes: 'o',
  labelFileSizeKilobytes: 'ko',
  labelFileSizeMegabytes: 'Mo',
  labelFileSizeGigabytes: 'Go',
  labelDecimalSeparator: ',',
  labelThousandsSeparator: ' ',
  // FilePond 4.32 ignore labelDecimalSeparator dans l’affichage de la taille
  // (séparateur codé en dur) : le fichier vendu est ajusté pour la virgule.
  credits: false,
});

/** Long côté maximal après réduction dans le navigateur. */
export const LONG_SIDE = 2400;

/** Taille affichée à la française : « 94 ko », « 1,2 Mo ». */
export function formatFileSizeFr(bytes) {
  const size = Math.round(Math.abs(Number(bytes) || 0));
  if (size < 1000) return `${size} o`;
  if (size < 1e6) return `${Math.floor(size / 1000)} ko`;
  const format = (value, digits) => {
    const raw = value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
    return raw.replace('.', ',');
  };
  if (size < 1e9) return `${format(size / 1e6, 1)} Mo`;
  return `${format(size / 1e9, 2)} Go`;
}

function writeSizeLabel(item) {
  const sub = item?.container?.querySelector('.filepond--file-info-sub');
  const bytes = item?.fileSize ?? item?.file?.size;
  if (sub && Number.isFinite(bytes)) {
    const label = formatFileSizeFr(bytes);
    if (sub.textContent !== label) sub.textContent = label;
  }
}

function applySizeLabel(item, attempts = 0) {
  writeSizeLabel(item);
  if (attempts < 24) requestAnimationFrame(() => applySizeLabel(item, attempts + 1));
}

function watchSizeLabels(pond) {
  const tick = () => pond.getFiles().forEach(writeSizeLabel);
  const root = pond.element;
  if (!root) return;
  const obs = new MutationObserver(tick);
  obs.observe(root, { subtree: true, childList: true, characterData: true });
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function knownChecksums(media = []) {
  return new Map(
    (media || [])
      .filter((item) => item?.checksum)
      .map((item) => [item.checksum, item]),
  );
}

function fieldsHost(pond) {
  const parent = pond.element?.parentElement;
  if (!parent) return null;
  let host = parent.querySelector(':scope > [data-pond-host]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'pond-host';
    host.dataset.pondHost = '1';
    pond.element.after(host);
  }
  return host;
}

function fieldBox(item, pond) {
  const id = item?.id;
  if (!id) return null;
  return fieldsHost(pond)?.querySelector(`[data-pond-fields="${CSS.escape(id)}"]`) || null;
}

function syncFieldOrder(pond) {
  const host = fieldsHost(pond);
  if (!host) return;
  for (const item of pond.getFiles()) {
    const box = fieldBox(item, pond);
    if (box) host.append(box);
  }
}

function injectFields(item, pond, { requireCredit, defaults = {} }) {
  const host = fieldsHost(pond);
  if (!host) return;
  if (fieldBox(item, pond)) return fieldBox(item, pond);
  const box = document.createElement('div');
  box.className = 'pond-fields';
  box.dataset.pondFields = item.id;
  const name = item.filename || item.file?.name || 'Photo';
  box.innerHTML = `
    <p class="pond-fields-name">${escapeAttr(name)}</p>
    <label>Description accessible <small>(obligatoire)</small>
      <input type="text" data-pond-alt required placeholder="Ce que montre la photo" value="${escapeAttr(defaults.alt || '')}">
    </label>
    <label>Crédit ${requireCredit ? '<small>(obligatoire)</small>' : ''}
      <input type="text" data-pond-credit ${requireCredit ? 'required' : ''} placeholder="Prénom Nom ou agence" value="${escapeAttr(defaults.credit || '')}">
    </label>
    <label>Légende
      <input type="text" data-pond-caption placeholder="Texte affiché sous la photo" value="${escapeAttr(defaults.caption || '')}">
    </label>
    <p class="pond-duplicate" data-pond-duplicate hidden></p>`;
  host.append(box);
  const sync = () => {
    item.setMetadata('alt', box.querySelector('[data-pond-alt]').value.trim());
    item.setMetadata('credit', box.querySelector('[data-pond-credit]').value.trim());
    item.setMetadata('caption', box.querySelector('[data-pond-caption]').value.trim());
  };
  box.addEventListener('input', sync);
  sync();
  syncFieldOrder(pond);
  return box;
}

function injectWhenReady(item, pond, opts, attempts = 0) {
  if (!item) return;
  if (injectFields(item, pond, opts)) return;
  if (attempts > 40) return;
  requestAnimationFrame(() => injectWhenReady(item, pond, opts, attempts + 1));
}

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/**
 * Prépare une photo : orientation EXIF respectée, long côté borné, réencodage
 * sans métadonnées. FilePond fait le même travail via ses greffons ; cette
 * fonction sert aussi de repli et de vérification.
 */
export async function preparePhoto(file, { longSide = LONG_SIDE, quality = 0.85 } = {}) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    const scale = long > longSide ? longSide / long : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const type = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('Réencodage impossible.'))), type, quality);
    });
    const prepared = new File([blob], file.name || 'photo', { type: blob.type, lastModified: Date.now() });
    prepared._width = width;
    prepared._height = height;
    return prepared;
  } finally {
    bitmap.close?.();
  }
}

export function mountPhotoPond(input, options = {}) {
  const {
    multiple = true,
    requireCredit = true,
    maxFiles = multiple ? 20 : 1,
    defaults = {},
    media = [],
    labelIdle,
  } = options;
  const checksums = () => knownChecksums(typeof media === 'function' ? media() : media);
  let flagDuplicate = async () => ({ checksum: '', duplicate: null });

  const pond = FilePond.create(input, {
    ...(labelIdle ? { labelIdle } : {}),
    allowMultiple: multiple,
    maxFiles,
    maxFileSize: '8MB',
    acceptedFileTypes: ['image/jpeg', 'image/png', 'image/webp'],
    fileValidateTypeLabelExpectedTypes: 'JPEG, PNG ou WebP',
    allowRevert: true,
    instantUpload: false,
    allowProcess: false,
    imagePreviewHeight: 120,
    imageResizeTargetWidth: LONG_SIDE,
    imageResizeTargetHeight: LONG_SIDE,
    imageResizeMode: 'contain',
    imageResizeUpscale: false,
    imageTransformOutputQuality: 85,
    imageTransformOutputQualityMode: 'always',
    imageTransformOutputMimeType: null,
    stylePanelLayout: 'compact',
    credits: false,
    onaddfile: (error, item) => {
      if (error || !item) return;
      injectWhenReady(item, pond, { requireCredit, defaults });
      applySizeLabel(item);
      preparePhoto(item.file).then((prepared) => flagDuplicate(item, prepared)).catch(() => {});
    },
    onremovefile: (_error, item) => {
      fieldBox(item, pond)?.remove();
    },
    onreorderfiles: () => syncFieldOrder(pond),
  });

  const readFields = (item) => {
    const box = fieldBox(item, pond);
    return {
      alt: (box?.querySelector('[data-pond-alt]')?.value || item.getMetadata('alt') || defaults.alt || '').trim(),
      credit: (box?.querySelector('[data-pond-credit]')?.value || item.getMetadata('credit') || defaults.credit || '').trim(),
      caption: (box?.querySelector('[data-pond-caption]')?.value || item.getMetadata('caption') || defaults.caption || '').trim(),
    };
  };

  flagDuplicate = async (item, file) => {
    const hex = await sha256Hex(await file.arrayBuffer());
    const known = checksums().get(hex);
    const notice = fieldBox(item, pond)?.querySelector('[data-pond-duplicate]');
    if (notice && known) {
      notice.hidden = false;
      notice.textContent = `Cette photo est déjà dans la banque${known.alt ? ` (« ${known.alt} »)` : ''}. Vous pouvez l’ajouter quand même.`;
    } else if (notice) {
      notice.hidden = true;
      notice.textContent = '';
    }
    return { checksum: hex, duplicate: known || null };
  };

  pond.collectPhotos = async () => {
    const items = pond.getFiles();
    if (!items.length) return [];
    const photos = [];
    for (const item of items) {
      const details = readFields(item);
      if (!details.alt) throw new Error('Indiquez une description accessible pour chaque photo.');
      if (requireCredit && !details.credit) throw new Error('Indiquez le crédit de chaque photo.');
      const original = item.file;
      const prepared = await preparePhoto(original);
      const { checksum, duplicate } = await flagDuplicate(item, prepared);
      photos.push({
        file: prepared,
        alt: details.alt,
        credit: details.credit,
        caption: details.caption,
        width: prepared._width,
        height: prepared._height,
        checksum,
        duplicate,
      });
    }
    return photos;
  };

  pond.hasFiles = () => pond.getFiles().length > 0;
  pond.clearPhotos = () => pond.removeFiles();
  return pond;
}

export { FilePond };
