<?php
declare(strict_types=1);

/*
 * Le Socle — point d'entrée pour un hébergement mutualisé (serveur du cégep,
 * hébergeur PHP). Déposez le dossier `socle/` tel quel, ouvrez
 * https://votre-site/…/socle/redaction/ et créez le compte administrateur.
 *
 * Choix par défaut, chacun remplaçable par une variable d'environnement :
 * connexion par mot de passe, données dans `donnees/` (protégé).
 */
foreach ([
    'SOCLE_AUTH_MODE' => 'motdepasse',
    'SOCLE_CONFIG' => __DIR__ . '/donnees/socle.config.json',
    'SOCLE_DB' => __DIR__ . '/donnees/socle.sqlite',
] as $name => $value) {
    if (getenv($name) === false || getenv($name) === '') putenv($name . '=' . $value);
}

require_once __DIR__ . '/php/src/bootstrap.php';

// Premier passage (ou module allumé depuis) : créer les tables, sans console.
try {
    $store = socle_open_store();
    if ($store !== null) {
        $wanted = socle_enabled(socle_load_config());
        if (array_diff($wanted, $store->applied()) !== []) $store->migrate($wanted);
    }
} catch (Throwable $error) {
    error_log($error->getMessage());
}

socle_front();
