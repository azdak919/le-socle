<?php
declare(strict_types=1);

const SOCLE_STATUSES = ['draft', 'in-review', 'scheduled', 'published', 'archived', 'retracted'];
const SOCLE_ISO = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/';
const SOCLE_SLUG = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

function socle_rows(SocleStore $store, string $module): array {
    try {
        return $store->list($module);
    } catch (ModuleOff) {
        return [];
    }
}

function socle_read_publication(SocleStore $store): ?array {
    $raw = $store->get('editorial', 'publication');
    if ($raw === null) return null;
    $parsed = json_decode($raw, true);
    return is_array($parsed) ? $parsed : null;
}

/** Adresse publique d’un article, d’après l’adresse courante du journal (pas un chemin périmé). */
function socle_article_public_url(string $siteUrl, string $slug): string {
    return rtrim($siteUrl, '/') . '/articles/' . rawurlencode($slug) . '/';
}

/** Quand siteUrl change, les canonicalUrl stockées suivent, pour le flux et les liens. */
function socle_refresh_canonical_urls(SocleStore $store, string $siteUrl): int {
    $base = rtrim($siteUrl, '/');
    if ($base === '') return 0;
    $count = 0;
    foreach (socle_read_articles($store) as $article) {
        $slug = (string) ($article['slug'] ?? '');
        $id = (string) ($article['id'] ?? '');
        if ($slug === '' || $id === '') continue;
        $next = socle_article_public_url($base, $slug);
        if ((string) ($article['canonicalUrl'] ?? '') === $next) continue;
        $article['canonicalUrl'] = $next;
        $store->put('editorial', 'article:' . $id, socle_json($article));
        $count++;
    }
    return $count;
}


function socle_read_articles(SocleStore $store): array {
    $articles = [];
    foreach (socle_rows($store, 'editorial') as $row) {
        if (!str_starts_with($row['key'], 'article:')) continue;
        $parsed = json_decode($row['value'], true);
        if (is_array($parsed)) $articles[] = $parsed;
    }
    usort($articles, static fn (array $a, array $b): int => strcmp((string) ($a['slug'] ?? ''), (string) ($b['slug'] ?? '')));
    return $articles;
}

function socle_read_kind(SocleStore $store, string $prefix): array {
    $items = [];
    foreach (socle_rows($store, 'editorial') as $row) {
        if (!str_starts_with($row['key'], $prefix)) continue;
        $parsed = json_decode($row['value'], true);
        if (is_array($parsed)) $items[] = $parsed;
    }
    return $items;
}

function socle_check_article(array $article): void {
    if (($article['id'] ?? '') === '') throw new SocleHttp('id requis');
    if (preg_match(SOCLE_SLUG, (string) ($article['slug'] ?? '')) !== 1) throw new SocleHttp('slug invalide');
    if (trim((string) ($article['title'] ?? '')) === '') throw new SocleHttp('titre requis');
    if (!in_array($article['status'] ?? '', SOCLE_STATUSES, true)) throw new SocleHttp('statut inconnu');
    if (!is_array($article['body'] ?? null) || !is_string($article['body']['raw'] ?? null)) throw new SocleHttp('corps requis');
    if (preg_match(SOCLE_ISO, (string) ($article['updatedAt'] ?? '')) !== 1) throw new SocleHttp('updatedAt invalide');
    if (isset($article['scheduledAt']) && $article['scheduledAt'] !== null && preg_match(SOCLE_ISO, (string) $article['scheduledAt']) !== 1) {
        throw new SocleHttp('scheduledAt invalide');
    }
    if (($article['status'] ?? '') === 'scheduled' && empty($article['scheduledAt'])) {
        throw new SocleHttp("une publication programmée a besoin d'une heure");
    }
    if (!empty($article['reviewedBy']) && preg_match(SOCLE_SLUG, (string) $article['reviewedBy']) !== 1) throw new SocleHttp('reviewedBy invalide');
    if (!empty($article['reviewedAt']) && preg_match(SOCLE_ISO, (string) $article['reviewedAt']) !== 1) throw new SocleHttp('reviewedAt invalide');
    if (!empty($article['submittedAt']) && preg_match(SOCLE_ISO, (string) $article['submittedAt']) !== 1) throw new SocleHttp('submittedAt invalide');
    if (($article['status'] ?? '') === 'published' || ($article['status'] ?? '') === 'archived') {
        if (empty($article['publishedAt']) || preg_match(SOCLE_ISO, (string) $article['publishedAt']) !== 1) throw new SocleHttp('date de publication requise');
        if (!is_array($article['authors'] ?? null) || $article['authors'] === []) throw new SocleHttp('un article publié doit être signé');
        if (empty($article['section'])) throw new SocleHttp('un article publié doit avoir une section');
        if (trim((string) $article['body']['raw']) === '') throw new SocleHttp('un article publié ne peut pas être vide');
    }
}

