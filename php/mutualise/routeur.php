<?php
declare(strict_types=1);

/**
 * Routeur du serveur intégré de PHP.
 *
 * À la racine du journal (le dossier qui contient index.php) :
 *
 *   php -S 127.0.0.1:8080 routeur.php
 *
 * Sans ce fichier, « php -S » sert les fichiers tels quels : le dossier
 * donnees/ (la base SQLite) serait téléchargeable, et les pages Sauvegarde
 * et Mise à jour pourraient tomber sur une page introuvable, parce que le
 * dossier admin/ sur le disque fausse le préfixe détecté.
 */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$path = rawurldecode(is_string($path) && $path !== '' ? $path : '/');

if (preg_match('#(^|/)(donnees|php|extensions)(/|$)#i', $path) || preg_match('#\.(sqlite|sqlite3)$#i', $path)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo "interdit\n";
    return true;
}

$_SERVER['SOCLE_ROUTEUR'] = '1';
putenv('SOCLE_ROUTEUR=1');
$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/index.php';
return true;
