/*
 * shelf.js — library shelf interactions.
 * Clicking a cassette plays a short "insert into the VCR" animation, then
 * navigates to the player page for that tape.
 */
(function () {
  "use strict";

  // Live clock in the header, for that always-blinking-VCR feel.
  var clock = document.getElementById("clock");
  if (clock) {
    setInterval(function () {
      var d = new Date();
      var p = function (n) { return String(n).padStart(2, "0"); };
      clock.textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }, 1000);
  }

  function insertAndGo(href, title) {
    // Build a full-screen overlay showing the tape sliding into the deck.
    var overlay = document.createElement("div");
    overlay.className = "insert-overlay";
    overlay.innerHTML =
      '<div class="insert-tape">' + (title || "TAPE") + "</div>" +
      '<div class="digital text-2xl">LOADING…</div>';
    document.body.appendChild(overlay);

    // Respect reduced motion: navigate quickly if animations are disabled.
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(function () { window.location.href = href; }, reduce ? 150 : 1500);
  }

  document.querySelectorAll(".cassette").forEach(function (el) {
    var go = function () { insertAndGo(el.dataset.href, el.dataset.title); };
    el.addEventListener("click", go);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
})();
