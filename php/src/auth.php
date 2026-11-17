<?php
declare(strict_types=1);

const SOCLE_ROLES = ['auteur', 'reviseur', 'editeur', 'responsable'];
const SOCLE_MAGIC_MS = 900000;
const SOCLE_SESSION_MS = 43200000;
const SOCLE_STATE_MS = 600000;

function socle_is_role(?string $value): bool {
    return $value !== null && in_array($value, SOCLE_ROLES, true);
}

function socle_normalize_email(mixed $value): ?string {
    if (!is_string($value)) return null;
    $email = strtolower(trim($value));
    if (strlen($email) > 200 || preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email) !== 1) return null;
    return $email;
}

function socle_session_cookie(string $token): string {
    return 'socle_session=' . $token . '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' . (int) (SOCLE_SESSION_MS / 1000);
}

function socle_new_token(): string {
    return socle_b64url(random_bytes(32));
}

function socle_ensure_responsable(SocleStore $store, ?string $email): void {
    if ($email === null || trim($email) === '') return;
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    $store->put('auth', 'member:' . $clean, 'responsable');
}

function socle_role_of(SocleStore $store, string $email): ?string {
    try {
        $value = $store->get('auth', 'member:' . $email);
        return socle_is_role($value) ? $value : null;
    } catch (ModuleOff) {
        return null;
    }
}

function socle_may_update(SocleStore $store, ?string $actor, bool $defined): bool {
    if (!$defined) return true;
    if ($actor === null || $actor === '') return false;
    return socle_role_of($store, $actor) === 'responsable';
}

function socle_may_review(SocleStore $store, ?string $actor, bool $defined): bool {
    if (!$defined) return true;
    if ($actor === null || $actor === '') return false;
    $role = socle_role_of($store, $actor);
    return $role === 'reviseur' || $role === 'editeur' || $role === 'responsable';
}

function socle_save_member(SocleStore $store, ?string $actor, string $email, string $role): void {
    if ($actor === null || socle_role_of($store, $actor) !== 'responsable') throw new SocleHttp('réservé au responsable', 403);
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    if (!socle_is_role($role)) throw new SocleHttp('rôle inconnu');
    $store->put('auth', 'member:' . $clean, $role);
}

function socle_auth_runtime(): array {
    return [
        'mode' => socle_env('SOCLE_AUTH_MODE'),
        'publicOrigin' => socle_env('SOCLE_PUBLIC_ORIGIN'),
        'githubClientId' => socle_env('SOCLE_GITHUB_CLIENT_ID'),
        'githubClientSecret' => socle_env('SOCLE_GITHUB_CLIENT_SECRET'),
    ];
}

function socle_require_mode(array $runtime, string $expected): void {
    if (($runtime['mode'] ?? null) !== $expected) throw new SocleHttp('mode inconnu', 409);
}

function socle_plus(DateTimeImmutable $now, int $ms): DateTimeImmutable {
    return $now->modify('+' . intdiv($ms, 1000) . ' seconds');
}

function socle_forget_expired(SocleStore $store, DateTimeImmutable $now): void {
    $instant = socle_epoch_ms($now);
    foreach ($store->list('auth') as $row) {
        if (!str_starts_with($row['key'], 'magic:') && !str_starts_with($row['key'], 'state:') && !str_starts_with($row['key'], 'session:')) continue;
        $exp = '';
        $parsed = json_decode($row['value'], true);
        if (is_array($parsed) && is_string($parsed['exp'] ?? null)) $exp = $parsed['exp'];
        if ($exp === '' || socle_ms($exp) <= $instant) $store->delete('auth', $row['key']);
    }
}

function socle_epoch_ms(DateTimeImmutable $now): int {
    return (int) $now->format('U') * 1000 + (int) $now->format('v');
}

function socle_ms(string $iso): int {
    return socle_epoch_ms(new DateTimeImmutable($iso));
}

