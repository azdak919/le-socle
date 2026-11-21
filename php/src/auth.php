<?php
declare(strict_types=1);

require_once __DIR__ . '/roles.php';

/** Anciens noms de rôle encore lus (comptes et archives d’avant 1.2). */
const SOCLE_LEGACY_ROLES = ['responsable' => 'administrateur'];
const SOCLE_MAGIC_MS = 900000;
const SOCLE_RESET_MS = 3600000;
const SOCLE_EMAIL_CHANGE_MS = 3600000;
const SOCLE_SESSION_MS = 43200000;
const SOCLE_STATE_MS = 600000;
const SOCLE_RESET_MAX = 5;
const SOCLE_RESET_IP_MAX = 20;
const SOCLE_PBKDF2_ITERATIONS = 210000;
const SOCLE_MIN_PASSWORD = 10;
const SOCLE_MAX_TRIES = 10;
const SOCLE_TRIES_MS = 900000;
const SOCLE_DUMMY_HASH = 'pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Même format que Node : pbkdf2-sha256$tours$sel$empreinte (base64url). */
function socle_hash_password(string $password, ?string $salt = null): string {
    $salt ??= random_bytes(16);
    $hash = hash_pbkdf2('sha256', $password, $salt, SOCLE_PBKDF2_ITERATIONS, 32, true);
    return 'pbkdf2-sha256$' . SOCLE_PBKDF2_ITERATIONS . '$' . socle_b64url($salt) . '$' . socle_b64url($hash);
}

function socle_verify_password(string $password, ?string $stored): bool {
    $parts = explode('$', (string) $stored);
    if (count($parts) !== 4 || $parts[0] !== 'pbkdf2-sha256') return false;
    $rounds = (int) $parts[1];
    if ((string) $rounds !== $parts[1] || $rounds < 1000 || $rounds > 2000000) return false;
    $expected = socle_b64url_decode($parts[3]);
    if ($expected === '') return false;
    $actual = hash_pbkdf2('sha256', $password, socle_b64url_decode($parts[2]), $rounds, strlen($expected), true);
    return hash_equals($expected, $actual);
}

function socle_check_password(mixed $password): string {
    if (!is_string($password) || mb_strlen($password) < SOCLE_MIN_PASSWORD || mb_strlen($password) > 200) throw new SocleHttp('mot de passe trop court');
    return $password;
}

function socle_any_member(SocleStore $store): bool {
    foreach ($store->list('auth') as $row) {
        if (str_starts_with($row['key'], 'member:') && socle_canonical_role($row['value']) !== null) return true;
    }
    return false;
}

function socle_password_install(SocleStore $store, DateTimeImmutable $now, mixed $email, mixed $password): string {
    socle_require_mode(socle_auth_runtime(), 'motdepasse');
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    $secret = socle_check_password($password);
    if (socle_any_member($store)) throw new SocleHttp('déjà installé', 409);
    $store->put('auth', 'member:' . $clean, 'administrateur');
    $store->put('auth', 'password:' . $clean, socle_hash_password($secret));
    return socle_create_session($store, $clean, $now);
}

function socle_password_login(SocleStore $store, DateTimeImmutable $now, mixed $email, mixed $password): string {
    socle_require_mode(socle_auth_runtime(), 'motdepasse');
    $clean = socle_normalize_email($email);
    if ($clean === null || !is_string($password)) throw new SocleHttp('accès refusé', 401);
    $key = 'tries:' . $clean;
    $tries = json_decode((string) ($store->get('auth', $key) ?? '{}'), true);
    if (!is_array($tries)) $tries = [];
    $since = is_string($tries['since'] ?? null) ? $tries['since'] : null;
    $fresh = $since !== null && socle_ms(socle_iso($now)) - socle_ms($since) < SOCLE_TRIES_MS;
    $count = (int) ($tries['n'] ?? 0);
    if ($fresh && $count >= SOCLE_MAX_TRIES) throw new SocleHttp("trop d'essais", 429);
    $known = socle_role_of($store, $clean) !== null;
    $matches = socle_verify_password($password, ($known ? $store->get('auth', 'password:' . $clean) : null) ?? SOCLE_DUMMY_HASH);
    if (!$known || !$matches) {
        $store->put('auth', $key, socle_json(['n' => ($fresh ? $count : 0) + 1, 'since' => $fresh ? $since : socle_iso($now)]));
        throw new SocleHttp('accès refusé', 401);
    }
    $store->delete('auth', $key);
    socle_forget_expired($store, $now);
    return socle_create_session($store, $clean, $now);
}

