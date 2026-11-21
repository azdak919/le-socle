<?php
declare(strict_types=1);

function socle_smtp_settings(): ?array {
    $host = socle_env('SOCLE_SMTP_HOST');
    $from = socle_env('SOCLE_SMTP_FROM');
    if ($host === null || $from === null) return null;
    $secure = socle_env('SOCLE_SMTP_SECURE') === '1';
    $port = (int) (socle_env('SOCLE_SMTP_PORT') ?? ($secure ? '465' : '587'));
    if ($port < 1) return null;
    return [
        'host' => $host,
        'port' => $port,
        'secure' => $secure,
        'user' => socle_env('SOCLE_SMTP_USER'),
        'password' => getenv('SOCLE_SMTP_PASSWORD') === false ? null : (string) getenv('SOCLE_SMTP_PASSWORD'),
        'from' => $from,
    ];
}

function socle_smtp_send(array $settings, string $to, string $subject, string $text): void {
    $remote = ($settings['secure'] ? 'tls' : 'tcp') . '://' . $settings['host'] . ':' . $settings['port'];
    $socket = @stream_socket_client($remote, $errno, $error, 5);
    if ($socket === false) throw new RuntimeException('smtp muet');
    stream_set_timeout($socket, 5);
    try {
        socle_smtp_expect(socle_smtp_read($socket), 220);
        socle_smtp_write($socket, 'EHLO socle');
        $ehlo = socle_smtp_read($socket);
        socle_smtp_expect($ehlo, 250);
        if (!$settings['secure'] && stripos($ehlo, 'STARTTLS') !== false) {
            socle_smtp_write($socket, 'STARTTLS');
            socle_smtp_expect(socle_smtp_read($socket), 220);
            if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new RuntimeException('smtp muet');
            }
            socle_smtp_write($socket, 'EHLO socle');
            socle_smtp_expect(socle_smtp_read($socket), 250);
        }
        if ($settings['user'] !== null) {
            socle_smtp_write($socket, 'AUTH LOGIN');
            socle_smtp_expect(socle_smtp_read($socket), 334);
            socle_smtp_write($socket, base64_encode((string) $settings['user']));
            socle_smtp_expect(socle_smtp_read($socket), 334);
            socle_smtp_write($socket, base64_encode((string) ($settings['password'] ?? '')));
            socle_smtp_expect(socle_smtp_read($socket), 235);
        }
        socle_smtp_write($socket, 'MAIL FROM:<' . $settings['from'] . '>');
        socle_smtp_expect(socle_smtp_read($socket), 250);
        socle_smtp_write($socket, 'RCPT TO:<' . $to . '>');
        socle_smtp_expect(socle_smtp_read($socket), 250);
        socle_smtp_write($socket, 'DATA');
        socle_smtp_expect(socle_smtp_read($socket), 354);
        $stuffed = implode("\r\n", array_map(
            static fn (string $line): string => str_starts_with($line, '.') ? '.' . $line : $line,
            explode("\r\n", str_replace(["\r\n", "\r"], "\n", str_replace("\n", "\r\n", $text))),
        ));
        socle_smtp_write($socket, implode("\r\n", [
            'From: ' . $settings['from'],
            'To: ' . $to,
            'Subject: ' . $subject,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            $stuffed,
            '.',
        ]));
        socle_smtp_expect(socle_smtp_read($socket), 250);
        socle_smtp_write($socket, 'QUIT');
    } finally {
        fclose($socket);
    }
}

function socle_smtp_write($socket, string $line): void {
    $written = fwrite($socket, $line . "\r\n");
    if ($written === false) throw new RuntimeException('smtp muet');
}

function socle_smtp_read($socket): string {
    $pending = '';
    $ready = [];
    $deadline = microtime(true) + 5;
    while (microtime(true) < $deadline) {
        $chunk = fread($socket, 8192);
        if ($chunk === false || $chunk === '') {
            $meta = stream_get_meta_data($socket);
            if ($meta['timed_out'] || $meta['eof']) break;
            continue;
        }
        $pending .= $chunk;
        $parts = preg_split("/\r?\n/", $pending);
        if ($parts === false) break;
        $pending = (string) array_pop($parts);
        foreach ($parts as $line) if ($line !== '') $ready[] = $line;
        foreach ($ready as $index => $line) {
            if (preg_match('/^\d{3} /', $line) === 1) {
                return implode("\n", array_slice($ready, 0, $index + 1));
            }
        }
    }
    throw new RuntimeException('smtp muet');
}

function socle_smtp_expect(string $reply, int $code): void {
    $lines = explode("\n", $reply);
    $last = $lines[count($lines) - 1] ?? '';
    if (!str_starts_with($last, (string) $code)) throw new RuntimeException('smtp refusé');
}

