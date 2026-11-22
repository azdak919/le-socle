<?php
declare(strict_types=1);

/*
 * Extensions du Socle, contrat version 1 (docs/extensions.md).
 *
 * Une extension est un dossier extensions/<id>/ avec un manifeste
 * extension.json et un fichier d'entrée qui renvoie une fonction. Le dossier
 * extensions/ n'est jamais touché par une mise à jour ; il est gardé dans la
 * sauvegarde du programme et remis par le retour arrière. L'état (activée,
 * coupée, rôles, tâches) est dans donnees/extensions.json.
 *
 * Une extension invalide, incompatible ou en erreur n'est pas chargée : le
 * reste de l'espace de rédaction continue, et la page Extensions dit pourquoi.
 * Le site public ne charge jamais une extension.
 */

const SOCLE_EXT_API = 1;
const SOCLE_EXT_ECHECS_MAX = 3;
// Licences compatibles avec l'AGPLv3 du Socle (identifiants SPDX).
const SOCLE_EXT_LICENCES = ['AGPL-3.0-only', 'AGPL-3.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'GPL-2.0-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'Apache-2.0', 'MPL-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib', 'CC0-1.0'];
// Contrat api: 1 : ces licences, acceptées quand le Socle était sous GPL version 2
// seulement, restent chargées pendant la transition, avec un avertissement dans la
// fiche. Elles sont incompatibles avec l'AGPLv3 et seront refusées par api: 2.
const SOCLE_EXT_LICENCES_TRANSITION = ['GPL-2.0-only'];
const SOCLE_EXT_ID = '/^[a-z][a-z0-9-]{1,39}$/';
const SOCLE_EXT_SECRET = '/^[A-Z][A-Z0-9_]{1,63}$/';
const SOCLE_EXT_CHEMIN = '#^[a-z0-9][a-z0-9/-]{0,79}$|^$#';
const SOCLE_EXT_ROLES_SOCLE = ['auteur', 'photographe', 'reviseur', 'chef-pupitre', 'editeur', 'administrateur'];

final class SocleExtensionErreur extends RuntimeException {}

/* ------------------------------------------------------------------ */
/* Emplacements                                                        */
/* ------------------------------------------------------------------ */

function socle_ext_dir(): string {
    return socle_env('SOCLE_EXTENSIONS_DIR') ?? (socle_root() . '/extensions');
}

/** Au moins une extension déposée dans extensions/ (un dossier avec extension.json). */
function socle_ext_presentes(): bool {
    $dir = socle_ext_dir();
    if (!is_dir($dir)) return false;
    return (glob($dir . '/*/extension.json') ?: []) !== [];
}

function socle_ext_donnees_dir(): string {
    $db = socle_env('SOCLE_DB');
    return $db !== null ? dirname($db) : socle_root() . '/donnees';
}

