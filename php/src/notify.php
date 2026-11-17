<?php
declare(strict_types=1);

function socle_notify_runtime(?array $smtp): array {
    $from = socle_env('SOCLE_SMTP_FROM');
    return [
        'publicOrigin' => socle_env('SOCLE_PUBLIC_ORIGIN'),
        'publicKey' => socle_env('SOCLE_VAPID_PUBLIC'),
        'privateKey' => socle_env('SOCLE_VAPID_PRIVATE'),
        'subject' => $from !== null ? 'mailto:' . $from : null,
        'mailer' => $smtp,
    ];
}

function socle_normalize_notify_email(string $value): ?string {
    $email = strtolower(trim($value));
    if (strlen($email) > 200 || preg_match('/^[^\s@]+@[^\s@]+$/', $email) !== 1) return null;
    return $email;
}

function socle_normalize_endpoint(string $value): ?string {
    if (strlen($value) > 500) return null;
    $parts = parse_url($value);
    if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || isset($parts['user']) || isset($parts['pass'])) return null;
    $url = 'https://' . $parts['host'];
    if (isset($parts['port'])) $url .= ':' . $parts['port'];
    $url .= $parts['path'] ?? '';
    if (isset($parts['query'])) $url .= '?' . $parts['query'];
    if (isset($parts['fragment'])) $url .= '#' . $parts['fragment'];
    return $url;
}

function socle_valid_key(string $value, int $bytes): bool {
    if (preg_match('/^[A-Za-z0-9_-]+$/', $value) !== 1) return false;
    return strlen(socle_b64url_decode($value)) === $bytes;
}

function socle_addr_key(string $channel, string $address): string {
    return 'addr:' . $channel . ':' . socle_hash($address);
}

function socle_prepare_subscription(string $channel, string $address, array $runtime, ?array $push = null): array {
    $clean = $channel === 'courriel' ? socle_normalize_notify_email($address) : socle_normalize_endpoint($address);
    if ($clean === null) throw new SocleHttp('demande refusée');
    if ($channel === 'push') {
        if ($runtime['publicKey'] === null || $runtime['privateKey'] === null) throw new SocleHttp('clés absentes', 409);
        if ($push === null || !socle_valid_key($push['p256dh'], 65) || !socle_valid_key($push['auth'], 16)) {
            throw new SocleHttp('demande refusée');
        }
    }
    return ['token' => socle_b64url(random_bytes(32)), 'address' => $clean];
}

function socle_save_subscription(SocleStore $store, string $channel, string $address, string $token, ?array $push = null): void {
    $hash = socle_hash($token);
    $previous = $store->get('notify', socle_addr_key($channel, $address));
    if ($previous !== null) $store->delete('notify', 'lien:' . $previous);
    $record = ['channel' => $channel, 'address' => $address, 'hash' => $hash];
    if ($channel === 'push' && $push !== null) {
        $record['p256dh'] = $push['p256dh'];
        $record['auth'] = $push['auth'];
    }
    $store->put('notify', 'lien:' . $hash, socle_json($record));
    $store->put('notify', socle_addr_key($channel, $address), $hash);
}

function socle_unsubscribe(SocleStore $store, string $token): void {
    $key = 'lien:' . socle_hash($token);
    $raw = $store->get('notify', $key);
    if ($raw === null) throw new SocleHttp('lien inconnu');
    $record = json_decode($raw, true);
    if (!is_array($record)) throw new SocleHttp('lien inconnu');
    $store->delete('notify', $key);
    $store->delete('notify', socle_addr_key((string) $record['channel'], (string) $record['address']));
}

function socle_list_subscriptions(SocleStore $store): array {
    $records = [];
    foreach ($store->list('notify') as $row) {
        if (!str_starts_with($row['key'], 'lien:')) continue;
        $record = json_decode($row['value'], true);
        if (!is_array($record)) continue;
        if (($record['channel'] ?? '') !== 'courriel' && ($record['channel'] ?? '') !== 'push') continue;
        if (empty($record['address']) || empty($record['hash'])) continue;
        $records[] = $record;
    }
    usort($records, static function (array $a, array $b): int {
        return strcmp((string) $a['channel'], (string) $b['channel']) ?: strcmp((string) $a['address'], (string) $b['address']);
    });
    return $records;
}

function socle_subscriptions_for_archive(SocleStore $store): array {
    try {
        return socle_list_subscriptions($store);
    } catch (ModuleOff) {
        return [];
    }
}

