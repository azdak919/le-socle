<?php
declare(strict_types=1);

// API de rédaction en JSON : même contrat que src/redaction-http.ts.
// Lire l'en-tête de ce fichier Node pour les règles (local, rôles, JSON).

const SOCLE_REDACTION_KINDS = ['author', 'section', 'category', 'tag'];
const SOCLE_REDACTION_EDITORS = ['reviseur', 'editeur', 'responsable'];
const SOCLE_REDACTION_PUBLIC = ['published', 'scheduled', 'archived', 'retracted'];
const SOCLE_REDACTION_MAX = 8388608;
const SOCLE_REDACTION_EXT = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];

function socle_redaction_json(int $status, mixed $value): array {
    return socle_result($status, socle_json($value), ['content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store']);
}

function socle_redaction_fail(int $status, string $message): array {
    return socle_redaction_json($status, ['error' => $message]);
}

function socle_sniff_image(string $bytes): ?string {
    if (strlen($bytes) > 3 && str_starts_with($bytes, "\xff\xd8\xff")) return 'image/jpeg';
    if (strlen($bytes) > 8 && str_starts_with($bytes, "\x89PNG")) return 'image/png';
    if (strlen($bytes) > 12 && substr($bytes, 0, 4) === 'RIFF' && substr($bytes, 8, 4) === 'WEBP') return 'image/webp';
    return null;
}

function socle_redaction_text(mixed $value, int $max = 2000): string {
    return is_string($value) ? mb_substr(trim($value), 0, $max) : '';
}

function socle_redaction_list(mixed $value): array {
    if (!is_array($value)) return [];
    $out = [];
    foreach ($value as $item) {
        if (!is_string($item)) continue;
        $clean = trim($item);
        if ($clean !== '') $out[] = $clean;
    }
    return $out;
}

function socle_redaction_clamp(mixed $value): float|int {
    $number = is_numeric($value) ? $value + 0 : 50;
    return min(100, max(0, $number));
}

function socle_redaction_library(SocleStore $store, array $config): array {
    if (!$config['modules']['media']) return [];
    $items = [];
    foreach (socle_rows($store, 'media') as $row) {
        if (!str_starts_with($row['key'], 'library:')) continue;
        $parsed = json_decode($row['value'], true);
        if (is_array($parsed)) $items[] = $parsed;
    }
    usort($items, static fn (array $a, array $b): int => strcmp((string) $a['id'], (string) $b['id']));
    return $items;
}

function socle_redaction_state(SocleStore $store, array $config, ?string $role): array {
    $articles = socle_read_articles($store);
    usort($articles, static fn (array $a, array $b): int => strcmp((string) ($b['publishedAt'] ?? $b['updatedAt'] ?? ''), (string) ($a['publishedAt'] ?? $a['updatedAt'] ?? '')));
    return [
        'format' => 'socle-redaction',
        'version' => 1,
        'publication' => socle_read_publication($store),
        'articles' => $articles,
        'authors' => socle_read_kind($store, 'author:'),
        'taxonomies' => [
            'sections' => socle_read_kind($store, 'section:'),
            'categories' => socle_read_kind($store, 'category:'),
            'tags' => socle_read_kind($store, 'tag:'),
        ],
        'media' => socle_redaction_library($store, $config),
        'demoVisible' => $store->get('editorial', 'demo-visible') !== '0',
        'modules' => ['media' => (bool) $config['modules']['media'], 'review' => (bool) $config['modules']['review'], 'auth' => (bool) $config['modules']['auth']],
        'role' => $role,
        'syncedAt' => socle_iso(socle_now()),
    ];
}

function socle_redaction_local(): bool {
    $address = $_SERVER['REMOTE_ADDR'] ?? '';
    if (!in_array($address, ['127.0.0.1', '::1', '::ffff:127.0.0.1'], true)) return false;
    foreach (['HTTP_X_FORWARDED_FOR', 'HTTP_FORWARDED', 'HTTP_X_REAL_IP', 'HTTP_CF_CONNECTING_IP'] as $header) {
        if (!empty($_SERVER[$header])) return false;
    }
    return true;
}