const SOCLE_SMTP_STORE_KEY = 'smtp:settings';
const SOCLE_SMTP_PROVIDERS = ['hebergeur', 'gmail', 'outlook', 'personnalise'];

function socle_smtp_stored(SocleStore $store): ?array {
    $raw = $store->get('auth', SOCLE_SMTP_STORE_KEY);
    if ($raw === null) return null;
    $parsed = json_decode($raw, true);
    return is_array($parsed) ? $parsed : null;
}

function socle_smtp_complete(?array $row): ?array {
    if ($row === null) return null;
    $host = trim((string) ($row['host'] ?? ''));
    $from = trim((string) ($row['from'] ?? ''));
    $port = (int) ($row['port'] ?? 0);
    if ($host === '' || $from === '' || $port < 1 || $port > 65535) return null;
    $user = trim((string) ($row['user'] ?? ''));
    $password = (string) ($row['password'] ?? '');
    return [
        'host' => $host,
        'port' => $port,
        'secure' => (bool) ($row['secure'] ?? false),
        'user' => $user !== '' ? $user : null,
        'password' => $password !== '' ? $password : null,
        'from' => $from,
    ];
}

function socle_smtp_from_store(SocleStore $store): ?array {
    return socle_smtp_complete(socle_smtp_stored($store));
}

function socle_smtp_resolve(SocleStore $store): ?array {
    return socle_smtp_from_store($store) ?? socle_smtp_settings();
}

function socle_smtp_public(SocleStore $store): array {
    $stored = socle_smtp_stored($store);
    $complete = socle_smtp_complete($stored);
    if ($stored !== null && $complete !== null) {
        $fournisseur = in_array($stored['fournisseur'] ?? null, SOCLE_SMTP_PROVIDERS, true)
            ? $stored['fournisseur']
            : 'personnalise';
        return [
            'fournisseur' => $fournisseur,
            'host' => $complete['host'],
            'port' => $complete['port'],
            'secure' => $complete['secure'],
            'user' => (string) ($complete['user'] ?? ''),
            'from' => $complete['from'],
            'motDePasseEnregistre' => ($complete['password'] ?? null) !== null,
            'source' => 'enregistrement',
        ];
    }
    $env = socle_smtp_settings();
    if ($env !== null) {
        return [
            'fournisseur' => 'personnalise',
            'host' => $env['host'],
            'port' => $env['port'],
            'secure' => (bool) $env['secure'],
            'user' => (string) ($env['user'] ?? ''),
            'from' => $env['from'],
            'motDePasseEnregistre' => ($env['password'] ?? null) !== null && $env['password'] !== '',
            'source' => 'environnement',
        ];
    }
    return [
        'fournisseur' => 'hebergeur',
        'host' => '',
        'port' => 465,
        'secure' => true,
        'user' => '',
        'from' => '',
        'motDePasseEnregistre' => false,
        'source' => 'absent',
    ];
}

function socle_smtp_save(SocleStore $store, array $body): array {
    $fournisseur = $body['fournisseur'] ?? null;
    if (!in_array($fournisseur, SOCLE_SMTP_PROVIDERS, true)) throw new SocleHttp('demande refusée');
    $host = is_string($body['host'] ?? null) ? trim($body['host']) : '';
    $from = is_string($body['from'] ?? null) ? trim($body['from']) : '';
    $user = is_string($body['user'] ?? null) ? trim($body['user']) : '';
    $port = (int) ($body['port'] ?? 0);
    $secure = ($body['secure'] ?? false) === true || ($body['secure'] ?? null) === '1';
    $incoming = is_string($body['password'] ?? null) ? $body['password'] : '';
    if ($host === '' || $from === '' || $user === '' || $port < 1 || $port > 65535) {
        throw new SocleHttp('réglages incomplets', 409);
    }
    if (strlen($from) > 200 || preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $from) !== 1) {
        throw new SocleHttp('demande refusée');
    }
    $previous = socle_smtp_stored($store);
    $password = $incoming !== '' ? $incoming : (is_string($previous['password'] ?? null) ? $previous['password'] : '');
    if ($password === '') throw new SocleHttp('réglages incomplets', 409);
    $store->put('auth', SOCLE_SMTP_STORE_KEY, socle_json([
        'fournisseur' => $fournisseur,
        'host' => $host,
        'port' => $port,
        'secure' => $secure,
        'user' => $user,
        'password' => $password,
        'from' => $from,
    ]));
    return socle_smtp_public($store);
}

function socle_smtp_clear(SocleStore $store): array {
    $store->delete('auth', SOCLE_SMTP_STORE_KEY);
    return socle_smtp_public($store);
}

function socle_smtp_error_code(Throwable $error): string {
    $raw = $error->getMessage();
    if (in_array($raw, ['smtp muet', 'smtp refusé', 'smtp absent', 'réglages incomplets', 'demande refusée'], true)) {
        return $raw;
    }
    return 'smtp refusé';
}
