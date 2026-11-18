<?php
declare(strict_types=1);

const SOCLE_FILE_NAMES = ['kiosque.config.ts', 'theme/tokens.css', 'OWNERS.md'];
const SOCLE_SEASONS = ['automne', 'hiver', 'ete'];
/** Modules recopiés tels quels dans la sauvegarde complète (`redaction/donnees.json`). */
const SOCLE_BACKUP_MODULES = ['editorial', 'media'];
const SOCLE_SECRET_LINE = '/(token|password|secret|api[_-]?key|authorization)\s*[:=]/i';

function socle_default_years(DateTimeImmutable $now): array {
    $year = socle_civil_year($now);
    return [$year, $year - 1];
}

function socle_read_prefs(SocleStore $store, DateTimeImmutable $now): array {
    $raw = $store->get('export', 'prefs');
    if ($raw === null) return ['years' => socle_default_years($now)];
    $parsed = json_decode($raw, true);
    if (!is_array($parsed) || !is_array($parsed['years'] ?? null)) return ['years' => socle_default_years($now)];
    return ['years' => array_map('intval', $parsed['years'])];
}

function socle_write_prefs(SocleStore $store, array $years): void {
    $store->put('export', 'prefs', socle_json(['years' => $years]));
}

function socle_is_session_name(string $value): bool {
    if (str_contains($value, '/') || str_contains($value, '\\') || str_contains($value, '..')) return false;
    return preg_match('/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,40}$/u', $value) === 1;
}

function socle_strip_secrets(string $text): string {
    $lines = explode("\n", $text);
    $kept = [];
    foreach ($lines as $line) {
        if (preg_match(SOCLE_SECRET_LINE, $line) === 1) continue;
        $kept[] = $line;
    }
    return implode("\n", $kept);
}

function socle_html_page(string $title, string $body): string {
    return '<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>' . socle_escape($title) . '</title>
</head>
<body>
<h1>' . socle_escape($title) . '</h1>
' . $body . '
</body>
</html>
';
}

function socle_article_html(array $article): string {
    return socle_html_page(
        (string) $article['title'],
        '<p>' . socle_escape((string) $article['year']) . ' · ' . socle_escape((string) $article['session']) . ' · ' . socle_escape((string) $article['status']) . '</p>
<pre>' . socle_escape((string) $article['markdown']) . '</pre>',
    );
}

function socle_record_from_editorial(string $value): ?array {
    $parsed = json_decode($value, true);
    if (!is_array($parsed) || empty($parsed['id']) || empty($parsed['title'])) return null;
    $when = $parsed['publishedAt'] ?? $parsed['updatedAt'] ?? null;
    if (!is_string($when) || $when === '') return null;
    $year = socle_civil_year(new DateTimeImmutable($when));
    return [
        'id' => (string) $parsed['id'],
        'title' => (string) $parsed['title'],
        'year' => $year,
        'session' => is_string($parsed['session'] ?? null) ? $parsed['session'] : '',
        'status' => (string) ($parsed['status'] ?? 'draft'),
        'markdown' => (string) ($parsed['body']['raw'] ?? ''),
    ];
}

function socle_articles_of(SocleStore $store): array {
    $byId = [];
    foreach (socle_rows($store, 'export') as $row) {
        if (!str_starts_with($row['key'], 'article:')) continue;
        $article = json_decode($row['value'], true);
        if (is_array($article) && isset($article['id'])) $byId[$article['id']] = $article;
    }
    foreach (socle_rows($store, 'editorial') as $row) {
        if (!str_starts_with($row['key'], 'article:')) continue;
        $article = socle_record_from_editorial($row['value']);
        if ($article !== null) $byId[$article['id']] = $article;
    }
    return array_values($byId);
}

function socle_empty_site_zip(): string {
    return socle_zip_store([
        socle_text_file('manifest.json', socle_json_pretty([
            'kind' => 'site',
            'includedYears' => [],
            'excludedYears' => [],
            'note' => "Les années plus anciennes ne sont pas dans ce fichier. Une archive antérieure est supposée les contenir. Ce programme ne peut pas le vérifier.",
        ])),
        socle_text_file('index.html', socle_html_page('Sauvegarde', '<p>Aucun article.</p>')),
    ]);
}