function socle_redaction_bytes(SocleStore $store, string $src): ?string {
    try {
        $path = socle_media_path($src);
    } catch (SocleHttp) {
        return null;
    }
    $raw = null;
    try {
        $raw = $store->get('media', 'bytes:' . $path);
    } catch (ModuleOff) {
    }
    if ($raw === null) {
        try {
            $raw = $store->get('editorial', 'bytes:' . $path);
        } catch (ModuleOff) {
        }
    }
    if ($raw === null) return null;
    $bytes = base64_decode($raw, true);
    return $bytes === false ? null : $bytes;
}

function socle_handle_redaction(string $method, string $uri, array $config, SocleStore $store, string $raw, ?string $actor, bool $defined): array {
    $path = socle_request_path($uri);
    if (!$config['modules']['editorial'] || !str_starts_with($path, '/v1/redaction/')) return socle_result(404);
    if (!$defined) {
        if (!socle_redaction_local()) return socle_redaction_fail(403, "Sans le module auth, la rédaction ne s'ouvre que depuis la machine du socle.");
        $role = 'responsable';
    } else {
        if ($actor === null || $actor === '') return socle_redaction_fail(401, 'Connexion requise.');
        $role = socle_role_of($store, $actor);
        if ($role === null) return socle_redaction_fail(403, "Ce compte n'a pas de rôle dans la rédaction.");
    }
    $editor = in_array($role, SOCLE_REDACTION_EDITORS, true);

    if ($method === 'GET' && $path === '/v1/redaction/etat') {
        return socle_redaction_json(200, socle_redaction_state($store, $config, $role));
    }
    if ($method === 'GET' && $path === '/v1/redaction/fichier') {
        parse_str((string) (parse_url($uri, PHP_URL_QUERY) ?? ''), $query);
        $bytes = socle_redaction_bytes($store, is_string($query['src'] ?? null) ? $query['src'] : '');
        if ($bytes === null) return socle_redaction_fail(404, 'Fichier absent.');
        return socle_result(200, $bytes, ['content-type' => socle_sniff_image($bytes) ?? 'application/octet-stream', 'cache-control' => 'private, max-age=300', 'x-content-type-options' => 'nosniff']);
    }
    if ($method !== 'POST') return socle_result(405, '', ['allow' => 'GET, POST']);
    $type = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
    if (!str_starts_with($type, 'application/json')) return socle_redaction_fail(415, 'Envoyez du JSON (content-type: application/json).');
    $body = socle_object_body($raw);
    if ($body === null) return socle_redaction_fail(400, 'JSON illisible.');
    $now = socle_iso(socle_now());

    try {
        if ($path === '/v1/redaction/article') {
            $input = is_array($body['article'] ?? null) ? $body['article'] : [];
            $publication = socle_read_publication($store);
            if ($publication === null) return socle_redaction_fail(409, "Créez d'abord la publication.");
            $articles = socle_read_articles($store);
            $existing = null;
            foreach ($articles as $item) if (($item['id'] ?? null) === ($input['id'] ?? null)) $existing = $item;
            $id = socle_redaction_text($input['id'] ?? null, 80);
            if ($id === '') $id = $existing['id'] ?? socle_uuid();
            $status = socle_redaction_text($input['status'] ?? null, 20);
            $bodyIn = is_array($input['body'] ?? null) ? $input['body'] : [];
            $article = array_merge($existing ?? [], $input, [
                'id' => $id,
                'slug' => socle_redaction_text($input['slug'] ?? null, 96),
                'publication' => $publication['slug'],
                'title' => socle_redaction_text($input['title'] ?? null, 300),
                'excerpt' => socle_redaction_text($input['excerpt'] ?? null, 2000),
                'body' => ['format' => ($bodyIn['format'] ?? '') === 'html' ? 'html' : 'markdown', 'raw' => is_string($bodyIn['raw'] ?? null) ? $bodyIn['raw'] : ''],
                'media' => is_array($input['media'] ?? null) ? $input['media'] : ($existing['media'] ?? []),
                'authors' => socle_redaction_list($input['authors'] ?? null),
                'categories' => socle_redaction_list($input['categories'] ?? null),
                'tags' => socle_redaction_list($input['tags'] ?? null),
                'lang' => socle_redaction_text($input['lang'] ?? null, 12) ?: ($existing['lang'] ?? 'fr-CA'),
                'status' => $status,
                'updatedAt' => $now,
                'canonicalUrl' => socle_redaction_text($input['canonicalUrl'] ?? null, 500) ?: ($existing['canonicalUrl'] ?? ''),
                'source' => ['backend' => 'socle', 'backendId' => $id, 'fetchedAt' => $now],
            ]);
            $section = socle_redaction_text($input['section'] ?? null, 96);
            if ($section === '') unset($article['section']); else $article['section'] = $section;
            $published = socle_redaction_text($input['publishedAt'] ?? null, 40);
            if ($published !== '') $article['publishedAt'] = $published;
            elseif ($status === 'published' || $status === 'archived') $article['publishedAt'] = $existing['publishedAt'] ?? $now;
            elseif (isset($existing['publishedAt'])) $article['publishedAt'] = $existing['publishedAt'];
            else unset($article['publishedAt']);
            $touches = in_array($status, SOCLE_REDACTION_PUBLIC, true) || ($existing !== null && in_array($existing['status'] ?? '', SOCLE_REDACTION_PUBLIC, true));
            if ($touches && !$editor) return socle_redaction_fail(403, 'Publier ou programmer demande un réviseur, un éditeur ou le responsable.');
            foreach ($articles as $item) {
                if (($item['slug'] ?? '') === $article['slug'] && ($item['id'] ?? '') !== $id) {
                    return socle_redaction_fail(409, "L'adresse « " . $article['slug'] . ' » est déjà prise par un autre article.');
                }
            }
            return socle_redaction_json(200, ['article' => socle_save_article($store, $article, $now)]);
        }
        if ($path === '/v1/redaction/entite') {
            $kind = socle_redaction_text($body['kind'] ?? null, 20);
            if (!in_array($kind, SOCLE_REDACTION_KINDS, true)) return socle_redaction_fail(400, 'Genre inconnu.');
            if ($kind !== 'author' && !$editor) return socle_redaction_fail(403, 'Les sections, catégories et étiquettes demandent un éditeur.');
            $input = is_array($body['entity'] ?? null) ? $body['entity'] : [];
            $id = socle_redaction_text($input['id'] ?? null, 80);
            if ($id === '') $id = socle_uuid();
            $name = socle_redaction_text($input['name'] ?? null, 200);
            $slug = socle_redaction_text($input['slug'] ?? null, 96);
            if ($name === '' || preg_match(SOCLE_SLUG, $slug) !== 1) return socle_redaction_fail(400, 'Un nom et un identifiant URL valides sont requis.');
            $entity = array_merge($input, ['id' => $id, 'name' => $name, 'slug' => $slug]);
            $store->put('editorial', $kind . ':' . $id, socle_json($entity));
            return socle_redaction_json(200, ['entity' => $entity]);
        }
        if ($path === '/v1/redaction/supprimer') {
            if (!$editor) return socle_redaction_fail(403, 'Supprimer demande un éditeur.');
            $kind = socle_redaction_text($body['kind'] ?? null, 20);
            $id = socle_redaction_text($body['id'] ?? null, 80);
            if ($id === '' || !in_array($kind, [...SOCLE_REDACTION_KINDS, 'article'], true)) return socle_redaction_fail(400, 'Genre ou identifiant invalide.');
            $store->delete('editorial', $kind . ':' . $id);
            return socle_redaction_json(200, ['ok' => true]);
        }
        if ($path === '/v1/redaction/publication') {
            if (!$editor) return socle_redaction_fail(403, 'La configuration du journal demande un éditeur.');
            $publication = is_array($body['publication'] ?? null) ? $body['publication'] : null;
            if ($publication === null || socle_redaction_text($publication['name'] ?? null) === '' || preg_match(SOCLE_SLUG, socle_redaction_text($publication['slug'] ?? null, 96)) !== 1) {
                return socle_redaction_fail(400, "La publication a besoin d'un nom et d'un identifiant.");
            }
            $store->put('editorial', 'publication', socle_json($publication));
            return socle_redaction_json(200, ['publication' => $publication]);
        }
        if ($path === '/v1/redaction/exemples') {
            if (!$editor) return socle_redaction_fail(403, 'Réservé à un éditeur.');
            $store->put('editorial', 'demo-visible', ($body['visible'] ?? true) === false ? '0' : '1');
            return socle_redaction_json(200, ['ok' => true]);
        }
        if ($path === '/v1/redaction/photo') {
            if (!$config['modules']['media']) return socle_redaction_fail(404, 'Le module media est éteint.');
            $input = is_array($body['asset'] ?? null) ? $body['asset'] : [];
            $data = is_string($body['data'] ?? null) ? preg_replace('/^data:[^,]*,/', '', $body['data']) : '';
            $bytes = base64_decode((string) $data, false);
            if ($bytes === false || $bytes === '') return socle_redaction_fail(400, 'Fichier vide.');
            if (strlen($bytes) > SOCLE_REDACTION_MAX) return socle_redaction_fail(413, 'Photo trop lourde (8 Mo au plus).');
            $mime = socle_sniff_image($bytes);
            if ($mime === null) return socle_redaction_fail(415, 'Seules les photos JPEG, PNG ou WebP sont acceptées.');
            $id = preg_replace('/[^a-zA-Z0-9-]/', '', socle_redaction_text($input['id'] ?? null, 80));
            if ($id === '' || $id === null) $id = socle_uuid();
            $src = '/media/banque/' . $id . '.' . SOCLE_REDACTION_EXT[$mime];
            $alt = socle_redaction_text($input['alt'] ?? null, 500);
            $credit = socle_redaction_text($input['credit'] ?? null, 200);
            $mark = ['backend' => 'socle', 'backendId' => $id, 'fetchedAt' => $now];
            if (($body['bank'] ?? true) === false) {
                if ($alt === '') return socle_redaction_fail(400, 'fiche incomplète');
                $image = ['id' => $id, 'kind' => 'image', 'src' => $src, 'alt' => $alt];
                if ($credit !== '') $image['credit'] = $credit;
                $image['source'] = $mark;
                $store->put('media', 'image:' . $id, socle_json($image));
                $store->put('media', 'bytes:' . socle_media_path($src), base64_encode($bytes));
                if ($credit !== '') $store->delete('media', 'queue:credit:' . $id);
                else $store->put('media', 'queue:credit:' . $id, $src);
                return socle_redaction_json(200, ['asset' => $image]);
            }
            if ($credit === '') return socle_redaction_fail(400, 'crédit requis');
            if ($alt === '') return socle_redaction_fail(400, 'fiche incomplète');
            $focal = is_array($input['focalPoint'] ?? null) ? $input['focalPoint'] : [];
            $asset = [
                'id' => $id,
                'kind' => 'image',
                'src' => $src,
                'remoteSrc' => '',
                'alt' => $alt,
                'credit' => $credit,
                'creditUrl' => socle_redaction_text($input['creditUrl'] ?? null, 500),
                'license' => socle_redaction_text($input['license'] ?? null, 100) ?: 'Tous droits réservés',
                'licenseUrl' => socle_redaction_text($input['licenseUrl'] ?? null, 500),
                'sourceUrl' => socle_redaction_text($input['sourceUrl'] ?? null, 500),
                'width' => max(0, (int) round((float) ($input['width'] ?? 0))),
                'height' => max(0, (int) round((float) ($input['height'] ?? 0))),
                'focalPoint' => ['x' => socle_redaction_clamp($focal['x'] ?? null), 'y' => socle_redaction_clamp($focal['y'] ?? null)],
                'institution' => socle_redaction_text($input['institution'] ?? null, 200),
                'campus' => socle_redaction_text($input['campus'] ?? null, 200),
                'keywords' => array_slice(socle_redaction_list($input['keywords'] ?? null), 0, 30),
                'usages' => array_slice(socle_redaction_list($input['usages'] ?? null), 0, 10),
                'source' => $mark,
            ];
            $store->put('media', 'library:' . $id, socle_json($asset));
            $store->put('media', 'bytes:' . socle_media_path($src), base64_encode($bytes));
            $store->delete('media', 'queue:credit:' . $id);
            return socle_redaction_json(200, ['asset' => $asset]);
        }
        if ($path === '/v1/redaction/photo/fiche') {
            if (!$config['modules']['media']) return socle_redaction_fail(404, 'Le module media est éteint.');
            $input = is_array($body['asset'] ?? null) ? $body['asset'] : [];
            $id = socle_redaction_text($input['id'] ?? null, 80);
            $raw = $id !== '' ? $store->get('media', 'library:' . $id) : null;
            if ($raw === null) return socle_redaction_fail(404, 'Photo absente de la banque.');
            $current = json_decode($raw, true);
            $credit = socle_redaction_text($input['credit'] ?? null, 200);
            if ($credit === '') return socle_redaction_fail(400, 'Une photo de la banque garde toujours un crédit.');
            $focal = is_array($input['focalPoint'] ?? null) ? $input['focalPoint'] : $current['focalPoint'];
            $next = array_merge($current, [
                'alt' => socle_redaction_text($input['alt'] ?? null, 500) ?: $current['alt'],
                'credit' => $credit,
                'creditUrl' => socle_redaction_text($input['creditUrl'] ?? null, 500),
                'license' => socle_redaction_text($input['license'] ?? null, 100) ?: $current['license'],
                'licenseUrl' => socle_redaction_text($input['licenseUrl'] ?? null, 500),
                'keywords' => array_slice(socle_redaction_list($input['keywords'] ?? null), 0, 30),
                'usages' => array_slice(socle_redaction_list($input['usages'] ?? null), 0, 10),
                'focalPoint' => ['x' => socle_redaction_clamp($focal['x'] ?? null), 'y' => socle_redaction_clamp($focal['y'] ?? null)],
            ]);
            $store->put('media', 'library:' . $id, socle_json($next));
            return socle_redaction_json(200, ['asset' => $next]);
        }
        if ($path === '/v1/redaction/photo/supprimer') {
            if (!$config['modules']['media']) return socle_redaction_fail(404, 'Le module media est éteint.');
            if (!$editor) return socle_redaction_fail(403, 'Retirer une photo de la banque demande un éditeur.');
            $id = socle_redaction_text($body['id'] ?? null, 80);
            $raw = $id !== '' ? $store->get('media', 'library:' . $id) : null;
            if ($raw === null) return socle_redaction_fail(404, 'Photo absente de la banque.');
            $asset = json_decode($raw, true);
            $users = [];
            foreach (socle_read_articles($store) as $article) {
                $uses = (($article['lead']['src'] ?? null) === $asset['src']);
                foreach (($article['media'] ?? []) as $item) if (($item['src'] ?? null) === $asset['src']) $uses = true;
                if ($uses) $users[] = (string) ($article['title'] ?? '');
            }
            if ($users !== []) return socle_redaction_fail(409, 'Cette photo illustre encore ' . count($users) . ' article(s) : ' . implode(', ', $users) . '.');
            $store->delete('media', 'library:' . $id);
            $store->delete('media', 'bytes:' . socle_media_path($asset['src']));
            return socle_redaction_json(200, ['ok' => true]);
        }
    } catch (ModuleOff $error) {
        return socle_redaction_fail(409, 'Module éteint.');
    } catch (SocleHttp $error) {
        return socle_redaction_fail(400, $error->getMessage());
    }
    return socle_result(404);
}

