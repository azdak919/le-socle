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
