/**
 * Homepage earnings calculator (served at /assets/home.js). The page already
 * shows a worked example without script; this makes the sliders live and adds
 * the $ / KSh and per month / per day switches.
 * Written without backticks or dollar-brace so it can live in a template string.
 */
export const HOME_JS = String.raw`(function () {
  "use strict";
  var calc = document.querySelector("[data-calc]");
  if (!calc) return;
  var ladder = [];
  try { ladder = JSON.parse(calc.getAttribute("data-ladder") || "[]"); } catch (e) { ladder = []; }
  if (!ladder.length) ladder = [[0, 0.12]];
  var kes = Number(calc.getAttribute("data-kes")) || 129;
  var members = document.getElementById("calc-members");
  var price = document.getElementById("calc-price");
  var membersOut = document.getElementById("calc-members-out");
  var priceOut = document.getElementById("calc-price-out");
  var priceLabel = document.getElementById("calc-price-label");
  var label = document.getElementById("calc-label");
  var keep = document.getElementById("calc-keep");
  var note = document.getElementById("calc-note");
  var switches = calc.querySelector(".calc-switches");

  // Slider range and starting price for each currency and period.
  var RANGES = {
    USD: { month: [1, 50, 1, 5], day: [0.5, 5, 0.5, 1] },
    KES: { month: [100, 5000, 50, 500], day: [10, 500, 10, 50] }
  };
  var currency = "USD", period = "month";

  function money(n) {
    if (currency === "KES") return "KSh " + Math.round(n).toLocaleString("en-US");
    var whole = Math.abs(n - Math.round(n)) < 0.005 || n >= 100;
    return "$" + (whole ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));
  }
  function pct(n) { return Math.round(n * 100) + "%"; }
  function fill(input) {
    var p = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty("--fill", p + "%");
  }
  // The fee for a month's sales in dollars, from the volume ladder (highest step first).
  function cutFor(monthlyUsd) {
    for (var i = 0; i < ladder.length; i++) if (monthlyUsd >= ladder[i][0]) return ladder[i][1];
    return ladder[ladder.length - 1][1];
  }
  function update() {
    var m = Number(members.value), p = Number(price.value), gross = m * p;
    var each = period === "day" ? "a day" : "a month";
    var monthlyUsd = gross * (period === "day" ? 30 : 1) / (currency === "KES" ? kes : 1);
    var fee = cutFor(monthlyUsd);
    membersOut.textContent = m.toLocaleString("en-US");
    priceOut.textContent = money(p);
    priceLabel.textContent = period === "day" ? "Daily price" : "Monthly price";
    label.textContent = period === "day" ? "You keep each day" : "You keep each month";
    keep.textContent = money(gross * (1 - fee));
    var top = ladder[ladder.length - 1][1];
    note.textContent = m.toLocaleString("en-US") + " members × " + money(p) + " " + each + ", after the " + pct(fee) + " fee" +
      (fee < top ? ", lower because you sell more." : ". The fee falls as your sales grow.");
    fill(members); fill(price);
  }
  function setRange() {
    var r = RANGES[currency][period];
    price.min = String(r[0]); price.max = String(r[1]); price.step = String(r[2]); price.value = String(r[3]);
    update();
  }
  function pick(group, attr, value) {
    var buttons = switches.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute(attr) === value));
    }
  }
  if (switches) {
    switches.hidden = false;
    switches.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button) return;
      if (button.hasAttribute("data-currency")) {
        currency = button.getAttribute("data-currency");
        pick(switches, "data-currency", currency);
      } else if (button.hasAttribute("data-period")) {
        period = button.getAttribute("data-period");
        pick(switches, "data-period", period);
      }
      setRange();
    });
  }
  members.addEventListener("input", update);
  price.addEventListener("input", update);
  update();
})();
`;
