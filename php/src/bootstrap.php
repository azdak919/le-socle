<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/zip.php';
require_once __DIR__ . '/smtp.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/audience.php';
require_once __DIR__ . '/editorial.php';
require_once __DIR__ . '/media.php';
require_once __DIR__ . '/review.php';
require_once __DIR__ . '/redaction.php';
require_once __DIR__ . '/notify.php';
require_once __DIR__ . '/archive.php';
require_once __DIR__ . '/admin.php';

function socle_dispatch(string $method, string $uri, string $path, string $raw): array {
    $app = str_starts_with($path, '/v1') || str_starts_with($path, '/admin');
    try {
        $config = socle_load_config();
    } catch (Throwable) {
        return $app ? socle_text(500, 'erreur') : socle_serve_static($uri);
    }
    try {
        $store = socle_open_store();
    } catch (Throwable) {
        $store = null;
    }
    if ($store === null) return $app ? socle_result(404) : socle_serve_static($uri);
    if ($config['modules']['auth']) {
        try {
            socle_ensure_administrateur($store, socle_env('SOCLE_ADMINISTRATEUR') ?? socle_env('SOCLE_RESPONSABLE'));
        } catch (ModuleOff) {
        }
    }
    $smtp = ($config['modules']['auth'] || $config['modules']['notify']) ? socle_smtp_settings() : null;
    $actorDefined = (bool) $config['modules']['auth'];
    $cookie = $_SERVER['HTTP_COOKIE'] ?? null;
    $actor = $actorDefined ? socle_email_from_cookie($store, socle_now(), is_string($cookie) ? $cookie : null) : null;
    $access = $_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] ?? null;
    if ($config['modules']['editorial']) {
        $page = socle_serve_redaction_page($path, $method);
        if ($page !== null) return $page;
        $photo = socle_public_media($method, $path, $config, $store);
        if ($photo !== null) return $photo;
    }
    $gate = socle_admin_gate($method, $path, $config, $store, $actor, $actorDefined);
    if ($gate !== null) return $gate;
    if (str_starts_with($path, '/v1/redaction/')) return socle_handle_redaction($method, $uri, $config, $store, $raw, $actor, $actorDefined);
    if (str_starts_with($path, '/v1/auth')) {
        return socle_handle_auth($method, $uri, $config, $store, $raw, is_string($cookie) ? $cookie : null, is_string($access) ? $access : null, $smtp);
    }
    if ($path === '/admin/medias') return socle_handle_media($method, $uri, $config, $store);
    $reviewPath = str_starts_with($path, '/admin/relecture') || str_starts_with($path, '/v1/review');
    $audiencePath = str_starts_with($path, '/v1/audience') || str_starts_with($path, '/admin/audience');
    $notifyPath = str_starts_with($path, '/v1/notify') || str_starts_with($path, '/admin/abonnements');
    $editorialPath = str_starts_with($path, '/admin/articles') || str_starts_with($path, '/admin/relecture') || str_starts_with($path, '/v1/editorial');
    if ($config['modules']['review'] && $reviewPath) return socle_handle_review($method, $uri, $config, $store, $raw, $actor);
    if ($editorialPath) return socle_handle_editorial($method, $uri, $config, $store, $raw);
    if ($audiencePath) return socle_handle_audience($method, $uri, $config, $store, $raw, $actor);
    if ($notifyPath) return socle_handle_notify($method, $uri, $config, $store, $raw, $actor, $smtp);
    if (str_starts_with($path, '/admin')) return socle_handle_admin($method, $uri, $config, $store, $raw, $actor, $actorDefined);
    if (str_starts_with($path, '/v1')) return socle_handle_health($method, $path, $config);
    return socle_serve_static($uri);
}

function socle_front(): void {
    ini_set('display_errors', '0');
    static $handler = false;
    if (!$handler) {
        $handler = true;
        set_error_handler(static function (int $severity, string $message): bool {
            if ((error_reporting() & $severity) === 0) return false;
            throw new ErrorException($message, 0, $severity);
        });
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    // Hébergement mutualisé : le socle vit souvent dans un sous-dossier
    // (https://cegep.example/journal/socle/). On retire ce préfixe à l'entrée
    // et on le remet dans les adresses des réponses.
    $base = socle_base_path((string) ($_SERVER['SCRIPT_NAME'] ?? ''));
    if ($base !== '' && ($uri === $base || str_starts_with($uri, $base . '/') || str_starts_with($uri, $base . '?'))) {
        $uri = substr($uri, strlen($base));
        if ($uri === '' || $uri[0] !== '/') $uri = '/' . $uri;
    }
    $path = socle_request_path($uri);
    $raw = file_get_contents('php://input');
    if ($raw === false) $raw = '';
    try {
        $result = socle_dispatch($method, $uri, $path, $raw);
    } catch (Throwable $error) {
        error_log($error->getMessage());
        $result = socle_text(500, 'erreur');
    }
    socle_emit(socle_with_base($result, $base), $method);
}

function socle_cli_value(array $argv, string $name): ?string {
    $index = array_search($name, $argv, true);
    if ($index === false) return null;
    $value = $argv[$index + 1] ?? '';
    if ($value === '' || str_starts_with($value, '--')) throw new RuntimeException('option ' . $name . ' sans valeur');
    return $value;
}

function socle_cli_option(array $argv, string $name, string $fallback): string {
    return socle_cli_value($argv, $name) ?? $fallback;
}

function socle_cli(array $argv): void {
    $args = array_slice($argv, 1);
    $command = ($args[0] ?? '') === 'export' || ($args[0] ?? '') === 'migrate' ? array_shift($args) : 'migrate';
    $db = socle_cli_value($args, '--db');
    $configPath = socle_cli_value($args, '--config');
    if ($db !== null) putenv('SOCLE_DB=' . $db);
    if ($configPath !== null) putenv('SOCLE_CONFIG=' . $configPath);
    $store = socle_open_store();
    if ($store === null) {
        fwrite(STDERR, "sqlite absent\n");
        exit(1);
    }
    $config = socle_load_config();
    if ($command === 'export') {
        $store->resume();
        if (!in_array('export', $store->applied(), true)) {
            fwrite(STDERR, "module export éteint\n");
            exit(1);
        }
        $out = socle_cli_option($args, '--out', 'sauvegardes/export.zip');
        socle_write_bytes($out, socle_build_site_zip($store, socle_now()));
        echo $out, "\n";
        return;
    }
    $backup = socle_cli_option($args, '--backup', 'sauvegardes/avant-migrate.zip');
    $store->resume();
    $bytes = in_array('export', $store->applied(), true)
        ? socle_build_site_zip($store, socle_now())
        : socle_empty_site_zip();
    socle_write_bytes($backup, $bytes);
    if (in_array('--down', $args, true)) {
        $removed = $store->rollback();
        echo $backup, "\n";
        if ($removed !== null) echo 'retiré : ', $removed, "\n";
        return;
    }
    $store->migrate(socle_enabled($config));
    echo $backup, "\n";
}

function socle_write_bytes(string $path, string $bytes): void {
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        fwrite(STDERR, "sauvegarde non écrite\n");
        exit(1);
    }
    if (file_put_contents($path, $bytes) === false) {
        fwrite(STDERR, "sauvegarde non écrite\n");
        exit(1);
    }
}