/**
 * L'admin de rédaction sous `/redaction/` : la page `admin/serveur.html` et
 * ses fichiers `admin/assets/`, à la racine du dépôt. Même règle que Node
 * (`src/redaction-page.ts`). `null` : ce chemin n'est pas l'admin.
 */
const SOCLE_REDACTION_ASSETS = [
    'admin.js', 'admin.css', 'runtime.js', 'util.js', 'export.js',
    'stock-photo-match.js', 'marked.esm.js', 'socle-backend.js',
];

function socle_serve_redaction_page(string $path, string $method): ?array {
    if ($path !== '/redaction' && !str_starts_with($path, '/redaction/')) return null;
    if ($method !== 'GET' && $method !== 'HEAD') return socle_result(405, '', ['allow' => 'GET, HEAD']);
    if ($path === '/redaction') return socle_result(301, '', ['location' => '/redaction/']);
    $dir = dirname(__DIR__, 2) . '/admin';
    if ($path === '/redaction/') {
        $file = $dir . '/serveur.html';
        $type = 'text/html; charset=utf-8';
    } else {
        $name = substr($path, strlen('/redaction/assets/'));
        if (!str_starts_with($path, '/redaction/assets/') || !in_array($name, SOCLE_REDACTION_ASSETS, true)) return socle_result(404);
        $file = $dir . '/assets/' . $name;
        $type = str_ends_with($name, '.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    }
    $bytes = is_file($file) ? file_get_contents($file) : false;
    if ($bytes === false) return socle_result(404);
    return socle_result(200, $bytes, [
        'content-type' => $type,
        'x-content-type-options' => 'nosniff',
        'referrer-policy' => 'same-origin',
        'x-frame-options' => 'DENY',
        'cache-control' => 'no-cache',
    ]);
}
