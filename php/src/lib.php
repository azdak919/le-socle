<?php
declare(strict_types=1);

const SOCLE_MODULES = ['auth', 'editorial', 'media', 'audience', 'notify', 'review', 'export'];

final class ModuleOff extends RuntimeException {
    public function __construct(public string $module) {
        parent::__construct('module éteint : ' . $module);
    }
}

final class SocleHttp extends RuntimeException {
    public function __construct(string $message, public int $status = 400) {
        parent::__construct($message);
    }
}

function socle_root(): string {
    return dirname(__DIR__, 2);
}

function socle_public_dir(): string {
    return dirname(__DIR__) . '/public';
}

function socle_env(string $name): ?string {
    $value = getenv($name);
    if (!is_string($value)) return null;
    $value = trim($value);
    return $value === '' ? null : $value;
}

function socle_now(): DateTimeImmutable {
    $raw = socle_env('SOCLE_NOW');
    if ($raw !== null) return new DateTimeImmutable($raw);
    return new DateTimeImmutable('now');
}

function socle_iso(DateTimeImmutable $now): string {
    $utc = $now->setTimezone(new DateTimeZone('UTC'));
    return $utc->format('Y-m-d\TH:i:s.v\Z');
}

function socle_civil_date(DateTimeImmutable $now): string {
    return $now->setTimezone(new DateTimeZone('America/Toronto'))->format('Y-m-d');
}

function socle_civil_year(DateTimeImmutable $now): int {
    return (int) $now->setTimezone(new DateTimeZone('America/Toronto'))->format('Y');
}

function socle_json(mixed $value): string {
    return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
}

function socle_json_pretty(mixed $value): string {
    $json = json_encode(
        $value,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR,
    );
    $pretty = preg_replace_callback('/^( {4})+/m', static function (array $match): string {
        return str_repeat('  ', intdiv(strlen($match[0]), 4));
    }, $json);
    return is_string($pretty) ? $pretty : $json;
}

function socle_package_version(): string {
    $parsed = json_decode((string) file_get_contents(socle_root() . '/package.json'), true);
    return is_array($parsed) && isset($parsed['version']) ? (string) $parsed['version'] : '0.0.0';
}

function socle_version_file(): string {
    return socle_env('SOCLE_VERSION_FILE') ?? (socle_root() . '/socle.version');
}

function socle_installed_version(): string {
    $file = socle_version_file();
    if (is_file($file)) return trim((string) file_get_contents($file));
    return socle_package_version();
}

function socle_set_version(string $next): void {
    $file = socle_version_file();
    $dir = dirname($file);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('version non écrite');
    }
    if (file_put_contents($file, $next . "\n") === false) throw new RuntimeException('version non écrite');
}

function socle_release(): ?array {
    $path = socle_env('SOCLE_RELEASE_FILE');
    if ($path === null || !is_file($path)) return null;
    $parsed = json_decode((string) file_get_contents($path), true);
    if (!is_array($parsed) || !is_string($parsed['version'] ?? null) || !is_string($parsed['notes'] ?? null)) return null;
    return ['version' => $parsed['version'], 'notes' => $parsed['notes']];
}

function socle_default_config(): array {
    $modules = [];
    foreach (SOCLE_MODULES as $name) $modules[$name] = false;
    return ['modules' => $modules];
}

function socle_parse_config(mixed $value): array {
    if (!is_array($value) || array_is_list($value)) throw new RuntimeException('config invalide');
    $keys = array_keys($value);
    if ($keys !== ['modules']) throw new RuntimeException('config invalide');
    $raw = $value['modules'];
    if (!is_array($raw) || (array_is_list($raw) && $raw !== [])) throw new RuntimeException('config invalide');
    $config = socle_default_config();
    foreach ($raw as $key => $flag) {
        if (!in_array($key, SOCLE_MODULES, true)) throw new RuntimeException('module inconnu : ' . $key);
        if (!is_bool($flag)) throw new RuntimeException('interrupteur invalide : ' . $key);
        $config['modules'][$key] = $flag;
    }
    return $config;
}

function socle_config_path(): string {
    return socle_env('SOCLE_CONFIG') ?? (socle_root() . '/socle.config.json');
}

