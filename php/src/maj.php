<?php
declare(strict_types=1);

/*
 * Mise à jour en un clic du paquet complet (et du paquet PHP qui porte un
 * paquet.json). Chaque installation reste autonome : elle lit elle-même la
 * dernière Release publique de son dépôt, sans serveur central.
 *
 *  1. sauvegarde du programme (ZIP) et copie de la base, dans donnees/ ;
 *  2. téléchargement du ZIP de la Release, vérifié (même dossier racine,
 *     index.php et paquet.json présents) ;
 *  3. installation par-dessus, sans jamais toucher donnees/ ;
 *  4. en cas d'échec, retour automatique à la sauvegarde. Le bouton
 *     « Revenir à la version précédente » réinstalle la dernière sauvegarde.
 *
 * extensions/ (docs/extensions.md) n'est jamais écrit par une mise à jour,
 * même si un paquet en contenait un : il est gardé dans la sauvegarde du
 * programme, et seul le retour arrière le remet tel qu'il était.
 */

const SOCLE_MAJ_DIRS = ['php', 'admin', 'site'];
const SOCLE_MAJ_FILES = ['index.php', '.htaccess', '.user.ini', 'LISEZMOI.txt', 'LICENSE', 'THIRD_PARTY.md', 'package.json', 'paquet.json'];
const SOCLE_MAJ_MAX = 60_000_000;
// Dossier préservé : jamais vidé ni écrit par une mise à jour.
const SOCLE_MAJ_EXTENSIONS = 'extensions';
// Marque de la sauvegarde : elle contient l'état exact d'extensions/ (même vide).
const SOCLE_MAJ_EXTENSIONS_MARQUE = 'extensions/.sauvegarde-du-socle';

function socle_paquet(): ?array {
    $path = socle_root() . '/paquet.json';
    if (!is_file($path)) return null;
    $parsed = json_decode((string) file_get_contents($path), true);
    if (!is_array($parsed) || !preg_match('#^[\w.-]+/[\w.-]+$#', (string) ($parsed['depot'] ?? '')) || !preg_match('#^[\w.-]+\.zip$#', (string) ($parsed['fichier'] ?? ''))) return null;
    return $parsed;
}

function socle_paquet_version(): string {
    $paquet = socle_paquet();
    return is_string($paquet['version'] ?? null) ? $paquet['version'] : socle_package_version();
}

function socle_maj_dir(): string {
    $db = socle_env('SOCLE_DB');
    $base = $db !== null ? dirname($db) : socle_root() . '/donnees';
    $dir = $base . '/mises-a-jour';
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) throw new RuntimeException('dossier des mises à jour impossible à créer');
    return $dir;
}

/** GET simple, redirections suivies (GitHub renvoie vers son stockage). */
function socle_http_get(string $url, int $max = SOCLE_MAJ_MAX): string {
    $local = socle_env('SOCLE_MAJ_SOURCE');
    if (!preg_match('#^https://#', $url) && !($local !== null && str_starts_with($url, 'file://'))) throw new RuntimeException('adresse refusée');
    if (str_starts_with($url, 'file://')) {
        $data = file_get_contents(substr($url, 7));
        if ($data === false) throw new RuntimeException('fichier introuvable');
        return $data;
    }
    $headers = ['User-Agent: le-socle', 'Accept: application/vnd.github+json, application/octet-stream, */*'];
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5, CURLOPT_TIMEOUT => 120, CURLOPT_HTTPHEADER => $headers, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS]);
        $data = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        if (!is_string($data) || $status !== 200) throw new RuntimeException('téléchargement refusé (' . $status . ')');
    } else {
        $context = stream_context_create(['http' => ['header' => implode("\r\n", $headers), 'follow_location' => 1, 'max_redirects' => 5, 'timeout' => 120]]);
        $data = @file_get_contents($url, false, $context);
        if (!is_string($data)) throw new RuntimeException('téléchargement impossible : l’hébergeur bloque peut-être les connexions sortantes');
    }
    if (strlen($data) > $max) throw new RuntimeException('fichier trop gros');
    return $data;
}