function socle_is_role(?string $value): bool {
    return $value !== null && in_array($value, SOCLE_ROLES, true);
}

/** Rôle à jour : « responsable » (ancien nom) devient « administrateur ». */
function socle_canonical_role(?string $value): ?string {
    if (socle_is_role($value)) return $value;
    return $value !== null ? (SOCLE_LEGACY_ROLES[$value] ?? null) : null;
}

function socle_normalize_email(mixed $value): ?string {
    if (!is_string($value)) return null;
    $email = strtolower(trim($value));
    if (strlen($email) > 200 || preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email) !== 1) return null;
    return $email;
}

function socle_cookie_secure(): bool {
    $origin = socle_env('SOCLE_PUBLIC_ORIGIN') ?? '';
    return str_starts_with($origin, 'https://');
}

function socle_session_cookie(string $token): string {
    $secure = socle_cookie_secure() ? '; Secure' : '';
    return 'socle_session=' . $token . '; HttpOnly; Path=/; SameSite=Lax' . $secure . '; Max-Age=' . (int) (SOCLE_SESSION_MS / 1000);
}

function socle_clear_session_cookie(): string {
    $secure = socle_cookie_secure() ? '; Secure' : '';
    return 'socle_session=; HttpOnly; Path=/; SameSite=Lax' . $secure . '; Max-Age=0';
}

function socle_new_token(): string {
    return socle_b64url(random_bytes(32));
}

/** Ancien nom, gardé pour les intégrations existantes. */
function socle_ensure_responsable(SocleStore $store, ?string $email): void {
    socle_ensure_administrateur($store, $email);
}

function socle_ensure_administrateur(SocleStore $store, ?string $email): void {
    if ($email === null || trim($email) === '') return;
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    $store->put('auth', 'member:' . $clean, 'administrateur');
}

function socle_role_of(SocleStore $store, string $email): ?string {
    try {
        return socle_canonical_role($store->get('auth', 'member:' . $email));
    } catch (ModuleOff) {
        return null;
    }
}

function socle_may_update(SocleStore $store, ?string $actor, bool $defined): bool {
    if (!$defined) return true;
    if ($actor === null || $actor === '') return false;
    return socle_role_of($store, $actor) === 'administrateur';
}

function socle_may_review(SocleStore $store, ?string $actor, bool $defined): bool {
    if (!$defined) return true;
    if ($actor === null || $actor === '') return false;
    $role = socle_role_of($store, $actor);
    return $role === 'reviseur' || $role === 'editeur' || $role === 'administrateur';
}

/** Rubriques d’un compte ; liste vide = toutes. */
function socle_scope_of(SocleStore $store, string $email): array {
    try {
        $raw = $store->get('auth', 'scope:' . $email);
    } catch (ModuleOff) {
        return [];
    }
    return $raw === null ? [] : socle_clean_scope(json_decode($raw, true));
}

function socle_write_scope(SocleStore $store, string $email, string $role, mixed $sections): void {
    $scope = in_array($role, SOCLE_SCOPED, true) ? socle_clean_scope($sections) : [];
    if ($scope !== []) $store->put('auth', 'scope:' . $email, socle_json($scope));
    else $store->delete('auth', 'scope:' . $email);
}

