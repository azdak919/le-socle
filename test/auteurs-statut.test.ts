import assert from "node:assert/strict";
import { test } from "node:test";

import {
  articlesDeLauteur,
  auteurPeutEtreSupprime,
  estAuteurAncien,
  normaliserAuteur,
  statutAuteur,
  STATUT_AUTEUR_ACTIF,
  STATUT_AUTEUR_ANCIEN,
} from "../admin/assets/auteurs-statut.js";

test("un auteur sans statut est actif ; active: false devient ancien", () => {
  assert.equal(statutAuteur({ slug: "amira" }), STATUT_AUTEUR_ACTIF);
  assert.equal(statutAuteur({ slug: "camille", active: true }), STATUT_AUTEUR_ACTIF);
  assert.equal(statutAuteur({ slug: "camille", active: false }), STATUT_AUTEUR_ANCIEN);
  assert.equal(statutAuteur({ slug: "camille", status: "former" }), STATUT_AUTEUR_ANCIEN);
  assert.equal(statutAuteur({ slug: "camille", status: "ancien", active: true }), STATUT_AUTEUR_ANCIEN);
  assert.equal(estAuteurAncien({ active: false }), true);
  assert.equal(estAuteurAncien({ name: "Amira" }), false);
});

test("la normalisation écrit status et active, sans perdre le reste", () => {
  const ancien = normaliserAuteur({ slug: "leonie-gagnon", name: "Léonie Gagnon", active: false, role: "Ancienne rédactrice en chef" });
  assert.equal(ancien.status, STATUT_AUTEUR_ANCIEN);
  assert.equal(ancien.active, false);
  assert.equal(ancien.name, "Léonie Gagnon");
  const actif = normaliserAuteur({ slug: "amira-benali", name: "Amira Benali" });
  assert.equal(actif.status, STATUT_AUTEUR_ACTIF);
  assert.equal(actif.active, true);
});

test("un auteur cité dans un article, publié ou non, ne peut pas être supprimé", () => {
  const leonie = { slug: "leonie-gagnon", name: "Léonie Gagnon" };
  const articles = [
    { title: "Ancien mandat", status: "published", authors: ["leonie-gagnon"] },
    { title: "Brouillon", status: "draft", authors: ["amira-benali"] },
  ];
  assert.deepEqual(articlesDeLauteur(leonie, articles).map((a) => a.title), ["Ancien mandat"]);
  assert.equal(auteurPeutEtreSupprime(leonie, articles), false);
  assert.equal(auteurPeutEtreSupprime({ slug: "personne-neuve" }, articles), true);
});
