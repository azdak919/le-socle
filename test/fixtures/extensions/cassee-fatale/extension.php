<?php
// Redéclare une fonction du Socle : erreur fatale de PHP, impossible à attraper.
function socle_json(mixed $value): string { return ''; }
return function (SocleExtension $ext): void {};
