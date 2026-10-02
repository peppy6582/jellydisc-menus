// Filters the browse page's cards. Everything is read from data attributes and compared as text; nothing is
// ever written back as markup.
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll("#cards .card"));
  var q = document.getElementById("f-text"), type = document.getElementById("f-type"),
      tag = document.getElementById("f-tag"), feat = document.getElementById("f-feature"),
      count = document.getElementById("f-count"), none = document.getElementById("f-none");
  function has(list, word) { return (" " + list + " ").indexOf(" " + word + " ") >= 0; }
  function apply() {
    var text = q.value.trim().toLowerCase(), shown = 0;
    cards.forEach(function (c) {
      var ok = (!text || c.dataset.text.indexOf(text) >= 0) &&
        (!type.value || c.dataset.type === type.value) &&
        (!tag.value || has(c.dataset.tags, tag.value)) &&
        (!feat.value || has(c.dataset.features, feat.value));
      c.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = shown + " of " + cards.length + " menus";
    none.hidden = shown !== 0;
  }
  document.getElementById("filters").addEventListener("submit", function (e) { e.preventDefault(); });
  [q, type, tag, feat].forEach(function (el) { el.addEventListener("input", apply); });
  apply();
})();
