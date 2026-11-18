<?php
declare(strict_types=1);

function socle_backup_dir(): string {
    return socle_env('SOCLE_BACKUP_DIR') ?? (socle_root() . '/sauvegardes');
}

function socle_upload_dir(): ?string {
    $raw = socle_env('SOCLE_UPLOAD_DIR');
    if ($raw === null || str_contains($raw, '..') || str_contains($raw, "\n") || str_contains($raw, "\r")) return null;
    return $raw;
}

function socle_major(string $version): int {
    $part = explode('.', $version)[0] ?? '0';
    return is_numeric($part) ? (int) $part : 0;
}

function socle_program_backup_name(string $from, string $to): string {
    return 'socle-' . $from . '-vers-' . $to . '.json';
}

function socle_write_program_backup(string $dir, string $from, string $to, string $at): string {
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) throw new RuntimeException('sauvegarde non écrite');
    $name = socle_program_backup_name($from, $to);
    $body = socle_json(['line' => 'socle', 'from' => $from, 'to' => $to, 'at' => $at]);
    if (file_put_contents($dir . '/' . $name, $body) === false) throw new RuntimeException('sauvegarde non écrite');
    if (file_put_contents($dir . '/latest.json', $body) === false) throw new RuntimeException('sauvegarde non écrite');
    return $name;
}

function socle_read_program_backup(string $dir): ?array {
    $path = $dir . '/latest.json';
    if (!is_file($path)) return null;
    $parsed = json_decode((string) file_get_contents($path), true);
    if (!is_array($parsed) || ($parsed['line'] ?? '') !== 'socle' || !is_string($parsed['from'] ?? null)) return null;
    return $parsed;
}

function socle_copy_tree(string $from, string $to): void {
    if (!is_dir($to) && !mkdir($to, 0775, true) && !is_dir($to)) throw new RuntimeException('dossier non préparé');
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($from, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST,
    );
    $fromReal = rtrim(str_replace('\\', '/', (string) realpath($from)), '/');
    foreach ($iterator as $item) {
        $path = str_replace('\\', '/', $item->getPathname());
        $relative = ltrim(substr($path, strlen($fromReal)), '/');
        if ($relative === '' || str_contains($relative, '..')) continue;
        $target = $to . '/' . $relative;
        if ($item->isDir()) {
            if (!is_dir($target) && !mkdir($target, 0775, true) && !is_dir($target)) throw new RuntimeException('dossier non préparé');
            continue;
        }
        if (!copy($item->getPathname(), $target)) throw new RuntimeException('dossier non préparé');
    }
}

function socle_prepare_folder(string $backupDir, string $from, string $to): string {
    $dir = $backupDir . '/socle-' . $from . '-vers-' . $to;
    if (is_dir($dir)) {
        $cleanup = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST,
        );
        foreach ($cleanup as $item) {
            if ($item->isDir()) rmdir($item->getPathname());
            else unlink($item->getPathname());
        }
    }
    socle_copy_tree(dirname(__DIR__) . '/public', $dir . '/public');
    socle_copy_tree(dirname(__DIR__) . '/src', $dir . '/src');
    return $dir;
}

