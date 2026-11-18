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
            'office' => 'Back office',
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
            'restoreHint' => '<h2>Restore an archive</h2><p class="aide">Choose a ZIP downloaded from this page. A session archive only replaces its articles.</p><form class="noprint" id="restaurer"><input type="file" name="archive" accept=".zip,application/zip" required> <button type="submit">Restore</button></form><p id="restaurer-etat" role="status"></p>',
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
        'office' => 'Back-office',
        'notice' => 'Allumez la sauvegarde et téléchargez l\'archive. Si le serveur est perdu, réinstallez avec le configurateur du Kiosque et choisissez cette archive.',
        'saveLink' => 'Sauvegarde', 'updateLink' => 'Mise à jour', 'articlesLink' => 'Articles', 'reviewLink' => 'Relecture',
        'mediaLink' => 'Médias', 'audienceLink' => 'Audience', 'notifyLink' => 'Abonnements',
        'saveTitle' => 'Sauvegarde', 'off' => 'La sauvegarde est éteinte.', 'activate' => 'Activer',
        'saveIntro' => 'Gardez une copie du journal hors du serveur : articles, photos, équipe et réglages, dans un seul fichier ZIP. Faites-le avant chaque mise à jour.',
        'yearsTitle' => 'Années comprises dans l’archive',
        'yearsHelp' => 'L’année en cours et la précédente sont cochées au départ. Décochez les années déjà gardées dans une archive plus ancienne : l’archive sera plus légère.',
        'sessionsTitle' => 'Archive d’une session', 'sessionsHelp' => 'Seulement les articles de la session choisie, sans photos ni réglages.',
        'restored' => 'Archive restaurée. Rechargez la rédaction pour voir le contenu.',
        'restoreFailed' => 'La restauration a échoué : vérifiez que c’est bien un ZIP téléchargé sur cette page.',
        'savePrefs' => 'Enregistrer', 'downloadSite' => 'Télécharger la sauvegarde complète', 'sessionOf' => 'Session', 'articlesOnly' => 'articles seulement',
        'restoreHint' => '<h2>Restaurer une archive</h2><p class="aide">Choisissez un ZIP téléchargé sur cette page. Une archive de session ne remplace que ses articles.</p><form class="noprint" id="restaurer"><input type="file" name="archive" accept=".zip,application/zip" required> <button type="submit">Restaurer</button></form><p id="restaurer-etat" role="status"></p>',
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

    if (!$exportOn && $path !== '/admin/mise-a-jour' && $path !== '/admin/mise-a-jour/revenir') {
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
' . $copy['restoreHint'] . '<script>document.getElementById(\'restaurer\').onsubmit=async function(e){e.preventDefault();var f=this.archive.files[0];if(!f)return;var s=document.getElementById(\'restaurer-etat\');s.textContent=\'…\';var r=await fetch(location.pathname+\'/restaurer\'+location.search,{method:\'POST\',headers:{\'content-type\':\'application/zip\'},body:f});var t=await r.text();s.textContent=r.ok?' . json_encode($copy['restored'], JSON_UNESCAPED_UNICODE) . ':' . json_encode($copy['restoreFailed'], JSON_UNESCAPED_UNICODE) . '+\' (\'+r.status+\')\';};</script>';
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

    if ($path === '/admin/sauvegarde/restaurer' && $method === 'POST') {
        $report = socle_restore_zip($store, $raw);
        return socle_result(200, socle_json($report), ['content-type' => 'application/json; charset=utf-8']);
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
