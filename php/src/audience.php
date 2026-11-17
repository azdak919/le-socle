<?php
declare(strict_types=1);

const SOCLE_AUDIENCE_TOKEN = '/^[a-z0-9][a-z0-9-]{0,23}$/';
const SOCLE_AUDIENCE_WINDOW = 300000;
const SOCLE_AUDIENCE_CAP = 60;

function socle_reset_bursts(): void {
    $GLOBALS['socle_bursts'] = [];
}

function socle_allow_name(SocleStore $store, string $name): void {
    if (preg_match(SOCLE_AUDIENCE_TOKEN, $name) !== 1 || $name === 'article' || $name === 'sport') {
        throw new SocleHttp('nom refusé');
    }
    $store->put('audience', 'allowed:' . $name, '1');
}

function socle_take_burst(string $key, int $now, int $cap): bool {
    if (!isset($GLOBALS['socle_bursts']) || !is_array($GLOBALS['socle_bursts'])) $GLOBALS['socle_bursts'] = [];
    foreach ($GLOBALS['socle_bursts'] as $stored => $value) {
        if ($now - $value['at'] > SOCLE_AUDIENCE_WINDOW) unset($GLOBALS['socle_bursts'][$stored]);
    }
    $current = $GLOBALS['socle_bursts'][$key] ?? null;
    if ($current === null || $now - $current['at'] > SOCLE_AUDIENCE_WINDOW) {
        $GLOBALS['socle_bursts'][$key] = ['count' => 1, 'at' => $now];
        return true;
    }
    if ($current['count'] >= $cap) return false;
    $GLOBALS['socle_bursts'][$key]['count'] = $current['count'] + 1;
    return true;
}

function socle_iso_week(string $date): string {
    $parts = array_map('intval', explode('-', $date));
    $utc = new DateTimeImmutable(sprintf('%04d-%02d-%02dT00:00:00Z', $parts[0] ?? 0, $parts[1] ?? 1, $parts[2] ?? 1));
    $weekday = (int) $utc->format('w');
    if ($weekday === 0) $weekday = 7;
    $thursday = $utc->modify('+' . (4 - $weekday) . ' days');
    $yearStart = new DateTimeImmutable($thursday->format('Y') . '-01-01T00:00:00Z');
    $week = (int) ceil(((($thursday->getTimestamp() - $yearStart->getTimestamp()) / 86400) + 1) / 7);
    return $thursday->format('Y') . '-W' . str_pad((string) $week, 2, '0', STR_PAD_LEFT);
}

function socle_age_days(string $older, string $today): int {
    $start = (new DateTimeImmutable($older . 'T00:00:00Z'))->getTimestamp();
    $end = (new DateTimeImmutable($today . 'T00:00:00Z'))->getTimestamp();
    return (int) round(($end - $start) / 86400);
}

function socle_rollup(SocleStore $store, string $today): void {
    foreach ($store->list('audience') as $row) {
        if (!str_starts_with($row['key'], 'day:')) continue;
        $parts = explode(':', $row['key']);
        $date = $parts[1] ?? '';
        if ($date === '' || socle_age_days($date, $today) <= 90) continue;
        $name = $parts[2] ?? '';
        $contexte = $parts[3] ?? '';
        $weekKey = 'week:' . socle_iso_week($date) . ':' . $name . ':' . $contexte;
        $sum = (int) ($store->get('audience', $weekKey) ?? '0') + (int) $row['value'];
        $store->put('audience', $weekKey, (string) $sum);
        $store->delete('audience', $row['key']);
    }
}

function socle_record_event(SocleStore $store, DateTimeImmutable $now, string $name, string $contexte, int $cap = SOCLE_AUDIENCE_CAP): void {
    if (preg_match(SOCLE_AUDIENCE_TOKEN, $name) !== 1 || preg_match(SOCLE_AUDIENCE_TOKEN, $contexte) !== 1) {
        throw new SocleHttp('demande refusée');
    }
    if ($name !== 'article' && $name !== 'sport') {
        if ($store->get('audience', 'allowed:' . $name) !== '1') throw new SocleHttp('nom refusé');
    }
    if (!socle_take_burst($name . ':' . $contexte, socle_epoch_ms($now), $cap)) return;
    $day = socle_civil_date($now);
    $key = 'day:' . $day . ':' . $name . ':' . $contexte;
    $current = (int) ($store->get('audience', $key) ?? '0');
    $store->put('audience', $key, (string) ($current + 1));
    socle_rollup($store, $day);
}