function socle_admin_copy(string $lang): array {
    if ($lang === 'en') {
        return [
            'office' => 'Administration',
            'notice' => 'Turn backup on and download the archive. If the server is lost, reinstall with the Kiosque configurator and choose that archive.',
            'saveLink' => 'Backup', 'updateLink' => 'Update', 'articlesLink' => 'Articles', 'reviewLink' => 'Review',
            'mediaLink' => 'Media', 'audienceLink' => 'Audience', 'notifyLink' => 'Subscriptions',
            'saveTitle' => 'Backup', 'off' => 'Backup is off.', 'activate' => 'Turn on',
            'saveIntro' => 'Keep a copy of the journal off the server: articles, photos, team and settings, in one ZIP file. Do it before every update.',
            'yearsTitle' => 'Years in the archive',
            'yearsHelp' => 'The current year and the previous one start checked. Uncheck years already kept in an older archive: the archive gets lighter.',
            'sessionsTitle' => 'Archive of one session', 'sessionsHelp' => "Only that session's articles, without photos or settings.",
            'restored' => 'Archive restored. Reload the newsroom to see the content.',
            'restoreFailed' => 'Restore failed: make sure it is a ZIP downloaded from this page.',
            'savePrefs' => 'Save', 'downloadSite' => 'Download the full backup', 'sessionOf' => 'Session', 'articlesOnly' => 'articles only',
            'restoreHint' => '<h2>Restore a backup</h2><p class="aide">Choose a ZIP file downloaded from this page. You will first see what it contains: nothing changes until you confirm. A session backup only replaces that session’s articles. Administrator only.</p><form class="noprint" id="restaurer" data-lecture="Reading the file…" data-choisir="Choose a file first." data-apercu="What this backup contains" data-fichier="File" data-date="Backup date" data-inconnue="not given (older backup)" data-journal="Journal" data-session="One session only" data-articles="Articles" data-photos="Photos" data-sections="Sections" data-comptes="Team accounts" data-avertir="Restoring puts back this backup’s articles, photos, sections and accounts over the current content; articles written since are kept. Just before, the journal automatically keeps a copy of the current state, which you can download." data-confirmer="Restore this backup" data-annuler="Cancel" data-fait="Backup restored. Reload the newsroom to see the content." data-auto="Copy of the state before restoring:" data-telecharger="download it" data-echec="Nothing changed:"><label>Backup file (ZIP) <input type="file" name="archive" accept=".zip,application/zip" required></label> <button type="submit">Show its content</button></form><div id="restaurer-etat" role="status" tabindex="-1"></div>',
            'updateTitle' => 'Update', 'line' => 'Socle', 'installed' => 'Installed version', 'offered' => 'Offered version',
            'none' => 'No new version is prepared on this server.',
            'latest' => '<h2>Install the latest version</h2><ol><li>Download the full backup (Backup page).</li><li><a href="https://github.com/azdak919/le-socle/releases/latest/download/le-socle-php.zip">Download le-socle-php.zip</a> (what is new is on the <a href="https://github.com/azdak919/le-socle/releases/latest">latest release page</a>).</li><li>Upload the socle/ folder over the old one, without replacing donnees/.</li></ol>',
            'backupWill' => 'Program backup, before', 'notContent' => 'The journal content is not in this backup.',
            'major' => 'This version breaks something. I confirm.', 'updateBtn' => 'Update', 'revert' => 'Restore the backup',
            'done' => 'The update worked.', 'reverted' => 'The previous version is back.', 'noBackup' => 'No program backup.',
            'used' => 'Folder already in use', 'prepared' => 'Folder prepared',
        ];
    }
    return [
        'office' => 'Interface d’administration',
        'notice' => 'Allumez la sauvegarde et téléchargez l\'archive. Si le serveur est perdu, réinstallez avec le configurateur du Kiosque et choisissez cette archive.',
        'saveLink' => 'Sauvegarde', 'updateLink' => 'Mise à jour', 'articlesLink' => 'Articles', 'reviewLink' => 'Relecture',
        'mediaLink' => 'Médias', 'audienceLink' => 'Audience', 'notifyLink' => 'Abonnements',
        'saveTitle' => 'Sauvegarde', 'off' => 'La sauvegarde est éteinte.', 'activate' => 'Activer',
        'saveIntro' => 'Gardez une copie du journal hors du serveur : articles, photos, équipe et réglages, dans un seul fichier ZIP. Faites-le avant chaque mise à jour.',
        'yearsTitle' => 'Années comprises dans la sauvegarde',
        'yearsHelp' => 'L’année en cours et la précédente sont cochées au départ. Décochez les années déjà gardées dans une sauvegarde plus ancienne : le fichier sera plus léger.',
        'sessionsTitle' => 'Sauvegarde d’une session', 'sessionsHelp' => 'Seulement les articles de la session choisie, sans photos ni réglages.',
        'restored' => 'Sauvegarde restaurée. Rechargez la rédaction pour voir le contenu.',
        'restoreFailed' => 'La restauration a échoué : vérifiez que c’est bien un ZIP téléchargé sur cette page.',
        'savePrefs' => 'Garder ce choix d’années', 'downloadSite' => 'Télécharger la sauvegarde complète', 'sessionOf' => 'Session', 'articlesOnly' => 'articles seulement',
        'restoreHint' => '<h2>Restaurer une sauvegarde</h2><p class="aide">Choisissez un fichier ZIP téléchargé sur cette page. Vous verrez d’abord ce qu’il contient : rien ne change avant votre confirmation. Une sauvegarde de session ne remplace que les articles de cette session. Réservé à l’administrateur.</p><form class="noprint" id="restaurer" data-lecture="Lecture du fichier…" data-choisir="Choisissez d’abord un fichier." data-apercu="Contenu de cette sauvegarde" data-fichier="Fichier" data-date="Date de la sauvegarde" data-inconnue="non indiquée (sauvegarde ancienne)" data-journal="Journal" data-session="Session seulement" data-articles="Articles" data-photos="Photos" data-sections="Sections" data-comptes="Comptes de l’équipe" data-avertir="Restaurer remet en place les articles, les photos, les sections et les comptes de cette sauvegarde, par-dessus le contenu actuel ; les articles écrits depuis sont gardés. Juste avant, le journal garde automatiquement une copie de l’état actuel, que vous pourrez télécharger." data-confirmer="Restaurer cette sauvegarde" data-annuler="Annuler" data-fait="Sauvegarde restaurée. Rechargez la rédaction pour voir le contenu." data-auto="Copie de l’état d’avant la restauration :" data-telecharger="la télécharger" data-echec="Rien n’a changé :"><label>Fichier de sauvegarde (ZIP) <input type="file" name="archive" accept=".zip,application/zip" required></label> <button type="submit">Voir le contenu</button></form><div id="restaurer-etat" role="status" tabindex="-1"></div>',
        'updateTitle' => 'Mise à jour', 'line' => 'Socle', 'installed' => 'Version en place', 'offered' => 'Version proposée',
        'none' => 'Aucune nouvelle version n’est préparée sur ce serveur.',
        'latest' => '<h2>Installer la dernière version</h2><ol><li>Téléchargez la sauvegarde complète (page Sauvegarde).</li><li><a href="https://github.com/azdak919/le-socle/releases/latest/download/le-socle-php.zip">Téléchargez le-socle-php.zip</a> (nouveautés sur la <a href="https://github.com/azdak919/le-socle/releases/latest">page de la dernière version</a>).</li><li>Envoyez le dossier socle/ par-dessus l’ancien, sans remplacer donnees/.</li></ol>',
        'backupWill' => 'Sauvegarde du programme, avant', 'notContent' => "Le contenu du journal n'est pas dans cette sauvegarde.",
        'major' => 'Cette version casse quelque chose. Je confirme.', 'updateBtn' => 'Mettre à jour', 'revert' => 'Revenir à la sauvegarde',
        'done' => 'La mise à jour a réussi.', 'reverted' => "La version d'avant est revenue.", 'noBackup' => 'Aucune sauvegarde de programme.',
        'used' => 'Dossier déjà utilisé', 'prepared' => 'Dossier préparé',
    ];
}