/** Dernière version publiée (Release GitHub du dépôt du paquet), gardée 10 minutes. */
function socle_maj_offer(bool $fresh = false): ?array {
    $paquet = socle_paquet();
    if ($paquet === null) return null;
    $cache = socle_maj_dir() . '/derniere-version.json';
    if (!$fresh && is_file($cache) && time() - (int) filemtime($cache) < 600) {
        $saved = json_decode((string) file_get_contents($cache), true);
        // Une réponse sans nouveautés (Release encore vide) est redemandée.
        if (is_array($saved) && trim((string) ($saved['notes'] ?? '')) !== '') return $saved;
    }
    $local = socle_env('SOCLE_MAJ_SOURCE');
    $raw = $local !== null ? socle_http_get('file://' . $local, 1_000_000) : socle_http_get('https://api.github.com/repos/' . $paquet['depot'] . '/releases/latest', 1_000_000);
    $release = json_decode($raw, true);
    if (!is_array($release) || !is_string($release['tag_name'] ?? null)) throw new RuntimeException('réponse de GitHub illisible');
    $url = null;
    foreach (($release['assets'] ?? []) as $asset) {
        if (($asset['name'] ?? '') === $paquet['fichier'] && is_string($asset['browser_download_url'] ?? null)) $url = $asset['browser_download_url'];
    }
    if ($url === null) throw new RuntimeException('la dernière version ne contient pas ' . $paquet['fichier']);
    $offer = [
        'version' => ltrim($release['tag_name'], 'v'),
        // Notes entières : les deux parties (site Web, espace de rédaction) dépassent
        // souvent 2 000 caractères ; GitHub plafonne déjà le texte d'une Release.
        'notes' => mb_substr((string) ($release['body'] ?? ''), 0, 100_000),
        'page' => is_string($release['html_url'] ?? null) ? $release['html_url'] : 'https://github.com/' . $paquet['depot'] . '/releases/latest',
        'url' => $url,
    ];
    file_put_contents($cache, socle_json($offer));
    return $offer;
}

function socle_version_newer(string $offered, string $current): bool {
    return version_compare($offered, $current, '>');
}

/** Fichiers du programme (tout sauf donnees/), chemin relatif => octets ; avec extensions/ pour la sauvegarde. */
function socle_program_files(bool $withExtensions = false): array {
    $root = socle_root();
    $files = [];
    if ($withExtensions) {
        $files[SOCLE_MAJ_EXTENSIONS_MARQUE] = "Sauvegarde du dossier extensions/ par Le Socle.\n";
        $dir = $root . '/' . SOCLE_MAJ_EXTENSIONS;
        if (is_dir($dir)) {
            $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
            foreach ($iterator as $item) {
                if (!$item->isFile()) continue;
                $relative = ltrim(str_replace('\\', '/', substr($item->getPathname(), strlen($root))), '/');
                if ($relative === SOCLE_MAJ_EXTENSIONS_MARQUE) continue;
                $files[$relative] = (string) file_get_contents($item->getPathname());
            }
        }
    }
    foreach (SOCLE_MAJ_FILES as $name) {
        if (is_file($root . '/' . $name)) $files[$name] = (string) file_get_contents($root . '/' . $name);
    }
    foreach (SOCLE_MAJ_DIRS as $dir) {
        if (!is_dir($root . '/' . $dir)) continue;
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/' . $dir, FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $item) {
            if (!$item->isFile()) continue;
            $relative = ltrim(str_replace('\\', '/', substr($item->getPathname(), strlen($root))), '/');
            $files[$relative] = (string) file_get_contents($item->getPathname());
        }
    }
    ksort($files);
    return $files;
}

function socle_remove_tree(string $dir): void {
    if (!is_dir($dir)) return;
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $item) {
        if ($item->isDir()) @rmdir($item->getPathname());
        else @unlink($item->getPathname());
    }
    @rmdir($dir);
}

/**
 * Remplace le programme par ces fichiers (chemins relatifs à la racine du
 * paquet). donnees/ n'est jamais touché ; les dossiers du programme sont
 * vidés d'abord pour qu'un fichier retiré par la nouvelle version disparaisse.
 */