function socle_ext_etat_path(): string {
    return socle_ext_donnees_dir() . '/extensions.json';
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

function socle_ext_norm(string $version): ?string {
    if (preg_match('/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/', trim($version), $m) !== 1) return null;
    return (int) $m[1] . '.' . (int) ($m[2] ?? 0) . '.' . (int) ($m[3] ?? 0);
}

/** Plage de versions : « >=1.5.0 <2.0.0 », « ^1.5.0 », « ~1.5.0 », « 1.5.0 », « * ». */
function socle_ext_plage_valide(string $plage): bool {
    $plage = trim($plage);
    if ($plage === '' || strlen($plage) > 80) return false;
    if ($plage === '*') return true;
    foreach (preg_split('/\s+/', $plage) ?: [] as $part) {
        if (preg_match('/^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,2})$/', $part) !== 1) return false;
    }
    return true;
}

function socle_ext_satisfait(string $version, string $plage): bool {
    $v = socle_ext_norm($version);
    if ($v === null || !socle_ext_plage_valide($plage)) return false;
    if (trim($plage) === '*') return true;
    foreach (preg_split('/\s+/', trim($plage)) ?: [] as $part) {
        preg_match('/^(>=|<=|>|<|=|\^|~)?(.+)$/', $part, $m);
        $op = $m[1] === '' ? '=' : $m[1];
        $cible = (string) socle_ext_norm($m[2]);
        [$maj, $min] = array_map('intval', explode('.', $cible));
        $ok = match ($op) {
            '>=' => version_compare($v, $cible, '>='),
            '<=' => version_compare($v, $cible, '<='),
            '>' => version_compare($v, $cible, '>'),
            '<' => version_compare($v, $cible, '<'),
            '=' => version_compare($v, $cible, '=='),
            '^' => version_compare($v, $cible, '>=') && version_compare($v, ($maj + 1) . '.0.0', '<'),
            '~' => version_compare($v, $cible, '>=') && version_compare($v, $maj . '.' . ($min + 1) . '.0', '<'),
        };
        if (!$ok) return false;
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* Manifeste                                                           */
/* ------------------------------------------------------------------ */

/** Lit et vérifie extension.json. Lève SocleExtensionErreur avec un message lisible. */
function socle_ext_manifeste(string $dir): array {
    $id = basename($dir);
    $path = $dir . '/extension.json';
    if (!is_file($path)) throw new SocleExtensionErreur('le fichier extension.json manque');
    $raw = json_decode((string) file_get_contents($path), true);
    if (!is_array($raw) || array_is_list($raw)) throw new SocleExtensionErreur('extension.json n’est pas un objet JSON valide');
    $text = static function (string $key, int $max, bool $required = true) use ($raw): string {
        $value = $raw[$key] ?? null;
        if ($value === null && !$required) return '';
        if (!is_string($value) || trim($value) === '' || mb_strlen($value) > $max) throw new SocleExtensionErreur('champ « ' . $key . ' » manquant ou trop long');
        return trim($value);
    };
    $m = [];
    $m['id'] = $text('id', 40);
    if (preg_match(SOCLE_EXT_ID, $m['id']) !== 1) throw new SocleExtensionErreur('identifiant invalide : lettres minuscules, chiffres et tirets');
    if ($m['id'] !== $id) throw new SocleExtensionErreur('l’identifiant « ' . $m['id'] . ' » doit être le nom du dossier (« ' . $id . ' »)');
    $m['nom'] = $text('nom', 80);
    $m['version'] = $text('version', 20);
    if (preg_match('/^\d+\.\d+\.\d+$/', $m['version']) !== 1) throw new SocleExtensionErreur('version invalide (forme 1.0.0)');
    $m['description'] = $text('description', 300, false);
    $m['auteur'] = $text('auteur', 120, false);
    $m['socle'] = $text('socle', 80);
    if (!socle_ext_plage_valide($m['socle'])) throw new SocleExtensionErreur('plage « socle » illisible (exemple : >=1.5.0 <2.0.0)');
    $api = $raw['api'] ?? null;
    if (!is_int($api)) throw new SocleExtensionErreur('champ « api » manquant (nombre entier)');
    $m['api'] = $api;
    $m['licence'] = $text('licence', 40);
    if (!in_array($m['licence'], SOCLE_EXT_LICENCES, true) && !in_array($m['licence'], SOCLE_EXT_LICENCES_TRANSITION, true)) throw new SocleExtensionErreur('licence « ' . $m['licence'] . ' » non compatible avec l’AGPLv3 du Socle');
    $entree = $raw['point_entree'] ?? 'extension.php';
    if (!is_string($entree) || preg_match('#^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*\.php$#', $entree) !== 1) throw new SocleExtensionErreur('point d’entrée invalide');
    $m['point_entree'] = $entree;
    $secrets = $raw['secrets'] ?? [];
    if (!is_array($secrets) || !array_is_list($secrets) || count($secrets) > 20) throw new SocleExtensionErreur('« secrets » doit être une liste de noms');
    foreach ($secrets as $name) {
        if (!is_string($name) || preg_match(SOCLE_EXT_SECRET, $name) !== 1) throw new SocleExtensionErreur('nom de secret invalide (MAJUSCULES_ET_SOULIGNÉS)');
    }
    $m['secrets'] = array_values(array_unique($secrets));
    $roles = $raw['roles'] ?? [];
    if (!is_array($roles) || !array_is_list($roles) || count($roles) > 10) throw new SocleExtensionErreur('« roles » doit être une liste');
    $m['roles'] = [];
    foreach ($roles as $role) {
        if (!is_array($role) || !is_string($role['id'] ?? null) || preg_match(SOCLE_EXT_ID, $role['id']) !== 1 || in_array($role['id'], SOCLE_EXT_ROLES_SOCLE, true)) throw new SocleExtensionErreur('rôle invalide');
        if (!is_string($role['nom'] ?? null) || trim($role['nom']) === '' || mb_strlen($role['nom']) > 60) throw new SocleExtensionErreur('rôle sans nom');
        $defaut = $role['defaut'] ?? ['administrateur'];
        if (!is_array($defaut)) throw new SocleExtensionErreur('rôle : « defaut » doit être une liste de rôles du Socle');
        foreach ($defaut as $core) if (!in_array($core, SOCLE_EXT_ROLES_SOCLE, true)) throw new SocleExtensionErreur('rôle : « ' . (string) $core . ' » n’est pas un rôle du Socle');
        $m['roles'][$role['id']] = ['id' => $role['id'], 'nom' => trim($role['nom']), 'defaut' => array_values(array_unique([...$defaut, 'administrateur']))];
    }
    return $m;
}

/** Raison d'incompatibilité avec cette version du Socle, ou null. */
function socle_ext_incompatible(array $manifeste, string $version): ?string {
    if ($manifeste['api'] !== SOCLE_EXT_API) return 'elle suit le contrat d’extensions ' . $manifeste['api'] . ', et Le Socle ' . $version . ' suit le contrat ' . SOCLE_EXT_API;
    if (!socle_ext_satisfait($version, $manifeste['socle'])) return 'elle demande Le Socle ' . $manifeste['socle'] . ', et la version ' . ($version === socle_package_version() ? 'installée' : 'visée') . ' est ' . $version;
    return null;
}

/* ------------------------------------------------------------------ */
/* État (donnees/extensions.json)                                      */
/* ------------------------------------------------------------------ */

function socle_ext_etat(): array {
    $path = socle_ext_etat_path();
    $parsed = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
    if (!is_array($parsed)) $parsed = [];
    $parsed['schema'] = 1;
    if (!is_array($parsed['extensions'] ?? null) || array_is_list($parsed['extensions'])) $parsed['extensions'] = [];
    if (!is_array($parsed['taches'] ?? null) || array_is_list($parsed['taches'])) $parsed['taches'] = [];
    return $parsed;
}

/** Modifie l'état sous verrou, puis l'écrit d'un coup (fichier temporaire renommé). */
function socle_ext_modifier(callable $change): array {
    $dir = socle_ext_donnees_dir();
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) throw new RuntimeException('dossier des données introuvable');
    $lock = fopen($dir . '/extensions.lock', 'c');
    if ($lock === false) throw new RuntimeException('état des extensions verrouillé');
    try {
        flock($lock, LOCK_EX);
        $etat = socle_ext_etat();
        $etat = $change($etat) ?? $etat;
        $tmp = socle_ext_etat_path() . '.' . getmypid() . '.tmp';
        if (file_put_contents($tmp, socle_json_pretty($etat) . "\n") === false || !rename($tmp, socle_ext_etat_path())) throw new RuntimeException('état des extensions non écrit');
        return $etat;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function socle_ext_fiche(array $etat, string $id): array {
    $fiche = $etat['extensions'][$id] ?? [];
    return [
        'active' => (bool) ($fiche['active'] ?? false),
        'echecs' => (int) ($fiche['echecs'] ?? 0),
        'coupee' => is_array($fiche['coupee'] ?? null) ? $fiche['coupee'] : null,
        'roles' => is_array($fiche['roles'] ?? null) ? $fiche['roles'] : [],
    ];
}

/** Coupe une extension : elle ne sera plus chargée tant que l'administrateur ne la réactive pas. */
function socle_ext_couper(string $id, string $raison): void {
    $raison = socle_ext_message($raison);
    try {
        socle_ext_modifier(static function (array $etat) use ($id, $raison): array {
            $fiche = socle_ext_fiche($etat, $id);
            $fiche['coupee'] = ['raison' => $raison, 'le' => socle_iso(socle_now())];
            $fiche['echecs'] = 0;
            $etat['extensions'][$id] = $fiche;
            return $etat;
        });
    } catch (Throwable $error) {
        error_log('extension ' . $id . ' non coupée : ' . $error->getMessage());
    }
    error_log('extension ' . $id . ' coupée : ' . $raison);
}

/** Un message d'erreur sans chemin complet du serveur, sur une ligne. */
function socle_ext_message(string $text): string {
    $text = str_replace([socle_root() . '/', socle_ext_dir() . '/'], ['', 'extensions/'], $text);
    $text = preg_replace('/\s+/', ' ', $text) ?? $text;
    return mb_substr(trim($text), 0, 300);
}

function socle_ext_compter_echec(string $id, Throwable $error): bool {
    $coupee = false;
    $raison = socle_ext_message(get_class($error) . ' : ' . $error->getMessage());
    try {
        socle_ext_modifier(static function (array $etat) use ($id, $raison, &$coupee): array {
            $fiche = socle_ext_fiche($etat, $id);
            $fiche['echecs']++;
            if ($fiche['echecs'] >= SOCLE_EXT_ECHECS_MAX) {
                $fiche['coupee'] = ['raison' => SOCLE_EXT_ECHECS_MAX . ' erreurs de suite ; la dernière : ' . $raison, 'le' => socle_iso(socle_now())];
                $fiche['echecs'] = 0;
                $coupee = true;
            }
            $etat['extensions'][$id] = $fiche;
            return $etat;
        });
    } catch (Throwable) {
    }
    error_log('extension ' . $id . ' : ' . $raison);
    return $coupee;
}

function socle_ext_reussite(string $id): void {
    $etat = socle_ext_etat();
    if (socle_ext_fiche($etat, $id)['echecs'] === 0) return;
    try {
        socle_ext_modifier(static function (array $etat) use ($id): array {
            $fiche = socle_ext_fiche($etat, $id);
            $fiche['echecs'] = 0;
            $etat['extensions'][$id] = $fiche;
            return $etat;
        });
    } catch (Throwable) {
    }
}

/* ------------------------------------------------------------------ */
/* Secrets : noms dans le manifeste, valeurs hors du dépôt              */
/* ------------------------------------------------------------------ */

function socle_ext_secret_valeur(string $name): ?string {
    $value = socle_env($name);
    if ($value !== null) return $value;
    static $fichier = null;
    if ($fichier === null) {
        $fichier = [];
        $path = socle_ext_donnees_dir() . '/secrets.php';
        if (is_file($path)) {
            try {
                $loaded = (static fn (string $p): mixed => require $p)($path);
                if (is_array($loaded)) $fichier = $loaded;
            } catch (Throwable) {
                error_log('donnees/secrets.php illisible');
            }
        }
    }
    $value = $fichier[$name] ?? null;
    return is_string($value) && trim($value) !== '' ? trim($value) : null;
}

/* ------------------------------------------------------------------ */
/* Inventaire et chargement                                            */
/* ------------------------------------------------------------------ */

/**
 * Toutes les extensions présentes, avec leur état. statut : active,
 * desactivee, coupee, incompatible, secret-manquant, invalide.
 */
function socle_ext_inventaire(?string $version = null): array {
    $version ??= socle_package_version();
    $root = socle_ext_dir();
    if (!is_dir($root)) return [];
    $etat = socle_ext_etat();
    $out = [];
    $names = scandir($root) ?: [];
    sort($names);
    foreach ($names as $name) {
        if ($name === '.' || $name === '..' || str_starts_with($name, '.') || !is_dir($root . '/' . $name)) continue;
        $fiche = socle_ext_fiche($etat, $name);
        $item = ['id' => $name, 'manifeste' => null, 'statut' => 'invalide', 'raison' => null, 'fiche' => $fiche, 'secrets' => []];
        try {
            $m = socle_ext_manifeste($root . '/' . $name);
        } catch (SocleExtensionErreur $error) {
            $item['raison'] = $error->getMessage();
            $out[$name] = $item;
            continue;
        }
        $item['manifeste'] = $m;
        foreach ($m['secrets'] as $secret) $item['secrets'][$secret] = socle_ext_secret_valeur($secret) !== null;
        $incompatible = socle_ext_incompatible($m, $version);
        $missing = array_keys(array_filter($item['secrets'], static fn (bool $present): bool => !$present));
        if (!is_file($root . '/' . $name . '/' . $m['point_entree'])) {
            $item['raison'] = 'le fichier d’entrée ' . $m['point_entree'] . ' manque';
        } elseif ($incompatible !== null) {
            $item['statut'] = 'incompatible';
            $item['raison'] = $incompatible;
        } elseif (!$fiche['active']) {
            $item['statut'] = 'desactivee';
        } elseif ($fiche['coupee'] !== null) {
            $item['statut'] = 'coupee';
            $item['raison'] = (string) ($fiche['coupee']['raison'] ?? '');
        } elseif ($missing !== []) {
            $item['statut'] = 'secret-manquant';
            $item['raison'] = 'secret à définir sur le serveur : ' . implode(', ', $missing);
        } else {
            $item['statut'] = 'active';
        }
        $out[$name] = $item;
    }
    return $out;
}

/** Extension en cours d'exécution, pour la couper si PHP s'arrête net. */
function socle_ext_courante(?string $id = null, bool $set = false): ?string {
    static $current = null;
    if ($set) $current = $id;
    return $current;
}

function socle_ext_garde(): void {
    static $done = false;
    if ($done) return;
    $done = true;
    register_shutdown_function(static function (): void {
        $id = socle_ext_courante();
        if ($id === null) return;
        $error = error_get_last();
        $fatal = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR;
        $message = $error !== null && ($error['type'] & $fatal) !== 0 ? $error['message'] : 'arrêt net pendant son exécution';
        socle_ext_couper($id, 'erreur fatale : ' . $message);
        @unlink(socle_ext_donnees_dir() . '/extensions-chargement-' . $id);
    });
}

/** Exécute du code d'extension sous garde ; rend [ok, valeur ou erreur]. */
function socle_ext_executer(string $id, callable $code): array {
    socle_ext_garde();
    $before = socle_ext_courante();
    socle_ext_courante($id, true);
    try {
        return [true, $code()];
    } catch (Throwable $error) {
        return [false, $error];
    } finally {
        socle_ext_courante($before, true);
    }
}

/** Charge (une fois par requête) les extensions actives. */
function socle_ext_chargees(?SocleStore $store = null, bool $reset = false): array {
    static $loaded = null;
    if ($reset) $loaded = null;
    if ($loaded !== null) return $loaded;
    $loaded = [];
    if ($store === null) return $loaded;
    $root = socle_ext_dir();
    if (is_dir($root) && !is_file($root . '/.htaccess')) @file_put_contents($root . '/.htaccess', "Require all denied\n");
    foreach (socle_ext_inventaire() as $id => $item) {
        if ($item['statut'] !== 'active') continue;
        $marker = socle_ext_donnees_dir() . '/extensions-chargement-' . $id;
        // Une marque restée d'une requête précédente : PHP s'est arrêté pendant le chargement.
        if (is_file($marker) && time() - (int) filemtime($marker) > 120) {
            @unlink($marker);
            socle_ext_couper($id, 'le chargement s’est arrêté net (erreur fatale ou délai dépassé)');
            continue;
        }
        @file_put_contents($marker, (string) time());
        $ext = new SocleExtension($item['manifeste'], $store, $item['fiche']['roles']);
        $entry = $root . '/' . $id . '/' . $item['manifeste']['point_entree'];
        [$ok, $result] = socle_ext_executer($id, static function () use ($entry, $ext): bool {
            $register = (static fn (string $file): mixed => require $file)($entry);
            if (!is_callable($register)) throw new SocleExtensionErreur('le fichier d’entrée doit renvoyer une fonction (return function (SocleExtension $ext) { … };)');
            $register($ext);
            $ext->figer();
            return true;
        });
        @unlink($marker);
        if (!$ok) {
            socle_ext_couper($id, 'erreur au chargement : ' . get_class($result) . ' : ' . $result->getMessage());
            continue;
        }
        $loaded[$id] = $ext;
    }
    return $loaded;
}

/** Les rôles du Socle qui détiennent un rôle d'extension (réglé par l'administrateur, sinon le défaut du manifeste). */
function socle_ext_roles_detenteurs(array $manifeste, array $reglage, string $role): array {
    $defaut = $manifeste['roles'][$role]['defaut'] ?? ['administrateur'];
    $choisis = $reglage[$role] ?? null;
    $list = is_array($choisis) ? array_values(array_intersect($choisis, SOCLE_EXT_ROLES_SOCLE)) : $defaut;
    if (!in_array('administrateur', $list, true)) $list[] = 'administrateur';
    return $list;
}

/* ------------------------------------------------------------------ */
/* L'objet remis à l'extension : les points d'accroche                  */
/* ------------------------------------------------------------------ */

final class SocleExtension {
    private bool $figee = false;
    /** @var array<string, array{libelle:string, chemin:string, roles:array}> */
    public array $menus = [];
    /** @var array<string, array{methodes:array, gestionnaire:callable, roles:array}> */
    public array $pages = [];
    /** @var array<string, array{gestionnaire:callable, roles:array}> */
    public array $apis = [];
    public array $champs = [];
    /** @var array<string, array{minutes:int, gestionnaire:callable}> */
    public array $taches = [];
    /** @var array<string, array{gestionnaire:callable, roles:array}> */
    public array $cartes = [];

    public function __construct(public readonly array $manifeste, private SocleStore $store, private array $reglageRoles) {}

    public function id(): string { return $this->manifeste['id']; }
    public function nom(): string { return $this->manifeste['nom']; }
    public function version(): string { return $this->manifeste['version']; }
    public static function versionSocle(): string { return socle_package_version(); }
    public static function echapper(string $texte): string { return socle_escape($texte); }

    public function figer(): void { $this->figee = true; }

    private function ouverte(): void {
        if ($this->figee) throw new SocleExtensionErreur('les points d’accroche s’enregistrent au chargement seulement');
    }

    private function chemin(string $chemin): string {
        $chemin = trim($chemin, '/');
        if (preg_match(SOCLE_EXT_CHEMIN, $chemin) !== 1 || str_contains($chemin, '//')) throw new SocleExtensionErreur('chemin invalide : « ' . $chemin . ' »');
        return $chemin;
    }

    private function roles(array $roles): array {
        $known = [...SOCLE_EXT_ROLES_SOCLE, ...array_keys($this->manifeste['roles'])];
        foreach ($roles as $role) if (!is_string($role) || !in_array($role, $known, true)) throw new SocleExtensionErreur('rôle inconnu : « ' . (string) $role . ' » (déclarez-le dans le manifeste)');
        return array_values(array_unique([...$roles, 'administrateur']));
    }

    /** Entrée de menu vers une page de l'extension. */
    public function menu(string $libelle, string $chemin = '', array $roles = ['administrateur']): void {
        $this->ouverte();
        $libelle = trim($libelle);
        if ($libelle === '' || mb_strlen($libelle) > 40) throw new SocleExtensionErreur('libellé de menu vide ou trop long (40 caractères)');
        if (count($this->menus) >= 8) throw new SocleExtensionErreur('8 entrées de menu au plus');
        $chemin = $this->chemin($chemin);
        $this->menus[$chemin] = ['libelle' => $libelle, 'chemin' => $chemin, 'roles' => $this->roles($roles)];
    }

    /** Page de l'espace de rédaction, sous /admin/x/<id>/<chemin>. */
    public function page(string $chemin, callable $gestionnaire, array $roles = ['administrateur'], array $methodes = ['GET']): void {
        $this->ouverte();
        foreach ($methodes as $methode) if (!in_array($methode, ['GET', 'POST'], true)) throw new SocleExtensionErreur('une page répond à GET ou POST');
        $this->pages[$this->chemin($chemin)] = ['methodes' => $methodes, 'gestionnaire' => $gestionnaire, 'roles' => $this->roles($roles)];
    }

    /** Point d'API JSON, sous /v1/x/<id>/<chemin>. */
    public function api(string $methode, string $chemin, callable $gestionnaire, array $roles = ['administrateur']): void {
        $this->ouverte();
        if (!in_array($methode, ['GET', 'POST'], true)) throw new SocleExtensionErreur('une API répond à GET ou POST');
        $this->apis[$methode . ' ' . $this->chemin($chemin)] = ['gestionnaire' => $gestionnaire, 'roles' => $this->roles($roles)];
    }

    /** Réglages non secrets, modifiables par l'administrateur dans la page Extensions. */
    public function reglages(array $champs): void {
        $this->ouverte();
        $out = [];
        foreach ($champs as $champ) {
            if (!is_array($champ) || !is_string($champ['cle'] ?? null) || preg_match('/^[a-z][a-z0-9_]{0,39}$/', $champ['cle']) !== 1) throw new SocleExtensionErreur('réglage : clé invalide');
            $type = $champ['type'] ?? 'texte';
            if (!in_array($type, ['texte', 'nombre', 'case', 'choix'], true)) throw new SocleExtensionErreur('réglage : type inconnu « ' . (string) $type . ' »');
            if (!is_string($champ['libelle'] ?? null) || trim($champ['libelle']) === '') throw new SocleExtensionErreur('réglage : libellé manquant');
            if ($type === 'choix' && (!is_array($champ['choix'] ?? null) || $champ['choix'] === [])) throw new SocleExtensionErreur('réglage : liste « choix » manquante');
            $out[$champ['cle']] = ['cle' => $champ['cle'], 'type' => $type, 'libelle' => trim($champ['libelle']), 'aide' => (string) ($champ['aide'] ?? ''), 'defaut' => $champ['defaut'] ?? ($type === 'case' ? false : ($type === 'nombre' ? 0 : '')), 'choix' => $champ['choix'] ?? []];
        }
        $this->champs = $out;
    }

    public function reglage(string $cle): mixed {
        $saved = json_decode($this->donnees()->lire('_reglages') ?? '{}', true);
        if (is_array($saved) && array_key_exists($cle, $saved)) return $saved[$cle];
        return $this->champs[$cle]['defaut'] ?? null;
    }

    /** Tâche périodique, lancée par POST /v1/taches (cron) ou à la main. */
    public function tache(string $id, int $minutes, callable $gestionnaire): void {
        $this->ouverte();
        if (preg_match(SOCLE_EXT_ID, $id) !== 1) throw new SocleExtensionErreur('identifiant de tâche invalide');
        if ($minutes < 5 || $minutes > 10080) throw new SocleExtensionErreur('intervalle de tâche entre 5 minutes et 7 jours');
        $this->taches[$id] = ['minutes' => $minutes, 'gestionnaire' => $gestionnaire];
    }

    /** Carte du tableau de bord : le gestionnaire rend ['titre', 'lignes', 'lien', 'etat']. */
    public function carte(string $id, callable $gestionnaire, array $roles = ['administrateur']): void {
        $this->ouverte();
        if (preg_match(SOCLE_EXT_ID, $id) !== 1) throw new SocleExtensionErreur('identifiant de carte invalide');
        if (count($this->cartes) >= 4) throw new SocleExtensionErreur('4 cartes au plus');
        $this->cartes[$id] = ['gestionnaire' => $gestionnaire, 'roles' => $this->roles($roles)];
    }

    /** Un secret déclaré dans le manifeste, lu sur le serveur. Jamais affiché. */
    public function secret(string $nom): ?string {
        if (!in_array($nom, $this->manifeste['secrets'], true)) throw new SocleExtensionErreur('secret non déclaré dans le manifeste : ' . $nom);
        return socle_ext_secret_valeur($nom);
    }

    /** Accès GitHub fourni par le Socle, avec un jeton déclaré dans le manifeste. */
    public function github(string $secret = 'SOCLE_GITHUB_JETON'): SocleGitHub {
        $jeton = $this->secret($secret);
        if ($jeton === null) throw new SocleExtensionErreur('le secret ' . $secret . ' n’est pas défini sur le serveur');
        return new SocleGitHub($jeton);
    }

    public function donnees(): SocleExtensionDonnees {
        return new SocleExtensionDonnees($this->store, $this->id());
    }

    /** Le rôle d'extension est-il détenu par ce rôle du Socle ? */
    public function detient(string $roleSocle, string $role): bool {
        if ($roleSocle === 'administrateur' || $roleSocle === $role) return true;
        if (in_array($role, SOCLE_EXT_ROLES_SOCLE, true)) return false;
        return in_array($roleSocle, socle_ext_roles_detenteurs($this->manifeste, $this->reglageRoles, $role), true);
    }

    public function permis(string $roleSocle, array $roles): bool {
        foreach ($roles as $role) if ($this->detient($roleSocle, $role)) return true;
        return false;
    }

    public function journal(string $message): void {
        error_log('extension ' . $this->id() . ' : ' . socle_ext_message($message));
    }
}

/** Clé-valeur propre à une extension (table ext_<id>), dans la base du journal et ses sauvegardes. */
final class SocleExtensionDonnees {
    public function __construct(private SocleStore $store, private string $id) {}

    private function table(): string { return 'ext_' . str_replace('-', '_', $this->id); }

    public function lire(string $cle): ?string { return $this->store->extGet($this->table(), $cle); }
    public function ecrire(string $cle, string $valeur): void { $this->store->extPut($this->table(), $cle, $valeur); }
    public function effacer(string $cle): void { $this->store->extDelete($this->table(), $cle); }
    /** @return array<string, string> */
    public function tout(): array { return $this->store->extList($this->table()); }
}

/** Requête remise aux pages et aux API d'une extension. */
final class SocleRequete {
    public function __construct(
        public readonly string $methode,
        public readonly string $chemin,
        public readonly array $parametres,
        private string $corps,
        public readonly ?string $acteur,
        public readonly string $role,
        public readonly string $langue,
        private SocleExtension $ext,
    ) {}

    public function parametre(string $nom, string $defaut = ''): string {
        $value = $this->parametres[$nom] ?? $defaut;
        return is_string($value) ? $value : $defaut;
    }

    public function champ(string $nom, string $defaut = ''): string {
        return socle_form($this->corps)[$nom][0] ?? $defaut;
    }

    public function champs(string $nom): array {
        return socle_form($this->corps)[$nom] ?? [];
    }

    public function json(): ?array {
        $decoded = json_decode($this->corps, true);
        return is_array($decoded) ? $decoded : null;
    }

    public function peut(string $role): bool { return $this->ext->detient($this->role, $role); }

    public function adresse(string $chemin = ''): string {
        return '/admin/x/' . $this->ext->id() . ($chemin === '' ? '' : '/' . trim($chemin, '/'));
    }
}

/** Réponse d'une page ou d'une API d'extension. */
final class SocleReponse {
    private function __construct(public readonly array $resultat) {}

    public static function page(string $titre, string $corps): self { return new self(['page' => [$titre, $corps]]); }
    public static function json(mixed $donnees, int $statut = 200): self { return new self(['result' => socle_result($statut, socle_json($donnees), ['content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store'])]); }
    public static function redirection(string $adresse): self {
        if (!str_starts_with($adresse, '/') || str_starts_with($adresse, '//')) throw new SocleExtensionErreur('redirection hors de l’espace de rédaction refusée');
        return new self(['result' => socle_result(303, '', ['location' => $adresse, 'cache-control' => 'no-store'])]);
    }
    public static function texte(int $statut, string $texte): self { return new self(['result' => socle_text($statut, $texte)]); }
}

/* ------------------------------------------------------------------ */
/* Accès GitHub                                                        */
/* ------------------------------------------------------------------ */

final class SocleGitHubErreur extends RuntimeException {
    public function __construct(string $message, public int $statut = 0) { parent::__construct($message); }
}

final class SocleGitHub {
    private string $api;

    public function __construct(private string $jeton) {
        $api = rtrim(socle_env('SOCLE_GITHUB_API') ?? 'https://api.github.com', '/');
        // Adresse de test locale seulement ; sinon HTTPS obligatoire.
        if (!str_starts_with($api, 'https://') && preg_match('#^http://(127\.0\.0\.1|localhost)(:\d+)?$#', $api) !== 1) throw new SocleGitHubErreur('adresse de l’API GitHub refusée');
        $this->api = $api;
    }

    private static function depot(string $depot): string {
        if (preg_match('#^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$#', $depot) !== 1) throw new SocleGitHubErreur('dépôt invalide (forme propriétaire/nom)');
        return $depot;
    }

    private static function branche(string $branche): string {
        if (preg_match('#^[A-Za-z0-9._/-]{1,100}$#', $branche) !== 1 || str_contains($branche, '..')) throw new SocleGitHubErreur('nom de branche invalide');
        return $branche;
    }

    /** @return array{statut:int, corps:mixed} */
    private function appel(string $methode, string $chemin, ?array $corps = null): array {
        $headers = ['Authorization: Bearer ' . $this->jeton, 'Accept: application/vnd.github+json', 'X-GitHub-Api-Version: 2022-11-28', 'User-Agent: le-socle'];
        $payload = $corps === null ? null : socle_json($corps);
        if ($payload !== null) $headers[] = 'Content-Type: application/json';
        $url = $this->api . $chemin;
        if (function_exists('curl_init')) {
            $curl = curl_init($url);
            curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $methode, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20, CURLOPT_FOLLOWLOCATION => false]);
            if ($payload !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, $payload);
            $raw = curl_exec($curl);
            $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        } else {
            $context = stream_context_create(['http' => ['method' => $methode, 'header' => implode("\r\n", $headers), 'content' => $payload ?? '', 'ignore_errors' => true, 'timeout' => 20, 'follow_location' => 0]]);
            $raw = @file_get_contents($url, false, $context);
            $status = 0;
            foreach ($http_response_header ?? [] as $line) if (preg_match('#^HTTP/\S+\s(\d{3})#', $line, $m) === 1) $status = (int) $m[1];
        }
        if (!is_string($raw)) throw new SocleGitHubErreur('GitHub ne répond pas', 0);
        $decoded = $raw === '' ? null : json_decode($raw, true);
        if ($status < 200 || $status >= 300) {
            $message = is_array($decoded) && is_string($decoded['message'] ?? null) ? $decoded['message'] : 'refus';
            throw new SocleGitHubErreur('GitHub a répondu ' . $status . ' : ' . mb_substr($message, 0, 200), $status);
        }
        return ['statut' => $status, 'corps' => $decoded];
    }

    /** Déclenche un workflow (workflow_dispatch). Les entrées sont des textes. */
    public function declencher(string $depot, string $workflow, string $ref = 'main', array $entrees = []): void {
        if (preg_match('/^([A-Za-z0-9_.-]+\.ya?ml|\d+)$/', $workflow) !== 1) throw new SocleGitHubErreur('workflow invalide');
        $inputs = [];
        foreach ($entrees as $key => $value) {
            if (!is_string($key) || preg_match('/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/', $key) !== 1) throw new SocleGitHubErreur('entrée de workflow invalide');
            $inputs[$key] = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
        }
        $this->appel('POST', '/repos/' . self::depot($depot) . '/actions/workflows/' . rawurlencode($workflow) . '/dispatches', ['ref' => self::branche($ref), 'inputs' => (object) $inputs]);
    }

    /** Dernières exécutions d'un workflow. */
    public function executions(string $depot, string $workflow, int $nombre = 5): array {
        $nombre = max(1, min(30, $nombre));
        $reponse = $this->appel('GET', '/repos/' . self::depot($depot) . '/actions/workflows/' . rawurlencode($workflow) . '/runs?per_page=' . $nombre);
        $out = [];
        foreach (($reponse['corps']['workflow_runs'] ?? []) as $run) {
            if (!is_array($run)) continue;
            $out[] = ['id' => (int) ($run['id'] ?? 0), 'etat' => (string) ($run['status'] ?? ''), 'conclusion' => (string) ($run['conclusion'] ?? ''), 'cree' => (string) ($run['created_at'] ?? ''), 'lien' => (string) ($run['html_url'] ?? '')];
        }
        return $out;
    }

    /** Lit un fichier ; rend null s'il n'existe pas. */
    public function lireFichier(string $depot, string $chemin, string $ref = 'main'): ?array {
        if (preg_match('#^[A-Za-z0-9._/-]{1,200}$#', $chemin) !== 1 || str_contains($chemin, '..')) throw new SocleGitHubErreur('chemin de fichier invalide');
        try {
            $reponse = $this->appel('GET', '/repos/' . self::depot($depot) . '/contents/' . $chemin . '?ref=' . rawurlencode(self::branche($ref)));
        } catch (SocleGitHubErreur $error) {
            if ($error->statut === 404) return null;
            throw $error;
        }
        $corps = $reponse['corps'];
        if (!is_array($corps) || ($corps['type'] ?? '') !== 'file') throw new SocleGitHubErreur('ce chemin n’est pas un fichier');
        $contenu = base64_decode(str_replace("\n", '', (string) ($corps['content'] ?? '')), true);
        return ['contenu' => $contenu === false ? '' : $contenu, 'sha' => (string) ($corps['sha'] ?? '')];
    }

    /**
     * Propose des fichiers par une pull request : nouvelle branche depuis
     * $base, un commit par fichier, puis la PR. N'écrit jamais sur $base.
     * @param array<string, string> $fichiers chemin => contenu
     */
    public function proposerPR(string $depot, string $base, string $branche, string $titre, string $corps, array $fichiers): array {
        $depot = self::depot($depot);
        $base = self::branche($base);
        $branche = self::branche($branche);
        if ($branche === $base || in_array($branche, ['main', 'master'], true)) throw new SocleGitHubErreur('une proposition s’écrit sur une nouvelle branche, jamais sur ' . $branche);
        if ($fichiers === [] || count($fichiers) > 20) throw new SocleGitHubErreur('entre 1 et 20 fichiers par proposition');
        if (trim($titre) === '') throw new SocleGitHubErreur('titre de PR manquant');
        $ref = $this->appel('GET', '/repos/' . $depot . '/git/ref/heads/' . $base);
        $sha = (string) ($ref['corps']['object']['sha'] ?? '');
        if ($sha === '') throw new SocleGitHubErreur('branche de base introuvable');
        $this->appel('POST', '/repos/' . $depot . '/git/refs', ['ref' => 'refs/heads/' . $branche, 'sha' => $sha]);
        foreach ($fichiers as $chemin => $contenu) {
            $existant = $this->lireFichier($depot, (string) $chemin, $branche);
            $body = ['message' => mb_substr(trim($titre), 0, 200) . ' (' . $chemin . ')', 'content' => base64_encode((string) $contenu), 'branch' => $branche];
            if ($existant !== null) $body['sha'] = $existant['sha'];
            $this->appel('PUT', '/repos/' . $depot . '/contents/' . $chemin, $body);
        }
        $pr = $this->appel('POST', '/repos/' . $depot . '/pulls', ['title' => mb_substr(trim($titre), 0, 200), 'head' => $branche, 'base' => $base, 'body' => $corps]);
        return ['numero' => (int) ($pr['corps']['number'] ?? 0), 'lien' => (string) ($pr['corps']['html_url'] ?? '')];
    }
}

/* ------------------------------------------------------------------ */
/* Routage                                                             */
/* ------------------------------------------------------------------ */

/** Le rôle de la personne connectée ; sans auth, la machine du Socle vaut administrateur. */
function socle_ext_role(SocleStore $store, ?string $actor, bool $defined): ?string {
    if (!$defined) return socle_redaction_local() ? 'administrateur' : null;
    if ($actor === null || $actor === '') return null;
    return socle_role_of($store, $actor);
}

function socle_ext_meme_origine(): bool {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (!is_string($origin) || $origin === '' || $origin === 'null') return true;
    $host = parse_url($origin, PHP_URL_HOST);
    $port = parse_url($origin, PHP_URL_PORT);
    $here = (string) ($_SERVER['HTTP_HOST'] ?? '');
    return $here !== '' && strtolower($host . ($port ? ':' . $port : '')) === strtolower($here);
}

/** Erreur d'une extension dans une page : l'espace de rédaction reste debout. */
function socle_ext_page_erreur(string $lang, SocleExtension $ext, Throwable $error, bool $coupee): array {
    $body = '<p class="note" role="alert">L’extension « ' . socle_escape($ext->nom()) . ' » a rencontré une erreur. Le reste de l’espace de rédaction fonctionne normalement.</p>'
        . '<p class="aide">Détail : ' . socle_escape(socle_ext_message($error->getMessage())) . '</p>'
        . ($coupee ? '<p><strong>Elle est maintenant coupée</strong> après ' . SOCLE_EXT_ECHECS_MAX . ' erreurs de suite. L’administrateur peut la réactiver dans la page <a href="/admin/extensions">Extensions</a>.</p>' : '<p><a href="/admin/extensions">Voir la page Extensions</a></p>');
    $result = socle_admin_document($lang, socle_escape($ext->nom()), $body);
    $result['status'] = 500;
    return $result;
}

function socle_ext_sous_menu(SocleExtension $ext, string $role, string $actuel): string {
    $items = [];
    foreach ($ext->menus as $menu) {
        if (!$ext->permis($role, $menu['roles'])) continue;
        $href = '/admin/x/' . $ext->id() . ($menu['chemin'] === '' ? '' : '/' . $menu['chemin']);
        $items[] = '<a href="' . socle_escape($href) . '"' . ($menu['chemin'] === $actuel ? ' aria-current="page"' : '') . '>' . socle_escape($menu['libelle']) . '</a>';
    }
    return count($items) > 1 ? '<nav class="sous-menu" aria-label="' . socle_escape($ext->nom()) . '">' . implode('', $items) . '</nav>' : '';
}

/** /admin/x/<id>/… : pages des extensions. */
function socle_ext_handle_page(string $method, string $uri, SocleStore $store, string $raw, ?string $actor, bool $defined): array {
    socle_admin_extra_css(true);
    $path = socle_canonical_admin_path(socle_request_path($uri));
    $lang = socle_lang($uri);
    if (preg_match('#^/admin/x/([a-z][a-z0-9-]{1,39})(?:/(.*))?$#', $path, $m) !== 1) return socle_result(404);
    $role = socle_ext_role($store, $actor, $defined);
    if ($role === null) return socle_text(401, 'Connexion requise.');
    $ext = socle_ext_chargees($store)[$m[1]] ?? null;
    if ($ext === null) {
        $body = '<p class="note" role="status">Cette extension n’est pas active pour l’instant. ' . ($role === 'administrateur' ? 'La page <a href="/admin/extensions">Extensions</a> dit pourquoi.' : 'Demandez à l’administrateur du journal.') . '</p>';
        $result = socle_admin_document($lang, 'Extension indisponible', $body);
        $result['status'] = 404;
        return $result;
    }
    $chemin = trim((string) ($m[2] ?? ''), '/');
    $page = $ext->pages[$chemin] ?? null;
    if ($page === null) return socle_result(404);
    if (!in_array($method, $page['methodes'], true)) return socle_result(405, '', ['allow' => implode(', ', $page['methodes'])]);
    if (!$ext->permis($role, $page['roles'])) return socle_text(403, 'Votre rôle ne donne pas accès à cette page.');
    if ($method === 'POST' && !socle_ext_meme_origine()) return socle_text(403, 'Envoi refusé : il ne vient pas de l’espace de rédaction.');
    parse_str((string) (parse_url($uri, PHP_URL_QUERY) ?? ''), $query);
    $req = new SocleRequete($method, $chemin, $query, $raw, $actor, $role, $lang, $ext);
    [$ok, $value] = socle_ext_executer($ext->id(), static fn () => ($page['gestionnaire'])($req));
    if (!$ok) return socle_ext_page_erreur($lang, $ext, $value, socle_ext_compter_echec($ext->id(), $value));
    socle_ext_reussite($ext->id());
    $titre = $ext->menus[$chemin]['libelle'] ?? $ext->nom();
    if (is_string($value)) $value = SocleReponse::page($titre, $value);
    if (!$value instanceof SocleReponse) return socle_ext_page_erreur($lang, $ext, new SocleExtensionErreur('la page doit rendre du HTML ou une SocleReponse'), socle_ext_compter_echec($ext->id(), new SocleExtensionErreur('réponse invalide')));
    if (isset($value->resultat['result'])) return $value->resultat['result'];
    [$titre, $corps] = $value->resultat['page'];
    return socle_admin_document($lang, socle_escape($titre), socle_ext_sous_menu($ext, $role, $chemin) . $corps);
}

/** /v1/x/<id>/… : API JSON des extensions. */
function socle_ext_handle_api(string $method, string $uri, SocleStore $store, string $raw, ?string $actor, bool $defined): array {
    $path = socle_request_path($uri);
    if (preg_match('#^/v1/x/([a-z][a-z0-9-]{1,39})(?:/(.*))?$#', $path, $m) !== 1) return socle_result(404);
    $role = socle_ext_role($store, $actor, $defined);
    if ($role === null) return socle_text(401, 'Connexion requise.');
    $ext = socle_ext_chargees($store)[$m[1]] ?? null;
    if ($ext === null) return socle_result(404);
    $chemin = trim((string) ($m[2] ?? ''), '/');
    $api = $ext->apis[$method . ' ' . $chemin] ?? null;
    if ($api === null) return socle_result(404);
    if (!$ext->permis($role, $api['roles'])) return socle_text(403, 'refusé');
    if ($method === 'POST') {
        $type = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
        if (!str_starts_with($type, 'application/json')) return socle_text(415, 'application/json seulement');
        if (!socle_ext_meme_origine()) return socle_text(403, 'origine refusée');
    }
    parse_str((string) (parse_url($uri, PHP_URL_QUERY) ?? ''), $query);
    $req = new SocleRequete($method, $chemin, $query, $raw, $actor, $role, socle_lang($uri), $ext);
    [$ok, $value] = socle_ext_executer($ext->id(), static fn () => ($api['gestionnaire'])($req));
    if (!$ok) {
        socle_ext_compter_echec($ext->id(), $value);
        return socle_result(500, socle_json(['erreur' => 'l’extension a rencontré une erreur']), ['content-type' => 'application/json; charset=utf-8']);
    }
    socle_ext_reussite($ext->id());
    if ($value instanceof SocleReponse && isset($value->resultat['result'])) return $value->resultat['result'];
    return SocleReponse::json($value)->resultat['result'];
}

/* ------------------------------------------------------------------ */
/* Tâches                                                              */
/* ------------------------------------------------------------------ */

function socle_ext_lancer_tache(SocleExtension $ext, string $id, bool $force): array {
    $tache = $ext->taches[$id] ?? null;
    if ($tache === null) return ['extension' => $ext->id(), 'tache' => $id, 'statut' => 'inconnue', 'message' => ''];
    $cle = $ext->id() . '/' . $id;
    $etat = socle_ext_etat();
    $dernier = $etat['taches'][$cle]['dernier'] ?? null;
    if (!$force && is_string($dernier) && socle_now()->getTimestamp() - strtotime($dernier) < $tache['minutes'] * 60) {
        return ['extension' => $ext->id(), 'tache' => $id, 'statut' => 'pas-due', 'message' => ''];
    }
    $dir = socle_ext_donnees_dir();
    $lock = fopen($dir . '/extensions-tache-' . $ext->id() . '--' . $id . '.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
        if ($lock !== false) fclose($lock);
        return ['extension' => $ext->id(), 'tache' => $id, 'statut' => 'occupee', 'message' => 'déjà en cours'];
    }
    try {
        $start = microtime(true);
        [$ok, $value] = socle_ext_executer($ext->id(), static fn () => ($tache['gestionnaire'])($ext));
        $statut = $ok ? 'ok' : 'erreur';
        $message = $ok ? socle_ext_message(is_string($value) ? $value : '') : socle_ext_message($value->getMessage());
        if ($ok) socle_ext_reussite($ext->id()); else socle_ext_compter_echec($ext->id(), $value);
        $record = ['dernier' => socle_iso(socle_now()), 'statut' => $statut, 'message' => $message, 'duree_ms' => (int) round((microtime(true) - $start) * 1000)];
        socle_ext_modifier(static function (array $etat) use ($cle, $record): array {
            $etat['taches'][$cle] = $record;
            return $etat;
        });
        return ['extension' => $ext->id(), 'tache' => $id, 'statut' => $statut, 'message' => $message];
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** POST /v1/taches : lancé par le cron de l'hébergeur, avec le jeton SOCLE_TACHES_JETON. */
function socle_ext_handle_taches(string $method, SocleStore $store): array {
    if ($method !== 'POST') return socle_result(405, '', ['allow' => 'POST']);
    $expected = socle_env('SOCLE_TACHES_JETON');
    $given = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    $ok = socle_redaction_local() || ($expected !== null && strlen($expected) >= 24 && hash_equals('Bearer ' . $expected, $given));
    if (!$ok) return socle_text(403, 'jeton des tâches requis');
    $out = [];
    foreach (socle_ext_chargees($store) as $ext) {
        foreach (array_keys($ext->taches) as $id) $out[] = socle_ext_lancer_tache($ext, (string) $id, false);
    }
    return socle_result(200, socle_json(['taches' => $out]), ['content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store']);
}

/* ------------------------------------------------------------------ */
/* Menu et cartes pour l'espace de rédaction (admin.js)                  */
/* ------------------------------------------------------------------ */

function socle_ext_menu_json(SocleStore $store, string $role): array {
    $menu = [];
    $cartes = [];
    foreach (socle_ext_chargees($store) as $ext) {
        foreach ($ext->menus as $item) {
            if (!$ext->permis($role, $item['roles'])) continue;
            $menu[] = ['extension' => $ext->id(), 'libelle' => $item['libelle'], 'adresse' => '/admin/x/' . $ext->id() . ($item['chemin'] === '' ? '' : '/' . $item['chemin'])];
        }
        foreach ($ext->cartes as $id => $carte) {
            if (!$ext->permis($role, $carte['roles'])) continue;
            [$ok, $value] = socle_ext_executer($ext->id(), static fn () => ($carte['gestionnaire'])($ext));
            if (!$ok) {
                socle_ext_compter_echec($ext->id(), $value);
                $cartes[] = ['extension' => $ext->id(), 'id' => $id, 'titre' => $ext->nom(), 'lignes' => ['Cette carte n’a pas pu se charger.'], 'lien' => null, 'etat' => 'alerte'];
                continue;
            }
            $value = is_array($value) ? $value : [];
            $lignes = array_values(array_filter(array_map(static fn ($l): string => mb_substr((string) $l, 0, 200), is_array($value['lignes'] ?? null) ? $value['lignes'] : []), static fn (string $l): bool => $l !== ''));
            $lien = is_string($value['lien'] ?? null) && str_starts_with($value['lien'], '/') && !str_starts_with($value['lien'], '//') ? $value['lien'] : null;
            $cartes[] = ['extension' => $ext->id(), 'id' => $id, 'titre' => mb_substr((string) ($value['titre'] ?? $ext->nom()), 0, 80), 'lignes' => array_slice($lignes, 0, 6), 'lien' => $lien, 'etat' => in_array($value['etat'] ?? '', ['ok', 'attention', 'alerte'], true) ? $value['etat'] : 'ok'];
        }
    }
    $avis = [];
    if ($role === 'administrateur') {
        foreach (socle_ext_inventaire() as $item) {
            if (!in_array($item['statut'], ['coupee', 'incompatible', 'secret-manquant', 'invalide'], true)) continue;
            if ($item['statut'] !== 'invalide' && !$item['fiche']['active']) continue;
            $avis[] = ['extension' => $item['id'], 'nom' => $item['manifeste']['nom'] ?? $item['id'], 'statut' => $item['statut'], 'message' => socle_ext_libelle_statut($item['statut']) . ($item['raison'] ? ' : ' . $item['raison'] : '') . '.'];
        }
    }
    return ['api' => SOCLE_EXT_API, 'administrateur' => $role === 'administrateur', 'menu' => $menu, 'cartes' => $cartes, 'avis' => $avis];
}

function socle_ext_libelle_statut(string $statut): string {
    return [
        'active' => 'Active',
        'desactivee' => 'Désactivée',
        'coupee' => 'Coupée automatiquement',
        'incompatible' => 'Incompatible avec cette version du Socle',
        'secret-manquant' => 'En attente d’un secret',
        'invalide' => 'Manifeste invalide',
    ][$statut] ?? $statut;
}

/* ------------------------------------------------------------------ */
/* Avertissement avant une mise à jour                                  */
/* ------------------------------------------------------------------ */

/** Extensions en service qui seraient incompatibles avec la version visée. */
function socle_ext_incompatibles_avec(string $version): array {
    $out = [];
    foreach (socle_ext_inventaire() as $item) {
        if ($item['manifeste'] === null || !$item['fiche']['active']) continue;
        $raison = socle_ext_incompatible($item['manifeste'], $version);
        if ($raison !== null) $out[] = ['nom' => $item['manifeste']['nom'], 'version' => $item['manifeste']['version'], 'raison' => $raison];
    }
    return $out;
}

function socle_ext_avertissement_maj(?string $version, string $lang): string {
    if (!is_dir(socle_ext_dir())) return '';
    $actives = array_filter(socle_ext_inventaire(), static fn (array $item): bool => $item['manifeste'] !== null && $item['fiche']['active']);
    if ($actives === []) return '';
    socle_admin_extra_css(true);
    $en = $lang === 'en';
    if ($version === null) {
        return '<p class="note">' . ($en ? 'Extension compatibility with the new version could not be checked.' : 'La compatibilité des extensions avec la nouvelle version n’a pas pu être vérifiée.') . '</p>';
    }
    $bad = socle_ext_incompatibles_avec($version);
    if ($bad === []) {
        return '<p class="note">' . ($en ? 'Installed extensions are compatible with version ' : 'Les extensions installées sont compatibles avec la version ') . socle_escape($version) . ($en ? ' of the newsroom.' : ' de l’espace de rédaction.') . '</p>';
    }
    $items = '';
    foreach ($bad as $item) $items .= '<li><strong>' . socle_escape($item['nom']) . '</strong> ' . socle_escape($item['version']) . ' — ' . socle_escape($item['raison']) . '</li>';
    return '<div class="note alerte" role="alert" data-extensions-incompatibles><p><strong>' . ($en ? 'Warning:' : 'Attention :') . '</strong> '
        . ($en ? 'after this update, these extensions will be switched off, because they are not compatible with version ' : 'après cette mise à jour, ces extensions seront coupées, car elles ne sont pas compatibles avec la version ')
        . socle_escape($version) . ($en ? ' of the newsroom:' : ' de l’espace de rédaction :') . '</p><ul>' . $items . '</ul><p>'
        . ($en ? 'The rest of the newsroom will keep working. You can wait for a new version of the extension, or update now: the extension will come back on its own once a compatible version is installed.'
            : 'Le reste de l’espace de rédaction continuera de fonctionner. Vous pouvez attendre une nouvelle version de l’extension, ou mettre à jour maintenant : elle se rallumera d’elle-même dès qu’une version compatible sera installée.')
        . '</p></div>';
}

/* ------------------------------------------------------------------ */
/* Page Extensions (administrateur)                                     */
/* ------------------------------------------------------------------ */

function socle_ext_pastille(string $statut): string {
    $tone = ['active' => 'ok', 'desactivee' => 'neutre', 'coupee' => 'alerte', 'incompatible' => 'alerte', 'secret-manquant' => 'attention', 'invalide' => 'alerte'][$statut] ?? 'neutre';
    return '<span class="pastille pastille-' . $tone . '">' . socle_escape(socle_ext_libelle_statut($statut)) . '</span>';
}

function socle_ext_bouton(string $action, string $libelle, string $classe = ''): string {
    return '<form class="noprint" method="post" action="' . socle_escape($action) . '"><button type="submit"' . ($classe !== '' ? ' class="' . $classe . '"' : '') . '>' . $libelle . '</button></form>';
}

function socle_ext_fiche_html(array $item, ?SocleExtension $ext): string {
    $m = $item['manifeste'];
    $id = $item['id'];
    $base = '/admin/extensions/' . $id;
    $title = $m !== null ? socle_escape($m['nom']) : socle_escape($id);
    $html = '<article class="extension" id="extension-' . socle_escape($id) . '" data-statut="' . socle_escape($item['statut']) . '">';
    $html .= '<header class="extension-tete"><h2>' . $title . ($m !== null ? ' <small>' . socle_escape($m['version']) . '</small>' : '') . '</h2>' . socle_ext_pastille($item['statut']) . '</header>';
    if ($m !== null && $m['description'] !== '') $html .= '<p>' . socle_escape($m['description']) . '</p>';
    if ($item['raison']) $html .= '<p class="note' . (in_array($item['statut'], ['coupee', 'incompatible', 'invalide'], true) ? ' alerte' : '') . '" role="status">' . socle_escape(ucfirst((string) $item['raison'])) . ($item['statut'] === 'coupee' && isset($item['fiche']['coupee']['le']) ? ' <span class="aide">(' . socle_escape(socle_date_lisible((int) strtotime((string) $item['fiche']['coupee']['le']), 'fr')) . ')</span>' : '') . '</p>';
    if ($m !== null) {
        $html .= '<dl class="fiche">';
        $html .= '<dt>Dossier</dt><dd><code>extensions/' . socle_escape($id) . '</code></dd>';
        $html .= '<dt>Demande</dt><dd>Le Socle ' . socle_escape($m['socle']) . '</dd>';
        $html .= '<dt>Licence</dt><dd>' . socle_escape($m['licence']) . (in_array($m['licence'], SOCLE_EXT_LICENCES_TRANSITION, true) ? ' <span class="pastille pastille-attention">incompatible avec l’AGPLv3 : acceptée pendant la transition, refusée par le contrat 2</span>' : '') . '</dd>';
        if ($m['auteur'] !== '') $html .= '<dt>Auteur</dt><dd>' . socle_escape($m['auteur']) . '</dd>';
        if ($item['secrets'] !== []) {
            $secrets = [];
            foreach ($item['secrets'] as $name => $present) $secrets[] = '<code>' . socle_escape($name) . '</code> ' . ($present ? '<span class="pastille pastille-ok">défini</span>' : '<span class="pastille pastille-attention">à définir</span>');
            $html .= '<dt>Secrets</dt><dd class="secrets">' . implode('<br>', $secrets) . '</dd>';
        }
        $html .= '</dl>';
        if ($ext !== null && $ext->menus !== []) {
            $links = [];
            foreach ($ext->menus as $menu) $links[] = '<li><a class="bouton" href="/admin/x/' . socle_escape($id) . ($menu['chemin'] === '' ? '' : '/' . socle_escape($menu['chemin'])) . '">' . socle_escape($menu['libelle']) . '</a></li>';
            $html .= '<ul class="liens">' . implode('', $links) . '</ul>';
        }
        if ($m['roles'] !== [] && in_array($item['statut'], ['active', 'secret-manquant', 'desactivee'], true)) {
            $html .= '<h3>Rôles</h3><form class="noprint roles" method="post" action="' . socle_escape($base . '/roles') . '">';
            foreach ($m['roles'] as $role) {
                $holders = socle_ext_roles_detenteurs($m, $item['fiche']['roles'], $role['id']);
                $html .= '<fieldset><legend>' . socle_escape($role['nom']) . '</legend>';
                foreach (SOCLE_EXT_ROLES_SOCLE as $core) {
                    $label = ['auteur' => 'Auteur', 'photographe' => 'Photographe', 'reviseur' => 'Réviseur', 'chef-pupitre' => 'Chef de pupitre', 'editeur' => 'Éditeur', 'administrateur' => 'Administrateur'][$core];
                    $html .= '<label><input type="checkbox" name="' . socle_escape($role['id']) . '" value="' . $core . '"' . (in_array($core, $holders, true) ? ' checked' : '') . ($core === 'administrateur' ? ' disabled' : '') . '> ' . $label . '</label>';
                }
                $html .= '</fieldset>';
            }
            $html .= '<p><button type="submit" class="secondaire">Enregistrer les rôles</button></p></form>';
        }
        if ($ext !== null && $ext->taches !== []) {
            $etat = socle_ext_etat();
            $html .= '<h3>Tâches</h3><ul class="taches">';
            foreach ($ext->taches as $tid => $tache) {
                $record = $etat['taches'][$id . '/' . $tid] ?? null;
                $last = is_array($record) ? 'Dernière : ' . socle_escape(socle_date_lisible((int) strtotime((string) $record['dernier']), 'fr')) . ' — ' . ($record['statut'] === 'ok' ? 'réussie' : 'en erreur') . ($record['message'] !== '' ? ' (' . socle_escape($record['message']) . ')' : '') : 'Jamais lancée.';
                $every = $tache['minutes'] % 60 === 0 ? 'toutes les ' . ($tache['minutes'] / 60) . ' h' : 'toutes les ' . $tache['minutes'] . ' min';
                $html .= '<li><div><strong>' . socle_escape((string) $tid) . '</strong> <span class="aide">' . $every . '</span><br><span class="aide">' . $last . '</span></div>' . socle_ext_bouton($base . '/taches/' . $tid, 'Lancer maintenant', 'secondaire') . '</li>';
            }
            $html .= '</ul>';
        }
    }
    $actions = '';
    if ($m !== null && $ext !== null && $ext->champs !== []) $actions .= '<a class="bouton" href="' . socle_escape($base . '/reglages') . '">Réglages</a>';
    if ($m !== null && $item['statut'] === 'coupee') $actions .= socle_ext_bouton($base . '/reactiver', 'Réactiver');
    if ($m !== null && $item['statut'] === 'desactivee') $actions .= socle_ext_bouton($base . '/activer', 'Activer');
    if ($m !== null && $item['fiche']['active']) $actions .= socle_ext_bouton($base . '/desactiver', 'Désactiver', 'secondaire');
    if ($actions !== '') $html .= '<div class="actions">' . $actions . '</div>';
    return $html . '</article>';
}

function socle_ext_page_liste(string $lang, SocleStore $store, ?string $message): array {
    // Charger d'abord : une extension qui échoue au chargement apparaît aussitôt coupée.
    $loaded = socle_ext_chargees($store);
    $items = socle_ext_inventaire();
    $body = $message !== null ? '<p class="note" role="status">' . socle_escape($message) . '</p>' : '';
    $body .= '<p>Les extensions ajoutent à l’espace de rédaction des outils propres à votre journal. Chacune vit dans son dossier, sous <code>extensions/</code> sur le serveur : une mise à jour du Socle n’y touche jamais, et la sauvegarde du programme les garde.</p>';
    $body .= '<p class="aide">Une extension qui ne convient pas à cette version du Socle, ou qui provoque une erreur, est coupée toute seule : le reste de l’espace de rédaction continue de fonctionner. Contrat des extensions : version ' . SOCLE_EXT_API . ', Le Socle ' . socle_escape(socle_package_version()) . '.</p>';
    if ($items === []) {
        $body .= '<div class="vide"><h2>Aucune extension installée</h2><p>Pour en installer une, copiez son dossier dans <code>extensions/</code> sur le serveur (gestionnaire de fichiers de l’hébergeur ou FTP), puis revenez ici pour l’activer. Le guide est dans <a href="https://github.com/azdak919/le-socle/blob/main/docs/extensions.md" rel="noopener">docs/extensions.md</a>.</p></div>';
    } else {
        foreach ($items as $item) $body .= socle_ext_fiche_html($item, $loaded[$item['id']] ?? null);
    }
    return socle_admin_document($lang, 'Extensions', $body);
}

function socle_ext_page_reglages(string $lang, SocleExtension $ext, ?string $message): array {
    $saved = json_decode($ext->donnees()->lire('_reglages') ?? '{}', true);
    $saved = is_array($saved) ? $saved : [];
    $body = $message !== null ? '<p class="note" role="status">' . socle_escape($message) . '</p>' : '';
    $body .= '<p class="aide">Ces réglages ne sont pas secrets. Les jetons et mots de passe se définissent sur le serveur, jamais ici.</p>';
    $body .= '<form method="post" action="/admin/extensions/' . socle_escape($ext->id()) . '/reglages" class="reglages">';
    foreach ($ext->champs as $champ) {
        $value = array_key_exists($champ['cle'], $saved) ? $saved[$champ['cle']] : $champ['defaut'];
        $name = socle_escape($champ['cle']);
        $aide = $champ['aide'] !== '' ? '<span class="aide">' . socle_escape($champ['aide']) . '</span>' : '';
        $body .= match ($champ['type']) {
            'case' => '<p><label><input type="checkbox" name="' . $name . '" value="1"' . ($value ? ' checked' : '') . '> ' . socle_escape($champ['libelle']) . '</label>' . $aide . '</p>',
            'nombre' => '<p><label class="champ">' . socle_escape($champ['libelle']) . '<input type="number" name="' . $name . '" value="' . socle_escape((string) $value) . '"></label>' . $aide . '</p>',
            'choix' => '<p><label class="champ">' . socle_escape($champ['libelle']) . '<select name="' . $name . '">' . implode('', array_map(static fn ($c): string => '<option value="' . socle_escape((string) $c) . '"' . ((string) $c === (string) $value ? ' selected' : '') . '>' . socle_escape((string) $c) . '</option>', $champ['choix'])) . '</select></label>' . $aide . '</p>',
            default => '<p><label class="champ">' . socle_escape($champ['libelle']) . '<input type="text" name="' . $name . '" value="' . socle_escape((string) $value) . '"></label>' . $aide . '</p>',
        };
    }
    $body .= '<p><button type="submit">Enregistrer</button> <a class="bouton" href="/admin/extensions">Retour aux extensions</a></p></form>';
    return socle_admin_document($lang, 'Réglages — ' . socle_escape($ext->nom()), $body);
}

/** /admin/extensions… */
function socle_ext_handle_admin(string $method, string $uri, SocleStore $store, string $raw, ?string $actor, bool $defined): array {
    socle_admin_extra_css(true);
    $path = socle_canonical_admin_path(socle_request_path($uri));
    $lang = socle_lang($uri);
    $role = socle_ext_role($store, $actor, $defined);
    if ($role === null) return socle_text(401, 'Connexion requise.');
    if ($path === '/admin/extensions/menu.json') {
        if ($method !== 'GET') return socle_result(405, '', ['allow' => 'GET']);
        return socle_result(200, socle_json(socle_ext_menu_json($store, $role)), ['content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store']);
    }
    if ($role !== 'administrateur') return socle_text(403, 'réservé à l’administrateur');
    if ($method === 'POST' && !socle_ext_meme_origine()) return socle_text(403, 'Envoi refusé : il ne vient pas de l’espace de rédaction.');
    if ($path === '/admin/extensions') {
        if ($method !== 'GET') return socle_result(405, '', ['allow' => 'GET']);
        return socle_ext_page_liste($lang, $store, null);
    }
    if (preg_match('#^/admin/extensions/([a-z][a-z0-9-]{1,39})/(activer|desactiver|reactiver|roles|reglages|taches/([a-z][a-z0-9-]{1,39}))$#', $path, $m) !== 1) return socle_result(404);
    $id = $m[1];
    $action = $m[2];
    $inventaire = socle_ext_inventaire();
    $item = $inventaire[$id] ?? null;
    if ($item === null) return socle_result(404);
    if ($item['manifeste'] === null) return $method === 'POST' ? socle_ext_page_liste($lang, $store, '« ' . $id . ' » ne peut pas être activée : ' . (string) $item['raison'] . '.') : socle_result(404);
    $nom = $item['manifeste']['nom'];
    if ($action === 'reglages') {
        $ext = socle_ext_chargees($store)[$id] ?? null;
        if ($ext === null || $ext->champs === []) return socle_result(404);
        if ($method === 'GET') return socle_ext_page_reglages($lang, $ext, null);
        if ($method !== 'POST') return socle_result(405, '', ['allow' => 'GET, POST']);
        $form = socle_form($raw);
        $values = [];
        foreach ($ext->champs as $champ) {
            $given = $form[$champ['cle']][0] ?? null;
            $values[$champ['cle']] = match ($champ['type']) {
                'case' => $given === '1',
                'nombre' => is_numeric($given) ? $given + 0 : $champ['defaut'],
                'choix' => in_array($given, array_map('strval', $champ['choix']), true) ? $given : $champ['defaut'],
                default => mb_substr(trim((string) $given), 0, 500),
            };
        }
        $ext->donnees()->ecrire('_reglages', socle_json($values));
        return socle_ext_page_reglages($lang, $ext, 'Réglages enregistrés.');
    }
    if ($method !== 'POST') return socle_result(405, '', ['allow' => 'POST']);
    if (str_starts_with($action, 'taches/')) {
        $ext = socle_ext_chargees($store)[$id] ?? null;
        if ($ext === null || !isset($ext->taches[$m[3]])) return socle_result(404);
        $done = socle_ext_lancer_tache($ext, $m[3], true);
        $message = $done['statut'] === 'ok' ? 'Tâche « ' . $m[3] . ' » faite' . ($done['message'] !== '' ? ' : ' . $done['message'] : '.') : ($done['statut'] === 'occupee' ? 'La tâche « ' . $m[3] . ' » est déjà en cours.' : 'La tâche « ' . $m[3] . ' » a échoué : ' . $done['message']);
        return socle_ext_page_liste($lang, $store, $message);
    }
    if ($action === 'roles') {
        $form = socle_form($raw);
        socle_ext_modifier(static function (array $etat) use ($id, $item, $form): array {
            $fiche = socle_ext_fiche($etat, $id);
            $roles = [];
            foreach ($item['manifeste']['roles'] as $role) $roles[$role['id']] = array_values(array_unique([...array_intersect($form[$role['id']] ?? [], SOCLE_EXT_ROLES_SOCLE), 'administrateur']));
            $fiche['roles'] = $roles;
            $etat['extensions'][$id] = $fiche;
            return $etat;
        });
        return socle_ext_page_liste($lang, $store, 'Rôles de « ' . $nom . ' » enregistrés.');
    }
    if (in_array($item['statut'], ['incompatible', 'invalide'], true) && $action !== 'desactiver') return socle_ext_page_liste($lang, $store, '« ' . $nom . ' » ne peut pas être activée : ' . (string) $item['raison'] . '.');
    socle_ext_modifier(static function (array $etat) use ($id, $action): array {
        $fiche = socle_ext_fiche($etat, $id);
        $fiche['active'] = $action !== 'desactiver';
        $fiche['coupee'] = null;
        $fiche['echecs'] = 0;
        $etat['extensions'][$id] = $fiche;
        return $etat;
    });
    socle_ext_chargees($store);
    $now = socle_ext_inventaire()[$id] ?? null;
    $message = match (true) {
        $action === 'desactiver' => '« ' . $nom . ' » est désactivée.',
        $now !== null && $now['statut'] === 'active' => '« ' . $nom . ' » est active.',
        default => '« ' . $nom . ' » n’a pas pu démarrer : ' . (string) ($now['raison'] ?? 'raison inconnue') . '.',
    };
    return socle_ext_page_liste($lang, $store, $message);
}