function socle_handle_admin(string $method, string $url, array &$config, SocleStore $store, string $raw, ?string $actor, bool $actorDefined): array {
    $path = socle_request_path($url);
    $lang = socle_lang($url);
    $copy = socle_admin_copy($lang);
    $exportOn = (bool) $config['modules']['export'];
    $upload = socle_upload_dir();

    if ($path === '/admin' && $method === 'GET') {
        // Une seule admin : avec le module éditorial, c'est la rédaction.
        parse_str((string) (parse_url($url, PHP_URL_QUERY) ?? ''), $query);
        if ($config['modules']['editorial'] && !array_key_exists('outils', $query)) return socle_result(303, '', ['location' => '/redaction/']);
        $downloaded = $exportOn ? socle_was_downloaded($store) : false;
        $notice = !$exportOn || !$downloaded ? '<p><strong>' . $copy['notice'] . '</strong></p>' : '';
        $articlesLink = $config['modules']['editorial']
            ? '<p><a href="' . socle_with_lang('/admin/articles', $lang) . '">' . $copy['articlesLink'] . '</a></p>'
            : '';
        $reviewLink = $config['modules']['editorial'] || $config['modules']['review']
            ? '<p><a href="' . socle_with_lang('/admin/relecture', $lang) . '">' . $copy['reviewLink'] . '</a></p>'
            : '';
        $media = $config['modules']['media']
            ? '<p><a href="' . socle_with_lang('/admin/medias', $lang) . '">' . $copy['mediaLink'] . '</a></p>'
            : '';
        $audience = $config['modules']['audience']
            ? '<p><a href="' . socle_with_lang('/admin/audience', $lang) . '">' . $copy['audienceLink'] . '</a></p>'
            : '';
        $notify = $config['modules']['notify']
            ? '<p><a href="' . socle_with_lang('/admin/abonnements', $lang) . '">' . $copy['notifyLink'] . '</a></p>'
            : '';
        $body = $notice . $articlesLink . $reviewLink . $media . $audience . $notify
            . '<p><a href="' . socle_with_lang('/admin/sauvegarde', $lang) . '">' . $copy['saveLink'] . '</a></p>'
            . '<p><a href="' . socle_with_lang('/admin/mise-a-jour', $lang) . '">' . $copy['updateLink'] . '</a></p>';
        return socle_admin_document($lang, $copy['office'], $body);
    }

    if ($path === '/admin/sauvegarde/activer' && $method === 'POST') {
        $config['modules']['export'] = true;
        socle_save_config($config);
        $store->migrate(socle_enabled($config));
        return socle_result(303, '', ['location' => socle_with_lang('/admin/sauvegarde', $lang)]);
    }

    if (!$exportOn && $path !== '/admin/mise-a-jour' && !str_starts_with($path, '/admin/mise-a-jour/')) {
        if ($path === '/admin/sauvegarde' && $method === 'GET') {
            $form = '<p class="note">' . $copy['off'] . '</p><form class="noprint" method="post" action="' . socle_with_lang('/admin/sauvegarde/activer', $lang) . '"><button type="submit">' . $copy['activate'] . '</button></form>';
            return socle_admin_document($lang, $copy['saveTitle'], $form);
        }
        return socle_result(404);
    }

    if ($path === '/admin/sauvegarde' && $method === 'GET') {
        $now = socle_now();
        $prefs = socle_read_prefs($store, $now);
        $years = array_values(array_unique(array_merge(socle_default_years($now), $prefs['years'])));
        rsort($years, SORT_NUMERIC);
        $boxes = [];
        foreach ($years as $year) {
            $checked = in_array($year, $prefs['years'], true) ? ' checked' : '';
            $boxes[] = '<label><input type="checkbox" name="year" value="' . $year . '"' . $checked . '> ' . $year . '</label>';
        }
        $named = [];
        foreach (socle_sessions_in($store) as $session) {
            if (socle_is_session_name($session) && !in_array($session, SOCLE_SEASONS, true)) $named[] = $session;
        }
        $links = '';
        foreach (array_merge(SOCLE_SEASONS, $named) as $session) {
            $href = socle_with_lang('/admin/sauvegarde/session.zip?session=' . rawurlencode($session), $lang);
            $links .= '<li><a class="bouton" href="' . $href . '">' . $copy['sessionOf'] . ' ' . ($session === 'ete' ? 'été' : $session) . '</a></li>';
        }
        $body = '<p>' . $copy['saveIntro'] . '</p>
<p class="noprint"><a class="bouton principal" href="' . socle_with_lang('/admin/sauvegarde/site.zip', $lang) . '">' . $copy['downloadSite'] . '</a></p>
<h2>' . $copy['yearsTitle'] . '</h2>
<p class="aide">' . $copy['yearsHelp'] . '</p>
<form class="noprint" method="post" action="' . socle_with_lang('/admin/sauvegarde/prefs', $lang) . '"><p>' . implode(' ', $boxes) . '</p><p><button type="submit" class="secondaire">' . $copy['savePrefs'] . '</button></p></form>
<h2>' . $copy['sessionsTitle'] . '</h2>
<p class="aide">' . $copy['sessionsHelp'] . '</p>
<ul class="liens noprint">' . $links . '</ul>
' . $copy['restoreHint'] . '<script>' . socle_restore_script() . '</script>';
        return socle_admin_document($lang, $copy['saveTitle'], $body);
    }

    if ($path === '/admin/sauvegarde/prefs' && $method === 'POST') {
        if (str_contains($raw, '{')) {
            $parsed = json_decode($raw, true);
            $years = is_array($parsed) && is_array($parsed['years'] ?? null) ? array_map('intval', $parsed['years']) : [];
        } else {
            $form = socle_form($raw);
            $years = array_map('intval', $form['year'] ?? []);
        }
        socle_write_prefs($store, $years);
        return socle_result(303, '', ['location' => socle_with_lang('/admin/sauvegarde', $lang)]);
    }

    if ($path === '/admin/sauvegarde/site.zip' && $method === 'GET') {
        $zip = socle_build_site_zip($store, socle_now());
        socle_mark_downloaded($store);
        return socle_result(200, $zip, ['content-type' => 'application/zip']);
    }

    if ($path === '/admin/sauvegarde/session.zip' && $method === 'GET') {
        $query = [];
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
        $session = (string) ($query['session'] ?? '');
        if (!socle_is_session_name($session)) return socle_text(400, 'session inconnue');
        $zip = socle_build_session_zip($store, $session);
        socle_mark_downloaded($store);
        return socle_result(200, $zip, ['content-type' => 'application/zip']);
    }

    // Restauration en deux temps : 1) le serveur lit l'archive et en donne le résumé
    // (rien n'est écrit), 2) après confirmation, il garde une copie de l'état actuel
    // puis restaure. Réservé à l'administrateur (socle_admin_gate).
    if ($path === '/admin/sauvegarde/restaurer/apercu' && $method === 'POST') {
        try {
            $summary = socle_archive_summary($raw);
        } catch (Throwable $error) {
            return socle_result(400, socle_json(['error' => $error->getMessage()]), ['content-type' => 'application/json; charset=utf-8']);
        }
        return socle_result(200, socle_json(['jeton' => socle_restore_stash($raw), 'resume' => $summary]), ['content-type' => 'application/json; charset=utf-8']);
    }

    if ($path === '/admin/sauvegarde/restaurer' && $method === 'POST') {
        $json = ['content-type' => 'application/json; charset=utf-8'];
        try {
            $parsed = str_starts_with(ltrim($raw), '{') ? json_decode($raw, true) : null;
            $bytes = is_array($parsed) ? socle_restore_unstash((string) ($parsed['jeton'] ?? '')) : $raw;
            socle_archive_summary($bytes);
            $auto = socle_auto_backup($store, socle_now());
            $report = socle_restore_zip($store, $bytes);
        } catch (Throwable $error) {
            return socle_result(400, socle_json(['error' => $error->getMessage()]), $json);
        }
        return socle_result(200, socle_json($report + ['sauvegardeAuto' => $auto]), $json);
    }

    if (preg_match('#^/admin/sauvegarde/auto/(avant-restauration-[0-9-]+\.zip)$#', $path, $match) && $method === 'GET') {
        $file = socle_data_dir('sauvegardes-auto') . '/' . $match[1];
        if (!is_file($file)) return socle_result(404);
        return socle_result(200, (string) file_get_contents($file), ['content-type' => 'application/zip', 'content-disposition' => 'attachment; filename="' . $match[1] . '"']);
    }

    if ($path === '/admin/mise-a-jour' && $method === 'GET' && socle_paquet() !== null) {
        parse_str((string) (parse_url($url, PHP_URL_QUERY) ?? ''), $query);
        return socle_paquet_page($lang, socle_may_update($store, $actor, $actorDefined), array_key_exists('verifier', $query), null);
    }

    // Recharger la page après une mise à jour refait un GET : on revient à la page Mise à jour au lieu d'une page blanche.
    if (($path === '/admin/mise-a-jour/paquet' || $path === '/admin/mise-a-jour/paquet/revenir') && $method === 'GET') {
        return socle_result(303, '', ['location' => socle_with_lang('/admin/mise-a-jour', $lang)]);
    }

    if (($path === '/admin/mise-a-jour/paquet' || $path === '/admin/mise-a-jour/paquet/revenir') && $method === 'POST') {
        if (!socle_may_update($store, $actor, $actorDefined)) return socle_text(403, 'réservé à l’administrateur');
        if (socle_paquet() === null) return socle_text(409, 'ce paquet ne sait pas se mettre à jour seul');
        $en = $lang === 'en';
        try {
            if ($path === '/admin/mise-a-jour/paquet') {
                $done = socle_maj_apply();
                $message = $en ? 'Updated from ' . $done['from'] . ' to ' . $done['to'] . '. Program backup: ' . $done['backup'] . '.'
                    : 'Mise à jour faite : ' . $done['from'] . ' → ' . $done['to'] . '. Sauvegarde du programme : ' . $done['backup'] . '. Ouvrez le journal et la rédaction pour vérifier ; en cas de souci, revenez à la version précédente ci-dessous.';
            } else {
                $done = socle_maj_revert();
                $message = $en ? 'Back to ' . $done['to'] . '.' : 'Retour fait : la version ' . $done['to'] . ' est revenue. Les articles écrits depuis sont gardés.';
            }
        } catch (Throwable $error) {
            $message = ($en ? 'Nothing changed: ' : 'Rien n’a changé : ') . $error->getMessage() . '.';
        }
        return socle_paquet_page($lang, true, false, $message);
    }

    if ($path === '/admin/mise-a-jour' && $method === 'GET') {
        return socle_update_page($lang, $copy, $store, $actor, $actorDefined, $upload, null);
    }

    if ($path === '/admin/mise-a-jour' && $method === 'POST') {
        if (!socle_may_update($store, $actor, $actorDefined)) return socle_text(403, 'réservé à l’administrateur');
        $offered = socle_release();
        if ($offered === null) return socle_text(409, 'rien à mettre à jour');
        $params = socle_form($raw);
        if (socle_major($offered['version']) !== socle_major(socle_installed_version()) && (($params['confirmMajor'][0] ?? '') !== '1')) {
            return socle_text(409, 'version majeure en attente');
        }
        $previous = socle_installed_version();
        $prepared = null;
        try {
            socle_write_program_backup(socle_backup_dir(), $previous, $offered['version'], socle_iso(socle_now()));
            if ($upload !== null) $prepared = socle_prepare_folder(socle_backup_dir(), $previous, $offered['version']);
            socle_set_version($offered['version']);
        } catch (Throwable) {
            return socle_text(500, $previous);
        }
        $extra = '';
        if ($upload !== null && $prepared !== null) {
            $extra = '<p>' . $copy['used'] . ' : ' . socle_escape($upload) . '.</p><p>' . $copy['prepared'] . ' : ' . socle_escape($prepared) . '.</p>';
        }
        return socle_admin_document($lang, $copy['updateTitle'], '<p class="note">' . $copy['done'] . '</p><dl class="fiche"><dt>' . $copy['installed'] . '</dt><dd>' . socle_installed_version() . '</dd></dl>' . $extra);
    }

    if ($path === '/admin/mise-a-jour/revenir' && $method === 'POST') {
        if (!socle_may_update($store, $actor, $actorDefined)) return socle_text(403, 'réservé à l’administrateur');
        $saved = socle_read_program_backup(socle_backup_dir());
        if ($saved === null) return socle_text(409, $copy['noBackup']);
        $previous = socle_installed_version();
        try {
            socle_set_version((string) $saved['from']);
        } catch (Throwable) {
            return socle_text(500, $previous);
        }
        return socle_admin_document($lang, $copy['updateTitle'], '<p class="note">' . $copy['reverted'] . '</p><dl class="fiche"><dt>' . $copy['installed'] . '</dt><dd>' . socle_installed_version() . '</dd></dl>');
    }

    return socle_result(404);
}