function socle_restore_subscriptions(SocleStore $store, mixed $value): void {
    if (!is_array($value)) return;
    try {
        foreach ($value as $item) {
            if (!is_array($item)) continue;
            if (($item['channel'] ?? '') !== 'courriel' && ($item['channel'] ?? '') !== 'push') continue;
            if (empty($item['address']) || empty($item['hash'])) continue;
            $record = [
                'channel' => $item['channel'],
                'address' => $item['address'],
                'hash' => $item['hash'],
            ];
            if (!empty($item['p256dh']) && !empty($item['auth'])) {
                $record['p256dh'] = $item['p256dh'];
                $record['auth'] = $item['auth'];
            }
            $store->put('notify', 'lien:' . $item['hash'], socle_json($record));
            $store->put('notify', socle_addr_key((string) $item['channel'], (string) $item['address']), (string) $item['hash']);
        }
    } catch (ModuleOff) {
        return;
    }
}

function socle_absolute_link(string $origin, string $token): string {
    return rtrim($origin, '/') . '/v1/notify/desabonnement?token=' . rawurlencode($token);
}

function socle_p256_public_pem(string $raw): string {
    $prefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    $der = $prefix . $raw;
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

function socle_pkcs8_pem(string $der): string {
    return "-----BEGIN PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PRIVATE KEY-----\n";
}

function socle_der_to_p1363(string $der): string {
    $offset = 0;
    if (ord($der[$offset]) !== 0x30) throw new SocleHttp('clé illisible');
    $offset += 2;
    $read = static function (string $der, int &$offset): string {
        if (ord($der[$offset]) !== 0x02) throw new SocleHttp('clé illisible');
        $offset += 1;
        $len = ord($der[$offset]);
        $offset += 1;
        $value = substr($der, $offset, $len);
        $offset += $len;
        return ltrim($value, "\x00");
    };
    $r = str_pad($read($der, $offset), 32, "\x00", STR_PAD_LEFT);
    $s = str_pad($read($der, $offset), 32, "\x00", STR_PAD_LEFT);
    return substr($r, -32) . substr($s, -32);
}

function socle_vapid_jwt(string $endpoint, array $runtime, DateTimeImmutable $now): string {
    $header = socle_b64url(socle_json(['typ' => 'JWT', 'alg' => 'ES256']));
    $origin = parse_url($endpoint);
    $aud = ($origin['scheme'] ?? 'https') . '://' . ($origin['host'] ?? '');
    if (isset($origin['port'])) $aud .= ':' . $origin['port'];
    $claims = ['aud' => $aud, 'exp' => intdiv(socle_epoch_ms($now), 1000) + 12 * 60 * 60];
    if ($runtime['subject'] !== null) $claims['sub'] = $runtime['subject'];
    $payload = socle_b64url(socle_json($claims));
    $key = openssl_pkey_get_private(socle_pkcs8_pem(socle_b64url_decode((string) $runtime['privateKey'])));
    if ($key === false) throw new SocleHttp('clé illisible');
    $signature = '';
    if (!openssl_sign($header . '.' . $payload, $signature, $key, OPENSSL_ALGO_SHA256)) throw new SocleHttp('clé illisible');
    return $header . '.' . $payload . '.' . socle_b64url(socle_der_to_p1363($signature));
}

function socle_build_push(array $target, string $text, array $runtime, DateTimeImmutable $now): array {
    if ($runtime['publicKey'] === null || $runtime['privateKey'] === null) throw new SocleHttp('clés absentes', 409);
    $clientPublic = socle_b64url_decode($target['p256dh']);
    $auth = socle_b64url_decode($target['auth']);
    if (strlen($clientPublic) !== 65 || ord($clientPublic[0]) !== 4 || strlen($auth) !== 16) throw new SocleHttp('demande refusée');
    $server = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    if ($server === false) throw new SocleHttp('clé illisible');
    $details = openssl_pkey_get_details($server);
    $x = str_pad($details['ec']['x'], 32, "\x00", STR_PAD_LEFT);
    $y = str_pad($details['ec']['y'], 32, "\x00", STR_PAD_LEFT);
    $serverPublic = "\x04" . $x . $y;
    $peer = openssl_pkey_get_public(socle_p256_public_pem($clientPublic));
    if ($peer === false) throw new SocleHttp('demande refusée');
    $shared = openssl_pkey_derive($peer, $server, 32);
    if (!is_string($shared) || $shared === '') throw new SocleHttp('demande refusée');
    $salt = random_bytes(16);
    $info = "WebPush: info\0" . $clientPublic . $serverPublic;
    $ikm = hash_hkdf('sha256', $shared, 32, $info, $auth);
    $key = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
    $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
    $plain = $text . "\x02";
    $tag = '';
    $sealed = openssl_encrypt($plain, 'aes-128-gcm', $key, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    if ($sealed === false) throw new SocleHttp('demande refusée');
    $body = $salt . pack('N', strlen($plain) + 16 + 1) . chr(strlen($serverPublic)) . $serverPublic . $sealed . $tag;
    return [
        'url' => $target['address'],
        'headers' => [
            'authorization' => 'vapid t=' . socle_vapid_jwt($target['address'], $runtime, $now) . ', k=' . $runtime['publicKey'],
            'content-encoding' => 'aes128gcm',
            'content-type' => 'application/octet-stream',
            'ttl' => '86400',
        ],
        'body' => $body,
    ];
}

function socle_send_push(array $target, string $text, array $runtime, DateTimeImmutable $now): void {
    $request = socle_build_push($target, $text, $runtime, $now);
    $header = '';
    foreach ($request['headers'] as $name => $value) $header .= $name . ': ' . $value . "\r\n";
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => $header,
        'content' => $request['body'],
        'ignore_errors' => true,
        'timeout' => 5,
    ]]);
    @file_get_contents($request['url'], false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('/\s(\d{3})\s/', $line, $match) === 1) {
            $status = (int) $match[1];
            break;
        }
    }
    if ($status < 200 || $status >= 300) throw new SocleHttp('push refusé');
}

