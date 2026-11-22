<?php
declare(strict_types=1);

const SOCLE_INSTALL_CODE_KEY = 'install-code';
const SOCLE_INSTALL_CODE_FILE = 'code-installation.txt';
const SOCLE_INSTALL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function socle_inventer_code_installation(): string {
    $bytes = random_bytes(8);
    $code = '';
    $len = strlen(SOCLE_INSTALL_ALPHABET);
    for ($i = 0; $i < 8; $i++) $code .= SOCLE_INSTALL_ALPHABET[ord($bytes[$i]) % $len];
    return substr($code, 0, 4) . '-' . substr($code, 4);
}

function socle_dossier_des_donnees(): string {
    $explicit = socle_env('SOCLE_INSTALL_CODE_FILE');
    if ($explicit !== null) return dirname($explicit);
    $db = socle_env('SOCLE_DB');
    if ($db !== null) return dirname($db);
    return socle_root() . '/donnees';
}

function socle_chemin_fichier_code(): string {
    $explicit = socle_env('SOCLE_INSTALL_CODE_FILE');
    return $explicit !== null ? $explicit : (socle_dossier_des_donnees() . '/' . SOCLE_INSTALL_CODE_FILE);
}

function socle_peut_ecrire_fichier_code(): bool {
    if (socle_env('SOCLE_INSTALL_CODE_FILE') !== null) return true;
    $db = socle_env('SOCLE_DB');
    if ($db === ':memory:' || ($db !== null && str_contains($db, '://'))) return false;
    return true;
}

function socle_ecrire_fichier_code(string $code): void {
    if (!socle_peut_ecrire_fichier_code()) return;
    $file = socle_chemin_fichier_code();
    $dir = dirname($file);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) return;
    $body = "Code d’installation du journal (à usage unique)\n\n"
        . "Ce code est demandé à la première ouverture de l’espace de rédaction,\n"
        . "pour créer le compte administrateur. Ne le mettez pas dans un dossier\n"
        . "visible du Web. Après l’installation, ce fichier est retiré.\n\n"
        . $code . "\n";
    @file_put_contents($file, $body);
    @chmod($file, 0600);
}

/** @return array{code:string,created:bool} */
function socle_assurer_code_installation(SocleStore $store): array {
    $known = $store->get('auth', SOCLE_INSTALL_CODE_KEY);
    if (is_string($known) && trim($known) !== '') {
        $code = trim($known);
        if (!is_file(socle_chemin_fichier_code())) socle_ecrire_fichier_code($code);
        return ['code' => $code, 'created' => false];
    }
    $fromEnv = socle_env('SOCLE_INSTALL_CODE');
    $code = ($fromEnv !== null && preg_match('/^[A-Z0-9-]{6,20}$/i', $fromEnv))
        ? strtoupper($fromEnv)
        : socle_inventer_code_installation();
    $store->put('auth', SOCLE_INSTALL_CODE_KEY, $code);
    socle_ecrire_fichier_code($code);
    error_log('Socle : code d’installation (donnees/code-installation.txt) : ' . $code);
    return ['code' => $code, 'created' => true];
}

function socle_verifier_code_installation(SocleStore $store, mixed $brut): void {
    $attendu = socle_assurer_code_installation($store)['code'];
    $donne = strtoupper(trim((string) $brut));
    if ($donne === '' || $donne !== strtoupper($attendu)) {
        throw new SocleHttp('Ce code d’installation n’est pas le bon. Il se trouve dans le fichier donnees/code-installation.txt, sur le serveur.');
    }
}

function socle_retirer_code_installation(SocleStore $store): void {
    $store->delete('auth', SOCLE_INSTALL_CODE_KEY);
    $file = socle_chemin_fichier_code();
    if (is_file($file)) @unlink($file);
}

function socle_via_routeur(): bool {
    return socle_env('SOCLE_ROUTEUR') === '1' || (($_SERVER['SOCLE_ROUTEUR'] ?? '') === '1');
}