function socle_install_program(array $files): void {
    $root = socle_root();
    foreach (array_keys($files) as $name) {
        if (!is_string($name) || $name === '' || str_contains($name, '..') || str_starts_with($name, '/') || str_starts_with($name, 'donnees/')) throw new RuntimeException('chemin refusé : ' . $name);
        if (socle_maj_is_extension($name)) throw new RuntimeException('chemin refusé : ' . $name . ' (extensions/ est préservé)');
    }
    foreach (SOCLE_MAJ_DIRS as $dir) socle_remove_tree($root . '/' . $dir);
    foreach ($files as $name => $data) {
        $target = $root . '/' . $name;
        if (str_ends_with($name, '/')) continue;
        $dir = dirname($target);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) throw new RuntimeException('dossier non créé : ' . $name);
        if (file_put_contents($target, $data) === false) throw new RuntimeException('fichier non écrit : ' . $name);
    }
    if (function_exists('opcache_reset')) @opcache_reset();
}

/**
 * Fichier marqueur d’un paquet enveloppé dans un dossier (`kiosque-journal/`) :
 * son contenu s’installe à la racine du site déjà en place, pas dans un
 * sous-dossier. Il n’est pas recopié sur le site.
 */
const SOCLE_PAQUET_MARQUEUR = 'INSTALLER-A-LA-RACINE.txt';

function socle_maj_is_extension(string $relative): bool {
    return $relative === SOCLE_MAJ_EXTENSIONS || str_starts_with($relative, SOCLE_MAJ_EXTENSIONS . '/');
}

/** Ce qu'un paquet installe : ni donnees/, ni extensions/ (sauf, pour une sauvegarde, si on le demande). */
function socle_paquet_keep(string $relative, bool $extensions = false): bool {
    if ($relative === '' || str_starts_with($relative, 'donnees/') || $relative === SOCLE_PAQUET_MARQUEUR) return false;
    return $extensions || !socle_maj_is_extension($relative);
}

/** Remet extensions/ exactement comme dans une sauvegarde qui porte la marque ; sinon n'y touche pas. */
function socle_restore_extensions(array $files): bool {
    if (!isset($files[SOCLE_MAJ_EXTENSIONS_MARQUE])) return false;
    $root = socle_root();
    foreach (array_keys($files) as $name) {
        if (!is_string($name) || str_contains($name, '..') || !socle_maj_is_extension($name)) throw new RuntimeException('chemin refusé : ' . $name);
    }
    socle_remove_tree($root . '/' . SOCLE_MAJ_EXTENSIONS);
    if (!is_dir($root . '/' . SOCLE_MAJ_EXTENSIONS) && !mkdir($root . '/' . SOCLE_MAJ_EXTENSIONS, 0775, true)) throw new RuntimeException('dossier extensions/ non recréé');
    foreach ($files as $name => $data) {
        if ($name === SOCLE_MAJ_EXTENSIONS_MARQUE || str_ends_with($name, '/')) continue;
        $target = $root . '/' . $name;
        if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0775, true) && !is_dir(dirname($target))) throw new RuntimeException('dossier non créé : ' . $name);
        if (file_put_contents($target, $data) === false) throw new RuntimeException('fichier non écrit : ' . $name);
    }
    return true;
}

/**
 * Lit un ZIP de paquet et rend ses fichiers prêts à installer là où le site
 * est déjà. Deux formes acceptées : fichiers à la racine du ZIP, ou un seul
 * dossier enveloppant (paquet actuel `kiosque-journal/` avec le marqueur
 * INSTALLER-A-LA-RACINE.txt, anciens paquets `journal/`, sauvegardes).
 */
function socle_paquet_files(string $zip, bool $extensions = false): array {
    $entries = socle_unzip($zip);
    $flat = isset($entries['index.php'], $entries['paquet.json'], $entries['php/src/bootstrap.php']);
    if ($flat) {
        $files = [];
        foreach ($entries as $name => $data) {
            $relative = (string) $name;
            if (!socle_paquet_keep($relative, $extensions)) continue;
            $files[$relative] = $data;
        }
        return $files;
    }
    $root = null;
    foreach (array_keys($entries) as $name) {
        $first = explode('/', (string) $name)[0];
        if ($root === null) $root = $first;
        if ($first !== $root) throw new RuntimeException('le ZIP doit contenir un seul dossier, ou les fichiers à la racine');
    }
    if ($root === null || !isset($entries[$root . '/index.php'], $entries[$root . '/paquet.json'], $entries[$root . '/php/src/bootstrap.php'])) {
        throw new RuntimeException('ce ZIP n’est pas un paquet complet du Kiosque');
    }
    $files = [];
    foreach ($entries as $name => $data) {
        $relative = substr((string) $name, strlen($root) + 1);
        if (!socle_paquet_keep($relative, $extensions)) continue;
        $files[$relative] = $data;
    }
    return $files;
}

