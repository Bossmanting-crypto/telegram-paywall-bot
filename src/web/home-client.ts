/**
 * Homepage earnings calculator (served at /assets/home.js). The page already
 * shows a worked example without script; this only makes the sliders live.
 * Written without backticks or dollar-brace so it can live in a template string.
 */
export const HOME_JS = String.raw`(function () {
  "use strict";
  var calc = document.querySelector("[data-calc]");
  if (!calc) return;
  var free = Number(calc.getAttribute("data-free")) || 0.15;
  var starter = Number(calc.getAttribute("data-starter")) || 0.08;
  var members = document.getElementById("calc-members");
  var price = document.getElementById("calc-price");
  var membersOut = document.getElementById("calc-members-out");
  var priceOut = document.getElementById("calc-price-out");
  var keep = document.getElementById("calc-keep");
  var note = document.getElementById("calc-note");
  function usd(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
  function pct(n) { return Math.round(n * 100) + "%"; }
  function fill(input) {
    var p = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty("--fill", p + "%");
  }
  function update() {
    var m = Number(members.value), p = Number(price.value), gross = m * p;
    membersOut.textContent = m.toLocaleString("en-US");
    priceOut.textContent = usd(p);
    keep.textContent = usd(gross * (1 - starter));
    note.textContent = m.toLocaleString("en-US") + " members × " + usd(p) + " on Starter (" + pct(starter) + " fee). " +
      usd(gross * (1 - free)) + " during the free trial (" + pct(free) + ").";
    fill(members); fill(price);
  }
  members.addEventListener("input", update);
  price.addEventListener("input", update);
  update();
})();
`;
