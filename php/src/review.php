<?php
declare(strict_types=1);

const SOCLE_DECISIONS = ['publier', 'programmer', 'renvoyer'];
const SOCLE_CORRECTION_STATES = ['ouverte', 'acceptee', 'refusee'];

function socle_decide(SocleStore $store, string $id, string $decision, string $reviewer, string $now, ?string $scheduledAt): array {
    if (!in_array($decision, SOCLE_DECISIONS, true)) throw new SocleHttp('décision inconnue');
    $article = null;
    foreach (socle_read_articles($store) as $item) {
        if ($item['id'] === $id) $article = $item;
    }
    if ($article === null || (($article['status'] ?? '') !== 'in-review' && ($article['status'] ?? '') !== 'scheduled')) {
        throw new SocleHttp('pas en relecture');
    }
    $article['reviewedAt'] = $now;
    $article['reviewedBy'] = $reviewer;
    if ($decision === 'renvoyer') {
        $article['status'] = 'draft';
        unset($article['scheduledAt']);
    } elseif ($decision === 'programmer') {
        if ($scheduledAt === null || $scheduledAt === '') throw new SocleHttp("une publication programmée a besoin d'une heure");
        $article['status'] = 'scheduled';
        $article['scheduledAt'] = $scheduledAt;
    } else {
        $article['status'] = 'published';
        $article['publishedAt'] = $now;
    }
    try {
        return socle_save_article($store, $article, $now);
    } catch (SocleHttp $error) {
        throw new SocleHttp($error->getMessage(), $error->status);
    }
}

function socle_review_queue(SocleStore $store): array {
    return array_values(array_filter(
        socle_read_articles($store),
        static fn (array $article): bool => ($article['status'] ?? '') === 'in-review' || ($article['status'] ?? '') === 'scheduled',
    ));
}

function socle_acceptable_url(string $url): bool {
    if (str_starts_with($url, '/') && !str_starts_with($url, '//') && !str_contains($url, '\\') && !str_contains($url, '..')) {
        return true;
    }
    $parts = parse_url($url);
    if (!is_array($parts) || !isset($parts['scheme'])) return false;
    return $parts['scheme'] === 'https' || $parts['scheme'] === 'http';
}

function socle_add_correction(SocleStore $store, string $articleId, string $text, string $url): array {
    $clean = trim($text);
    if ($articleId === '' || $clean === '' || strlen($clean) > 4000 || !socle_acceptable_url($url)) {
        throw new SocleHttp('demande refusée');
    }
    $correction = [
        'id' => socle_uuid(),
        'articleId' => $articleId,
        'text' => $clean,
        'url' => $url,
        'state' => 'ouverte',
    ];
    $store->put('review', 'correction:' . $correction['id'], socle_json($correction));
    return $correction;
}

function socle_close_correction(SocleStore $store, string $id, string $state): array {
    if ($state !== 'acceptee' && $state !== 'refusee') throw new SocleHttp('décision inconnue');
    $raw = $store->get('review', 'correction:' . $id);
    if ($raw === null) throw new SocleHttp('pas en relecture');
    $correction = json_decode($raw, true);
    if (!is_array($correction)) throw new SocleHttp('pas en relecture');
    $correction['state'] = $state;
    $store->put('review', 'correction:' . $id, socle_json($correction));
    return $correction;
}

function socle_read_corrections(SocleStore $store): array {
    try {
        $corrections = [];
        foreach ($store->list('review') as $row) {
            if (!str_starts_with($row['key'], 'correction:')) continue;
            $parsed = json_decode($row['value'], true);
            if (is_array($parsed)) $corrections[] = $parsed;
        }
        usort($corrections, static fn (array $a, array $b): int => strcmp((string) $a['id'], (string) $b['id']));
        return $corrections;
    } catch (ModuleOff) {
        return [];
    }
}

function socle_restore_corrections(SocleStore $store, mixed $value): void {
    if (!is_array($value)) return;
    foreach ($value as $item) {
        if (!is_array($item)) continue;
        if (empty($item['id']) || empty($item['articleId']) || empty($item['text']) || empty($item['url'])) continue;
        if (!in_array($item['state'] ?? '', SOCLE_CORRECTION_STATES, true)) continue;
        try {
            $store->put('review', 'correction:' . $item['id'], socle_json([
                'id' => $item['id'],
                'articleId' => $item['articleId'],
                'text' => $item['text'],
                'url' => $item['url'],
                'state' => $item['state'],
            ]));
        } catch (ModuleOff) {
            return;
        }
    }
}

function socle_review_copy(string $lang): array {
    if ($lang === 'en') {
        return [
            'title' => 'Review', 'empty' => 'Nothing in review.', 'submitted' => 'Submitted', 'hour' => 'Hour',
            'reviewer' => 'Reviewer slug', 'publish' => 'Publish', 'schedule' => 'Schedule', 'back' => 'Send back',
            'save' => 'Save', 'due' => 'Published on time', 'correction' => 'Correction', 'propose' => 'Propose',
            'accept' => 'Accept', 'refuse' => 'Refuse',
            'states' => ['ouverte' => 'Open', 'acceptee' => 'Accepted', 'refusee' => 'Refused'],
        ];
    }
    return [
        'title' => 'Relecture', 'empty' => 'Rien en relecture.', 'submitted' => 'Soumis le', 'hour' => 'Heure',
        'reviewer' => 'Slug du réviseur', 'publish' => 'Publier', 'schedule' => 'Programmer', 'back' => 'Renvoyer',
        'save' => 'Enregistrer', 'due' => "Publication à l'heure", 'correction' => 'Correction', 'propose' => 'Proposer',
        'accept' => 'Accepter', 'refuse' => 'Refuser',
        'states' => ['ouverte' => 'Ouverte', 'acceptee' => 'Acceptée', 'refusee' => 'Refusée'],
    ];
}

