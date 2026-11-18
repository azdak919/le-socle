import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdminDeps } from "../src/admin.ts";
import type { SocleConfig } from "../src/config.ts";
import { MODULES } from "../src/modules.ts";
import type { SocleStore } from "../src/store.ts";

export const NOW = "2026-11-18T07:00:00.000Z";
// Un vrai en-tête PNG suivi de quelques octets : assez pour le reniflage.
export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0d0a2db40000000049454e44ae426082", "hex");

export function config(flags: Partial<Record<(typeof MODULES)[number], boolean>>): SocleConfig {
  const modules = {} as SocleConfig["modules"];
  for (const name of MODULES) modules[name] = flags[name] ?? false;
  return { modules };
}

export function deps(store: SocleStore): AdminDeps {
  return {
    store,
    now: () => new Date(NOW),
    backupDir: mkdtempSync(join(tmpdir(), "socle-redaction-")),
    release: () => null,
    version: () => "1.0.0",
    setVersion: async () => undefined,
  };
}

export type Call = (method: string, path: string, body?: unknown, type?: string) => Promise<{ status: number; json: any; bytes: Buffer; type: string }>;

export const PUBLICATION = {
  id: "11111111-1111-4111-8111-111111111111", slug: "la-gazette", name: "La Gazette", institution: "Cégep du Nord",
  institutionType: "cegep", lang: "fr-CA", siteUrl: "https://gazette.exemple", timeZone: "America/Toronto",
  theme: { accent: "#8a1538" }, governance: { owner: "Association", contact: "redaction@gazette.exemple" },
};

/**
 * Le parcours de l'admin du Kiosque, en ordre : la même suite tourne sur
 * chaque pilote (SQLite, D1), sur le vrai serveur Node, et sur PHP.
 */
export async function scenario(call: Call): Promise<string[]> {
  const seen: string[] = [];
  const step = async (label: string, method: string, path: string, body: unknown, status: number, type?: string) => {
    const result = await call(method, path, body, type);
    assert.equal(result.status, status, `${label} : ${JSON.stringify(result.json)}`);
    seen.push(`${label} ${result.status}`);
    return result;
  };
  await step("texte refusé", "POST", "/v1/redaction/publication", "nom=x", 415, "application/x-www-form-urlencoded");
  await step("publication", "POST", "/v1/redaction/publication", { publication: PUBLICATION }, 200);
  await step("auteur", "POST", "/v1/redaction/entite", { kind: "author", entity: { id: "a1", name: "Léa Roy", slug: "lea-roy" } }, 200);
  await step("section", "POST", "/v1/redaction/entite", { kind: "section", entity: { id: "s1", name: "Campus", slug: "campus" } }, 200);
  await step("section invalide", "POST", "/v1/redaction/entite", { kind: "section", entity: { name: "Sans slug", slug: "Pas Bon" } }, 400);
  const draft = { id: "art-1", slug: "premier-article", title: "Premier article", excerpt: "Résumé.", body: { format: "markdown", raw: "Bonjour." }, authors: ["lea-roy"], status: "draft" };
  await step("brouillon", "POST", "/v1/redaction/article", { article: draft }, 200);
  await step("publié sans section", "POST", "/v1/redaction/article", { article: { ...draft, status: "published", publishedAt: NOW } }, 400);
  await step("photo sans crédit", "POST", "/v1/redaction/photo", { asset: { id: "p1", alt: "La cour" }, data: PNG.toString("base64") }, 400);
  await step("faux fichier", "POST", "/v1/redaction/photo", { asset: { id: "p2", alt: "x", credit: "Moi" }, data: Buffer.from("<svg/>").toString("base64") }, 415);
  const photo = await step("photo de la banque", "POST", "/v1/redaction/photo", { asset: { id: "p1", alt: "La cour", credit: "Léa Roy", keywords: ["cour", "été"], usages: ["exterior"], width: 1, height: 1, focalPoint: { x: 40, y: 120 } }, data: `data:image/png;base64,${PNG.toString("base64")}` }, 200);
  assert.equal(photo.json.asset.src, "/media/banque/p1.png");
  assert.deepEqual(photo.json.asset.focalPoint, { x: 40, y: 100 });
  const file = await step("fichier", "GET", "/v1/redaction/fichier?src=%2Fmedia%2Fbanque%2Fp1.png", undefined, 200);
  assert.equal(file.type, "image/png");
  assert.deepEqual(file.bytes, PNG);
  await step("fiche sans crédit", "POST", "/v1/redaction/photo/fiche", { asset: { id: "p1", credit: "" } }, 400);
  await step("fiche", "POST", "/v1/redaction/photo/fiche", { asset: { id: "p1", credit: "Léa Roy", license: "CC BY 4.0", keywords: ["cour"], usages: ["exterior", "article"], focalPoint: { x: 50, y: 30 } } }, 200);
  // Une photo de la banque qui n'illustre rien de publié reste privée.
  await step("photo pas encore publique", "GET", "/media/banque/p1.png", undefined, 404);
  const lead = { id: "p1", kind: "image", src: "/media/banque/p1.png", alt: "La cour", credit: "Léa Roy" };
  await step("publié", "POST", "/v1/redaction/article", { article: { ...draft, status: "published", section: "campus", publishedAt: NOW, lead } }, 200);
  // Publiée, elle se lit à l'adresse que donne l'instantané : c'est là que
  // `sync` du Kiosque la rapatrie.
  const publicPhoto = await step("photo publique", "GET", "/media/banque/p1.png", undefined, 200);
  assert.equal(publicPhoto.type, "image/png");
  assert.deepEqual(publicPhoto.bytes, PNG);
  await step("chemin refusé", "GET", "/media/banque/%2e%2e/p1.png", undefined, 404);
  await step("adresse prise", "POST", "/v1/redaction/article", { article: { ...draft, id: "art-2" } }, 409);
  await step("photo utilisée", "POST", "/v1/redaction/photo/supprimer", { id: "p1" }, 409);
  const state = await step("état", "GET", "/v1/redaction/etat", undefined, 200);
  assert.equal(state.json.format, "socle-redaction");
  assert.equal(state.json.publication.name, "La Gazette");
  assert.equal(state.json.articles.length, 1);
  assert.equal(state.json.articles[0].status, "published");
  assert.equal(state.json.authors.length, 1);
  assert.equal(state.json.taxonomies.sections.length, 1);
  assert.equal(state.json.media.length, 1);
  assert.equal(state.json.media[0].license, "CC BY 4.0");
  await step("supprimer l'article", "POST", "/v1/redaction/supprimer", { kind: "article", id: "art-1" }, 200);
  await step("retirer la photo", "POST", "/v1/redaction/photo/supprimer", { id: "p1" }, 200);
  await step("photo publique retirée", "GET", "/media/banque/p1.png", undefined, 404);
  await step("fichier retiré", "GET", "/v1/redaction/fichier?src=%2Fmedia%2Fbanque%2Fp1.png", undefined, 404);
  await step("exemples", "POST", "/v1/redaction/exemples", { visible: false }, 200);
  const after = await step("état final", "GET", "/v1/redaction/etat", undefined, 200);
  assert.equal(after.json.articles.length, 0);
  assert.equal(after.json.media.length, 0);
  assert.equal(after.json.demoVisible, false);
  return seen;
}