/** Script de restauration en deux temps, partagé avec Node (admin/assets/restauration.js). */
function socle_restore_script(): string {
    return str_replace('</', '<\\/', (string) file_get_contents(dirname(__DIR__, 2) . '/admin/assets/restauration.js'));
}

/** Page Mise à jour d'un paquet complet : vérifier, mettre à jour, revenir. */
function socle_paquet_page(string $lang, bool $allowed, bool $check, ?string $message): array {
    $en = $lang === 'en';
    $t = $en
        ? ['title' => 'Update', 'version' => 'Journal version', 'latest' => 'Latest published version', 'check' => 'Check for a new version', 'uptodate' => 'The journal is up to date.', 'cannot' => 'Could not check', 'news' => 'What is new', 'safe' => 'Before installing, the journal keeps a copy of the program and of the database in donnees/mises-a-jour/. Articles, photos and accounts are not touched.', 'go' => 'Update to', 'back' => 'Go back to version', 'admin' => 'Only the administrator can update.', 'manual' => '<h2>By hand (if the button fails)</h2><ol><li>Download the full backup (Backup page).</li><li>Download the latest package (link below).</li><li>Upload its journal/ folder over this one, without replacing donnees/.</li></ol>', 'download' => 'Download the latest package']
        : ['title' => 'Mise à jour', 'version' => 'Version du journal', 'latest' => 'Dernière version publiée', 'check' => 'Vérifier s’il y a une nouvelle version', 'uptodate' => 'Le journal est à jour.', 'cannot' => 'Vérification impossible', 'news' => 'Nouveautés', 'safe' => 'Avant d’installer, le journal garde une copie du programme et de la base dans donnees/mises-a-jour/. Les articles, les photos et les comptes ne sont pas touchés.', 'go' => 'Mettre à jour vers la version', 'back' => 'Revenir à la version', 'admin' => 'Seul l’administrateur peut mettre à jour.', 'manual' => '<h2>À la main (si le bouton échoue)</h2><ol><li>Téléchargez la sauvegarde complète (page Sauvegarde).</li><li>Téléchargez le dernier paquet (lien ci-dessous).</li><li>Envoyez son dossier journal/ par-dessus celui-ci, sans remplacer donnees/.</li></ol>', 'download' => 'Télécharger le dernier paquet'];
    $paquet = socle_paquet() ?? [];
    $current = socle_paquet_version();
    $offer = null;
    $error = null;
    try {
        $cache = socle_maj_dir() . '/derniere-version.json';
        if ($check || is_file($cache)) $offer = socle_maj_offer($check);
    } catch (Throwable $failure) {
        $error = $failure->getMessage();
    }
    $body = $message !== null ? '<p class="note" role="status">' . socle_escape($message) . '</p>' : '';
    $current = socle_paquet_version();
    $body .= '<dl class="fiche"><dt>' . $t['version'] . '</dt><dd>' . socle_escape($current) . '</dd>';
    if ($offer !== null) $body .= '<dt>' . $t['latest'] . '</dt><dd><a href="' . socle_escape($offer['page']) . '" rel="noopener">' . socle_escape($offer['version']) . '</a></dd>';
    $body .= '</dl>';
    if ($error !== null) $body .= '<p class="note">' . $t['cannot'] . ' : ' . socle_escape($error) . '.</p>';
    if (!$allowed) {
        $body .= '<p class="aide">' . $t['admin'] . '</p>';
    } elseif ($offer !== null && socle_version_newer($offer['version'], $current)) {
        if (trim($offer['notes']) !== '') $body .= '<details><summary>' . $t['news'] . '</summary><pre style="white-space:pre-wrap">' . socle_escape($offer['notes']) . '</pre></details>';
        $body .= '<p class="aide">' . $t['safe'] . '</p><form class="noprint" method="post" action="' . socle_with_lang('/admin/mise-a-jour/paquet', $lang) . '"><button type="submit">' . $t['go'] . ' ' . socle_escape($offer['version']) . '</button></form>';
    } else {
        if ($offer !== null) $body .= '<p class="note">' . $t['uptodate'] . '</p>';
        $body .= '<form class="noprint" method="get" action="' . socle_with_lang('/admin/mise-a-jour', $lang) . '"><input type="hidden" name="verifier" value="1"><button type="submit" class="secondaire">' . $t['check'] . '</button></form>';
    }
    $history = [];
    try { $history = socle_maj_history(); } catch (Throwable) {}
    $last = end($history);
    if ($allowed && is_array($last) && is_string($last['sauvegarde'] ?? null)) {
        $body .= '<form class="noprint" method="post" action="' . socle_with_lang('/admin/mise-a-jour/paquet/revenir', $lang) . '"><button type="submit" class="secondaire">' . $t['back'] . ' ' . socle_escape((string) ($last['de'] ?? '')) . '</button></form>';
    }
    $depot = (string) ($paquet['depot'] ?? '');
    $file = (string) ($paquet['fichier'] ?? '');
    $body .= "\n" . $t['manual'] . '<p><a href="https://github.com/' . socle_escape($depot) . '/releases/latest/download/' . socle_escape($file) . '">' . $t['download'] . '</a></p>';
    return socle_admin_document($lang, $t['title'], $body);
}