function socle_create_session(SocleStore $store, string $email, DateTimeImmutable $now): string {
    $raw = socle_new_token();
    $store->put('auth', 'session:' . socle_hash($raw), socle_json([
        'email' => $email,
        'exp' => socle_iso(socle_plus($now, SOCLE_SESSION_MS)),
    ]));
    return $raw;
}

function socle_start_magic(SocleStore $store, ?array $smtp, DateTimeImmutable $now, string $email): void {
    $runtime = socle_auth_runtime();
    socle_require_mode($runtime, 'magic');
    if ($smtp === null) throw new SocleHttp('smtp absent', 409);
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    socle_forget_expired($store, $now);
    $raw = socle_new_token();
    $hash = socle_hash($raw);
    $exp = socle_iso(socle_plus($now, SOCLE_MAGIC_MS));
    $store->put('auth', 'magic:' . $hash, socle_json(['email' => $clean, 'exp' => $exp]));
    $origin = rtrim($runtime['publicOrigin'] ?? 'http://127.0.0.1:8787', '/');
    try {
        socle_smtp_send($smtp, $clean, 'Lien de connexion', $origin . '/v1/auth/lien?token=' . rawurlencode($raw));
    } catch (Throwable) {
        $store->delete('auth', 'magic:' . $hash);
        throw new SocleHttp('smtp absent', 409);
    }
}

function socle_consume_magic(SocleStore $store, DateTimeImmutable $now, string $token): string {
    socle_require_mode(socle_auth_runtime(), 'magic');
    if ($token === '') throw new SocleHttp('lien inconnu');
    $hash = socle_hash($token);
    $row = $store->get('auth', 'magic:' . $hash);
    if ($row === null) throw new SocleHttp('lien inconnu');
    $store->delete('auth', 'magic:' . $hash);
    $parsed = json_decode($row, true);
    if (!is_array($parsed) || !is_string($parsed['email'] ?? null) || !is_string($parsed['exp'] ?? null) || socle_ms($parsed['exp']) <= socle_ms(socle_iso($now))) {
        throw new SocleHttp('lien expiré');
    }
    socle_forget_expired($store, $now);
    return socle_create_session($store, $parsed['email'], $now);
}

function socle_form_query(array $pairs): string {
    $parts = [];
    foreach ($pairs as $key => $value) {
        $parts[] = socle_form_encode((string) $key) . '=' . socle_form_encode((string) $value);
    }
    return implode('&', $parts);
}

function socle_form_encode(string $value): string {
    return str_replace('%20', '+', str_replace('%2A', '*', rawurlencode($value)));
}

function socle_github_start(SocleStore $store, DateTimeImmutable $now): string {
    $runtime = socle_auth_runtime();
    socle_require_mode($runtime, 'github');
    if ($runtime['githubClientId'] === null || $runtime['githubClientSecret'] === null) throw new SocleHttp('client absent', 409);
    socle_forget_expired($store, $now);
    $state = socle_new_token();
    $store->put('auth', 'state:' . socle_hash($state), socle_json([
        'exp' => socle_iso(socle_plus($now, SOCLE_STATE_MS)),
    ]));
    $pairs = [
        'client_id' => $runtime['githubClientId'],
        'scope' => 'user:email',
        'state' => $state,
    ];
    if ($runtime['publicOrigin'] !== null) {
        $pairs['redirect_uri'] = rtrim($runtime['publicOrigin'], '/') . '/v1/auth/github/retour';
    }
    return 'https://github.com/login/oauth/authorize?' . socle_form_query($pairs);
}