function socle_save_article(SocleStore $store, array $article, string $now): array {
    $article['updatedAt'] = $now;
    $source = is_array($article['source'] ?? null) ? $article['source'] : [];
    $source['backend'] = 'socle';
    $source['fetchedAt'] = $now;
    if (!isset($source['backendId'])) $source['backendId'] = $article['id'] ?? '';
    $article['source'] = $source;
    if (($article['status'] ?? '') === 'in-review' && empty($article['submittedAt'])) $article['submittedAt'] = $now;
    socle_check_article($article);
    if (empty($article['featured'])) unset($article['featured']);
    else $article['featured'] = true;
    $store->put('editorial', 'article:' . $article['id'], socle_json($article));
    if (!empty($article['featured'])) {
        foreach (socle_read_articles($store) as $other) {
            if (($other['id'] ?? '') === ($article['id'] ?? '') || empty($other['featured'])) continue;
            unset($other['featured']);
            $other['updatedAt'] = $now;
            $store->put('editorial', 'article:' . $other['id'], socle_json($other));
        }
    }
    return $article;
}

function socle_publish_due(SocleStore $store, DateTimeImmutable $now): int {
    try {
        $store->get('review', 'on');
    } catch (ModuleOff) {
        return 0;
    }
    $instant = socle_iso($now);
    $count = 0;
    foreach (socle_read_articles($store) as $article) {
        if (($article['status'] ?? '') !== 'scheduled' || empty($article['scheduledAt'])) continue;
        if (socle_ms((string) $article['scheduledAt']) > socle_epoch_ms($now)) continue;
        $article['status'] = 'published';
        $article['publishedAt'] = $article['scheduledAt'];
        try {
            socle_save_article($store, $article, $instant);
            $count += 1;
        } catch (SocleHttp) {
        }
    }
    return $count;
}

function socle_public_author(array $author): array {
    unset($author['email']);
    return $author;
}

function socle_snapshot(SocleStore $store, string $audience): array {
    socle_publish_due($store, socle_now());
    $publication = socle_read_publication($store);
    if ($publication === null) throw new SocleHttp('publication absente');
    $demoOn = $store->get('editorial', 'demo-visible') !== '0';
    $articles = socle_read_articles($store);
    if ($audience === 'public') {
        $articles = array_values(array_filter($articles, static fn (array $article): bool => ($article['status'] ?? '') === 'published' || ($article['status'] ?? '') === 'archived'));
    }
    if (!($demoOn && $audience === 'editorial')) {
        $articles = array_values(array_filter($articles, static fn (array $article): bool => empty($article['isDemo'])));
    }
    $authors = socle_read_kind($store, 'author:');
    if ($audience === 'public') $authors = array_map('socle_public_author', $authors);
    $snapshot = [
        'publication' => $publication,
        'articles' => $articles,
        'authors' => $authors,
        'taxonomies' => [
            'sections' => socle_read_kind($store, 'section:'),
            'categories' => socle_read_kind($store, 'category:'),
            'tags' => socle_read_kind($store, 'tag:'),
        ],
        'syncedAt' => socle_iso(socle_now()),
    ];
    socle_attach_variants($snapshot, socle_media_by_src($store));
    return $snapshot;
}