function socle_update_page(string $lang, array $copy, SocleStore $store, ?string $actor, bool $actorDefined, ?string $upload, ?string $prepared): array {
    $current = socle_installed_version();
    $offered = socle_release();
    $offer = $offered !== null
        ? '<dt>' . $copy['offered'] . '</dt><dd>' . $offered['version'] . '</dd></dl><p>' . $offered['notes'] . '</p>'
        : '</dl><p class="aide">' . $copy['none'] . '</p>';
    $major = $offered !== null && socle_major($offered['version']) !== socle_major($current);
    $extra = $major ? '<label><input type="checkbox" name="confirmMajor" value="1"> ' . $copy['major'] . '</label>' : '';
    $named = $offered !== null ? socle_program_backup_name($current, $offered['version']) : '';
    $backup = $offered !== null
        ? '<p class="note">' . $copy['backupWill'] . ' : ' . $named . '. ' . $copy['notContent'] . '</p>'
        : '';
    $saved = socle_read_program_backup(socle_backup_dir());
    $allowed = socle_may_update($store, $actor, $actorDefined);
    $revert = $allowed && $saved !== null
        ? '<form class="noprint" method="post" action="' . socle_with_lang('/admin/mise-a-jour/revenir', $lang) . '"><button type="submit" class="secondaire">' . $copy['revert'] . '</button></form>'
        : '';
    $form = $allowed && $offered !== null
        ? '<form class="noprint" method="post" action="' . socle_with_lang('/admin/mise-a-jour', $lang) . '">
' . $extra . '
<p><button type="submit" name="confirm" value="1">' . $copy['updateBtn'] . '</button></p>
</form>'
        : '';
    $place = '';
    if ($upload !== null) $place = '<p>' . $copy['used'] . ' : ' . socle_escape($upload) . '.</p>';
    if ($prepared !== null) $place .= '<p>' . $copy['prepared'] . ' : ' . socle_escape($prepared) . '.</p>';
    $body = '<dl class="fiche"><dt>' . $copy['installed'] . '</dt><dd>' . $current . '</dd>' . $offer . $backup . '
' . $form . '
' . $revert . $place . "\n" . $copy['latest'];
    return socle_admin_document($lang, $copy['updateTitle'], $body);
}

