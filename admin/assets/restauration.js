// Restauration d'une sauvegarde, en deux temps, sur la page Sauvegarde
// (/admin/sauvegarde). Les textes viennent des attributs data-* du formulaire,
// en français ou en anglais. Le même fichier est inséré par PHP et par Node.
(function () {
  var form = document.getElementById("restaurer");
  var zone = document.getElementById("restaurer-etat");
  if (!form || !zone) return;
  var t = form.dataset;
  var nom = form.querySelector("[data-choix-nom]");
  var vide = nom ? nom.textContent : "";
  function montrerFichier() {
    if (!nom || !form.archive) return;
    var file = form.archive.files && form.archive.files[0];
    nom.textContent = file ? file.name : vide;
  }
  if (form.archive) form.archive.addEventListener("change", montrerFichier);
  form.addEventListener("reset", function () { setTimeout(montrerFichier, 0); });
  var page = location.pathname.replace(/\/$/, "");
  var query = location.search;
  function esc(value) {
    return String(value).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function erreur(detail) {
    zone.innerHTML = '<p class="note">' + esc(t.echec) + " " + esc(detail) + "</p>";
  }
  async function lire(response) {
    try { return await response.json(); } catch (e) { return {}; }
  }
  function ligne(nom, valeur) {
    return "<dt>" + esc(nom) + "</dt><dd>" + esc(valeur) + "</dd>";
  }
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var file = form.archive.files[0];
    if (!file) { erreur(t.choisir); return; }
    zone.textContent = t.lecture;
    var response = await fetch(page + "/restaurer/apercu" + query, {
      method: "POST", headers: { "content-type": "application/zip" }, body: file,
    });
    var data = await lire(response);
    if (!response.ok || !data.resume) { erreur(data.error || response.status); return; }
    var r = data.resume;
    var date = r.createdAt
      ? new Date(r.createdAt).toLocaleString(document.documentElement.lang === "en" ? "en-CA" : "fr-CA", { dateStyle: "long", timeStyle: "short" })
      : t.inconnue;
    zone.innerHTML = "<h3>" + esc(t.apercu) + "</h3><dl class=\"fiche\">"
      + ligne(t.fichier, file.name)
      + ligne(t.date, date)
      + (r.journal ? ligne(t.journal, r.journal) : "")
      + (r.session ? ligne(t.session, r.session === "ete" ? "été" : r.session) : "")
      + ligne(t.articles, r.articles)
      + ligne(t.photos, r.photos)
      + ligne(t.sections, r.sections)
      + ligne(t.comptes, r.comptes)
      + "</dl><p class=\"note\">" + esc(t.avertir) + "</p>"
      + "<p class=\"actions\"><button type=\"button\" class=\"danger\" data-oui>" + esc(t.confirmer) + "</button> "
      + "<button type=\"button\" class=\"secondaire\" data-non>" + esc(t.annuler) + "</button></p>";
    zone.querySelector("[data-non]").addEventListener("click", function () {
      zone.textContent = "";
      form.reset();
    });
    zone.querySelector("[data-oui]").addEventListener("click", async function () {
      this.disabled = true;
      zone.querySelector("[data-non]").disabled = true;
      var done = await fetch(page + "/restaurer" + query, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jeton: data.jeton }),
      });
      var report = await lire(done);
      form.reset();
      if (!done.ok) { erreur(report.error || done.status); return; }
      var lien = page + "/auto/" + encodeURIComponent(report.sauvegardeAuto) + query;
      zone.innerHTML = '<p class="note">' + esc(t.fait) + "</p><p>" + esc(t.auto)
        + ' <a href="' + esc(lien) + '">' + esc(t.telecharger) + "</a></p>";
      zone.focus();
    });
    zone.querySelector("[data-oui]").focus();
  });
})();
