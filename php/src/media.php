<?php
declare(strict_types=1);

function socle_media_path(string $src): string {
    $path = ltrim($src, '/');
    if ($path === '' || str_contains($path, '..') || str_contains($path, '\\')) throw new SocleHttp('chemin refusé');
    return $path;
}

function socle_credit_queue(SocleStore $store): array {
    $queue = [];
    foreach ($store->list('media') as $row) {
        if (!str_starts_with($row['key'], 'queue:credit:')) continue;
        $queue[] = ['id' => substr($row['key'], strlen('queue:credit:')), 'src' => $row['value']];
    }
    return $queue;
}

function socle_handle_media(string $method, string $url, array $config, SocleStore $store): array {
    $path = socle_request_path($url);
    if (!$config['modules']['media'] || $path !== '/admin/medias' || $method !== 'GET') return socle_result(404);
    $lang = socle_lang($url);
    $copy = $lang === 'en'
        ? ['title' => 'Media', 'empty' => 'No credit waiting.', 'missing' => 'This image has no credit. It stays in the mirror.']
        : ['title' => 'Médias', 'empty' => 'Aucun crédit en attente.', 'missing' => "Cette image n'a pas de crédit. Elle reste dans le miroir."];
    $items = '';
    foreach (socle_credit_queue($store) as $item) {
        $items .= '<li>' . $item['src'] . '<p>' . $copy['missing'] . '</p></li>';
    }
    $list = $items !== '' ? '<ul>' . $items . '</ul>' : '<p>' . $copy['empty'] . '</p>';
    return socle_admin_document($lang, $copy['title'], $list);
}

/** Toutes les adresses `/media/…` citées dans une valeur, texte compris. */
function socle_media_refs(mixed $value, array &$into): void {
    if (is_string($value)) {
        if (preg_match_all('~/media/[A-Za-z0-9._/-]+~', $value, $matches)) {
            foreach ($matches[0] as $match) $into[$match] = true;
        }
    } elseif (is_array($value)) {
        foreach ($value as $item) socle_media_refs($item, $into);
    }
}

/**
 * `GET /media/…` : seulement une photo qu'un article publié (ou archivé),
 * une signature ou la fiche du journal utilise. Même règle que Node
 * (`src/public-media.ts`). `null` : ce n'est pas une photo publique.
 */
function socle_public_media(string $method, string $path, array $config, SocleStore $store): ?array {
    if (($method !== 'GET' && $method !== 'HEAD') || !str_starts_with($path, '/media/') || !$config['modules']['editorial']) return null;
    $wanted = rawurldecode($path);
    if (str_contains($wanted, '..') || str_contains($wanted, '\\') || str_contains($wanted, "\0")) return null;
    try {
        $refs = [];
        socle_media_refs(socle_snapshot($store, 'public'), $refs);
    } catch (Throwable) {
        return null;
    }
    if (!isset($refs[$wanted])) return null;
    $bytes = socle_redaction_bytes($store, $wanted);
    if ($bytes === null) return null;
    $type = socle_sniff_image($bytes);
    if ($type === null) return null;
    return socle_result(200, $bytes, ['content-type' => $type, 'cache-control' => 'public, max-age=3600', 'x-content-type-options' => 'nosniff']);
}

/** Largeurs (côté long) des miniatures d'affichage. */
function socle_media_variant_widths(): array {
    return [480, 960, 1600];
}

function socle_gd_available(): bool {
    if (getenv('SOCLE_DISABLE_GD') === '1') return false;
    return extension_loaded('gd') && function_exists('imagecreatetruecolor') && function_exists('imagecopyresampled');
}

/** Le format peut-il être lu et réencodé par cette installation de GD ? */
function socle_gd_can_encode(string $mime): bool {
    if (!socle_gd_available()) return false;
    $info = gd_info();
    return match ($mime) {
        'image/jpeg' => function_exists('imagejpeg') && !empty($info['JPEG Support']),
        'image/png' => function_exists('imagepng') && !empty($info['PNG Support']),
        'image/webp' => function_exists('imagewebp') && !empty($info['WebP Support']),
        default => false,
    };
}

/** Réécrit un JPEG avec GD : mêmes dimensions, sans EXIF ni GPS. null si GD manque, si ce n'est pas un JPEG, ou en cas d'échec. Les PNG et WebP restent inchangés. */
function socle_gd_rewrite(string $bytes, string $mime): ?string {
    if ($mime !== 'image/jpeg' || !socle_gd_can_encode($mime)) return null;
    $image = socle_gd_from_bytes($bytes, $mime);
    if ($image === null) return null;
    $out = socle_gd_to_bytes($image, $mime);
    imagedestroy($image);
    return $out === false ? null : $out;
}

/** @return \GdImage|null */
function socle_gd_from_bytes(string $bytes, string $mime): mixed {
    $decoded = @imagecreatefromstring($bytes);
    return $decoded === false ? null : $decoded;
}