function socle_http_json(string $url, string $method, array $headers, ?string $body): array {
    $lines = [];
    foreach ($headers as $name => $value) $lines[] = $name . ': ' . $value;
    $context = stream_context_create(['http' => [
        'method' => $method,
        'header' => implode("\r\n", $lines),
        'content' => $body ?? '',
        'ignore_errors' => true,
        'timeout' => 5,
    ]]);
    $raw = @file_get_contents($url, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('/\s(\d{3})\s/', $line, $match) === 1) {
            $status = (int) $match[1];
            break;
        }
    }
    return ['ok' => $status >= 200 && $status < 300, 'body' => $raw === false ? '' : $raw];
}

function socle_github_email(string $code): string {
    $runtime = socle_auth_runtime();
    try {
        $tokenRes = socle_http_json('https://github.com/login/oauth/access_token', 'POST', [
            'accept' => 'application/json',
            'content-type' => 'application/json',
        ], socle_json([
            'client_id' => $runtime['githubClientId'],
            'client_secret' => $runtime['githubClientSecret'],
            'code' => $code,
        ]));
        $tokenBody = json_decode($tokenRes['body'], true);
        if (!$tokenRes['ok'] || !is_array($tokenBody) || !is_string($tokenBody['access_token'] ?? null)) {
            throw new SocleHttp('github refusé', 502);
        }
        $emailsRes = socle_http_json('https://api.github.com/user/emails', 'GET', [
            'accept' => 'application/vnd.github+json',
            'authorization' => 'Bearer ' . $tokenBody['access_token'],
        ], null);
        $emails = json_decode($emailsRes['body'], true);
        $chosen = null;
        if (is_array($emails)) {
            foreach ($emails as $item) {
                if (is_array($item) && ($item['primary'] ?? false) && ($item['verified'] ?? false)) {
                    $chosen = $item['email'] ?? null;
                    break;
                }
            }
            if ($chosen === null) {
                foreach ($emails as $item) {
                    if (is_array($item) && ($item['verified'] ?? false)) {
                        $chosen = $item['email'] ?? null;
                        break;
                    }
                }
            }
        }
        $clean = socle_normalize_email($chosen);
        if (!$emailsRes['ok'] || $clean === null) throw new SocleHttp('github refusé', 502);
        return $clean;
    } catch (SocleHttp $error) {
        throw $error;
    } catch (Throwable) {
        throw new SocleHttp('github refusé', 502);
    }
}

function socle_github_finish(SocleStore $store, DateTimeImmutable $now, string $code, string $state): string {
    $runtime = socle_auth_runtime();
    socle_require_mode($runtime, 'github');
    if ($runtime['githubClientId'] === null || $runtime['githubClientSecret'] === null) throw new SocleHttp('client absent', 409);
    if ($code === '' || $state === '') throw new SocleHttp('demande refusée');
    $key = 'state:' . socle_hash($state);
    $row = $store->get('auth', $key);
    $store->delete('auth', $key);
    if ($row === null) throw new SocleHttp('demande refusée');
    $parsed = json_decode($row, true);
    if (!is_array($parsed) || !is_string($parsed['exp'] ?? null) || socle_ms($parsed['exp']) <= socle_ms(socle_iso($now))) {
        throw new SocleHttp('lien expiré');
    }
    return socle_create_session($store, socle_github_email($code), $now);
}

function socle_access_login(SocleStore $store, DateTimeImmutable $now, ?string $assertion): string {
    socle_require_mode(socle_auth_runtime(), 'access');
    if ($assertion === null || $assertion === '') throw new SocleHttp('accès refusé', 401);
    throw new SocleHttp('accès refusé', 401);
}

function socle_email_from_cookie(SocleStore $store, DateTimeImmutable $now, ?string $cookie): ?string {
    $token = socle_cookie($cookie ?? '', 'socle_session');
    if ($token === null) return null;
    $key = 'session:' . socle_hash($token);
    try {
        $row = $store->get('auth', $key);
        if ($row === null) return null;
        $parsed = json_decode($row, true);
        if (!is_array($parsed) || !is_string($parsed['email'] ?? null) || !is_string($parsed['exp'] ?? null) || socle_ms($parsed['exp']) <= socle_ms(socle_iso($now))) {
            $store->delete('auth', $key);
            return null;
        }
        return $parsed['email'];
    } catch (ModuleOff) {
        return null;
    }
}

