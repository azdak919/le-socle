<?php
declare(strict_types=1);

/*
 * Bonjour — extension d'exemple du Socle (contrat d'extensions 1).
 * Copiez ce dossier dans extensions/bonjour/ sur le serveur, puis activez-la
 * dans la page Extensions. Licence : GPL version 2 seulement.
 *
 * Tout le code vit dans la fonction renvoyée : aucune fonction ni classe
 * nommée au premier niveau, pour ne jamais entrer en conflit avec le Socle.
 */

return function (SocleExtension $ext): void {
    $lecteurs = ['administrateur', 'bonjour-lecteur'];

    $ext->reglages([
        ['cle' => 'salutation', 'libelle' => 'Salutation', 'type' => 'texte', 'defaut' => 'Bonjour', 'aide' => 'Le mot affiché en tête de la page.'],
        ['cle' => 'maximum', 'libelle' => 'Nombre de notes gardées', 'type' => 'nombre', 'defaut' => 20],
    ]);

    $ext->menu('Bonjour', '', $lecteurs);

    $notes = static function () use ($ext): array {
        $saved = json_decode($ext->donnees()->lire('notes') ?? '[]', true);
        return is_array($saved) ? $saved : [];
    };

    $ext->page('', static function (SocleRequete $req) use ($ext, $notes): string {
        $e = [SocleExtension::class, 'echapper'];
        $items = '';
        foreach (array_reverse($notes()) as $note) {
            $items .= '<li>' . $e((string) $note['texte']) . ' <span class="aide">— ' . $e((string) $note['par']) . '</span></li>';
        }
        return '<p>' . $e((string) $ext->reglage('salutation')) . ', ' . $e($req->acteur ?? 'administrateur') . '.</p>'
            . ($items !== '' ? '<ul>' . $items . '</ul>' : '<p class="aide">Aucune note pour l’instant.</p>')
            . '<form method="post" action="' . $e($req->adresse('note')) . '"><p><label class="champ">Nouvelle note<input type="text" name="texte" required maxlength="200"></label></p><p><button type="submit">Ajouter</button></p></form>';
    }, $lecteurs);

    $ext->page('note', static function (SocleRequete $req) use ($ext, $notes): SocleReponse {
        $texte = trim($req->champ('texte'));
        if ($texte !== '') {
            $list = $notes();
            $list[] = ['texte' => mb_substr($texte, 0, 200), 'par' => $req->acteur ?? 'administrateur'];
            $list = array_slice($list, -max(1, (int) $ext->reglage('maximum')));
            $ext->donnees()->ecrire('notes', json_encode($list, JSON_UNESCAPED_UNICODE));
        }
        return SocleReponse::redirection($req->adresse());
    }, $lecteurs, ['POST']);

    $ext->api('GET', 'notes', static fn (SocleRequete $req): array => ['notes' => $notes()], $lecteurs);

    $ext->tache('compter', 60, static function (SocleExtension $ext) use ($notes): string {
        $count = count($notes());
        $ext->donnees()->ecrire('compte', (string) $count);
        return $count . ' note' . ($count > 1 ? 's' : '');
    });

    $ext->carte('resume', static function (SocleExtension $ext) use ($notes): array {
        $count = count($notes());
        return ['titre' => 'Bonjour', 'lignes' => [$count === 0 ? 'Aucune note.' : $count . ' note' . ($count > 1 ? 's' : '') . ' dans Bonjour.'], 'lien' => '/admin/x/bonjour', 'etat' => 'ok'];
    }, $lecteurs);
};
