import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = readFileSync(join(ROOT, "admin", "assets", "admin.js"), "utf8");

type AuthHelpers = {
  messageErreurAuth: (text: unknown, status: unknown, contentType?: unknown) => string;
  reponseAuthIllisible: (text: unknown, contentType?: unknown) => boolean;
  AUTH_ERROR_MESSAGES: Record<string, string>;
  MESSAGE_REPONSE_ILLISIBLE: string;
  MESSAGE_DEMO_COURRIEL: string;
  DEMO_COURRIEL: string;
  libelleAdresseActuelle: (email: unknown) => string;
};

function loadHelpers(): AuthHelpers {
  const start = ADMIN.indexOf("const AUTH_ERROR_MESSAGES");
  const end = ADMIN.indexOf("function readDemoProfile(");
  assert.ok(start !== -1 && end > start, "les aides d’erreur d’auth sont présentes");
  return new Function(`${ADMIN.slice(start, end)}; return { messageErreurAuth, reponseAuthIllisible, AUTH_ERROR_MESSAGES, MESSAGE_REPONSE_ILLISIBLE, MESSAGE_DEMO_COURRIEL, DEMO_COURRIEL, libelleAdresseActuelle };`)() as AuthHelpers;
}

const HOMEPAGE = `<!doctype html>
<html lang="fr-CA">
<head>
<meta charset="utf-8">
<title>Le Quorum — On vote, on débat, on imprime</title>
<link rel="canonical" href="https://kiosque.le-radar.ca/demo/">
</head>
<body><p>On vote, on débat, on imprime</p></body>
</html>`;

const HTML_405 = `<html>
<head><title>405 Not Allowed</title></head>
<body bgcolor="white">
<center><h1>405 Not Allowed</h1></center>
</body>
</html>`;

test("les codes d’erreur courts restent traduits, jamais le corps brut", () => {
  const { messageErreurAuth, AUTH_ERROR_MESSAGES, MESSAGE_REPONSE_ILLISIBLE } = loadHelpers();
  assert.equal(messageErreurAuth("courriel inchangé", 400), AUTH_ERROR_MESSAGES["courriel inchangé"]);
  assert.equal(messageErreurAuth("smtp absent", 409), AUTH_ERROR_MESSAGES["smtp absent"]);
  assert.equal(messageErreurAuth('{"error":"lien expiré"}', 400, "application/json"), AUTH_ERROR_MESSAGES["lien expiré"]);
  assert.equal(messageErreurAuth("", 404), "Le serveur du journal a refusé la demande (code 404). Réessayez ; si cela continue, prévenez l’administrateur.");
  assert.equal(messageErreurAuth(HOMEPAGE, 404, "text/html; charset=utf-8"), MESSAGE_REPONSE_ILLISIBLE);
  assert.equal(messageErreurAuth(HTML_405, 405, "text/html"), MESSAGE_REPONSE_ILLISIBLE);
  assert.equal(messageErreurAuth(HOMEPAGE, 200, "text/html"), MESSAGE_REPONSE_ILLISIBLE);
  assert.doesNotMatch(messageErreurAuth(HOMEPAGE, 404, "text/html"), /<!doctype|Le Quorum|On vote/);
  assert.doesNotMatch(messageErreurAuth(HTML_405, 405), /405 Not Allowed|bgcolor/);
  assert.match(MESSAGE_REPONSE_ILLISIBLE, /réponse lisible/);
  assert.doesNotMatch(MESSAGE_REPONSE_ILLISIBLE, /socle/i);
});

test("une réponse HTML ou trop longue est jugée illisible", () => {
  const { reponseAuthIllisible } = loadHelpers();
  assert.equal(reponseAuthIllisible(HOMEPAGE, "text/html"), true);
  assert.equal(reponseAuthIllisible(HTML_405), true);
  assert.equal(reponseAuthIllisible("ok", "application/json"), false);
  assert.equal(reponseAuthIllisible("courriel inchangé"), false);
  assert.equal(reponseAuthIllisible("x".repeat(200)), true);
});