function socle_handle_review(string $method, string $url, array $config, SocleStore $store, string $raw, ?string $actor): array {
    if (!$config['modules']['review']) return socle_result(404);
    $path = socle_request_path($url);
    $lang = socle_lang($url);
    $allowed = socle_may_review($store, $config['modules']['auth'] ? $actor : null, $config['modules']['auth']);
    try {
        if ($path === '/v1/review/echeance' && $method === 'POST') {
            if ($raw !== '' && $raw !== '{}') throw new SocleHttp('demande refusée');
            $published = socle_publish_due($store, socle_now());
            return socle_result(200, socle_json(['published' => $published]), ['content-type' => 'application/json; charset=utf-8']);
        }
        if ($path === '/admin/relecture/correction' && $method === 'POST') {
            if (!$allowed) return socle_text(403, 'réservé à la relecture');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'articleId,text,url') throw new SocleHttp('demande refusée');
            if (!is_string($body['articleId'] ?? null) || !is_string($body['text'] ?? null) || !is_string($body['url'] ?? null)) {
                throw new SocleHttp('demande refusée');
            }
            socle_add_correction($store, $body['articleId'], $body['text'], $body['url']);
            return socle_result(204);
        }
        if ($path === '/admin/relecture/correction/decision' && $method === 'POST') {
            if (!$allowed) return socle_text(403, 'réservé à la relecture');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'id,state') throw new SocleHttp('demande refusée');
            if (!is_string($body['id'] ?? null) || !is_string($body['state'] ?? null)) throw new SocleHttp('demande refusée');
            socle_close_correction($store, $body['id'], $body['state']);
            return socle_result(204);
        }
        if ($path === '/admin/relecture' && $method === 'POST') {
            if (!$allowed) return socle_text(403, 'réservé à la relecture');
            $params = socle_form($raw);
            $keys = array_keys($params);
            sort($keys, SORT_STRING);
            foreach ($keys as $key) {
                if (!in_array($key, ['decision', 'heure', 'id', 'reviewer'], true)) throw new SocleHttp('demande refusée');
            }
            if (empty($params['id'][0]) || empty($params['decision'][0]) || empty($params['reviewer'][0])) {
                throw new SocleHttp('demande refusée');
            }
            socle_decide(
                $store,
                $params['id'][0],
                $params['decision'][0],
                $params['reviewer'][0],
                socle_iso(socle_now()),
                $params['heure'][0] ?? null,
            );
            socle_publish_due($store, socle_now());
            return socle_result(303, '', ['location' => socle_with_lang('/admin/relecture', $lang)]);
        }
        if ($path === '/admin/relecture' && $method === 'GET') {
            $published = socle_publish_due($store, socle_now());
            return socle_review_page($lang, socle_review_queue($store), socle_read_corrections($store), $published, $allowed);
        }
        return socle_result(404);
    } catch (SocleHttp $error) {
        $status = $error->getMessage() === 'réservé à la relecture' ? 403 : 400;
        return socle_text($status, $error->getMessage());
    }
}

function socle_review_page(string $lang, array $articles, array $corrections, int $published, bool $allowed): array {
    $copy = socle_review_copy($lang);
    $due = $published > 0 ? '<p>' . $copy['due'] . ' : ' . $published . '.</p>' : '';
    $items = '';
    foreach ($articles as $article) {
        $form = $allowed
            ? '<form class="noprint" method="post" action="' . socle_with_lang('/admin/relecture', $lang) . '">
<input type="hidden" name="id" value="' . socle_escape((string) $article['id']) . '">
<label>' . $copy['reviewer'] . ' <input name="reviewer" value="' . socle_escape((string) ($article['reviewedBy'] ?? '')) . '"></label>
<label>' . $copy['hour'] . ' <input name="heure" value="' . socle_escape((string) ($article['scheduledAt'] ?? '')) . '"></label>
<button type="submit" name="decision" value="publier">' . $copy['publish'] . '</button>
<button type="submit" name="decision" value="programmer">' . $copy['schedule'] . '</button>
<button type="submit" name="decision" value="renvoyer">' . $copy['back'] . '</button>
</form>'
            : '';
        $items .= '<li><p>' . socle_escape((string) $article['title']) . '</p><p>' . $copy['submitted'] . ' : ' . socle_escape((string) ($article['submittedAt'] ?? '')) . '</p>' . $form . '</li>';
    }
    $notes = '';
    foreach ($corrections as $item) {
        $state = $copy['states'][$item['state']] ?? $item['state'];
        $notes .= '<li>' . socle_escape((string) $item['text']) . ' <p>' . $state . '</p></li>';
    }
    $list = $items !== '' ? '<ul>' . $items . '</ul>' : '<p>' . $copy['empty'] . '</p>';
    $noteList = $notes !== '' ? '<h2>' . $copy['correction'] . '</h2><ul>' . $notes . '</ul>' : '';
    return socle_admin_document($lang, $copy['title'], $due . $list . $noteList);
}