function socle_save_member(SocleStore $store, ?string $actor, string $email, string $role, ?string $password = null, mixed $sections = null): void {
    if ($actor === null || socle_role_of($store, $actor) !== 'administrateur') throw new SocleHttp('réservé à l’administrateur', 403);
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    $canonical = socle_canonical_role($role);
    if ($canonical === null) throw new SocleHttp('rôle inconnu');
    if ($password !== null) $store->put('auth', 'password:' . $clean, socle_hash_password(socle_check_password($password)));
    $store->put('auth', 'member:' . $clean, $canonical);
    socle_write_scope($store, $clean, $canonical, $sections);
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
        if (
            !str_starts_with($row['key'], 'magic:')
            && !str_starts_with($row['key'], 'state:')
            && !str_starts_with($row['key'], 'session:')
            && !str_starts_with($row['key'], 'reset:')
            && !str_starts_with($row['key'], 'courriel:')
        ) continue;
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
        $url = $origin . '/v1/auth/lien?token=' . rawurlencode($raw);
        socle_smtp_send($smtp, $clean, 'Lien de connexion', "Bonjour,\n\nPour ouvrir l’espace de rédaction, suivez ce lien (il expire dans 15 minutes) :\n\n{$url}\n");
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
            $role = socle_canonical_role($row['value']);
            if ($role === null) continue;
            $email = substr($row['key'], strlen('member:'));
            $sections = socle_scope_of($store, $email);
            $members[] = $sections !== [] ? ['email' => $email, 'role' => $role, 'sections' => $sections] : ['email' => $email, 'role' => $role];
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
        $role = socle_canonical_role(is_string($item['role'] ?? null) ? $item['role'] : null);
        if ($email === null || $role === null) continue;
        try {
            $store->put('auth', 'member:' . $email, $role);
            socle_write_scope($store, $email, $role, $item['sections'] ?? null);
        } catch (ModuleOff) {
            return;
        }
    }
}


function socle_too_many_tries(SocleStore $store, string $key, DateTimeImmutable $now, int $max): bool {
    $tries = json_decode((string) ($store->get('auth', $key) ?? '{}'), true);
    if (!is_array($tries)) $tries = [];
    $since = is_string($tries['since'] ?? null) ? $tries['since'] : null;
    $fresh = $since !== null && socle_ms(socle_iso($now)) - socle_ms($since) < SOCLE_TRIES_MS;
    return $fresh && (int) ($tries['n'] ?? 0) >= $max;
}

function socle_bump_tries(SocleStore $store, string $key, DateTimeImmutable $now): void {
    $tries = json_decode((string) ($store->get('auth', $key) ?? '{}'), true);
    if (!is_array($tries)) $tries = [];
    $since = is_string($tries['since'] ?? null) ? $tries['since'] : null;
    $fresh = $since !== null && socle_ms(socle_iso($now)) - socle_ms($since) < SOCLE_TRIES_MS;
    $store->put('auth', $key, socle_json([
        'n' => ($fresh ? (int) ($tries['n'] ?? 0) : 0) + 1,
        'since' => $fresh ? $since : socle_iso($now),
    ]));
}

function socle_revoke_sessions(SocleStore $store, string $email, ?string $keepHash = null): void {
    foreach ($store->list('auth') as $row) {
        if (!str_starts_with($row['key'], 'session:')) continue;
        if ($keepHash !== null && $row['key'] === 'session:' . $keepHash) continue;
        $parsed = json_decode($row['value'], true);
        $stored = is_array($parsed) && is_string($parsed['email'] ?? null) ? $parsed['email'] : '';
        if ($stored === $email) $store->delete('auth', $row['key']);
    }
}

function socle_rewrite_session_email(SocleStore $store, string $from, string $to): void {
    foreach ($store->list('auth') as $row) {
        if (!str_starts_with($row['key'], 'session:')) continue;
        $parsed = json_decode($row['value'], true);
        if (!is_array($parsed) || ($parsed['email'] ?? null) !== $from) continue;
        $parsed['email'] = $to;
        $store->put('auth', $row['key'], socle_json($parsed));
    }
}