function socle_members_for_archive(SocleStore $store): array {
    try {
        $members = [];
        foreach ($store->list('auth') as $row) {
            if (!str_starts_with($row['key'], 'member:')) continue;
            if (!socle_is_role($row['value'])) continue;
            $members[] = ['email' => substr($row['key'], strlen('member:')), 'role' => $row['value']];
        }
        usort($members, static fn (array $a, array $b): int => strcmp($a['email'], $b['email']));
        return $members;
    } catch (ModuleOff) {
        return [];
    }
}

function socle_restore_members(SocleStore $store, mixed $value): void {
    if (!is_array($value)) return;
    foreach ($value as $item) {
        if (!is_array($item)) continue;
        $email = socle_normalize_email($item['email'] ?? null);
        $role = is_string($item['role'] ?? null) ? $item['role'] : null;
        if ($email === null || !socle_is_role($role)) continue;
        try {
            $store->put('auth', 'member:' . $email, $role);
        } catch (ModuleOff) {
            return;
        }
    }
}

function socle_auth_fail(SocleHttp $error): array {
    return socle_text($error->status, $error->getMessage());
}

function socle_handle_auth(string $method, string $url, array $config, SocleStore $store, string $raw, ?string $cookie, ?string $accessHeader, ?array $smtp): array {
    if (!$config['modules']['auth']) return socle_result(404);
    $path = socle_request_path($url);
    $now = socle_now();
    try {
        if ($path === '/v1/auth/lien' && $method === 'POST') {
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'email' || !is_string($body['email'] ?? null)) {
                socle_require_mode(socle_auth_runtime(), socle_auth_runtime()['mode'] ?? '');
                $mode = socle_auth_runtime()['mode'];
                if ($mode !== 'magic' && $mode !== 'github' && $mode !== 'access') throw new SocleHttp('mode inconnu', 409);
                throw new SocleHttp('demande refusée');
            }
            socle_start_magic($store, $smtp, $now, $body['email']);
            return socle_result(202);
        }
        if ($path === '/v1/auth/lien' && $method === 'GET') {
            $query = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $session = socle_consume_magic($store, $now, (string) ($query['token'] ?? ''));
            return socle_result(303, '', ['location' => '/admin', 'set-cookie' => socle_session_cookie($session)]);
        }
        if ($path === '/v1/auth/github' && $method === 'GET') {
            return socle_result(302, '', ['location' => socle_github_start($store, $now)]);
        }
        if ($path === '/v1/auth/github/retour' && $method === 'GET') {
            $query = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $session = socle_github_finish($store, $now, (string) ($query['code'] ?? ''), (string) ($query['state'] ?? ''));
            return socle_result(303, '', ['location' => '/admin', 'set-cookie' => socle_session_cookie($session)]);
        }
        if ($path === '/v1/auth/access' && $method === 'GET') {
            $assertion = $accessHeader !== null && $accessHeader !== '' ? $accessHeader : socle_cookie($cookie ?? '', 'CF_Authorization');
            $session = socle_access_login($store, $now, $assertion);
            return socle_result(303, '', ['location' => '/admin', 'set-cookie' => socle_session_cookie($session)]);
        }
        if ($path === '/v1/auth/membres' && $method === 'POST') {
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'email,role') throw new SocleHttp('demande refusée');
            if (!is_string($body['email'] ?? null) || !is_string($body['role'] ?? null)) throw new SocleHttp('demande refusée');
            $actor = socle_email_from_cookie($store, $now, $cookie);
            socle_save_member($store, $actor, $body['email'], $body['role']);
            return socle_result(204);
        }
        return socle_result(404);
    } catch (SocleHttp $error) {
        return socle_auth_fail($error);
    }
}
