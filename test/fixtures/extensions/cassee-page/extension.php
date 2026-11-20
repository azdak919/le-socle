<?php
return function (SocleExtension $ext): void {
    $ext->menu('En erreur', '');
    $ext->page('', static function (SocleRequete $req): string { throw new RuntimeException('base distante injoignable'); });
};
