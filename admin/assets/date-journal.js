/**
 * Date et heure du journal, au format québécois, dans le fuseau du journal
 * (pas celui du navigateur). Les instants restent en ISO (UTC) à l’enregistrement.
 */

export const FUSEAU_DEFAUT = 'America/Toronto';

const LIBELLES_FUSEAU = {
  'America/Toronto': 'heure de l’Est — majorité du Québec',
  'America/Blanc-Sablon': 'heure de l’Atlantique — Blanc-Sablon',
};

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

export function libelleFuseau(timeZone) {
  const zone = timeZone || FUSEAU_DEFAUT;
  return LIBELLES_FUSEAU[zone] || `fuseau ${zone}`;
}

export function aideHeureJournal(timeZone) {
  return `Heure locale du journal (${libelleFuseau(timeZone)}).`;
}

function partiesZone(instant, timeZone) {
  const formateur = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parties = {};
  for (const part of formateur.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parties[part.type] = part.value;
  }
  return parties;
}

/** Décalage de la zone à cet instant : civil = UTC + décalage. */
export function decalageMs(instant, timeZone) {
  const parties = partiesZone(instant, timeZone);
  const commeUtc = Date.UTC(
    Number(parties.year),
    Number(parties.month) - 1,
    Number(parties.day),
    Number(parties.hour),
    Number(parties.minute),
    Number(parties.second),
  );
  return commeUtc - instant;
}

export function civilDepuisIso(iso, timeZone) {
  if (!iso) return { date: '', heure: '', minute: '' };
  const temps = Date.parse(iso);
  if (Number.isNaN(temps)) return { date: '', heure: '', minute: '' };
  const parties = partiesZone(temps, timeZone || FUSEAU_DEFAUT);
  return {
    date: `${parties.year}-${parties.month}-${parties.day}`,
    heure: parties.hour,
    minute: parties.minute,
  };
}

/** Insère les tirets AAAA-MM-JJ au fil de la saisie. */
export function normaliserDate(texte) {
  const chiffres = String(texte || '').replace(/\D/g, '').slice(0, 8);
  if (chiffres.length <= 4) return chiffres;
  if (chiffres.length <= 6) return `${chiffres.slice(0, 4)}-${chiffres.slice(4)}`;
  return `${chiffres.slice(0, 4)}-${chiffres.slice(4, 6)}-${chiffres.slice(6)}`;
}

export function analyserDate(texte) {
  const brut = String(texte || '').trim();
  if (!brut) return { vide: true };
  const correspondance = /^(\d{4})-(\d{2})-(\d{2})$/.exec(brut);
  if (!correspondance) return { erreur: 'Indiquez la date au format AAAA-MM-JJ, par exemple 2026-03-15.' };
  const annee = Number(correspondance[1]);
  const mois = Number(correspondance[2]);
  const jour = Number(correspondance[3]);
  const verif = new Date(Date.UTC(annee, mois - 1, jour));
  if (verif.getUTCFullYear() !== annee || verif.getUTCMonth() !== mois - 1 || verif.getUTCDate() !== jour) {
    return { erreur: 'Cette date n’existe pas.' };
  }
  return { annee, mois, jour };
}

export function analyserHeure(heureTexte, minuteTexte) {
  const h = String(heureTexte ?? '').trim();
  const m = String(minuteTexte ?? '').trim();
  if (h === '' && m === '') return { vide: true };
  if (h === '' || m === '' || !/^\d{1,2}$/.test(h) || !/^\d{1,2}$/.test(m)) {
    return { erreur: 'Indiquez l’heure en heures et minutes, de 0 h à 23 h 59.' };
  }
  const heure = Number(h);
  const minute = Number(m);
  if (heure > 23 || minute > 59) {
    return { erreur: 'Indiquez l’heure en heures et minutes, de 0 h à 23 h 59.' };
  }
  return { heure, minute };
}

function dateEnFrancais(annee, mois, jour) {
  if (jour === 1) return `le 1er ${MOIS_FR[mois - 1]} ${annee}`;
  return `le ${jour} ${MOIS_FR[mois - 1]} ${annee}`;
}

function murCorrespond(parties, annee, mois, jour, heure, minute) {
  return Number(parties.year) === annee
    && Number(parties.month) === mois
    && Number(parties.day) === jour
    && Number(parties.hour) === heure
    && Number(parties.minute) === minute;
}

/**
 * Convertit une date et une heure civiles du fuseau du journal en instant ISO.
 * Heure inexistante (passage à l’heure avancée) : { erreur }.
 * Heure en double (retour à l’heure normale) : première occurrence (heure avancée)
 * et { ambigu } pour prévenir la rédaction.
 * Champs tous vides : { iso: undefined }.
 */
export function civilVersIso(dateTexte, heureTexte, minuteTexte, timeZone) {
  const zone = timeZone || FUSEAU_DEFAUT;
  const date = analyserDate(dateTexte);
  const heure = analyserHeure(heureTexte, minuteTexte);
  if (date.vide && heure.vide) return { iso: undefined };
  if (date.erreur) return { erreur: date.erreur };
  if (date.vide) return { erreur: 'Indiquez la date au format AAAA-MM-JJ, par exemple 2026-03-15.' };
  if (heure.erreur) return { erreur: heure.erreur };
  if (heure.vide) return { erreur: 'Indiquez l’heure en heures et minutes, de 0 h à 23 h 59.' };

  const { annee, mois, jour } = date;
  const { heure: h, minute: min } = heure;
  const murCommeUtc = Date.UTC(annee, mois - 1, jour, h, min, 0);

  const instants = new Set();
  let guess = murCommeUtc;
  for (let i = 0; i < 3; i += 1) {
    const decalage = decalageMs(guess, zone);
    const candidat = murCommeUtc - decalage;
    instants.add(candidat);
    guess = candidat;
  }
  for (const base of [...instants]) {
    for (const delta of [-7_200_000, -3_600_000, 3_600_000, 7_200_000]) {
      const decalage = decalageMs(base + delta, zone);
      instants.add(murCommeUtc - decalage);
    }
  }

  const valides = [...instants]
    .filter((instant) => murCorrespond(partiesZone(instant, zone), annee, mois, jour, h, min))
    .sort((a, b) => a - b);

  if (valides.length === 0) {
    return {
      erreur: `Cette heure n’existe pas ${dateEnFrancais(annee, mois, jour)} : ce jour-là, l’horloge avance d’une heure.`,
    };
  }

  const iso = new Date(valides[0]).toISOString();
  if (valides.length > 1) {
    return {
      iso,
      ambigu: `Cette heure arrive deux fois ${dateEnFrancais(annee, mois, jour)} (retour à l’heure normale). La première occurrence (heure avancée) est retenue.`,
    };
  }
  return { iso };
}

/** Affichage figé en français du Québec, 24 h, dans le fuseau du journal. */
export function formaterHorodatage(iso, timeZone) {
  if (!iso) return '';
  const temps = Date.parse(iso);
  if (Number.isNaN(temps)) return '';
  try {
    return new Intl.DateTimeFormat('fr-CA', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timeZone || FUSEAU_DEFAUT,
      hourCycle: 'h23',
    }).format(new Date(temps));
  } catch {
    return '';
  }
}