test("authCall n’affiche plus le corps brut et refuse un JSON invalide", () => {
  assert.match(ADMIN, /function messageErreurAuth\(/);
  assert.match(ADMIN, /throw new Error\(messageErreurAuth\(text, response\.status, type\)\)/);
  assert.doesNotMatch(ADMIN, /messages\[text\] \|\| text/);
  assert.match(ADMIN, /Le serveur du journal ne répond pas\. Réessayez dans un instant\./);
  assert.match(ADMIN, /try \{\s*return JSON\.parse\(text\);/);
});

test("en démonstration, le courriel se traite localement, sans appel au serveur", () => {
  const { MESSAGE_DEMO_COURRIEL } = loadHelpers();
  const bind = ADMIN.slice(ADMIN.indexOf("async function bindProfile()"), ADMIN.indexOf("async function confirmEmailFromHash()"));
  assert.match(bind, /if \(!onSocle\(\)\) profile = readDemoProfile\(\);/);
  assert.match(bind, /if \(!onSocle\(\)\) \{\s*const current = readDemoProfile\(\);/);
  assert.match(bind, /profileStatus\(MESSAGE_DEMO_COURRIEL, true\)/);
  assert.match(bind, /profileStatus\(MESSAGE_DEMO_PROFIL, true\)/);
  assert.match(bind, /profileStatus\(MESSAGE_DEMO_MOTDEPASSE, true\)/);
  assert.ok(!bind.includes("await authCall") || bind.indexOf("if (!onSocle())") < bind.indexOf("await authCall"), "les appels auth viennent après le mode local");
  assert.equal(MESSAGE_DEMO_COURRIEL, "Le courriel a été mis à jour uniquement dans votre navigateur.");
  assert.doesNotMatch(MESSAGE_DEMO_COURRIEL, /socle|email|HTML|lien de confirmation|serveur d’envoi/i);
  assert.match(ADMIN, /if \(!onSocle\(\)\) \{\s*notify\(MESSAGE_DEMO_COURRIEL_ACTION\)/);
  assert.match(ADMIN, /onSocle\(\) && status === 'non-confirmee'/);
  assert.match(ADMIN, /Dans cette démonstration, aucun lien n’est envoyé : il n’y a pas de serveur d’envoi\./);
  assert.match(ADMIN, /function masquerAideSiStatut\(/);
  assert.match(ADMIN, /aide\.hidden = !status\.hidden/);
  assert.match(ADMIN, /masquerAideSiStatut\(\)/);
  const aide = ADMIN.slice(ADMIN.indexOf("function paintEmailStatus("), ADMIN.indexOf("async function bindProfile()"));
  const statut = ADMIN.slice(ADMIN.indexOf("function profileStatus("), ADMIN.indexOf("function courrielEtatLibelle("));
  assert.match(aide, /masquerAideSiStatut\(\)/);
  assert.match(statut, /masquerAideSiStatut\(\)/);
  assert.ok(!MESSAGE_DEMO_COURRIEL.includes("aucun lien"), "le statut ne répète pas l’aide");
});

test("l’adresse actuelle s’affiche, ou « aucune », sans pastille ni vide", () => {
  const { libelleAdresseActuelle, DEMO_COURRIEL } = loadHelpers();
  assert.equal(DEMO_COURRIEL, "redaction@exemple.ca");
  assert.equal(libelleAdresseActuelle("redaction@exemple.ca"), "Adresse actuelle : redaction@exemple.ca");
  assert.equal(libelleAdresseActuelle("  lea@exemple.ca  "), "Adresse actuelle : lea@exemple.ca");
  assert.equal(libelleAdresseActuelle(""), "Adresse actuelle : aucune");
  assert.equal(libelleAdresseActuelle("   "), "Adresse actuelle : aucune");
  assert.equal(libelleAdresseActuelle(undefined), "Adresse actuelle : aucune");
  assert.match(ADMIN, /email: email \|\| DEMO_COURRIEL/);
  assert.match(ADMIN, /email: DEMO_COURRIEL/);
  const paint = ADMIN.slice(ADMIN.indexOf("function paintEmailStatus("), ADMIN.indexOf("async function bindProfile()"));
  assert.match(paint, /paintAdresseActuelle\(email\)/);
  assert.match(paint, /etat\.hidden = !email/);
  assert.doesNotMatch(paint, /etat\.hidden = false/);
  const css = readFileSync(join(ROOT, "admin", "assets", "admin.css"), "utf8");
  assert.match(css, /\.profil-actuel:empty/);
});