function socle_maj_history(): array {
    $path = socle_maj_dir() . '/historique.json';
    $parsed = is_file($path) ? json_decode((string) file_get_contents($path), true) : [];
    return is_array($parsed) ? $parsed : [];
}

function socle_maj_record(array $entry): void {
    $history = socle_maj_history();
    $history[] = $entry;
    file_put_contents(socle_maj_dir() . '/historique.json', socle_json(array_slice($history, -20)));
}

/** Sauvegarde du programme et copie de la base ; rend le nom du ZIP. */
function socle_maj_backup(string $version, string $stamp): string {
    $dir = socle_maj_dir();
    $zip = [];
    foreach (socle_program_files(true) as $name => $data) $zip[] = ['name' => 'journal/' . $name, 'data' => $data];
    $name = 'programme-' . preg_replace('/[^0-9A-Za-z.-]/', '', $version) . '-' . $stamp . '.zip';
    if (file_put_contents($dir . '/' . $name, socle_zip_store($zip)) === false) throw new RuntimeException('sauvegarde non écrite');
    $db = socle_env('SOCLE_DB');
    if ($db !== null && is_file($db)) @copy($db, $dir . '/base-' . $stamp . '.sqlite');
    // On garde les trois dernières sauvegardes du programme.
    $old = glob($dir . '/programme-*.zip') ?: [];
    usort($old, static fn (string $a, string $b): int => filemtime($a) <=> filemtime($b) ?: strcmp($a, $b));
    foreach (array_slice($old, 0, max(0, count($old) - 3)) as $stale) @unlink($stale);
    $bases = glob($dir . '/base-*.sqlite') ?: [];
    sort($bases);
    foreach (array_slice($bases, 0, max(0, count($bases) - 3)) as $stale) @unlink($stale);
    return $name;
}

function socle_maj_apply(): array {
    $offer = socle_maj_offer(true);
    if ($offer === null) throw new RuntimeException('ce paquet ne sait pas se mettre à jour seul');
    $current = socle_paquet_version();
    if (!socle_version_newer($offer['version'], $current)) throw new RuntimeException('déjà à jour');
    $files = socle_paquet_files(socle_http_get($offer['url']));
    $stamp = gmdate('Ymd-His');
    $backup = socle_maj_backup($current, $stamp);
    try {
        socle_install_program($files);
    } catch (Throwable $error) {
        socle_install_program(socle_paquet_files((string) file_get_contents(socle_maj_dir() . '/' . $backup)));
        throw new RuntimeException('installation interrompue, version précédente remise : ' . $error->getMessage());
    }
    socle_maj_record(['de' => $current, 'vers' => $offer['version'], 'le' => socle_iso(socle_now()), 'sauvegarde' => $backup]);
    return ['from' => $current, 'to' => $offer['version'], 'backup' => $backup];
}

function socle_maj_revert(): array {
    $history = socle_maj_history();
    $last = end($history);
    if (!is_array($last) || !is_string($last['sauvegarde'] ?? null)) throw new RuntimeException('aucune sauvegarde de programme');
    $path = socle_maj_dir() . '/' . basename($last['sauvegarde']);
    if (!is_file($path)) throw new RuntimeException('sauvegarde introuvable');
    $current = socle_paquet_version();
    $saved = socle_paquet_files((string) file_get_contents($path), true);
    $program = array_filter($saved, static fn (string $name): bool => !socle_maj_is_extension($name), ARRAY_FILTER_USE_KEY);
    $extensions = array_filter($saved, static fn (string $name): bool => socle_maj_is_extension($name), ARRAY_FILTER_USE_KEY);
    socle_install_program($program);
    socle_restore_extensions($extensions);
    socle_maj_record(['de' => $current, 'vers' => (string) ($last['de'] ?? ''), 'le' => socle_iso(socle_now()), 'retour' => true]);
    return ['from' => $current, 'to' => (string) ($last['de'] ?? '')];
}