function socle_start_password_reset(SocleStore $store, ?array $smtp, DateTimeImmutable $now, mixed $email, ?string $ip): void {
    socle_require_mode(socle_auth_runtime(), 'motdepasse');
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    if ($ip !== null && $ip !== '' && socle_too_many_tries($store, 'reset-ip:' . $ip, $now, SOCLE_RESET_IP_MAX)) {
        throw new SocleHttp("trop d'essais", 429);
    }
    if (socle_too_many_tries($store, 'reset-tries:' . $clean, $now, SOCLE_RESET_MAX)) {
        throw new SocleHttp("trop d'essais", 429);
    }
    socle_bump_tries($store, 'reset-tries:' . $clean, $now);
    if ($ip !== null && $ip !== '') socle_bump_tries($store, 'reset-ip:' . $ip, $now);
    if (socle_role_of($store, $clean) === null || $smtp === null) return;
    socle_forget_expired($store, $now);
    $raw = socle_new_token();
    $hash = socle_hash($raw);
    $store->put('auth', 'reset:' . $hash, socle_json([
        'email' => $clean,
        'exp' => socle_iso(socle_plus($now, SOCLE_RESET_MS)),
    ]));
    $runtime = socle_auth_runtime();
    $origin = rtrim($runtime['publicOrigin'] ?? 'http://127.0.0.1:8787', '/');
    $url = $origin . '/redaction/#reinitialiser=' . rawurlencode($raw);
    try {
        socle_smtp_send($smtp, $clean, 'Réinitialiser votre mot de passe', "Bonjour,\n\nPour choisir un nouveau mot de passe pour l’espace de rédaction, suivez ce lien (il expire dans une heure, et ne sert qu’une fois) :\n\n{$url}\n\nSi vous n’avez pas demandé ce message, vous pouvez l’ignorer.\n");
    } catch (Throwable) {
        $store->delete('auth', 'reset:' . $hash);
    }
}

function socle_consume_password_reset(SocleStore $store, DateTimeImmutable $now, mixed $token, mixed $password): string {
    socle_require_mode(socle_auth_runtime(), 'motdepasse');
    if (!is_string($token) || $token === '') throw new SocleHttp('lien inconnu');
    $hash = socle_hash($token);
    $row = $store->get('auth', 'reset:' . $hash);
    if ($row === null) throw new SocleHttp('lien inconnu');
    $store->delete('auth', 'reset:' . $hash);
    $parsed = json_decode($row, true);
    if (!is_array($parsed) || !is_string($parsed['email'] ?? null) || !is_string($parsed['exp'] ?? null) || socle_ms($parsed['exp']) <= socle_epoch_ms($now)) {
        throw new SocleHttp('lien expiré');
    }
    $secret = socle_check_password($password);
    $store->put('auth', 'password:' . $parsed['email'], socle_hash_password($secret));
    $store->delete('auth', 'tries:' . $parsed['email']);
    socle_revoke_sessions($store, $parsed['email']);
    socle_forget_expired($store, $now);
    return socle_create_session($store, $parsed['email'], $now);
}

function socle_clean_name(mixed $value, string $label): string {
    if (!is_string($value)) throw new SocleHttp('demande refusée');
    $name = trim(preg_replace('/\s+/u', ' ', $value) ?? $value);
    if (strlen($name) > 120) throw new SocleHttp($label . ' trop long');
    return $name;
}

function socle_load_profile(SocleStore $store, string $email): array {
    $raw = $store->get('auth', 'profil:' . $email);
    $nom = '';
    $nomAffiche = '';
    if ($raw !== null) {
        $parsed = json_decode($raw, true);
        if (is_array($parsed)) {
            if (is_string($parsed['nom'] ?? null)) $nom = $parsed['nom'];
            if (is_string($parsed['nomAffiche'] ?? null)) $nomAffiche = $parsed['nomAffiche'];
        }
    }
    return ['email' => $email, 'nom' => $nom, 'nomAffiche' => $nomAffiche];
}

function socle_read_profile(SocleStore $store, ?string $actor): array {
    if ($actor === null || socle_role_of($store, $actor) === null) throw new SocleHttp('accès refusé', 401);
    return socle_load_profile($store, $actor);
}

function socle_update_profile(SocleStore $store, ?string $actor, mixed $nom, mixed $nomAffiche): array {
    if ($actor === null || socle_role_of($store, $actor) === null) throw new SocleHttp('accès refusé', 401);
    $profile = [
        'nom' => socle_clean_name($nom, 'nom'),
        'nomAffiche' => socle_clean_name($nomAffiche, 'nom d’affichage'),
    ];
    $store->put('auth', 'profil:' . $actor, socle_json($profile));
    return ['email' => $actor] + $profile;
}

