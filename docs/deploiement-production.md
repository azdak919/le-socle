# Mettre le Socle en production

Cette liste sert au moment où un journal installe **sa** copie pour de vrai, en HTTPS, avec une équipe qui se connecte. Rien n’est déployé depuis ce dépôt : les secrets, le nom de domaine et l’hébergement sont réglés par la personne qui installe (pour le Radar, c’est Charles). N’écrivez jamais les valeurs des secrets dans un fichier du projet, un ticket ou un message.

## 1. Avant d’ouvrir le journal au public

- Choisir l’hébergeur (PHP ou Node 22.18 ou plus récent). Allumer les modules utiles dans `socle.config.json` (`auth` et `editorial` au minimum pour l’espace de rédaction). Relancer ensuite `migrate` (voir `docs/adoption.md`).
- Poser l’adresse publique exacte, en HTTPS, dans `SOCLE_PUBLIC_ORIGIN` (sans barre finale). Les liens de réinitialisation et de confirmation de courriel sont construits à partir de cette adresse. Si elle est fausse, les courriels pointeront au mauvais endroit.
- Derrière un mandataire (nginx, Cloudflare), écouter seulement en local et poser `SOCLE_TRUST_PROXY=1`. Sans ce réglage, la limitation des essais de réinitialisation ne voit que l’adresse du mandataire.
- Le certificat HTTPS est celui de l’hébergeur ou de Cloudflare. Quand `SOCLE_PUBLIC_ORIGIN` commence par `https://`, le cookie de session est marqué `Secure`.
- Mode d’accès d’une équipe de journal : `SOCLE_AUTH_MODE=motdepasse`.

## 2. Envoi des courriels (forfait gratuit seulement)

Pour que « Mot de passe oublié » et le changement de courriel fonctionnent vraiment, le journal doit avoir un relais SMTP. C’est le mécanisme déjà utilisé pour le lien magique.

Variables, à poser dans l’environnement de l’hébergeur, **jamais** dans `socle.config.json` :

- `SOCLE_SMTP_HOST`
- `SOCLE_SMTP_FROM` (une adresse du domaine du journal, déjà autorisée à envoyer)
- `SOCLE_SMTP_PORT` (465 avec chiffrement d’emblée, ou 587)
- `SOCLE_SMTP_SECURE=1` pour le port 465 (TLS d’emblée)
- `SOCLE_SMTP_USER` et `SOCLE_SMTP_PASSWORD` si le serveur l’exige

Sur le port 587, le Socle demande STARTTLS si le serveur l’annonce. En production, préférez 465 avec `SOCLE_SMTP_SECURE=1`, ou un serveur 587 qui propose STARTTLS. L’adresse d’expédition doit être autorisée chez l’hébergeur (SPF, et DKIM s’il est offert).

Cloudflare Email Sending, sur le forfait gratuit, n’envoie un courriel qu’à des adresses de destination déjà vérifiées dans le compte Cloudflare. Cela ne convient pas à une équipe dont chaque personne a son propre courriel. L’envoi vers n’importe quelle adresse exige le forfait Workers payant, que ce projet n’utilise pas. Ne comptez donc pas sur Email Sending pour la réinitialisation.

Si le SMTP n’est pas réglé, la page « Mot de passe oublié » le dit clairement et renvoie vers l’administrateur (onglet « Équipe »). Ne mettez pas le journal en production dans cet état si l’équipe doit pouvoir réinitialiser elle-même son mot de passe.

## 3. Premier compte administrateur

1. Ouvrir `https://<votre-domaine>/redaction/` (ou `/admin`, qui y redirige).
2. Au premier passage, l’assistant crée le journal et le compte administrateur (courriel et mot de passe d’au moins 10 caractères). Faites-le tout de suite après la mise en ligne, avant d’ouvrir l’adresse à d’autres personnes.
3. Depuis l’onglet « Équipe », ajouter ensuite les comptes de la rédaction.

## 4. Essai de bout en bout, avant d’annoncer l’adresse

Sur l’adresse HTTPS réelle, pas seulement en local :

1. Se connecter, puis se déconnecter.
2. Vérifier le thème : le mode du système s’applique ; le bouton permet de passer au thème clair ou sombre.
3. « Mot de passe oublié » : inscrire le courriel d’un vrai compte de test, recevoir le message, suivre le lien (une heure, un seul usage), poser un nouveau mot de passe, constater que l’ancienne session est fermée et que l’on peut se reconnecter.
4. Recommencer avec une adresse **inconnue** : le message à l’écran est le même, aucun courriel n’indique si le compte existe.
5. Enchaîner plusieurs demandes trop vite : après cinq essais sur la même adresse en 15 minutes, la page demande d’attendre.
6. « Mon profil » : changer le nom et le nom d’affichage ; changer le mot de passe en saisissant l’actuel ; demander un changement de courriel et confirmer le lien reçu.
7. Ouvrir la même page sur un téléphone, en thème clair et en thème sombre.

## 5. Rappel des variables d’environnement

Aucune valeur n’est donnée ici. Posez seulement celles dont vous avez besoin.

| Variable | Rôle |
|---|---|
| `SOCLE_AUTH_MODE` | `motdepasse` pour une équipe de journal |
| `SOCLE_PUBLIC_ORIGIN` | Adresse publique en `https://…` |
| `SOCLE_TRUST_PROXY` | `1` derrière Cloudflare ou nginx |
| `SOCLE_SMTP_HOST` | Serveur d’envoi |
| `SOCLE_SMTP_FROM` | Expéditeur |
| `SOCLE_SMTP_PORT` | Port SMTP |
| `SOCLE_SMTP_SECURE` | `1` pour le TLS d’emblée (port 465) |
| `SOCLE_SMTP_USER` | Identifiant SMTP, s’il y a lieu |
| `SOCLE_SMTP_PASSWORD` | Mot de passe SMTP, s’il y a lieu |
| `SOCLE_DB` | Fichier SQLite (Node) |
| `SOCLE_BACKUP_DIR` | Dossier des sauvegardes |
| `SOCLE_STATIC` | Racine du site public déjà construit, s’il est servi par le Socle |
| `SOCLE_ADMINISTRATEUR` | Courriel d’un administrateur déjà connu, facultatif |

Les secrets restent dans le coffre de l’hébergeur.
