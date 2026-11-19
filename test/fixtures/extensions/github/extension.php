<?php
return function (SocleExtension $ext): void {
    $ext->menu('Pilote', '');
    $ext->page('', static fn (SocleRequete $req): string => '<form method="post" action="' . $req->adresse('lancer') . '"><button type="submit">Relancer</button></form>');
    $ext->page('lancer', static function (SocleRequete $req) use ($ext): string {
        $gh = $ext->github();
        $gh->declencher('exemple/radar', 'update-news.yml', 'main', ['dry_run' => true]);
        $runs = $gh->executions('exemple/radar', 'update-news.yml', 2);
        $pr = $gh->proposerPR('exemple/radar', 'main', 'socle/sources-essai', 'Corriger une source', 'Proposé depuis l’espace de rédaction.', ['news-sources.json' => "{\"ok\":true}\n"]);
        try {
            $gh->proposerPR('exemple/radar', 'main', 'main', 'Interdit', '', ['a.json' => '{}']);
            $refus = 'non';
        } catch (SocleGitHubErreur $error) {
            $refus = 'oui';
        }
        return '<p data-runs="' . count($runs) . '" data-pr="' . $pr['numero'] . '" data-refus-main="' . $refus . '">Fait.</p>';
    }, ['administrateur'], ['POST']);
};