function socle_change_own_password(SocleStore $store, DateTimeImmutable $now, ?string $actor, mixed $current, mixed $next, ?string $cookie): void {
    socle_require_mode(socle_auth_runtime(), 'motdepasse');
    if ($actor === null || socle_role_of($store, $actor) === null) throw new SocleHttp('accès refusé', 401);
    if (!is_string($current)) throw new SocleHttp('accès refusé', 401);
    $secret = socle_check_password($next);
    $matches = socle_verify_password($current, $store->get('auth', 'password:' . $actor) ?? SOCLE_DUMMY_HASH);
    if (!$matches) throw new SocleHttp('accès refusé', 401);
    if ($current === $secret) throw new SocleHttp('mot de passe inchangé');
    $store->put('auth', 'password:' . $actor, socle_hash_password($secret));
    $token = socle_cookie($cookie ?? '', 'socle_session');
    socle_revoke_sessions($store, $actor, $token !== null ? socle_hash($token) : null);
    $store->delete('auth', 'tries:' . $actor);
    socle_forget_expired($store, $now);
}

function socle_start_email_change(SocleStore $store, ?array $smtp, DateTimeImmutable $now, ?string $actor, mixed $email): void {
    if ($actor === null || socle_role_of($store, $actor) === null) throw new SocleHttp('accès refusé', 401);
    if ($smtp === null) throw new SocleHttp('smtp absent', 409);
    $clean = socle_normalize_email($email);
    if ($clean === null) throw new SocleHttp('demande refusée');
    if ($clean === $actor) throw new SocleHttp('courriel inchangé');
    if (socle_role_of($store, $clean) !== null) throw new SocleHttp('courriel déjà utilisé');
    socle_forget_expired($store, $now);
    $raw = socle_new_token();
    $hash = socle_hash($raw);
    $store->put('auth', 'courriel:' . $hash, socle_json([
        'email' => $actor,
        'nouveau' => $clean,
        'exp' => socle_iso(socle_plus($now, SOCLE_EMAIL_CHANGE_MS)),
    ]));
    $runtime = socle_auth_runtime();
    $origin = rtrim($runtime['publicOrigin'] ?? 'http://127.0.0.1:8787', '/');
    $url = $origin . '/redaction/#courriel=' . rawurlencode($raw);
    try {
        socle_smtp_send($smtp, $clean, 'Confirmer votre nouveau courriel', "Bonjour,\n\nPour confirmer cette adresse comme courriel de l’espace de rédaction, suivez ce lien (il expire dans une heure, et ne sert qu’une fois) :\n\n{$url}\n\nSi vous n’avez pas demandé ce changement, ignorez ce message.\n");
    } catch (Throwable) {
        $store->delete('auth', 'courriel:' . $hash);
        throw new SocleHttp('smtp absent', 409);
    }
}

function socle_confirm_email_change(SocleStore $store, DateTimeImmutable $now, mixed $token, ?string $actor): string {
    if ($actor === null) throw new SocleHttp('accès refusé', 401);
    if (!is_string($token) || $token === '') throw new SocleHttp('lien inconnu');
    $hash = socle_hash($token);
    $row = $store->get('auth', 'courriel:' . $hash);
    if ($row === null) throw new SocleHttp('lien inconnu');
    $store->delete('auth', 'courriel:' . $hash);
    $parsed = json_decode($row, true);
    if (!is_array($parsed) || !is_string($parsed['email'] ?? null) || !is_string($parsed['nouveau'] ?? null) || !is_string($parsed['exp'] ?? null) || socle_ms($parsed['exp']) <= socle_epoch_ms($now)) {
        throw new SocleHttp('lien expiré');
    }
    if ($parsed['email'] !== $actor) throw new SocleHttp('lien inconnu');
    if (socle_role_of($store, $parsed['nouveau']) !== null) throw new SocleHttp('courriel déjà utilisé');
    $role = socle_role_of($store, $parsed['email']);
    if ($role === null) throw new SocleHttp('accès refusé', 401);
    $password = $store->get('auth', 'password:' . $parsed['email']);
    $scope = $store->get('auth', 'scope:' . $parsed['email']);
    $profil = $store->get('auth', 'profil:' . $parsed['email']);
    $store->put('auth', 'member:' . $parsed['nouveau'], $role);
    if ($password !== null) $store->put('auth', 'password:' . $parsed['nouveau'], $password);
    if ($scope !== null) $store->put('auth', 'scope:' . $parsed['nouveau'], $scope);
    if ($profil !== null) $store->put('auth', 'profil:' . $parsed['nouveau'], $profil);
    $store->delete('auth', 'member:' . $parsed['email']);
    $store->delete('auth', 'password:' . $parsed['email']);
    $store->delete('auth', 'scope:' . $parsed['email']);
    $store->delete('auth', 'profil:' . $parsed['email']);
    $store->delete('auth', 'tries:' . $parsed['email']);
    socle_rewrite_session_email($store, $parsed['email'], $parsed['nouveau']);
    socle_forget_expired($store, $now);
    return $parsed['nouveau'];
}