function socle_deliver(SocleStore $store, array $runtime, string $text): int {
    $rows = socle_list_subscriptions($store);
    $emails = array_values(array_filter($rows, static fn (array $row): bool => $row['channel'] === 'courriel'));
    $pushes = array_values(array_filter($rows, static fn (array $row): bool => $row['channel'] === 'push' && !empty($row['p256dh']) && !empty($row['auth'])));
    if ($emails !== [] && $runtime['mailer'] === null) throw new SocleHttp('smtp absent', 409);
    if ($pushes !== [] && ($runtime['publicKey'] === null || $runtime['privateKey'] === null)) throw new SocleHttp('clés absentes', 409);
    $sent = 0;
    foreach ($emails as $row) {
        socle_smtp_send($runtime['mailer'], (string) $row['address'], 'Abonnement', $text);
        $sent += 1;
    }
    foreach ($pushes as $row) {
        socle_send_push([
            'address' => (string) $row['address'],
            'p256dh' => (string) $row['p256dh'],
            'auth' => (string) $row['auth'],
        ], $text, $runtime, socle_now());
        $sent += 1;
    }
    return $sent;
}

function socle_posted_text(string $raw): ?string {
    $text = trim($raw);
    if (str_starts_with($text, '{')) {
        $body = socle_object_body($raw);
        if ($body === null || socle_keys($body) !== 'text' || !is_string($body['text'] ?? null)) return null;
        return socle_clean_text($body['text']);
    }
    $params = socle_form($text);
    if (socle_form_keys($params) !== 'text') return null;
    return socle_clean_text($params['text'][0] ?? '');
}

function socle_clean_text(string $value): ?string {
    $text = trim($value);
    if ($text === '' || strlen($text) > 2000) return null;
    return $text;
}