function socle_avis_donnees_exposees(): ?string {
    $data = realpath(socle_dossier_des_donnees()) ?: socle_dossier_des_donnees();
    $web = realpath(socle_root()) ?: socle_root();
    $data = rtrim(str_replace('\\', '/', $data), '/');
    $web = rtrim(str_replace('\\', '/', $web), '/');
    $inside = $data === $web || str_starts_with($data, $web . '/');
    if (!$inside) return null;
    if (socle_via_routeur()) return null;
    if (PHP_SAPI === 'cli-server') {
        return 'Le dossier des données est dans l’espace Web, et le serveur intégré de PHP tourne sans le fichier routeur.php : la base pourrait être téléchargeable. Arrêtez le serveur et, dans le dossier du journal, lancez : php -S 127.0.0.1:8080 routeur.php';
    }
    $htaccess = is_file($data . '/.htaccess');
    if (!$htaccess) {
        return 'Le dossier des données est dans l’espace Web, mais le fichier qui l’interdit au public (.htaccess) est absent. Placez les données hors de la racine web, ou remettez ce fichier, ou demandez à l’informatique de fermer ce dossier.';
    }
    return null;
}

function socle_slug_auteur(string $name): string {
    if (function_exists('socle_slug_from')) {
        $slug = socle_slug_from($name);
        return $slug !== '' ? $slug : 'auteur';
    }
    $ascii = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name) ?: $name;
    $slug = strtolower((string) preg_replace('/[^a-z0-9]+/i', '-', $ascii));
    $slug = trim($slug, '-');
    return $slug !== '' ? $slug : 'auteur';
}

/** Crée (ou retrouve) l’auteur lié au compte, et renvoie son nom court. */
function socle_assurer_auteur_du_compte(SocleStore $store, string $email, string $nom, DateTimeImmutable $now): ?string {
    $lien = $store->get('auth', 'auteur-compte:' . $email);
    if (is_string($lien) && $lien !== '') return $lien;
    $affiche = trim($nom) !== '' ? trim($nom) : 'La rédaction';
    $slugBase = socle_slug_auteur($affiche);
    $slug = $slugBase;
    $n = 2;
    while (true) {
        $exists = false;
        foreach (socle_read_kind($store, 'author:') as $auteur) {
            if (($auteur['slug'] ?? '') === $slug) { $exists = true; break; }
        }
        if (!$exists) break;
        $slug = $slugBase . '-' . $n;
        $n++;
    }
    $id = socle_uuid();
    $auteur = [
        'id' => $id,
        'slug' => $slug,
        'name' => $affiche,
        'source' => ['backend' => 'socle', 'backendId' => $id, 'fetchedAt' => socle_iso($now)],
    ];
    $store->put('editorial', 'author:' . $id, socle_json($auteur));
    $store->put('auth', 'auteur-compte:' . $email, $slug);
    return $slug;
}

/** Sur un article publié sans auteur, rattache l’auteur du compte. */
function socle_signer_article_si_besoin(SocleStore $store, array &$article, ?string $actor): void {
    $status = $article['status'] ?? '';
    if ($status !== 'published' && $status !== 'archived') return;
    if (!is_array($article['authors'] ?? null) || $article['authors'] !== []) return;
    if ($actor === null || $actor === '') return;
    $names = function_exists('socle_parse_stored_profile')
        ? socle_parse_stored_profile($store->get('auth', 'profil:' . $actor))
        : ['prenom' => '', 'nom' => '', 'nomAffiche' => ''];
    $nom = function_exists('socle_nom_pour_affichage') ? socle_nom_pour_affichage($names) : '';
    $slug = socle_assurer_auteur_du_compte($store, $actor, $nom !== '' ? $nom : 'La rédaction', socle_now());
    if (is_string($slug) && $slug !== '') $article['authors'] = [$slug];
}