function socle_load_config(): array {
    $path = socle_config_path();
    if (!is_file($path)) return socle_default_config();
    try {
        $root = json_decode((string) file_get_contents($path), false, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable) {
        throw new RuntimeException('config invalide');
    }
    if (!$root instanceof stdClass) throw new RuntimeException('config invalide');
    $vars = get_object_vars($root);
    if (array_keys($vars) !== ['modules'] || !$vars['modules'] instanceof stdClass) {
        throw new RuntimeException('config invalide');
    }
    $raw = [];
    foreach (get_object_vars($vars['modules']) as $key => $flag) $raw[$key] = $flag;
    return socle_parse_config(['modules' => $raw]);
}

function socle_stringify_config(array $config): string {
    $modules = [];
    foreach (SOCLE_MODULES as $name) $modules[$name] = (bool) $config['modules'][$name];
    return socle_json_pretty(['modules' => $modules]) . "\n";
}

function socle_save_config(array $config): void {
    if (file_put_contents(socle_config_path(), socle_stringify_config($config)) === false) {
        throw new RuntimeException('config non écrite');
    }
}

function socle_enabled(array $config): array {
    $names = [];
    foreach (SOCLE_MODULES as $name) if ($config['modules'][$name]) $names[] = $name;
    return $names;
}

function socle_quote_ident(string $name): string {
    if (preg_match('/^[a-z0-9_]+$/', $name) !== 1) throw new RuntimeException('identifiant refusé : ' . $name);
    return '"' . $name . '"';
}

final class SocleStore {
    /** @var array<string, true> */
    private array $enabled = [];

    public function __construct(private PDO $db) {
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    }

    public function migrate(array $modules): void {
        $this->db->exec('CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, seq INTEGER NOT NULL)');
        foreach ($modules as $module) {
            if (!in_array($module, SOCLE_MODULES, true)) throw new RuntimeException('module inconnu : ' . $module);
            $table = socle_quote_ident('mod_' . $module);
            $this->db->exec('CREATE TABLE IF NOT EXISTS ' . $table . ' (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
            $current = $this->db->query('SELECT COALESCE(MAX(seq), 0) AS seq FROM schema_migration')->fetch();
            $seq = (int) ($current['seq'] ?? 0) + 1;
            $insert = $this->db->prepare('INSERT INTO schema_migration (id, seq) VALUES (?, ?) ON CONFLICT (id) DO NOTHING');
            $insert->execute([$module, $seq]);
        }
        $this->enabled = [];
        foreach ($modules as $module) $this->enabled[$module] = true;
    }

    public function applied(): array {
        if (!$this->tableExists('schema_migration')) return [];
        $rows = $this->db->query('SELECT id FROM schema_migration ORDER BY seq, id')->fetchAll();
        $ids = [];
        foreach ($rows as $row) {
            $id = (string) $row['id'];
            if (in_array($id, SOCLE_MODULES, true)) $ids[] = $id;
        }
        return $ids;
    }

    public function resume(): void {
        $this->enabled = [];
        foreach ($this->applied() as $id) $this->enabled[$id] = true;
    }

    public function rollback(): ?string {
        if (!$this->tableExists('schema_migration')) return null;
        $row = $this->db->query('SELECT id FROM schema_migration ORDER BY seq DESC, id DESC LIMIT 1')->fetch();
        if ($row === false) return null;
        $id = (string) $row['id'];
        $delete = $this->db->prepare('DELETE FROM schema_migration WHERE id = ?');
        $delete->execute([$id]);
        unset($this->enabled[$id]);
        return $id;
    }

    public function put(string $module, string $key, string $value): void {
        $this->assertEnabled($module);
        $sql = 'INSERT INTO ' . $this->table($module) . ' (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
        $this->db->prepare($sql)->execute([$key, $value]);
    }

    public function delete(string $module, string $key): void {
        $this->assertEnabled($module);
        $this->db->prepare('DELETE FROM ' . $this->table($module) . ' WHERE key = ?')->execute([$key]);
    }

    public function get(string $module, string $key): ?string {
        $this->assertEnabled($module);
        $stmt = $this->db->prepare('SELECT value FROM ' . $this->table($module) . ' WHERE key = ?');
        $stmt->execute([$key]);
        $row = $stmt->fetch();
        return $row === false ? null : (string) $row['value'];
    }

    public function list(string $module): array {
        $this->assertEnabled($module);
        $stmt = $this->db->query('SELECT key, value FROM ' . $this->table($module) . ' ORDER BY key');
        $rows = [];
        foreach ($stmt->fetchAll() as $row) {
            $rows[] = ['key' => (string) $row['key'], 'value' => (string) $row['value']];
        }
        return $rows;
    }

    public function tableReady(string $module): bool {
        return $this->tableExists('mod_' . $module);
    }

    private function tableExists(string $name): bool {
        $stmt = $this->db->prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?");
        $stmt->execute([$name]);
        return $stmt->fetch() !== false;
    }

    private function assertEnabled(string $module): void {
        if (!isset($this->enabled[$module])) throw new ModuleOff($module);
    }

    private function table(string $module): string {
        if (!in_array($module, SOCLE_MODULES, true)) throw new RuntimeException('module inconnu : ' . $module);
        return socle_quote_ident('mod_' . $module);
    }
}

function socle_path_inside(string $path, string $root): bool {
    $rootReal = realpath($root);
    if ($rootReal === false) return false;
    $rootReal = rtrim(str_replace('\\', '/', $rootReal), '/');
    $dir = is_dir($path) ? $path : dirname($path);
    $dirReal = realpath($dir);
    if ($dirReal === false) return false;
    $full = rtrim(str_replace('\\', '/', $dirReal), '/') . '/' . basename($path);
    if (file_exists($path)) {
        $got = realpath($path);
        if ($got !== false) $full = str_replace('\\', '/', $got);
    }
    return $full === $rootReal || str_starts_with($full, $rootReal . '/');
}

function socle_open_store(): ?SocleStore {
    if (socle_env('SOCLE_NO_DB') === '1') return null;
    if (!extension_loaded('pdo_sqlite')) return null;
    $path = socle_env('SOCLE_DB') ?? (dirname(__DIR__) . '/data/socle.sqlite');
    if (str_contains($path, "\0")) return null;
    if (socle_path_inside($path, socle_public_dir())) return null;
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) return null;
    if (socle_path_inside($path, socle_public_dir())) return null;
    $pdo = new PDO('sqlite:' . $path);
    $pdo->exec('PRAGMA busy_timeout = 2000');
    $store = new SocleStore($pdo);
    $store->resume();
    return $store;
}

function socle_b64url(string $bytes): string {
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function socle_b64url_decode(string $value): string {
    $pad = strlen($value) % 4;
    if ($pad !== 0) $value .= str_repeat('=', 4 - $pad);
    $raw = base64_decode(strtr($value, '-_', '+/'), true);
    return $raw === false ? '' : $raw;
}

function socle_hash(string $token): string {
    return hash('sha256', $token);
}

function socle_escape(string $value): string {
    return str_replace(['&', '<', '>', '"'], ['&amp;', '&lt;', '&gt;', '&quot;'], $value);
}

function socle_object_body(string $raw): ?array {
    try {
        $value = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable) {
        return null;
    }
    if (!is_array($value) || array_is_list($value)) return null;
    return $value;
}

function socle_keys(array $body): string {
    $keys = array_keys($body);
    sort($keys, SORT_STRING);
    return implode(',', $keys);
}

function socle_form(string $text): array {
    $out = [];
    if ($text === '') return $out;
    foreach (explode('&', $text) as $part) {
        if ($part === '') continue;
        $eq = strpos($part, '=');
        $key = urldecode($eq === false ? $part : substr($part, 0, $eq));
        $value = urldecode($eq === false ? '' : substr($part, $eq + 1));
        $out[$key][] = $value;
    }
    return $out;
}

function socle_form_keys(array $form): string {
    $keys = array_keys($form);
    sort($keys, SORT_STRING);
    return implode(',', $keys);
}

function socle_cookie(string $header, string $name): ?string {
    if ($header === '') return null;
    foreach (explode(';', $header) as $part) {
        $eq = strpos($part, '=');
        if ($eq === false) continue;
        if (trim(substr($part, 0, $eq)) !== $name) continue;
        $value = trim(substr($part, $eq + 1));
        return $value === '' ? null : $value;
    }
    return null;
}

function socle_lang(string $url): string {
    $query = parse_url($url, PHP_URL_QUERY);
    if (!is_string($query)) return 'fr';
    parse_str($query, $params);
    return ($params['lang'] ?? '') === 'en' ? 'en' : 'fr';
}

function socle_with_lang(string $path, string $lang): string {
    if ($lang === 'fr') return $path;
    return str_contains($path, '?') ? $path . '&lang=en' : $path . '?lang=en';
}

function socle_result(int $status, string $body = '', array $headers = []): array {
    return ['status' => $status, 'body' => $body, 'headers' => $headers];
}

function socle_text(int $status, string $body): array {
    return socle_result($status, $body, ['content-type' => 'text/plain; charset=utf-8']);
}

// Logo du Socle, copie exacte de admin/marque.js (un test le vérifie).
// Twemoji U+1F9F1 « brique », CC BY 4.0, © Twitter, Inc. et contributeurs (THIRD_PARTY.md).
const SOCLE_ICON_SVG_B64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDI0IiBoZWlnaHQ9IjEwMjQiIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiIGZpbGw9Im5vbmUiPgogIDxkZWZzPgogICAgPHJhZGlhbEdyYWRpZW50IGlkPSJzYmciIGN4PSI1MCUiIGN5PSIzNiUiIHI9Ijg0JSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiMxMTExMTMiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDkwOTBBIi8+CiAgICA8L3JhZGlhbEdyYWRpZW50PgogIDwvZGVmcz4KICA8c3R5bGU+LmZpbGV0e2Rpc3BsYXk6bm9uZX1AbWVkaWEgKHByZWZlcnMtY29sb3Itc2NoZW1lOmRhcmspey5maWxldHtkaXNwbGF5OmlubGluZX19PC9zdHlsZT4KICA8cmVjdCB3aWR0aD0iMTAyNCIgaGVpZ2h0PSIxMDI0IiByeD0iMjMyIiBmaWxsPSJ1cmwoI3NiZykiLz48cmVjdCBjbGFzcz0iZmlsZXQiIHg9IjYiIHk9IjYiIHdpZHRoPSIxMDEyIiBoZWlnaHQ9IjEwMTIiIHJ4PSIyMjYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLW9wYWNpdHk9Ii4xNCIgc3Ryb2tlLXdpZHRoPSIxMiIvPgogIDxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEwOS4xNyA5Ny45OCkgc2NhbGUoMjIuMzc5NikiPgo8cGF0aCBmaWxsPSIjQzE2OTRGIiBkPSJNMzUuNjI3IDEwLjgyNkwuMzczIDE2LjU2djkuNzIyaC4wMDRjLS4wMTIuMTQ5LjEyOS4yOTUuNDQzLjQ3My43MjcuNDEyIDkuODM1IDUuMjg2IDEwLjU1MyA1LjYzOS44OTUuNDM5IDEuNDQxLjQ5MyAyLjIwNi4xMTIuNjI2LS4zMTIgMTkuMjM2LTEwLjE3MyAyMC45MzItMTEuMDc0Ljg2My0uNDU5IDEuMTQ2LS43MTEgMS4wOTktLjkxOWguMDE4di05LjY4N3oiLz48cGF0aCBmaWxsPSIjQTAwNDFFIiBkPSJNLjM3MyAxNi41NnY5LjcyMmguMDA0Yy0uMDEyLjE0OS4xMjkuMjk1LjQ0My40NzMuNzI3LjQxMiA5LjgzNSA1LjI4NiAxMC41NTMgNS42MzkuNDMyLjIxMi43ODEuMzI5IDEuMTE0LjM1NlYxNi41NkguMzczeiIvPjxwYXRoIGZpbGw9IiNEOTlFODIiIGQ9Ik0yMi4yMjQgNC42ODJjMS4wNzYtLjU1OCAxLjExMy0uNjI4IDIuMjQ5LS4wMjQgMS4xMzYuNjA0IDkuODQ2IDUuMjQ4IDEwLjQ4NyA1LjU4OS44MTQuNDM0IDEuMTEyLjU5MS0uNDQ5IDEuNDIxLTEuNjk2LjkwMi0yMC4zMDYgMTAuNzYzLTIwLjkzMiAxMS4wNzQtLjc2NS4zODEtMS4zMTEuMzI3LTIuMjA2LS4xMTItLjcxOC0uMzUyLTkuODI2LTUuMjI2LTEwLjU1My01LjYzOS0uODItLjQ2NS0uNDgyLS43MDYuNzY5LTEuMzdMMjIuMjI0IDQuNjgyeiIvPjxlbGxpcHNlIGZpbGw9IiNDMTY5NEYiIGN4PSIxMS4xODkiIGN5PSIxNy4xOTEiIHJ4PSIzLjY3OSIgcnk9IjEuODQiLz48cGF0aCBmaWxsPSIjQTAwNDFFIiBkPSJNMTEuNjQyIDE2LjczNGMtMS41NjktLjUxNi0zLjM1Mi0uMzY5LTQuMTA4LjMzOS0uMDA1LjA0LS4wMjQuMDc4LS4wMjQuMTE4IDAgMS4wMTYgMS42NDcgMS44NCAzLjY3OSAxLjg0IDEuMDYzIDAgMi4wMTMtLjIyOSAyLjY4NC0uNTg5LS4zMzMtLjY5Mi0xLjA4Ni0xLjMzMi0yLjIzMS0xLjcwOHoiLz48ZWxsaXBzZSBmaWxsPSIjQzE2OTRGIiBjeD0iMTgiIGN5PSIxMy42MzkiIHJ4PSIzLjY3OSIgcnk9IjEuODQiLz48cGF0aCBmaWxsPSIjQTAwNDFFIiBkPSJNMTguNDUzIDEzLjE4MmMtMS41NjktLjUxNi0zLjM1Mi0uMzY5LTQuMTA4LjMzOS0uMDA1LjA0LS4wMjQuMDc4LS4wMjQuMTE4IDAgMS4wMTYgMS42NDcgMS44NCAzLjY3OSAxLjg0IDEuMDYzIDAgMi4wMTMtLjIyOSAyLjY4NC0uNTg5LS4zMzMtLjY5Mi0xLjA4Ni0xLjMzMi0yLjIzMS0xLjcwOHoiLz48ZWxsaXBzZSBmaWxsPSIjQzE2OTRGIiBjeD0iMjQuODExIiBjeT0iMTAuMDg3IiByeD0iMy42NzkiIHJ5PSIxLjg0Ii8+PHBhdGggZmlsbD0iI0EwMDQxRSIgZD0iTTI1LjI2NCA5LjYzYy0xLjU2OS0uNTE2LTMuMzUyLS4zNjktNC4xMDguMzM5LS4wMDUuMDQtLjAyNC4wNzgtLjAyNC4xMTggMCAxLjAxNiAxLjY0NyAxLjg0IDMuNjc5IDEuODQgMS4wNjMgMCAyLjAxMi0uMjI5IDIuNjg0LS41ODktLjMzMy0uNjkyLTEuMDg2LTEuMzMyLTIuMjMxLTEuNzA4eiIvPgogIDwvZz4KPC9zdmc+Cg==';
const SOCLE_FAVICON_16_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACzUlEQVR42lWTzWtcZRTGf8/73jt3JvdmDLUbMVITjC0JJVQiaDEYsYhBq0ig4F7Q6sK/QcS1dKO4t24sdKVE/IL6ESwFUwsGE01T00xM0gRNppOZO/e+x8WYUM/qeRa/8xwOPALIsmxGcu8CIyAvIf43AgwzDKwEbpiFt5vN5nfKsuwVcJckOQDpAOhpJ0cZAlLPl6UhQQi2K9nzPo6Tz53TEVAp4UBIEHkHwG6rQ+wdebeknRfUkhiMAqiZ2YSyrB7+S5UkvOtF7bU6RN7x3KnjvDUzxfZeiwuXvuXqwk3iyFONvQVDyrK6HYCS4267gxk8Pf4I51+c5PToEBvXFinvNukbeZCvltb4aHaO5cZWj+nvr5sQ7bxLNxhPHD/GGy88xdToEPtbO7Q9bF5ZYne5wfC50wyODdP4/U/Ovf8JKztNIgElxujIIK9NPc70xAmqfTFbK1ssfPAF2eB9nDg/TZTUaG1us/jjNdjbo+Y9ZkbUMeMhX+HDZyd5dPoxfr08x8pnczz80gQT77xKmZfkf7fYWVtif3uHMgSSSgwCA6IgSIrA0oVZGlcWGDxzkrHXz5IMZBR5h+Zag9bGFkW3wEcRA2lCKy9odwucRIQZSLg4ZvvnZXZvrPLAM2McnTxGa2ODbjvHxRH1tEoZAt/88RcfX19m9Z8WiXe9H7QxDGMgrtIMgdUv59GRgsr9KVlfDSf4afUOF6+vcHXtDk5Q9R7DiCom1lXwXrLL2aLGqRDjqzXStEqtWmH+9jYXf1nh+1ubBDOySoSZEcx6x6dpZkKWyxQkTpYxLytl6Mwwn95a5+vFdTplIEsiBJTB7u2FlKbZPGjcQYGIWhiJc/gAe3lBfxLhpEMQwIwSzJvZTVWr/U86Z7OS6mA4hAEmiCRKs8NO9uShDyEw44siv+195QdgXOKogevVUYR74IMdQGlmv5npzf395uV/AWbQSYwL+6BNAAAAAElFTkSuQmCC';
const SOCLE_FAVICON_32_B64 = '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';

function socle_favicons(): string {
    return '<link rel="icon" type="image/png" sizes="16x16" href="data:image/png;base64,' . SOCLE_FAVICON_16_B64 . '">'
        . '<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,' . SOCLE_FAVICON_32_B64 . '">'
        . '<link rel="icon" type="image/svg+xml" sizes="any" href="data:image/svg+xml;base64,' . SOCLE_ICON_SVG_B64 . '">';
}

/** Nom du journal pour l’en-tête des pages d’administration ; vide tant qu’il n’est pas configuré. */
function socle_admin_journal_name(?string $name = null): string {
    static $current = '';
    if ($name !== null) $current = trim($name);
    return $current;
}

function socle_admin_brand(string $sub): string {
    $name = socle_admin_journal_name();
    if ($name !== '') return '<span><strong>' . htmlspecialchars($name, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</strong><small>' . $sub . '</small></span>';
    return '<img class="logo" src="data:image/svg+xml;base64,' . SOCLE_ICON_SVG_B64 . '" alt="" width="32" height="32"><span><strong>Le Socle</strong><small>' . $sub . '</small></span>';
}

function socle_admin_document(string $lang, string $title, string $body): array {
    $copy = $lang === 'en'
        ? ['html' => 'en', 'skip' => 'Skip to content', 'back' => 'Dashboard', 'brandSub' => 'Newsroom', 'powered' => 'Powered by', 'office' => 'Administration', 'save' => 'Backup', 'update' => 'Update', 'other' => 'Français', 'otherLang' => 'fr']
        : ['html' => 'fr', 'skip' => 'Aller au contenu', 'back' => 'Tableau de bord', 'brandSub' => 'Espace de rédaction', 'powered' => 'Propulsé par', 'office' => 'Interface d’administration', 'save' => 'Sauvegarde', 'update' => 'Mise à jour', 'other' => 'English', 'otherLang' => 'en'];
    $other = socle_with_lang('/admin', $copy['otherLang']);
    $back = socle_with_lang('/admin', $lang);
    $saveCurrent = $title === $copy['save'] ? ' aria-current="page"' : '';
    $updateCurrent = $title === $copy['update'] ? ' aria-current="page"' : '';
    $html = '<!DOCTYPE html>
<html lang="' . $copy['html'] . '">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>' . $title . (socle_admin_journal_name() !== '' ? ' — ' . htmlspecialchars(socle_admin_journal_name(), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') : '') . '</title>
' . socle_favicons() . '
<style>
  :root { --primary: #6d2350; --fg: #1f1a1d; --muted: #6b6468; --border: #e9e3e6; --bg: #fdfcfd; --card: #fff; --accent: #f8eff4; --radius: 0.625rem; color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.5; color: var(--fg); background: var(--bg); }
  a { color: var(--primary); }
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
  .skip { position: absolute; left: -999px; }
  .skip:focus { left: 0.5rem; top: 0.5rem; background: #fff; padding: 0.5rem; z-index: 2; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.5rem; padding: 0.75rem 1.25rem; background: #fff; border-bottom: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: 0.6rem; color: var(--fg); text-decoration: none; }
  .brand .logo { display: block; width: 2rem; height: 2rem; flex: none; }
  .brand strong { display: block; font-size: 0.9rem; line-height: 1.2; }
  .brand small { display: block; color: var(--muted); font-size: 0.75rem; }
  .tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-left: auto; }
  .tabs a { padding: 0.4rem 0.7rem; border-radius: 0.5rem; color: var(--fg); text-decoration: none; font-size: 0.875rem; }
  .tabs a:hover { background: var(--accent); }
  .tabs a[aria-current="page"] { background: var(--accent); color: var(--primary); font-weight: 600; }
  main { max-width: 52rem; margin: 1.5rem auto; padding: 0 1rem; page: letter; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); padding: 1.25rem 1.5rem 1.5rem; }
  h1 { margin: 0 0 1rem; font-size: 1.5rem; letter-spacing: -0.02em; }
  h2 { margin: 1.5rem 0 0.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); font-size: 1.05rem; }
  h1 + h2 { margin-top: 0; padding-top: 0; border-top: 0; }
  p { margin: 0.5rem 0; }
  ol { margin: 0.5rem 0; padding-left: 1.25rem; } li { margin: 0.25rem 0; }
  .muted, .aide { color: var(--muted); font-size: 0.875rem; }
  .fiche { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0.5rem 0; }
  .fiche dt { color: var(--muted); }
  .fiche dd { margin: 0; font-weight: 600; }
  .note { background: var(--accent); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.75rem 1rem; }
  label { display: inline-flex; align-items: center; gap: 0.4rem; margin: 0.15rem 1rem 0.15rem 0; }
  ul.liens { list-style: none; padding: 0; margin: 0.5rem 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button, .bouton { display: inline-flex; align-items: center; min-height: 2.25rem; padding: 0.45rem 0.9rem; border: 1px solid var(--border); border-radius: 0.5rem; background: #fff; color: var(--fg); font: inherit; font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer; }
  button:hover, .bouton:hover { background: var(--accent); }
  button[type="submit"]:not(.secondaire), .bouton.principal { background: var(--primary); border-color: var(--primary); color: #fff; }
  input[type="file"] { font: inherit; font-size: 0.875rem; max-width: 100%; }
  button.danger { background: #991b1b; border-color: #991b1b; color: #fff; }
  button.danger:hover { background: #7f1d1d; }
  button:disabled { opacity: 0.6; cursor: default; }
  h3 { margin: 1rem 0 0.25rem; font-size: 0.95rem; }
  .versions { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.9rem; }
  .versions th, .versions td { text-align: left; vertical-align: top; padding: 0.5rem 0.75rem 0.5rem 0; border-bottom: 1px solid var(--border); }
  .versions thead th { color: var(--muted); font-weight: 500; font-size: 0.8rem; }
  .versions tbody th small { display: block; color: var(--muted); font-weight: 400; font-size: 0.8rem; }
  .nouveautes ul { margin: 0.25rem 0 0.75rem; padding-left: 1.25rem; } .nouveautes li { margin: 0.3rem 0; }
  #restaurer label { flex-wrap: wrap; }
  form { margin: 0.75rem 0; }
  @page letter { size: letter; }
  @page legal { size: legal; }
  @page tabloid { size: tabloid; }
  @page a4 { size: A4; }
  @page a3 { size: A3; }
  @media (max-width: 40rem) { .tabs { margin-left: 0; width: 100%; } main { margin-top: 1rem; padding: 0 0.6rem; } .panel { padding: 1rem; } }
  .powered { margin: 1.5rem auto 2rem; padding: 0 1rem; max-width: 52rem; font-size: 0.75rem; color: var(--muted); }
  .powered a { color: inherit; }
  @media print { nav, .noprint, .bar { display: none; } .panel { border: 0; padding: 0; } }
</style>
</head>
<body>
<a class="skip" href="#contenu">' . $copy['skip'] . '</a>
<header class="bar noprint">
<a class="brand" href="' . $back . '">' . socle_admin_brand($copy['brandSub']) . '</a>
<nav class="tabs" aria-label="' . $copy['office'] . '">
<a href="' . $back . '">' . $copy['back'] . '</a>
<a href="' . socle_with_lang('/admin/sauvegarde', $lang) . '"' . $saveCurrent . '>' . $copy['save'] . '</a>
<a href="' . socle_with_lang('/admin/mise-a-jour', $lang) . '"' . $updateCurrent . '>' . $copy['update'] . '</a>
<a href="' . $other . '" hreflang="' . $copy['otherLang'] . '">' . $copy['other'] . '</a>
</nav>
</header>
<main id="contenu">
<div class="panel">
<h1>' . $title . '</h1>
' . $body . '
</div>
</main>
<p class="powered noprint">' . $copy['powered'] . ' <a href="https://azdak919.github.io/le-socle/">Le Socle</a> ' . htmlspecialchars(socle_package_version(), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</p>
</body>
</html>';
    return socle_result(200, $html, ['content-type' => 'text/html; charset=utf-8']);
}

function socle_health(array $config): array {
    $modules = [];
    foreach (SOCLE_MODULES as $name) $modules[$name] = (bool) $config['modules'][$name];
    return ['version' => socle_package_version(), 'modules' => $modules];
}

function socle_handle_health(string $method, string $path, array $config): array {
    if ($path !== '/v1/health') return socle_result(404);
    if ($method !== 'GET' && $method !== 'HEAD') return socle_result(405, '', ['allow' => 'GET, HEAD']);
    $body = socle_json(socle_health($config));
    return socle_result(200, $method === 'HEAD' ? '' : $body, ['content-type' => 'application/json; charset=utf-8']);
}

function socle_static_root(): ?string {
    $root = socle_env('SOCLE_STATIC');
    if ($root === null || !is_dir($root)) return null;
    $real = realpath($root);
    return $real === false ? null : $real;
}

function socle_static_type(string $path): string {
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    return match ($ext) {
        'html', 'htm' => 'text/html; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'js' => 'text/javascript; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'svg' => 'image/svg+xml',
        'txt' => 'text/plain; charset=utf-8',
        'png' => 'image/png',
        'jpg', 'jpeg' => 'image/jpeg',
        'webp' => 'image/webp',
        'pdf' => 'application/pdf',
        default => 'application/octet-stream',
    };
}

function socle_serve_static(string $urlPath): array {
    $root = socle_static_root();
    if ($root === null) return socle_result(404);
    $path = rawurldecode(parse_url($urlPath, PHP_URL_PATH) ?: '/');
    if (str_contains($path, '\\') || str_contains($path, "\0") || str_contains($path, '..')) return socle_result(404);
    $relative = ltrim($path, '/');
    if ($relative === '') $relative = 'index.html';
    $candidate = $root . '/' . $relative;
    if (is_dir($candidate)) $candidate = rtrim($candidate, '/') . '/index.html';
    $real = realpath($candidate);
    if ($real === false || !is_file($real)) return socle_result(404);
    $rootPrefix = rtrim(str_replace('\\', '/', $root), '/');
    $file = str_replace('\\', '/', $real);
    if ($file !== $rootPrefix && !str_starts_with($file, $rootPrefix . '/')) return socle_result(404);
    $bytes = file_get_contents($real);
    if ($bytes === false) return socle_result(404);
    return socle_result(200, $bytes, ['content-type' => socle_static_type($real)]);
}

/** Bandeau « journal fictif » (essai, démonstration), au-dessus du mât. */
const SOCLE_BANDEAU_FICTIF = '<div class="demo-banner" role="note"><span class="demo-banner__lead">Journal étudiant fictif</span><span class="demo-banner__sep" aria-hidden="true"> — </span><span class="demo-banner__rest">essai : articles et personnes inventés</span></div>';

/**
 * Adresse publique du journal : schéma + hôte de la requête, plus le
 * sous-dossier détecté (vide à la racine du domaine). On ne reprend pas le
 * chemin éventuellement périmé de siteUrl, pour que les liens restent justes
 * après un déplacement (par exemple de /journal/ vers la racine).
 */
function socle_public_base_url(): string {
    $forwarded = strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
    $https = $forwarded === 'https'
        || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (string) ($_SERVER['SERVER_PORT'] ?? '') === '443';
    $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
    $base = socle_base_path((string) ($_SERVER['SCRIPT_NAME'] ?? ''));
    return rtrim(($https ? 'https' : 'http') . '://' . $host . $base, '/');
}

function socle_xml(string $value): string {
    return htmlspecialchars($value, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

function socle_live_teams(?array $publication): array {
    $sports = is_array($publication) && is_array($publication['masthead']['sports'] ?? null) ? $publication['masthead']['sports'] : [];
    if (($sports['enabled'] ?? true) === false) return [];
    if (!empty($sports['teams']) && is_array($sports['teams'])) return array_values(array_filter($sports['teams'], 'is_array'));
    if (!empty($sports['team']) && is_array($sports['team'])) return [$sports['team']];
    return [];
}

function socle_live_slug_in(array $items, string $slug): bool {
    foreach ($items as $item) {
        if (is_array($item) && (string) ($item['slug'] ?? '') === $slug) return true;
    }
    return false;
}

/** Pages HTML connues du mode vivant : on sert la coquille en 200 ; le reste en 404. */
function socle_live_known(string $path, ?SocleStore $store): bool {
    if (in_array($path, ['/', '/archives/', '/recherche/', '/revue/', '/plan-du-site/'], true)) return true;
    if (preg_match('#^/archives/[0-9]{4}/$#', $path) === 1) return true;
    if ($store === null) return false;
    try {
        $publication = socle_read_publication($store);
        $articles = socle_read_articles($store);
        $authors = socle_read_kind($store, 'author:');
        $sections = socle_read_kind($store, 'section:');
        $categories = socle_read_kind($store, 'category:');
    } catch (Throwable) {
        return false;
    }
    if (preg_match('#^/articles/([^/]+)/$#', $path, $match) === 1) {
        $slug = rawurldecode($match[1]);
        foreach ($articles as $article) {
            $status = (string) ($article['status'] ?? '');
            if ((string) ($article['slug'] ?? '') === $slug && ($status === 'published' || $status === 'archived')) return true;
        }
        return false;
    }
    if (preg_match('#^/sections/([^/]+)/$#', $path, $match) === 1) {
        return socle_live_slug_in($sections, rawurldecode($match[1]));
    }
    if (preg_match('#^/categories/([^/]+)/$#', $path, $match) === 1) {
        return socle_live_slug_in($categories, rawurldecode($match[1]));
    }
    if ($path === '/auteurs/') return true;
    if (preg_match('#^/auteurs/([^/]+)/$#', $path, $match) === 1) {
        return socle_live_slug_in($authors, rawurldecode($match[1]));
    }
    if ($path === '/sports/') return socle_live_teams(is_array($publication) ? $publication : null) !== [];
    return false;
}

function socle_live_listed(array $articles): array {
    $listed = array_values(array_filter($articles, static fn (array $article): bool => ($article['status'] ?? '') === 'published'));
    usort($listed, static function (array $a, array $b): int {
        return strcmp((string) ($b['publishedAt'] ?? $b['updatedAt'] ?? ''), (string) ($a['publishedAt'] ?? $a['updatedAt'] ?? ''));
    });
    return $listed;
}

function socle_live_feed(?SocleStore $store): string {
    $base = socle_public_base_url();
    $publication = ['name' => 'Le journal', 'tagline' => '', 'institution' => '', 'lang' => 'fr-CA'];
    $articles = [];
    $authors = [];
    if ($store !== null) {
        try {
            $publication = socle_read_publication($store) ?? $publication;
            $articles = socle_live_listed(socle_read_articles($store));
            $authors = socle_read_kind($store, 'author:');
        } catch (Throwable) {
        }
    }
    $name = (string) ($publication['name'] ?? 'Le journal');
    $lang = (string) ($publication['lang'] ?? 'fr-CA');
    $subtitle = (string) ($publication['tagline'] ?? '') !== '' ? (string) $publication['tagline'] : (string) ($publication['institution'] ?? '');
    $updated = $articles[0]['updatedAt'] ?? $articles[0]['publishedAt'] ?? gmdate('Y-m-d\TH:i:s\Z');
    foreach ($articles as $article) {
        $stamp = (string) ($article['updatedAt'] ?? '');
        if ($stamp > $updated) $updated = $stamp;
    }
    $entries = '';
    foreach (array_slice($articles, 0, 30) as $article) {
        $slug = (string) ($article['slug'] ?? '');
        // Toujours l’adresse courante (comme le plan du site), jamais un canonicalUrl
        // périmé après un déplacement (ex. /journal/ vers la racine).
        $url = $base . '/articles/' . rawurlencode($slug) . '/';
        $names = [];
        foreach ((array) ($article['authors'] ?? []) as $slugAuthor) {
            $found = $slugAuthor;
            foreach ($authors as $author) {
                if (is_array($author) && (string) ($author['slug'] ?? '') === (string) $slugAuthor) {
                    $found = (string) ($author['name'] ?? $slugAuthor);
                    break;
                }
            }
            $names[] = (string) $found;
        }
        if ($names === []) $names[] = $name;
        $authorXml = '';
        foreach ($names as $person) $authorXml .= "    <author><name>" . socle_xml((string) $person) . "</name></author>\n";
        $id = (string) ($article['id'] ?? $slug);
        $entries .= "  <entry>\n    <title>" . socle_xml((string) ($article['title'] ?? '')) . "</title>\n    <link href=\"" . socle_xml($url) . "\" rel=\"alternate\" type=\"text/html\"/>\n    <id>urn:uuid:" . socle_xml($id) . "</id>\n    <updated>" . socle_xml((string) ($article['updatedAt'] ?? $article['publishedAt'] ?? $updated)) . "</updated>\n    <published>" . socle_xml((string) ($article['publishedAt'] ?? $article['updatedAt'] ?? $updated)) . "</published>\n" . $authorXml . "    <summary type=\"text\">" . socle_xml((string) ($article['excerpt'] ?? '')) . "</summary>\n  </entry>\n";
    }
    return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\" xml:lang=\"" . socle_xml($lang) . "\">\n  <title>" . socle_xml($name) . "</title>\n  <subtitle>" . socle_xml($subtitle) . "</subtitle>\n  <link href=\"" . socle_xml($base) . "/feed.xml\" rel=\"self\"/>\n  <link href=\"" . socle_xml($base) . "/\"/>\n  <id>" . socle_xml($base) . "/</id>\n  <updated>" . socle_xml((string) $updated) . "</updated>\n  <generator uri=\"https://github.com/azdak919/le-kiosque\">Le Kiosque</generator>\n" . $entries . "</feed>\n";
}

function socle_live_sitemap(?SocleStore $store): string {
    $base = socle_public_base_url();
    $urls = [$base . '/', $base . '/archives/', $base . '/plan-du-site/', $base . '/recherche/'];
    if ($store !== null) {
        try {
            $publication = socle_read_publication($store);
            if (socle_live_teams(is_array($publication) ? $publication : null) !== []) $urls[] = $base . '/sports/';
            foreach (socle_live_listed(socle_read_articles($store)) as $article) {
                $slug = (string) ($article['slug'] ?? '');
                if ($slug !== '') $urls[] = $base . '/articles/' . rawurlencode($slug) . '/';
            }
            foreach (socle_read_kind($store, 'section:') as $section) {
                $slug = (string) ($section['slug'] ?? '');
                if ($slug !== '') $urls[] = $base . '/sections/' . rawurlencode($slug) . '/';
            }
        } catch (Throwable) {
        }
    }
    $body = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n";
    foreach ($urls as $loc) $body .= "  <url><loc>" . socle_xml($loc) . "</loc></url>\n";
    return $body . "</urlset>\n";
}

/**
 * Site du journal dans le paquet complet : `site/` porte `kiosque-vivant.json`.
 * Une adresse connue reçoit la coquille (statut 200) ; une adresse inconnue
 * reçoit la même coquille en vrai HTTP 404. Le navigateur dessine la page à
 * partir du Socle. `noindex` de la publication ajoute la balise robots, ferme
 * robots.txt, et n'annonce pas le plan du site ; le flux RSS reste servi.
 */

/**
 * La coquille du paquet complet est construite avec le nom « Le journal ».
 * On y inscrit le vrai nom dès la première réponse, sans attendre le dessin
 * dans le navigateur (titre, mât, pied de page).
 */
function socle_live_fill_shell(string $html, array $publication): string {
    $name = trim((string) ($publication['name'] ?? ''));
    if ($name === '' || $name === 'Le journal') return $html;
    $safe = socle_escape($name);
    $html = preg_replace('#<title>Le journal</title>#', '<title>' . $safe . '</title>', $html, 1) ?? $html;
    $html = str_replace('content="Le journal"', 'content="' . $safe . '"', $html);
    $html = str_replace('title="Le journal"', 'title="' . $safe . '"', $html);
    $html = str_replace('<span class="wordmark-name">Le journal</span>', '<span class="wordmark-name">' . $safe . '</span>', $html);
    $html = str_replace('<p class="site-foot__wordmark">Le journal</p>', '<p class="site-foot__wordmark">' . $safe . '</p>', $html);
    $html = preg_replace('#(© \d{4}(?:–\d{4})? )Le journal\.#u', '$1' . $safe . '.', $html) ?? $html;
    return $html;
}

function socle_serve_site(string $uri, ?SocleStore $store): array {
    $root = socle_static_root();
    $live = $root !== null && is_file($root . '/kiosque-vivant.json');
    $path = socle_request_path($uri);
    $noindex = false;
    $fictif = false;
    $publication = null;
    if ($live && $store !== null) {
        try {
            $publication = socle_read_publication($store);
            $noindex = is_array($publication) && !empty($publication['noindex']);
            $fictif = is_array($publication) && !empty($publication['fictif']);
        } catch (Throwable) {
        }
    }
    if ($live && $path === '/robots.txt') {
        if ($noindex) {
            $body = "User-agent: *\nDisallow: /\n";
        } else {
            $body = "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /redaction\nSitemap: " . socle_public_base_url() . "/sitemap.xml\n";
        }
        return socle_result(200, $body, ['content-type' => 'text/plain; charset=utf-8']);
    }
    if ($live && $path === '/feed.xml') {
        return socle_result(200, socle_live_feed($store), ['content-type' => 'application/atom+xml; charset=utf-8', 'cache-control' => 'no-cache']);
    }
    if ($live && $path === '/sitemap.xml') {
        return socle_result(200, socle_live_sitemap($store), ['content-type' => 'application/xml; charset=utf-8', 'cache-control' => 'no-cache']);
    }
    $result = socle_serve_static($uri);
    if ($result['status'] === 404 && $live && !preg_match('#\.[A-Za-z0-9]{1,5}$#', $path)) {
        $known = socle_live_known($path, $store);
        $file = $known && is_file($root . '/index.html') ? $root . '/index.html' : $root . '/404.html';
        $shell = @file_get_contents($file);
        if (!is_string($shell) && $file !== $root . '/404.html') $shell = @file_get_contents($root . '/404.html');
        if (is_string($shell)) $result = socle_result($known ? 200 : 404, $shell, ['content-type' => 'text/html; charset=utf-8']);
    }
    $html = $live && str_starts_with((string) ($result['headers']['content-type'] ?? ''), 'text/html');
    if ($html && ($result['status'] === 200 || $result['status'] === 404)) {
        $result['headers']['cache-control'] = 'no-cache';
        if ($noindex) $result['body'] = preg_replace('#</head>#i', '<meta name="robots" content="noindex, nofollow"></head>', (string) $result['body'], 1) ?? $result['body'];
        if ($fictif) $result['body'] = preg_replace('#<body([^>]*)>#i', '<body$1>' . SOCLE_BANDEAU_FICTIF, (string) $result['body'], 1) ?? $result['body'];
        if (is_array($publication)) $result['body'] = socle_live_fill_shell((string) $result['body'], $publication);
    }
    // Un journal dans un sous-dossier n'a pas la main sur le robots.txt du
    // domaine : l'en-tête suit chaque réponse du site.
    if ($live && $noindex && $result['status'] < 400) $result['headers']['x-robots-tag'] = 'noindex, nofollow';
    return $result;
}

/** Dossier du front (`/journal/socle`), vide à la racine du domaine. */
function socle_base_path(string $scriptName): string {
    $dir = str_replace('\\', '/', dirname($scriptName));
    $dir = rtrim($dir, '/.');
    return $dir === '' ? '' : $dir;
}

/** Remet le sous-dossier dans les redirections et les liens des pages HTML. */
function socle_with_base(array $result, string $base): array {
    if ($base === '') return $result;
    foreach ($result['headers'] as $name => $value) {
        if (strtolower((string) $name) === 'location' && is_string($value) && str_starts_with($value, '/') && !str_starts_with($value, '//')) {
            $result['headers'][$name] = $base . $value;
        }
    }
    $type = '';
    foreach ($result['headers'] as $name => $value) if (strtolower((string) $name) === 'content-type') $type = (string) $value;
    if (str_starts_with($type, 'text/html')) {
        $body = preg_replace('#\b(href|action|src)="/(?!/)#', '$1="' . $base . '/', $result['body']) ?? $result['body'];
        $body = str_replace(
            ['"adminBasePath":"/redaction"', '"assetsBase":"/redaction/assets"', '"apiBase":""', '"publicBasePath":""', '"assetsBase":"/assets/editorial"'],
            ['"adminBasePath":"' . $base . '/redaction"', '"assetsBase":"' . $base . '/redaction/assets"', '"apiBase":"' . $base . '"', '"publicBasePath":"' . $base . '"', '"assetsBase":"' . $base . '/assets/editorial"'],
            $body,
        );
        $result['body'] = $body;
    }
    return $result;
}

function socle_emit(array $result, string $method): void {
    header_remove('Content-Type');
    header_remove('X-Powered-By');
    http_response_code($result['status']);
    foreach ($result['headers'] as $name => $value) {
        $clean = str_replace(["\r", "\n"], '', (string) $value);
        header($name . ': ' . $clean, false);
    }
    if ($method === 'HEAD') return;
    echo $result['body'];
}

function socle_request_path(string $uri): string {
    $path = parse_url($uri, PHP_URL_PATH);
    return is_string($path) && $path !== '' ? $path : '/';
}