function socle_journal_name(SocleStore $store, array $config): ?string {
    if (empty($config['modules']['editorial'])) return null;
    try {
        $publication = socle_read_publication($store);
    } catch (Throwable) {
        return null;
    }
    $name = is_array($publication) && is_string($publication['name'] ?? null) ? trim($publication['name']) : '';
    return $name !== '' ? $name : null;
}

function socle_auth_fail(SocleHttp $error): array {
    return socle_text($error->status, $error->getMessage());
}

function socle_handle_auth(string $method, string $url, array $config, SocleStore $store, string $raw, ?string $cookie, ?string $accessHeader, ?array $smtp, ?string $ip = null): array {
    if (!$config['modules']['auth']) return socle_result(404);
    $path = socle_request_path($url);
    $now = socle_now();
    try {
        if ($path === '/v1/auth/lien' && $method === 'POST') {
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'email' || !is_string($body['email'] ?? null)) {
                socle_require_mode(socle_auth_runtime(), socle_auth_runtime()['mode'] ?? '');
                $mode = socle_auth_runtime()['mode'];
                if ($mode !== 'magic' && $mode !== 'github' && $mode !== 'access' && $mode !== 'motdepasse') throw new SocleHttp('mode inconnu', 409);
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
        $jsonType = ['content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store'];
        if ($path === '/v1/auth/etat' && $method === 'GET') {
            $actor = socle_email_from_cookie($store, $now, $cookie);
            return socle_result(200, socle_json([
                'mode' => socle_auth_runtime()['mode'],
                'installed' => socle_any_member($store),
                'email' => $actor,
                'role' => $actor !== null ? socle_role_of($store, $actor) : null,
                'journal' => socle_journal_name($store, $config),
                'courriel' => $smtp !== null,
            ]), $jsonType);
        }
        if (($path === '/v1/auth/installation' || $path === '/v1/auth/motdepasse') && $method === 'POST') {
            if (!str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''), 'application/json')) throw new SocleHttp('demande refusée');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'email,password') throw new SocleHttp('demande refusée');
            $session = $path === '/v1/auth/installation'
                ? socle_password_install($store, $now, $body['email'], $body['password'])
                : socle_password_login($store, $now, $body['email'], $body['password']);
            return socle_result(204, '', ['set-cookie' => socle_session_cookie($session)]);
        }
        if ($path === '/v1/auth/deconnexion' && $method === 'POST') {
            $token = socle_cookie($cookie ?? '', 'socle_session');
            if ($token !== null) $store->delete('auth', 'session:' . socle_hash($token));
            return socle_result(204, '', ['set-cookie' => socle_clear_session_cookie()]);
        }
        if ($path === '/v1/auth/membres' && $method === 'GET') {
            $actor = socle_email_from_cookie($store, $now, $cookie);
            if ($actor === null || socle_role_of($store, $actor) !== 'administrateur') throw new SocleHttp('réservé à l’administrateur', 403);
            return socle_result(200, socle_json(socle_members_for_archive($store)), $jsonType);
        }
        if ($path === '/v1/auth/membres' && $method === 'POST') {
            $body = socle_object_body($raw);
            if ($body === null || array_diff(array_keys($body), ['email', 'password', 'role', 'sections']) !== []) throw new SocleHttp('demande refusée');
            if (array_key_exists('sections', $body) && !is_array($body['sections'])) throw new SocleHttp('demande refusée');
            if (!is_string($body['email'] ?? null) || !is_string($body['role'] ?? null)) throw new SocleHttp('demande refusée');
            if (array_key_exists('password', $body) && (socle_auth_runtime()['mode'] ?? null) !== 'motdepasse') throw new SocleHttp('demande refusée');
            if (array_key_exists('password', $body) && !is_string($body['password'])) throw new SocleHttp('mot de passe trop court');
            $actor = socle_email_from_cookie($store, $now, $cookie);
            socle_save_member($store, $actor, $body['email'], $body['role'], $body['password'] ?? null, $body['sections'] ?? null);
            return socle_result(204);
        }

        if ($path === '/v1/auth/reinitialiser' && $method === 'POST') {
            if (!str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''), 'application/json')) throw new SocleHttp('demande refusée');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'email' || !is_string($body['email'] ?? null)) throw new SocleHttp('demande refusée');
            socle_start_password_reset($store, $smtp, $now, $body['email'], $ip);
            return socle_result(202);
        }
        if ($path === '/v1/auth/reinitialiser/confirmer' && $method === 'POST') {
            if (!str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''), 'application/json')) throw new SocleHttp('demande refusée');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'password,token') throw new SocleHttp('demande refusée');
            $session = socle_consume_password_reset($store, $now, $body['token'] ?? null, $body['password'] ?? null);
            return socle_result(204, '', ['set-cookie' => socle_session_cookie($session)]);
        }
        if ($path === '/v1/auth/profil' && $method === 'GET') {
            $actor = socle_email_from_cookie($store, $now, $cookie);
            return socle_result(200, socle_json(socle_read_profile($store, $actor)), $jsonType);
        }
        if ($path === '/v1/auth/profil' && $method === 'POST') {
            if (!str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''), 'application/json')) throw new SocleHttp('demande refusée');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'nom,nomAffiche') throw new SocleHttp('demande refusée');
            $actor = socle_email_from_cookie($store, $now, $cookie);
            return socle_result(200, socle_json(socle_update_profile($store, $actor, $body['nom'] ?? null, $body['nomAffiche'] ?? null)), $jsonType);
        }
        if ($path === '/v1/auth/profil/motdepasse' && $method === 'POST') {
            if (!str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''), 'application/json')) throw new SocleHttp('demande refusée');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'actuel,nouveau') throw new SocleHttp('demande refusée');
            $actor = socle_email_from_cookie($store, $now, $cookie);
            socle_change_own_password($store, $now, $actor, $body['actuel'] ?? null, $body['nouveau'] ?? null, $cookie);
            return socle_result(204);
        }
        if ($path === '/v1/auth/profil/courriel' && $method === 'POST') {
            if (!str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''), 'application/json')) throw new SocleHttp('demande refusée');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'courriel' || !is_string($body['courriel'] ?? null)) throw new SocleHttp('demande refusée');
            $actor = socle_email_from_cookie($store, $now, $cookie);
            socle_start_email_change($store, $smtp, $now, $actor, $body['courriel']);
            return socle_result(202);
        }
        if ($path === '/v1/auth/profil/courriel/confirmer' && $method === 'POST') {
            if (!str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''), 'application/json')) throw new SocleHttp('demande refusée');
            $body = socle_object_body($raw);
            if ($body === null || socle_keys($body) !== 'token') throw new SocleHttp('demande refusée');
            $actor = socle_email_from_cookie($store, $now, $cookie);
            $email = socle_confirm_email_change($store, $now, $body['token'] ?? null, $actor);
            return socle_result(200, socle_json(['email' => $email]), $jsonType);
        }
        return socle_result(404);
    } catch (SocleHttp $error) {
        return socle_auth_fail($error);
    }
}
