<?php
return function (SocleExtension $ext): void {
    $ext->menu('Cassée', '');
    throw new RuntimeException('réglage obligatoire absent');
};