function socle_gd_to_bytes(mixed $image, string $mime): string|false {
    ob_start();
    $ok = false;
    if ($mime === 'image/png') $ok = imagepng($image, null, 6);
    elseif ($mime === 'image/webp' && function_exists('imagewebp')) $ok = imagewebp($image, null, 85);
    else $ok = imagejpeg($image, null, 85);
    $data = ob_get_clean();
    return $ok ? $data : false;
}

/**
 * Miniatures du côté long 480, 960 et 1600 px, sans agrandir.
 * Tableau d'entrées {width,height,src,bytes} ; vide si GD manque.
 */
function socle_media_make_variants(string $bytes, string $mime, string $id, string $ext): array {
    if (!socle_gd_can_encode($mime)) return [];
    $source = socle_gd_from_bytes($bytes, $mime);
    if ($source === null) return [];
    $srcW = imagesx($source);
    $srcH = imagesy($source);
    $long = max($srcW, $srcH);
    $variants = [];
    foreach (socle_media_variant_widths() as $target) {
        if ($target >= $long) continue;
        $scale = $target / $long;
        $width = max(1, (int) round($srcW * $scale));
        $height = max(1, (int) round($srcH * $scale));
        $canvas = imagecreatetruecolor($width, $height);
        if ($mime === 'image/png' || $mime === 'image/webp') {
            imagealphablending($canvas, false);
            imagesavealpha($canvas, true);
            $transparent = imagecolorallocatealpha($canvas, 0, 0, 0, 127);
            imagefilledrectangle($canvas, 0, 0, $width, $height, $transparent);
        }
        imagecopyresampled($canvas, $source, 0, 0, 0, 0, $width, $height, $srcW, $srcH);
        $out = socle_gd_to_bytes($canvas, $mime);
        imagedestroy($canvas);
        if ($out === false) continue;
        $variants[] = [
            'width' => $width,
            'height' => $height,
            'src' => '/media/banque/' . $id . '-' . $target . '.' . $ext,
            'bytes' => $out,
        ];
    }
    imagedestroy($source);
    return $variants;
}

function socle_media_store_variants(SocleStore $store, array $variants): array {
    $meta = [];
    foreach ($variants as $variant) {
        $store->put('media', 'bytes:' . socle_media_path($variant['src']), base64_encode($variant['bytes']));
        $meta[] = ['width' => $variant['width'], 'height' => $variant['height'], 'src' => $variant['src']];
    }
    return $meta;
}

function socle_media_delete_files(SocleStore $store, array $asset): void {
    $store->delete('media', 'bytes:' . socle_media_path((string) ($asset['src'] ?? '')));
    foreach (($asset['variants'] ?? []) as $variant) {
        if (!is_array($variant) || !is_string($variant['src'] ?? null)) continue;
        $store->delete('media', 'bytes:' . socle_media_path($variant['src']));
    }
}

function socle_media_checksum(string $bytes): string {
    return hash('sha256', $bytes);
}

/** Une autre fiche de la banque a déjà la même empreinte. */
function socle_media_duplicate(SocleStore $store, string $checksum, string $ignoreId = ''): ?array {
    if ($checksum === '') return null;
    foreach (socle_rows($store, 'media') as $row) {
        if (!str_starts_with($row['key'], 'library:')) continue;
        $item = json_decode($row['value'], true);
        if (!is_array($item)) continue;
        if (($item['id'] ?? '') === $ignoreId) continue;
        if (($item['checksum'] ?? '') === $checksum) return $item;
    }
    return null;
}

function socle_media_used_in_masthead(SocleStore $store, string $src): bool {
    $raw = $store->get('editorial', 'publication');
    if ($raw === null) return false;
    $publication = json_decode($raw, true);
    if (!is_array($publication)) return false;
    foreach (($publication['masthead']['backgrounds']['images'] ?? []) as $image) {
        if (is_array($image) && ($image['src'] ?? null) === $src) return true;
    }
    return false;
}


/** Fiches de la banque indexées par leur adresse publique. */
function socle_media_by_src(SocleStore $store): array {
    $map = [];
    try {
        $rows = socle_rows($store, 'media');
    } catch (ModuleOff) {
        return [];
    }
    foreach ($rows as $row) {
        if (!str_starts_with($row['key'], 'library:')) continue;
        $item = json_decode($row['value'], true);
        if (is_array($item) && is_string($item['src'] ?? null)) $map[$item['src']] = $item;
    }
    return $map;
}

/**
 * Recopie les miniatures de la banque sur les photos citées (à la une, mât, etc.)
 * pour que l'instantané public les serve et que le site les mette dans le srcset.
 */
function socle_attach_variants(mixed &$value, array $bySrc): void {
    if (!is_array($value)) return;
    if (is_string($value['src'] ?? null) && isset($bySrc[$value['src']]) && is_array($bySrc[$value['src']]['variants'] ?? null)) {
        $value['variants'] = $bySrc[$value['src']]['variants'];
        if (empty($value['width']) && isset($bySrc[$value['src']]['width'])) $value['width'] = $bySrc[$value['src']]['width'];
        if (empty($value['height']) && isset($bySrc[$value['src']]['height'])) $value['height'] = $bySrc[$value['src']]['height'];
    }
    foreach ($value as &$item) socle_attach_variants($item, $bySrc);
    unset($item);
}
