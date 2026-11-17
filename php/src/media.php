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
