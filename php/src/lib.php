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

function socle_admin_document(string $lang, string $title, string $body): array {
    $copy = $lang === 'en'
        ? ['html' => 'en', 'skip' => 'Skip to content', 'back' => 'Dashboard', 'brandSub' => 'Newsroom', 'office' => 'Back office', 'save' => 'Backup', 'update' => 'Update', 'other' => 'Français', 'otherLang' => 'fr']
        : ['html' => 'fr', 'skip' => 'Aller au contenu', 'back' => 'Tableau de bord', 'brandSub' => 'Rédaction', 'office' => 'Back-office', 'save' => 'Sauvegarde', 'update' => 'Mise à jour', 'other' => 'English', 'otherLang' => 'en'];
    $other = socle_with_lang('/admin', $copy['otherLang']);
    $back = socle_with_lang('/admin', $lang);
    $saveCurrent = $title === $copy['save'] ? ' aria-current="page"' : '';
    $updateCurrent = $title === $copy['update'] ? ' aria-current="page"' : '';
    $html = '<!DOCTYPE html>
<html lang="' . $copy['html'] . '">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>' . $title . '</title>
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
  .brand .logo { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 0.5rem; background: var(--primary); color: #fff; font-weight: 700; }
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
  form { margin: 0.75rem 0; }
  @page letter { size: letter; }
  @page legal { size: legal; }
  @page tabloid { size: tabloid; }
  @page a4 { size: A4; }
  @page a3 { size: A3; }
  @media (max-width: 40rem) { .tabs { margin-left: 0; width: 100%; } main { margin-top: 1rem; padding: 0 0.6rem; } .panel { padding: 1rem; } }
  @media print { nav, .noprint, .bar { display: none; } .panel { border: 0; padding: 0; } }
</style>
</head>
<body>
<a class="skip" href="#contenu">' . $copy['skip'] . '</a>
<header class="bar noprint">
<a class="brand" href="' . $back . '"><span class="logo" aria-hidden="true">K</span><span><strong>Le Kiosque</strong><small>' . $copy['brandSub'] . '</small></span></a>
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
            ['"adminBasePath":"/redaction"', '"assetsBase":"/redaction/assets"', '"apiBase":""'],
            ['"adminBasePath":"' . $base . '/redaction"', '"assetsBase":"' . $base . '/redaction/assets"', '"apiBase":"' . $base . '"'],
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