function socle_build_site_zip(SocleStore $store, DateTimeImmutable $now): string {
    $prefs = socle_read_prefs($store, $now);
    $articles = socle_articles_of($store);
    $included = array_values(array_filter($articles, static fn (array $article): bool => in_array($article['year'], $prefs['years'], true)));
    $present = [];
    foreach ($articles as $article) $present[$article['year']] = true;
    $presentYears = array_map('intval', array_keys($present));
    sort($presentYears, SORT_NUMERIC);
    $excluded = array_values(array_filter($presentYears, static fn (int $year): bool => !in_array($year, $prefs['years'], true)));
    $files = [];
    $files[] = socle_text_file('manifest.json', socle_json_pretty([
        'kind' => 'site',
        'includedYears' => $prefs['years'],
        'excludedYears' => $excluded,
        'note' => "Les années plus anciennes ne sont pas dans ce fichier. Une archive antérieure est supposée les contenir. Ce programme ne peut pas le vérifier.",
    ]));
    $links = [];
    foreach ($included as $article) {
        $links[] = '<li><a href="html/' . socle_escape((string) $article['id']) . '.html">' . socle_escape((string) $article['title']) . '</a></li>';
    }
    $files[] = socle_text_file('index.html', socle_html_page('Sauvegarde', "<ul>\n" . implode("\n", $links) . "\n</ul>"));
    foreach ($included as $article) {
        $files[] = socle_text_file('content/articles/' . $article['id'] . '.md', (string) $article['markdown']);
        $files[] = socle_text_file('content/articles/' . $article['id'] . '.json', socle_json_pretty($article));
        $files[] = socle_text_file('html/' . $article['id'] . '.html', socle_article_html($article));
    }
    $rows = [];
    try {
        $rows = $store->list('export');
    } catch (ModuleOff) {
        $rows = [];
    }
    foreach (SOCLE_FILE_NAMES as $name) {
        foreach ($rows as $row) {
            if ($row['key'] === 'file:' . $name) $files[] = socle_text_file($name, socle_strip_secrets($row['value']));
        }
    }
    foreach ($rows as $row) {
        if (!str_starts_with($row['key'], 'media:')) continue;
        $path = substr($row['key'], strlen('media:'));
        $used = false;
        foreach ($included as $article) {
            if (str_contains((string) $article['markdown'], $path)) $used = true;
        }
        if (!$used) continue;
        $files[] = ['name' => $path, 'data' => socle_b64url_decode_std($row['value'])];
        foreach ($rows as $credit) {
            if ($credit['key'] === 'credit:' . $path) $files[] = socle_text_file($path . '.credit', $credit['value']);
        }
    }
    foreach (socle_rows($store, 'editorial') as $row) {
        if (!str_starts_with($row['key'], 'bytes:')) continue;
        $path = substr($row['key'], strlen('bytes:'));
        $used = false;
        foreach ($included as $article) {
            if (str_contains((string) $article['markdown'], $path)) $used = true;
        }
        if (!$used) continue;
        $files[] = ['name' => $path, 'data' => base64_decode($row['value'], true) ?: ''];
    }
    // La rédaction entière (fiche du journal, articles avec photos et signatures,
    // sections, banque de photos) : c'est elle qu'une restauration remet en place.
    $files[] = socle_text_file('redaction/donnees.json', socle_json(socle_backup_rows($store)));
    $members = socle_members_for_archive($store);
    if ($members !== []) $files[] = socle_text_file('auth/members.json', socle_json_pretty($members));
    $corrections = socle_read_corrections($store);
    if ($corrections !== []) $files[] = socle_text_file('review/corrections.json', socle_json_pretty($corrections));
    $subscriptions = socle_subscriptions_for_archive($store);
    if ($subscriptions !== []) $files[] = socle_text_file('notify/subscriptions.json', socle_json_pretty($subscriptions));
    return socle_zip_store($files);
}

/** Lignes des modules de la rédaction, pour `redaction/donnees.json`. */
function socle_backup_rows(SocleStore $store): array {
    $modules = [];
    foreach (SOCLE_BACKUP_MODULES as $module) {
        $rows = [];
        foreach (socle_rows($store, $module) as $row) $rows[] = ['key' => (string) $row['key'], 'value' => (string) $row['value']];
        $modules[$module] = $rows;
    }
    return ['format' => 'socle-sauvegarde', 'version' => 1, 'modules' => $modules];
}