function socle_field(string $id, string $label, string $name, string $value, string $kind = 'text'): string {
    return '<p><label for="' . $id . '">' . $label . '</label><br><input id="' . $id . '" name="' . $name . '" type="' . $kind . '" value="' . socle_escape($value) . '"></p>';
}

function socle_article_form(string $lang, array $article, string $error = ''): string {
    $copy = socle_editorial_copy($lang);
    $status = $article['status'] ?? 'draft';
    $options = '';
    foreach (SOCLE_STATUSES as $item) {
        $selected = $item === $status ? ' selected' : '';
        $label = $lang === 'fr' ? (['draft' => 'Brouillon', 'in-review' => 'En révision', 'scheduled' => 'Programmé', 'published' => 'Publié', 'archived' => 'Archivé', 'retracted' => 'Retiré'][$item] ?? $item) : $item;
        $options .= '<option value="' . $item . '"' . $selected . '>' . $label . '</option>';
    }
    $alert = $error !== '' ? '<p role="alert">' . socle_escape($error) . '</p>' : '';
    $author = $article['authors'][0] ?? '';
    return $alert . '<form method="post" action="' . socle_with_lang('/admin/articles', $lang) . '">
<input type="hidden" name="id" value="' . socle_escape((string) ($article['id'] ?? '')) . '">
' . socle_field('titre', $copy['title'], 'title', (string) ($article['title'] ?? '')) . '
' . socle_field('slug', $copy['slug'], 'slug', (string) ($article['slug'] ?? '')) . '
<p><label for="statut">' . $copy['status'] . '</label><br><select id="statut" name="status">' . $options . '</select></p>
<p><label for="texte">' . $copy['body'] . '</label><br><textarea id="texte" name="markdown">' . socle_escape((string) ($article['body']['raw'] ?? '')) . '</textarea></p>
' . socle_field('extrait', $copy['excerpt'], 'excerpt', (string) ($article['excerpt'] ?? '')) . '
' . socle_field('auteur', $copy['author'], 'author', (string) $author) . '
' . socle_field('section', $copy['section'], 'section', (string) ($article['section'] ?? '')) . '
' . socle_field('heure', $copy['scheduled'], 'scheduledAt', (string) ($article['scheduledAt'] ?? '')) . '
' . socle_field('session', $copy['session'], 'session', (string) ($article['session'] ?? '')) . '
' . socle_field('soumis', $copy['submitted'], 'submittedAt', (string) ($article['submittedAt'] ?? '')) . '
' . socle_field('revu', $copy['reviewedAt'], 'reviewedAt', (string) ($article['reviewedAt'] ?? '')) . '
' . socle_field('reviseur', $copy['reviewedBy'], 'reviewedBy', (string) ($article['reviewedBy'] ?? '')) . '
<p class="noprint"><button type="submit">' . $copy['save'] . '</button></p>
</form>';
}

function socle_editorial_copy(string $lang): array {
    if ($lang === 'en') {
        return [
            'articles' => 'Articles', 'review' => 'Review', 'title' => 'Title', 'slug' => 'Slug', 'status' => 'Status',
            'body' => 'Text', 'excerpt' => 'Excerpt', 'author' => 'Author slug', 'section' => 'Section',
            'scheduled' => 'Publish time', 'session' => 'Session', 'submitted' => 'Submitted',
            'reviewedAt' => 'Reviewed at', 'reviewedBy' => 'Reviewed by', 'save' => 'Save',
            'empty' => 'No articles.', 'queueEmpty' => 'Nothing in review.',
            'missingPub' => 'The journal has no publication record yet.',
        ];
    }
    return [
        'articles' => 'Articles', 'review' => 'Relecture', 'title' => 'Titre', 'slug' => 'Adresse', 'status' => 'Statut',
        'body' => 'Texte', 'excerpt' => 'Extrait', 'author' => 'Auteur (nom court)', 'section' => 'Section',
        'scheduled' => 'Heure de publication', 'session' => 'Session', 'submitted' => 'Soumis le',
        'reviewedAt' => 'Révisé le', 'reviewedBy' => 'Révisé par', 'save' => 'Enregistrer',
        'empty' => 'Aucun article.', 'queueEmpty' => 'Rien en relecture.',
        'missingPub' => "Le journal n'a pas encore de fiche.",
    ];
}