/**
 * Porte des pages /admin, miroir de src/admin-gate.ts : avec auth, une
 * session et un rôle ; la sauvegarde à l’administrateur ; le formulaire
 * d’article sans JavaScript aux réviseurs, éditeurs et à l’administrateur.
 * Sans auth : seulement depuis la machine du socle.
 */
function socle_admin_gate(string $method, string $path, array $config, SocleStore $store, ?string $actor, bool $defined): ?array {
    if ($path !== '/admin' && !str_starts_with($path, '/admin/')) return null;
    if (!$defined) {
        return socle_redaction_local() ? null : socle_text(403, "Sans le module auth, l'administration ne s'ouvre que depuis la machine du socle.");
    }
    if ($actor === null || $actor === '') {
        if ($method === 'GET' && $config['modules']['editorial']) return socle_result(303, '', ['location' => '/redaction/', 'cache-control' => 'no-store']);
        return socle_text(401, 'Connexion requise.');
    }
    $role = socle_role_of($store, $actor);
    if ($role === null) return socle_text(403, "Ce compte n'a pas de rôle dans la rédaction.");
    if (str_starts_with($path, '/admin/sauvegarde') && $role !== 'administrateur') return socle_text(403, 'réservé à l’administrateur');
    if (str_starts_with($path, '/admin/articles') && $method !== 'GET' && !in_array($role, ['reviseur', 'editeur', 'administrateur'], true)) {
        return socle_text(403, 'Publier sans JavaScript demande un réviseur, un éditeur ou l’administrateur ; passez par la rédaction.');
    }
    return null;
}