/** Remet les lignes de `redaction/donnees.json` ; ce qui a été écrit depuis reste. */
function socle_restore_rows(SocleStore $store, mixed $value): int {
    if (!is_array($value) || ($value['format'] ?? '') !== 'socle-sauvegarde' || !is_array($value['modules'] ?? null)) {
        throw new RuntimeException('redaction/donnees.json illisible');
    }
    $count = 0;
    foreach (SOCLE_BACKUP_MODULES as $module) {
        $rows = $value['modules'][$module] ?? [];
        if (!is_array($rows)) continue;
        foreach ($rows as $row) {
            if (!is_array($row) || !is_string($row['key'] ?? null) || !is_string($row['value'] ?? null) || $row['key'] === '') continue;
            try {
                $store->put($module, $row['key'], $row['value']);
                $count += 1;
            } catch (ModuleOff) {
                break;
            }
        }
    }
    return $count;
}

function socle_b64url_decode_std(string $value): string {
    $raw = base64_decode($value, true);
    return $raw === false ? '' : $raw;
}

function socle_sessions_in(SocleStore $store): array {
    $names = [];
    foreach (socle_articles_of($store) as $article) $names[(string) ($article['session'] ?? '')] = true;
    return array_keys($names);
}

function socle_build_session_zip(SocleStore $store, string $session): string {
    $articles = array_values(array_filter(socle_articles_of($store), static fn (array $article): bool => ($article['session'] ?? '') === $session));
    $years = [];
    foreach ($articles as $article) $years[$article['year']] = true;
    $includedYears = array_map('intval', array_keys($years));
    sort($includedYears, SORT_NUMERIC);
    $links = [];
    foreach ($articles as $article) {
        $links[] = '<li><a href="html/' . socle_escape((string) $article['id']) . '.html">' . socle_escape((string) $article['title']) . '</a></li>';
    }
    $files = [
        socle_text_file('manifest.json', socle_json_pretty([
            'kind' => 'session',
            'session' => $session,
            'includedYears' => $includedYears,
        ])),
        socle_text_file('index.html', socle_html_page('Session ' . $session, "<ul>\n" . implode("\n", $links) . "\n</ul>")),
    ];
    foreach ($articles as $article) {
        $files[] = socle_text_file('content/articles/' . $article['id'] . '.md', (string) $article['markdown']);
        $files[] = socle_text_file('content/articles/' . $article['id'] . '.json', socle_json_pretty($article));
        $files[] = socle_text_file('html/' . $article['id'] . '.html', socle_article_html($article));
    }
    return socle_zip_store($files);
}

function socle_restore_zip(SocleStore $store, string $bytes): array {
    $files = socle_unzip($bytes);
    $manifestRaw = $files['manifest.json'] ?? null;
    if ($manifestRaw === null) throw new RuntimeException('manifest manquant');
    $manifest = json_decode($manifestRaw, true);
    if (!is_array($manifest)) throw new RuntimeException('manifest manquant');
    if (($manifest['kind'] ?? '') === 'session') {
        $session = (string) ($manifest['session'] ?? '');
        foreach ($files as $name => $data) {
            if (!str_ends_with($name, '.json') || !str_starts_with($name, 'content/articles/')) continue;
            $article = json_decode($data, true);
            if (!is_array($article) || ($article['session'] ?? '') !== $session) continue;
            $store->put('export', 'article:' . $article['id'], socle_json($article));
        }
        return ['excludedYears' => [], 'session' => $session];
    }
    foreach (SOCLE_FILE_NAMES as $name) {
        if (isset($files[$name])) $store->put('export', 'file:' . $name, $files[$name]);
    }
    foreach ($files as $name => $data) {
        if (!str_ends_with($name, '.json') || !str_starts_with($name, 'content/articles/')) continue;
        $article = json_decode($data, true);
        if (!is_array($article) || empty($article['id'])) continue;
        $store->put('export', 'article:' . $article['id'], socle_json($article));
    }
    foreach ($files as $name => $data) {
        if (!str_starts_with($name, 'media/')) continue;
        $store->put('export', 'media:' . $name, base64_encode($data));
    }
    if (isset($files['redaction/donnees.json'])) socle_restore_rows($store, json_decode($files['redaction/donnees.json'], true));
    if (isset($files['auth/members.json'])) socle_restore_members($store, json_decode($files['auth/members.json'], true));
    if (isset($files['review/corrections.json'])) socle_restore_corrections($store, json_decode($files['review/corrections.json'], true));
    if (isset($files['notify/subscriptions.json'])) socle_restore_subscriptions($store, json_decode($files['notify/subscriptions.json'], true));
    return ['excludedYears' => $manifest['excludedYears'] ?? [], 'session' => null];
}

function socle_mark_downloaded(SocleStore $store): void {
    $store->put('export', 'downloaded', '1');
}

function socle_was_downloaded(SocleStore $store): bool {
    return $store->get('export', 'downloaded') === '1';
}