function socle_totals(SocleStore $store, DateTimeImmutable $now): array {
    $day = socle_civil_date($now);
    $totals = [];
    foreach ($store->list('audience') as $row) {
        if (!str_starts_with($row['key'], 'day:' . $day . ':')) continue;
        $parts = explode(':', $row['key']);
        $name = $parts[2] ?? '';
        $contexte = $parts[3] ?? '';
        if ($name === '' || $contexte === '') continue;
        $totals[] = ['name' => $name, 'contexte' => $contexte, 'count' => (int) $row['value']];
    }
    usort($totals, static function (array $a, array $b): int {
        return strcmp($a['name'], $b['name']) ?: strcmp($a['contexte'], $b['contexte']);
    });
    return $totals;
}

function socle_handle_audience(string $method, string $url, array $config, SocleStore $store, string $raw, ?string $actor): array {
    if (!$config['modules']['audience']) return socle_result(404);
    $path = socle_request_path($url);
    $lang = socle_lang($url);
    $copy = $lang === 'en'
        ? ['title' => 'Audience', 'empty' => 'No total today.', 'totals' => "Today's totals.", 'name' => 'Name', 'save' => 'Allow']
        : ['title' => 'Audience', 'empty' => "Aucun total aujourd'hui.", 'totals' => 'Totaux du jour.', 'name' => 'Nom', 'save' => 'Autoriser'];
    try {
        if ($path === '/v1/audience/event' && $method === 'POST') {
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'contexte,name') throw new SocleHttp('demande refusée');
            if (!is_string($body['name'] ?? null) || !is_string($body['contexte'] ?? null)) throw new SocleHttp('demande refusée');
            socle_record_event($store, socle_now(), $body['name'], $body['contexte']);
            return socle_result(204);
        }
        if ($path === '/admin/audience/noms' && $method === 'POST') {
            $allowed = socle_may_update($store, $config['modules']['auth'] ? $actor : null, $config['modules']['auth']);
            if (!$allowed) return socle_text(403, 'réservé au responsable');
            $name = socle_posted_name($raw);
            if ($name === null) throw new SocleHttp('demande refusée');
            socle_allow_name($store, $name);
            if (!str_starts_with(trim($raw), '{')) {
                return socle_result(303, '', ['location' => socle_with_lang('/admin/audience', $lang)]);
            }
            return socle_result(204);
        }
        if ($path === '/admin/audience' && $method === 'GET') {
            $items = '';
            foreach (socle_totals($store, socle_now()) as $row) {
                $items .= '<li>' . socle_escape($row['name']) . ' · ' . socle_escape($row['contexte']) . ' · ' . $row['count'] . '</li>';
            }
            $list = $items !== '' ? '<ul>' . $items . '</ul>' : '<p>' . $copy['empty'] . '</p>';
            $allowed = socle_may_update($store, $config['modules']['auth'] ? $actor : null, $config['modules']['auth']);
            $form = $allowed
                ? '<form class="noprint" method="post" action="' . socle_with_lang('/admin/audience/noms', $lang) . '"><label>' . $copy['name'] . ' <input name="name"></label> <button type="submit">' . $copy['save'] . '</button></form>'
                : '';
            return socle_admin_document($lang, $copy['title'], '<p>' . $copy['totals'] . '</p>' . $list . $form);
        }
        return socle_result(404);
    } catch (SocleHttp $error) {
        return socle_text(400, $error->getMessage());
    }
}

function socle_posted_name(string $raw): ?string {
    $text = trim($raw);
    if (str_starts_with($text, '{')) {
        $body = socle_object_body($raw);
        if ($body === null || socle_keys($body) !== 'name' || !is_string($body['name'] ?? null)) return null;
        return $body['name'];
    }
    $params = socle_form($text);
    if (socle_form_keys($params) !== 'name') return null;
    return $params['name'][0] ?? null;
}
