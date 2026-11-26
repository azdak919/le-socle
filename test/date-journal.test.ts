import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aideHeureJournal,
  analyserDate,
  civilDepuisIso,
  civilVersIso,
  formaterHorodatage,
  libelleFuseau,
  normaliserDate,
  FUSEAU_DEFAUT,
} from "../admin/assets/date-journal.js";

const TORONTO = "America/Toronto";
const BLANC_SABLON = "America/Blanc-Sablon";

test("le fuseau par défaut est l’heure de l’Est, majoritairement le Québec", () => {
  assert.equal(FUSEAU_DEFAUT, TORONTO);
  assert.equal(libelleFuseau(TORONTO), "heure de l’Est — majorité du Québec");
  assert.equal(libelleFuseau(BLANC_SABLON), "heure de l’Atlantique — Blanc-Sablon");
  assert.equal(aideHeureJournal(TORONTO), "Heure locale du journal (heure de l’Est — majorité du Québec).");
});

test("la saisie de date s’écrit AAAA-MM-JJ, sans dépendre de la langue du navigateur", () => {
  assert.equal(normaliserDate("20260308"), "2026-03-08");
  assert.equal(normaliserDate("2026-03-08"), "2026-03-08");
  assert.equal(normaliserDate("2026/03/08"), "2026-03-08");
  assert.equal(analyserDate("2026-02-31").erreur, "Cette date n’existe pas.");
  assert.equal(analyserDate("03-08-2026").erreur?.includes("AAAA-MM-JJ"), true);
});

test("un horaire de Toronto se convertit en ISO sans utiliser le fuseau du système", () => {
  // 8 mars 2026, 1 h 30 : encore l’heure normale (UTC−5).
  const avant = civilVersIso("2026-03-08", "1", "30", TORONTO);
  assert.equal(avant.iso, "2026-03-08T06:30:00.000Z");
  assert.equal(avant.erreur, undefined);

  // 8 mars 2026, 3 h 30 : déjà l’heure avancée (UTC−4).
  const apres = civilVersIso("2026-03-08", "3", "30", TORONTO);
  assert.equal(apres.iso, "2026-03-08T07:30:00.000Z");

  const civil = civilDepuisIso("2026-03-08T07:30:00.000Z", TORONTO);
  assert.deepEqual(civil, { date: "2026-03-08", heure: "03", minute: "30" });
});

test("le 8 mars 2026 à 2 h 30 n’existe pas à Toronto (passage à l’heure avancée)", () => {
  const resultat = civilVersIso("2026-03-08", "2", "30", TORONTO);
  assert.equal(resultat.iso, undefined);
  assert.match(resultat.erreur ?? "", /n’existe pas le 8 mars 2026/);
  assert.match(resultat.erreur ?? "", /avance d’une heure/);
});

test("le 1er novembre 2026 à 1 h 30 arrive deux fois à Toronto : on retient l’heure avancée", () => {
  const resultat = civilVersIso("2026-11-01", "1", "30", TORONTO);
  // Première occurrence : encore UTC−4.
  assert.equal(resultat.iso, "2026-11-01T05:30:00.000Z");
  assert.match(resultat.ambigu ?? "", /arrive deux fois le 1er novembre 2026/);
  assert.match(resultat.ambigu ?? "", /heure avancée/);

  const minuit = civilVersIso("2026-11-01", "0", "30", TORONTO);
  assert.equal(minuit.iso, "2026-11-01T04:30:00.000Z");
  assert.equal(minuit.ambigu, undefined);

  const deuxHeures = civilVersIso("2026-11-01", "2", "30", TORONTO);
  assert.equal(deuxHeures.iso, "2026-11-01T07:30:00.000Z");
  assert.equal(deuxHeures.ambigu, undefined);
});

test("Blanc-Sablon n’observe pas l’heure avancée : 2 h 30 le 8 mars existe", () => {
  const resultat = civilVersIso("2026-03-08", "2", "30", BLANC_SABLON);
  assert.equal(resultat.iso, "2026-03-08T06:30:00.000Z");
  assert.equal(resultat.erreur, undefined);
  assert.equal(resultat.ambigu, undefined);
});

test("les champs vides ne produisent pas d’instant ; un champ seul est refusé", () => {
  assert.deepEqual(civilVersIso("", "", "", TORONTO), { iso: undefined });
  assert.match(civilVersIso("2026-03-15", "", "", TORONTO).erreur ?? "", /heures et minutes/);
  assert.match(civilVersIso("", "14", "30", TORONTO).erreur ?? "", /AAAA-MM-JJ/);
});

test("l’affichage reste en français du Québec, 24 h, même si le système est en anglais", () => {
  const texte = formaterHorodatage("2026-03-15T18:30:00.000Z", TORONTO);
  // 18:30 UTC = 14 h 30 à Toronto (heure normale).
  assert.doesNotMatch(texte, /AM|PM|am|pm/);
  assert.match(texte, /14/);
  assert.match(texte, /30/);
});
