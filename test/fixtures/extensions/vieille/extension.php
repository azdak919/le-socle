<?php
return function (SocleExtension $ext): void {
    $ext->menu('Accueil', '');
    $ext->page('', static fn (SocleRequete $req): string => '<p>Bonjour.</p>');
};