function socle_handle_editorial(string $method, string $url, array $config, SocleStore $store, string $raw): array {
    $path = socle_request_path($url);
    $lang = socle_lang($url);
    $copy = socle_editorial_copy($lang);
    if (!$config['modules']['editorial']) return socle_result(404);
    if ($path === '/v1/editorial/snapshot' && $method === 'GET') {
        try {
            return socle_result(200, socle_json(socle_snapshot($store, 'public')), ['content-type' => 'application/json; charset=utf-8']);
        } catch (SocleHttp $error) {
            return socle_text(400, $error->getMessage());
        }
    }
    if ($path === '/admin/articles' && $method === 'GET') {
        $items = '';
        foreach (socle_read_articles($store) as $article) {
            $when = !empty($article['scheduledAt']) ? ' — ' . $article['scheduledAt'] : '';
            $items .= '<li><a href="' . socle_with_lang('/admin/articles/' . $article['id'], $lang) . '">' . socle_escape((string) $article['title']) . '</a> (' . $article['status'] . $when . ')</li>';
        }
        $list = $items !== '' ? '<ul>' . $items . '</ul>' : '<p>' . $copy['empty'] . '</p>';
        return socle_admin_document($lang, $copy['articles'], $list . '<p class="noprint"><a href="' . socle_with_lang('/admin/articles/nouveau', $lang) . '">' . $copy['save'] . '</a></p>');
    }
    if ($path === '/admin/articles/nouveau' && $method === 'GET') {
        return socle_admin_document($lang, $copy['articles'], socle_article_form($lang, []));
    }
    if (preg_match('#^/admin/articles/([^/]+)$#', $path, $one) === 1 && $method === 'GET' && $one[1] !== 'nouveau') {
        $found = null;
        foreach (socle_read_articles($store) as $article) {
            if ($article['id'] === $one[1]) $found = $article;
        }
        if ($found === null) return socle_result(404);
        $page = '<article><h2>' . socle_escape((string) $found['title']) . '</h2><p>' . socle_escape((string) $found['status']) . '</p><pre>' . socle_escape((string) ($found['body']['raw'] ?? '')) . '</pre></article>' . socle_article_form($lang, $found);
        return socle_admin_document($lang, (string) $found['title'], $page);
    }
    if ($path === '/admin/articles' && $method === 'POST') {
        $params = socle_form($raw);
        $one = static fn (string $key): string => $params[$key][0] ?? '';
        $publication = null;
        try {
            $publication = socle_read_publication($store);
        } catch (ModuleOff) {
            $publication = null;
        }
        if ($publication === null) {
            return socle_admin_document($lang, $copy['articles'], '<p role="alert">' . $copy['missingPub'] . '</p>');
        }
        $now = socle_iso(socle_now());
        $id = $one('id') !== '' ? $one('id') : socle_uuid();
        $existing = null;
        foreach (socle_read_articles($store) as $article) {
            if ($article['id'] === $id) $existing = $article;
        }
        $author = $one('author');
        $status = $one('status') !== '' ? $one('status') : 'draft';
        $article = [
            'id' => $id,
            'slug' => $one('slug'),
            'publication' => (string) ($publication['slug'] ?? ''),
            'title' => $one('title'),
            'excerpt' => $one('excerpt'),
            'body' => ['format' => 'markdown', 'raw' => $one('markdown')],
            'media' => $existing['media'] ?? [],
            'authors' => $author !== '' ? [$author] : [],
            'categories' => $existing['categories'] ?? [],
            'tags' => $existing['tags'] ?? [],
            'lang' => (string) ($publication['lang'] ?? ''),
            'status' => $status,
            'updatedAt' => $now,
            'canonicalUrl' => rtrim((string) ($publication['siteUrl'] ?? ''), '/') . '/' . $one('slug'),
            'source' => ['backend' => 'socle', 'backendId' => $id, 'fetchedAt' => $now],
        ];
        if (isset($existing['lead'])) $article['lead'] = $existing['lead'];
        if (isset($existing['isDemo'])) $article['isDemo'] = $existing['isDemo'];
        if ($one('section') !== '') $article['section'] = $one('section');
        if ($status === 'published' || $status === 'archived') $article['publishedAt'] = $existing['publishedAt'] ?? $now;
        elseif (isset($existing['publishedAt'])) $article['publishedAt'] = $existing['publishedAt'];
        foreach (['submittedAt', 'reviewedAt', 'reviewedBy', 'scheduledAt', 'session'] as $field) {
            if ($one($field) !== '') $article[$field] = $one($field);
        }
        try {
            socle_save_article($store, $article, $now);
        } catch (SocleHttp $error) {
            $page = socle_admin_document($lang, $copy['articles'], socle_article_form($lang, $article, $error->getMessage()));
            return socle_result(400, $page['body'], ['content-type' => 'text/html; charset=utf-8']);
        }
        return socle_result(303, '', ['location' => socle_with_lang('/admin/articles', $lang)]);
    }
    if ($path === '/admin/relecture' && $method === 'GET') {
        $items = '';
        foreach (socle_read_articles($store) as $article) {
            if (($article['status'] ?? '') !== 'in-review') continue;
            $items .= '<li>
<p>' . socle_escape((string) $article['title']) . '</p>
<p>' . $copy['submitted'] . ' : ' . socle_escape((string) ($article['submittedAt'] ?? '')) . '</p>
<form class="noprint" method="post" action="' . socle_with_lang('/admin/relecture', $lang) . '">
<input type="hidden" name="id" value="' . socle_escape((string) $article['id']) . '">
' . socle_field('revu-' . $article['id'], $copy['reviewedAt'], 'reviewedAt', (string) ($article['reviewedAt'] ?? '')) . '
' . socle_field('par-' . $article['id'], $copy['reviewedBy'], 'reviewedBy', (string) ($article['reviewedBy'] ?? '')) . '
<p><button type="submit">' . $copy['save'] . '</button></p>
</form>
</li>';
        }
        $list = $items !== '' ? '<ul>' . $items . '</ul>' : '<p>' . $copy['queueEmpty'] . '</p>';
        return socle_admin_document($lang, $copy['review'], $list);
    }
    if ($path === '/admin/relecture' && $method === 'POST') {
        $params = socle_form($raw);
        $id = $params['id'][0] ?? '';
        $found = null;
        foreach (socle_read_articles($store) as $article) {
            if ($article['id'] === $id) $found = $article;
        }
        if ($found === null) return socle_result(404);
        $reviewedAt = $params['reviewedAt'][0] ?? '';
        $reviewedBy = $params['reviewedBy'][0] ?? '';
        if ($reviewedAt !== '') $found['reviewedAt'] = $reviewedAt;
        else unset($found['reviewedAt']);
        if ($reviewedBy !== '') $found['reviewedBy'] = $reviewedBy;
        else unset($found['reviewedBy']);
        try {
            socle_save_article($store, $found, socle_iso(socle_now()));
        } catch (SocleHttp $error) {
            return socle_text(400, $error->getMessage());
        }
        return socle_result(303, '', ['location' => socle_with_lang('/admin/relecture', $lang)]);
    }
    return socle_result(404);
}

function socle_uuid(): string {
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
}
