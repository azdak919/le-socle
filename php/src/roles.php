<?php
declare(strict_types=1);

/**
 * Droits de la rédaction, miroir de src/roles.ts.
 * auteur : articles non publics, dans ses rubriques s’il en a ;
 * photographe : banque de photos seulement ;
 * reviseur, editeur, administrateur : relisent et publient partout ;
 * chef-pupitre : relit et publie dans ses rubriques (toutes si aucune).
 */

const SOCLE_ROLES = ['auteur', 'photographe', 'reviseur', 'chef-pupitre', 'editeur', 'administrateur'];
const SOCLE_EDITORS = ['reviseur', 'editeur', 'administrateur'];
const SOCLE_SCOPED = ['auteur', 'chef-pupitre'];

function socle_is_editor(?string $role): bool {
    return $role !== null && in_array($role, SOCLE_EDITORS, true);
}

function socle_writes_articles(?string $role): bool {
    return $role !== null && $role !== 'photographe';
}

function socle_manages_bank(?string $role): bool {
    return $role === 'photographe' || socle_is_editor($role);
}

/** Liste vide = toutes les rubriques. */
function socle_in_scope(array $scope, ?string $section, ?string $sectionSlug = null): bool {
    if ($scope === []) return true;
    if (($section ?? '') === '' && ($sectionSlug ?? '') === '') return false;
    return in_array($section ?? '', $scope, true) || ($sectionSlug !== null && in_array($sectionSlug, $scope, true));
}

function socle_publishes_in(?string $role, bool $sectionInScope): bool {
    if (socle_is_editor($role)) return true;
    return $role === 'chef-pupitre' && $sectionInScope;
}

function socle_clean_scope(mixed $value): array {
    if (!is_array($value)) return [];
    $out = [];
    foreach ($value as $item) {
        if (!is_string($item)) continue;
        $clean = substr(trim($item), 0, 96);
        if (preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]*$/', $clean) === 1 && !in_array($clean, $out, true)) $out[] = $clean;
        if (count($out) >= 50) break;
    }
    return $out;
}
