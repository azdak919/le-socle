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
  credits: false,
});

/** Long côté maximal après réduction dans le navigateur. */
export const LONG_SIDE = 2400;

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

function injectFields(item, pond, { requireCredit, defaults = {} }) {
  const file = item.container?.querySelector('.filepond--file');
  if (!file || file.querySelector('[data-pond-fields]')) return;
  const box = document.createElement('div');
  box.className = 'pond-fields';
  box.dataset.pondFields = '1';
  const id = item.id;
  box.innerHTML = `
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
  file.append(box);
  const sync = () => {
    item.setMetadata('alt', box.querySelector('[data-pond-alt]').value.trim());
    item.setMetadata('credit', box.querySelector('[data-pond-credit]').value.trim());
    item.setMetadata('caption', box.querySelector('[data-pond-caption]').value.trim());
  };
  box.addEventListener('input', sync);
  sync();
  return box;
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
  const pond = FilePond.create(input, {
    allowMultiple: multiple,
    maxFiles,
    maxFileSize: '8MB',
    acceptedFileTypes: ['image/jpeg', 'image/png', 'image/webp'],
    fileValidateTypeLabelExpectedTypes: 'JPEG, PNG ou WebP',
    allowRevert: true,
    instantUpload: false,
    allowProcess: false,
    imagePreviewHeight: 140,
    imageResizeTargetWidth: LONG_SIDE,
    imageResizeTargetHeight: LONG_SIDE,
    imageResizeMode: 'contain',
    imageResizeUpscale: false,
    imageTransformOutputQuality: 85,
    imageTransformOutputQualityMode: 'always',
    imageTransformOutputMimeType: null,
    labelIdle: labelIdle || undefined,
    stylePanelLayout: 'compact',
    credits: false,
    onaddfile: (error, item) => {
      if (error || !item) return;
      injectFields(item, pond, { requireCredit, defaults });
    },
  });

  const checksums = () => knownChecksums(typeof media === 'function' ? media() : media);

  const readFields = (item) => {
    const box = item.container?.querySelector('[data-pond-fields]');
    return {
      alt: (box?.querySelector('[data-pond-alt]')?.value || item.getMetadata('alt') || defaults.alt || '').trim(),
      credit: (box?.querySelector('[data-pond-credit]')?.value || item.getMetadata('credit') || defaults.credit || '').trim(),
      caption: (box?.querySelector('[data-pond-caption]')?.value || item.getMetadata('caption') || defaults.caption || '').trim(),
    };
  };

  const flagDuplicate = async (item, file) => {
    const hex = await sha256Hex(await file.arrayBuffer());
    const known = checksums().get(hex);
    const notice = item.container?.querySelector('[data-pond-duplicate]');
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