function socle_handle_notify(string $method, string $url, array $config, SocleStore $store, string $raw, ?string $actor, ?array $smtp): array {
    if (!$config['modules']['notify']) return socle_result(404);
    $path = socle_request_path($url);
    $lang = socle_lang($url);
    $runtime = socle_notify_runtime($smtp);
    try {
        if ($path === '/v1/notify/cles' && $method === 'GET') {
            if ($runtime['publicKey'] === null || $runtime['privateKey'] === null) return socle_text(409, 'clés absentes');
            return socle_result(200, socle_json(['publicKey' => $runtime['publicKey']]), ['content-type' => 'application/json; charset=utf-8']);
        }
        if ($path === '/v1/notify/abonnement' && $method === 'POST') {
            $body = socle_object_body($raw);
            if ($body === null) throw new SocleHttp('demande refusée');
            $channel = $body['channel'] ?? null;
            if ($channel !== 'courriel' && $channel !== 'push') throw new SocleHttp('demande refusée');
            $expected = $channel === 'courriel' ? 'address,channel' : 'address,auth,channel,p256dh';
            if (socle_keys($body) !== $expected) throw new SocleHttp('demande refusée');
            if (!is_string($body['address'] ?? null)) throw new SocleHttp('demande refusée');
            if ($channel === 'push' && (!is_string($body['p256dh'] ?? null) || !is_string($body['auth'] ?? null))) {
                throw new SocleHttp('demande refusée');
            }
            if ($channel === 'courriel' && $runtime['mailer'] === null) return socle_text(409, 'smtp absent');
            if ($channel === 'courriel' && $runtime['publicOrigin'] === null) return socle_text(409, 'origine absente');
            $push = $channel === 'push' ? ['p256dh' => (string) $body['p256dh'], 'auth' => (string) $body['auth']] : null;
            $prepared = socle_prepare_subscription($channel, $body['address'], $runtime, $push);
            if ($channel === 'courriel') {
                try {
                    socle_smtp_send($runtime['mailer'], $prepared['address'], 'Abonnement', socle_absolute_link((string) $runtime['publicOrigin'], $prepared['token']));
                } catch (Throwable) {
                    return socle_text(409, 'smtp absent');
                }
            }
            socle_save_subscription($store, $channel, $prepared['address'], $prepared['token'], $push);
            if ($channel === 'courriel') return socle_result(202);
            return socle_result(201, socle_json(['url' => '/v1/notify/desabonnement?token=' . rawurlencode($prepared['token'])]), ['content-type' => 'application/json; charset=utf-8']);
        }
        if ($path === '/v1/notify/desabonnement' && $method === 'GET') {
            $query = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $token = (string) ($query['token'] ?? '');
            if ($token === '') throw new SocleHttp('lien inconnu');
            socle_unsubscribe($store, $token);
            return socle_text(200, 'désabonné');
        }
        if ($path === '/admin/abonnements/envoi' && $method === 'POST') {
            $allowed = socle_may_update($store, $config['modules']['auth'] ? $actor : null, $config['modules']['auth']);
            if (!$allowed) return socle_text(403, 'réservé au responsable');
            $text = socle_posted_text($raw);
            if ($text === null) throw new SocleHttp('demande refusée');
            $sent = socle_deliver($store, $runtime, $text);
            if (!str_starts_with(trim($raw), '{')) {
                return socle_result(303, '', ['location' => socle_with_lang('/admin/abonnements', $lang)]);
            }
            return socle_result(200, socle_json(['sent' => $sent]), ['content-type' => 'application/json; charset=utf-8']);
        }
        if ($path === '/admin/abonnements' && $method === 'GET') {
            return socle_notify_page($store, $config, $lang, $actor, $runtime);
        }
        return socle_result(404);
    } catch (SocleHttp $error) {
        $status = in_array($error->getMessage(), ['clés absentes', 'smtp absent', 'origine absente'], true) ? 409 : $error->status;
        if (!in_array($error->getMessage(), ['clés absentes', 'smtp absent', 'origine absente'], true) && $error->status === 400) $status = 400;
        if ($error->getMessage() === 'lien inconnu' || $error->getMessage() === 'demande refusée') $status = 400;
        return socle_text($status, $error->getMessage());
    }
}

function socle_notify_page(SocleStore $store, array $config, string $lang, ?string $actor, array $runtime): array {
    $copy = $lang === 'en'
        ? ['title' => 'Subscriptions', 'empty' => 'No subscription.', 'email' => 'Email', 'push' => 'Push', 'missing' => 'Push keys are missing.', 'key' => 'Public key', 'message' => 'Message', 'send' => 'Send']
        : ['title' => 'Abonnements', 'empty' => 'Aucun abonnement.', 'email' => 'Courriel', 'push' => 'Push', 'missing' => 'Clés push absentes.', 'key' => 'Clé publique', 'message' => 'Message', 'send' => 'Envoyer'];
    $rows = socle_list_subscriptions($store);
    $emails = 0;
    $pushes = 0;
    foreach ($rows as $row) {
        if ($row['channel'] === 'courriel') $emails += 1;
        if ($row['channel'] === 'push') $pushes += 1;
    }
    $allowed = socle_may_update($store, $config['modules']['auth'] ? $actor : null, $config['modules']['auth']);
    $counts = '<p>' . $copy['email'] . ' : ' . $emails . '. ' . $copy['push'] . ' : ' . $pushes . '.</p>';
    $list = !$allowed
        ? ''
        : ($rows === []
            ? '<p>' . $copy['empty'] . '</p>'
            : '<ul>' . implode('', array_map(static fn (array $row): string => '<li>' . socle_escape((string) $row['channel']) . ' · ' . socle_escape((string) $row['address']) . '</li>', $rows)) . '</ul>');
    $key = $runtime['publicKey'] !== null
        ? '<p>' . $copy['key'] . ' : ' . socle_escape((string) $runtime['publicKey']) . '</p>'
        : '<p>' . $copy['missing'] . '</p>';
    $form = $allowed
        ? '<form class="noprint" method="post" action="' . socle_with_lang('/admin/abonnements/envoi', $lang) . '"><label>' . $copy['message'] . ' <input name="text"></label> <button type="submit">' . $copy['send'] . '</button></form>'
        : '';
    return socle_admin_document($lang, $copy['title'], $counts . $list . $key . $form);
}
