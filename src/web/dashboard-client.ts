/**
 * Browser code for the creator dashboard (served at /assets/dashboard.js).
 *
 * Plain ES2017, no build step and no framework. It talks to the same
 * /api/v1 endpoints the docs describe, sending the account key as a header.
 * The key is kept in sessionStorage, so it is forgotten when the tab closes.
 * Every piece of data is inserted with textContent, never as HTML.
 *
 * Written without backticks or dollar-brace so it can live in a template string.
 */
export const DASHBOARD_JS = String.raw`(function () {
  "use strict";

  var STORE = "pb_key";
  var meta = function (name) { var m = document.querySelector('meta[name="' + name + '"]'); return m ? m.getAttribute("content") : ""; };
  var PLATFORM = { name: meta("pb-name") || "Paywall Bot", contact: meta("pb-contact"), signups: meta("pb-signups") !== "closed" };
  var state = { key: null, admin: false, me: null };
  var app = document.getElementById("app");
  var nav = document.getElementById("nav");
  var toastEl = document.getElementById("toast");
  var toastTimer = null;

  // ── Small helpers ──────────────────────────────────────────────────────────

  function storeGet() { try { return sessionStorage.getItem(STORE); } catch (e) { return null; } }
  function storeSet(v) { try { if (v) sessionStorage.setItem(STORE, v); else sessionStorage.removeItem(STORE); } catch (e) { /* private mode */ } }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "class") el.className = v;
        else if (k === "value") el.value = v;
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { add(el, c); }); return; }
    el.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  function setMain() {
    app.textContent = "";
    for (var i = 0; i < arguments.length; i++) add(app, arguments[i]);
    window.scrollTo(0, 0);
  }

  function money(n) { var v = Number(n || 0); return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2); }
  var SYMBOL = { USD: "$", KES: "KSh ", NGN: "₦", GHS: "GH₵", ZAR: "R " };
  function priceText(n, currency) {
    var v = Number(n || 0);
    if (!(v > 0)) return "off";
    var c = currency || "USD";
    return (SYMBOL[c] || c + " ") + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  function day(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function daysUntil(iso) { return Math.ceil((Date.parse(iso) - Date.now()) / 86400000); }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function toast(message, bad) {
    toastEl.textContent = message;
    toastEl.className = "toast" + (bad ? " bad" : "");
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }

  function api(method, path, body) {
    var headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (state.key) headers[state.admin ? "x-admin-key" : "x-api-key"] = state.key;
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { detail: text }; }
          if (!res.ok) {
            var err = new Error(data.detail || ("Something went wrong (error " + res.status + "). Try again."));
            err.status = res.status;
            if (res.status === 401 && state.key) { signOut(true); }
            throw err;
          }
          return data;
        });
      }, function () { throw new Error("Couldn't reach the server. Check your connection and try again."); });
  }

  function selectText(el) {
    var range = document.createRange(); range.selectNodeContents(el);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  function copyField(value, extraClass) {
    var code = h("code", { class: extraClass || null }, value);
    var btn = h("button", { type: "button", class: "btn small" }, "Copy");
    btn.addEventListener("click", function () {
      var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { selectText(code); });
      } else { selectText(code); }
    });
    return h("div", { class: "copy" }, code, btn);
  }

  var fieldCount = 0;
  function field(label, control, hint) {
    if (!control.id) control.id = "f" + (++fieldCount);
    return h("div", { class: "field" }, h("label", { for: control.id }, label), control, hint ? h("p", { class: "hint" }, hint) : null);
  }
  function input(name, attrs) {
    var a = { name: name, id: "f-" + name + "-" + (++fieldCount), autocomplete: "off" };
    Object.keys(attrs || {}).forEach(function (k) { a[k] = attrs[k]; });
    return h("input", a);
  }
  function textarea(name, value, attrs) {
    var a = { name: name, id: "f-" + name + "-" + (++fieldCount) };
    Object.keys(attrs || {}).forEach(function (k) { a[k] = attrs[k]; });
    var t = h("textarea", a); t.value = value || ""; return t;
  }
  function select(name, options, current) {
    var s = h("select", { name: name, id: "f-" + name + "-" + (++fieldCount) });
    options.forEach(function (o) { s.appendChild(h("option", { value: o[0], selected: o[0] === current }, o[1])); });
    return s;
  }
  function values(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      out[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
    });
    return out;
  }
  function num(v) { return v === "" || v === undefined ? undefined : Number(v); }

  /** A form whose submit runs fn(values, form); errors appear inside the form. */
  function form(fn, children, submitLabel, submitClass) {
    var error = h("p", { class: "form-error", role: "alert", hidden: true });
    var submit = h("button", { type: "submit", class: "btn " + (submitClass || "primary") }, submitLabel);
    var f = h("form", { novalidate: true }, children, error, h("div", { class: "row" }, submit));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      error.hidden = true;
      var bad = Array.prototype.find.call(f.elements, function (el) { return el.willValidate && !el.checkValidity(); });
      if (bad) { error.textContent = bad.validationMessage + " (" + (bad.labels && bad.labels[0] ? bad.labels[0].textContent : bad.name) + ")"; error.hidden = false; bad.focus(); return; }
      submit.disabled = true;
      Promise.resolve().then(function () { return fn(values(f), f); })
        .catch(function (err) { error.textContent = err.message; error.hidden = false; })
        .then(function () { submit.disabled = false; });
    });
    return f;
  }

  /** A button that asks "are you sure" in place before running fn. */
  function confirmButton(label, confirmLabel, fn, cls) {
    var armed = false;
    var btn = h("button", { type: "button", class: "btn small " + (cls || "") }, label);
    btn.addEventListener("click", function () {
      if (!armed) {
        armed = true; btn.textContent = confirmLabel; btn.classList.add("solid");
        setTimeout(function () { if (armed) { armed = false; btn.textContent = label; btn.classList.remove("solid"); } }, 4000);
        return;
      }
      armed = false; btn.disabled = true;
      Promise.resolve().then(fn).catch(function (err) { toast(err.message, true); })
        .then(function () { btn.disabled = false; btn.textContent = label; btn.classList.remove("solid"); });
    });
    return btn;
  }

  function pill(text, kind) { return h("span", { class: "pill " + (kind || "") }, text); }
  function botStatus(status) {
    if (status === "active") return pill("Selling", "ok");
    if (status === "paused") return pill("Paused", "warn");
    if (status === "expired") return pill("Stopped", "bad");
    return pill(status || "unknown");
  }
  var ACCESS = { one_time: "Lifetime", daily: "Daily", weekly: "Weekly", monthly: "Monthly", manual_grant: "Free, from you", image_unlock: "Image vault", coin_pack: "Coins", platform_fee: "Platform fees", starter_plan: "Starter plan" };
  var PROVIDER = { paystack: "Paystack", nowpayments: "NOWPayments", btcpay: "BTCPay" };

  function tile(label, value, note) {
    return h("div", { class: "tile" }, h("span", { class: "label" }, label), h("span", { class: "value" }, value), note ? h("span", { class: "note" }, note) : null);
  }
  function panel(title, right) {
    var p = h("section", { class: "panel" });
    if (title) p.appendChild(h("div", { class: "panel-head" }, h("h2", null, title), right || null));
    for (var i = 2; i < arguments.length; i++) add(p, arguments[i]);
    return p;
  }
  function pageHead(title, sub, right) {
    return h("div", { class: "page-head" }, h("div", { class: "spread" }, h("h1", null, title), right || null), sub ? h("p", { class: "muted" }, sub) : null);
  }
  function loading() { setMain(h("div", { class: "loading" }, "Loading…")); }
  function failed(err) {
    if (err && err.status === 401) return;
    setMain(pageHead("Couldn't load this page"), h("p", { class: "banner bad" }, err.message), h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: route }, "Try again")));
  }

  function renderChecks(list, body) {
    list.textContent = "";
    var checks = body.checks || {};
    Object.keys(checks).forEach(function (name) {
      var c = checks[name];
      var cls = c.ok === true ? "ok" : c.ok === false ? "bad" : "skip";
      var mark = c.ok === true ? "✓" : c.ok === false ? "✗" : "–";
      var li = h("li", null, h("span", { class: "mark " + cls, "aria-label": cls === "ok" ? "Working" : cls === "bad" ? "Problem" : "Not set up" }, mark), h("span", { class: "name" }, name.replace(/_/g, " ")));
      if (c.detail) li.appendChild(h("span", { class: "detail" }, c.detail));
      (c.warnings || []).forEach(function (w) { li.appendChild(h("span", { class: "detail warn" }, w)); });
      list.appendChild(li);
    });
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  function renderNav(active) {
    nav.textContent = "";
    if (!state.key) {
      nav.appendChild(h("a", { href: "/" }, "Home"));
      return;
    }
    var links = [["overview", "Overview"], ["bots", "Bots"], ["payments", "Payments"], ["account", "Account"]];
    if (state.admin) links.push(["creators", "Creators"]);
    links.forEach(function (l) {
      nav.appendChild(h("a", { href: "#" + l[0], "aria-current": active === l[0] ? "page" : null }, l[1]));
    });
    nav.appendChild(h("button", { type: "button", onclick: function () { signOut(false); } }, "Sign out"));
  }

  function route() {
    var parts = location.hash.replace(/^#/, "").split("/");
    var view = parts[0] || "";
    if (!state.key) {
      renderNav(null);
      return view === "signup" && PLATFORM.signups ? viewSignup() : viewSignin();
    }
    var section = view === "bot" || view === "newbot" ? "bots" : view;
    renderNav(section || "overview");
    if (view === "bots") return viewBots();
    if (view === "newbot") return viewNewBot();
    if (view === "bot" && parts[1]) return viewBot(decodeURIComponent(parts[1]));
    if (view === "payments") return viewPayments();
    if (view === "account") return viewAccount();
    if (view === "creators" && state.admin) return viewCreators();
    return viewOverview();
  }
  function go(hash) { if (location.hash === "#" + hash) route(); else location.hash = hash; }

  function signIn(key) {
    state.key = key; state.admin = key.indexOf("pbk_") !== 0;
    return api("GET", "/api/v1/tenants/me").then(function (me) {
      state.me = me; storeSet(key); return me;
    }, function (err) { state.key = null; state.admin = false; throw err; });
  }
  function signOut(expired) {
    state.key = null; state.admin = false; state.me = null; storeSet(null);
    if (expired) toast("Your key didn't work. Sign in again.", true);
    go("signin");
  }

  // ── Signed out ────────────────────────────────────────────────────────────

  function authTabs(active) {
    if (!PLATFORM.signups) return null;
    return h("div", { class: "tabs" },
      h("a", { href: "#signup", "aria-current": active === "signup" ? "page" : null }, "Create account"),
      h("a", { href: "#signin", "aria-current": active === "signin" ? "page" : null }, "Sign in"));
  }

  function viewSignin() {
    var key = input("key", { type: "password", required: true, spellcheck: "false", placeholder: "pbk_…" });
    setMain(h("div", { class: "auth stack" }, authTabs("signin"), panel(null, null,
      h("h1", null, "Sign in"),
      h("p", { class: "muted" }, "Paste the account key you saved when you signed up. It starts with pbk_."),
      form(function (v) {
        return signIn(v.key).then(function () { go("overview"); });
      }, [field("Account key", key, "The platform owner can sign in with the admin key.")], "Sign in"))));
    key.focus();
  }

  function viewSignup() {
    var name = input("name", { required: true, maxlength: 128, autocomplete: "name", placeholder: "Your name or brand" });
    setMain(h("div", { class: "auth stack" }, authTabs("signup"), panel(null, null,
      h("h1", null, "Start now"),
      h("p", { class: "muted" }, "You'll get an account key straight away. No card, no monthly fee."),
      form(function (v) {
        var body = { name: v.name, email: v.email };
        if (v.telegram_id) body.telegram_id = Number(v.telegram_id);
        return api("POST", "/api/v1/tenants/signup", body).then(showNewKey);
      }, [
        field("Name", name),
        field("Email", input("email", { type: "email", required: true, maxlength: 256, autocomplete: "email", placeholder: "you@example.com" })),
        field("Your Telegram user ID (optional)", input("telegram_id", { inputmode: "numeric", pattern: "[0-9]*", title: "Numbers only", placeholder: "e.g. 123456789" }), "Lets you get a new key from your bot if you ever lose it. Get it from @userinfobot."),
      ], "Create account"))));
    name.focus();
  }

  function showNewKey(res) {
    var go2 = h("button", { type: "button", class: "btn primary", disabled: true }, "Open my dashboard");
    var ok = h("input", { type: "checkbox", id: "saved-key" });
    ok.addEventListener("change", function () { go2.disabled = !ok.checked; });
    go2.addEventListener("click", function () {
      go2.disabled = true;
      signIn(res.api_key).then(function () { go("newbot"); }, function (err) { toast(err.message, true); go2.disabled = false; });
    });
    setMain(h("div", { class: "auth stack" }, panel(null, null,
      h("h1", null, "Save your account key"),
      h("p", null, "This key is how you sign in. It's shown only once, so copy it somewhere safe now, such as a password manager."),
      copyField(res.api_key, "secret-key"),
      h("p", { class: "hint" }, "No monthly fee. Each sale has a " + res.platform_cut + " platform fee."),
      h("label", { class: "check", for: "saved-key" }, ok, h("span", null, "I've saved my key")),
      h("div", { class: "row" }, go2))));
  }

  // ── Overview ──────────────────────────────────────────────────────────────


  function botList(bots) {
    if (!bots.length) return h("p", { class: "empty" }, "No bots yet.");
    return h("div", { class: "list" }, bots.map(function (b) {
      return h("a", { class: "bot-row", href: "#bot/" + encodeURIComponent(b.id) },
        h("div", null,
          h("div", { class: "bot-name" }, b.bot_username ? "@" + String(b.bot_username).replace(/^@/, "") : b.id === "owner" ? "Your bot" : "Unnamed bot"),
          h("div", { class: "hint" }, (b.group_name || "No group linked yet") + " · " + planSummary(b.prices))),
        h("div", { class: "row" }, h("span", { class: "hint" }, plural(b.member_count || 0, "member")), botStatus(b.status)));
    }));
  }

  function planSummary(p) {
    var parts = [["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"], ["one_time", "lifetime"]]
      .filter(function (x) { return Number(p[x[0]]) > 0; })
      .map(function (x) { return x[1] + " " + priceText(p[x[0]], p.currency); });
    return parts.length ? parts.join(" · ") : "no plans on sale";
  }

  function canAddBot(me, bots) {
    if (state.admin) return { ok: false, why: "Your own bot is set up through Cloudflare secrets. Creators add theirs here." };
    return { ok: true };
  }

  function viewOverview() {
    loading();
    var calls = [api("GET", "/api/v1/tenants/me"), api("GET", "/api/v1/analytics/overview"), api("GET", "/api/v1/bots")];
    calls.push(state.admin ? api("GET", "/admin/overview") : api("GET", "/api/v1/tenants/billing"));
    Promise.all(calls).then(function (r) {
      var me = r[0], ov = r[1], bots = r[2].bots, plat = state.admin ? r[3] : null, bill = state.admin ? null : r[3];
      state.me = me;
      var allowed = canAddBot(me, bots);
      var out = [pageHead("Hi, " + me.name, state.admin ? "Your own bot and the creators on your platform." : planName(me.tier) + " plan · " + me.platform_cut + " fee per sale")];
      if (bill && bill.billing_hold) {
        out.push(h("div", { class: "banner bad" }, h("span", null, "Sales are paused: " + money(bill.fees_owed_usd) + " in platform fees is unpaid."), h("a", { href: "#account", class: "btn small" }, "Pay now")));
      } else if (bill && bill.fee_limit_usd && bill.fees_owed_usd >= bill.fee_limit_usd * 0.8) {
        out.push(h("div", { class: "banner warn" }, h("span", null, "You owe " + money(bill.fees_owed_usd) + " in platform fees. Sales pause at " + money(bill.fee_limit_usd) + "."), h("a", { href: "#account", class: "btn small" }, "Pay now")));
      }
      out.push(h("div", { class: "tiles" },
        tile("Earned, last 30 days", money(ov.last_30_days.net), plural(ov.last_30_days.transactions, "sale")),
        tile("Earned, all time", money(ov.all_time.net), ov.all_time.platform_fee > 0 ? "after " + money(ov.all_time.platform_fee) + " in fees" : plural(ov.all_time.transactions, "sale")),
        tile("Paying members now", String(ov.active_members), plural(ov.total_bots, "bot"))));
      if (plat) {
        out.push(panel("Your platform", h("a", { href: "#creators" }, "Manage creators"),
          h("div", { class: "tiles" },
            tile("Creators", String(plat.creators.total), plat.creators.on_free_trial + " on Standard"),
            tile("Fees earned, 30 days", money(plat.last_30_days.platform_fees_usd), "on " + money(plat.last_30_days.processed_usd) + " of creator sales"),
            tile("Fees earned, all time", money(plat.all_time.platform_fees_usd), plural(plat.all_time.transactions, "sale") + " in total"))));
      }
      out.push(panel("Your bots", allowed.ok ? h("a", { class: "btn small primary", href: "#newbot" }, "Add a bot") : null,
        botList(bots), !allowed.ok && !bots.length ? h("p", { class: "hint" }, allowed.why) : null));
      if (!bots.length && allowed.ok) {
        out.push(panel("Get started", null, h("ol", { class: "steps" },
          h("li", null, h("div", null, h("b", null, "Create a Telegram bot. "), "Message @BotFather, send /newbot and copy the token.")),
          h("li", null, h("div", null, h("b", null, "Add it here "), "with your Paystack or NOWPayments keys.")),
          h("li", null, h("div", null, h("b", null, "Add the bot to your group "), "as an admin with the Ban users permission.")))));
      }
      setMain(out);
    }).catch(failed);
  }

  function nextRate(me) {
    var v = me.volume_pricing;
    if (!v || !v.next) return "";
    return " · " + v.next.platform_cut + " once you pass $" + Number(v.next.from_usd).toLocaleString("en-US") + " in 30 days";
  }
  function planName(tier) { return tier === "starter" ? "Starter" : tier === "whitelabel" ? "White label" : "Standard"; }

  // ── Bots ──────────────────────────────────────────────────────────────────

  function viewBots() {
    loading();
    Promise.all([api("GET", "/api/v1/bots"), api("GET", "/api/v1/tenants/me")]).then(function (r) {
      var bots = r[0].bots, me = r[1];
      var allowed = canAddBot(me, bots);
      setMain(pageHead("Bots", "Each bot looks after one Telegram group.", allowed.ok ? h("a", { class: "btn primary", href: "#newbot" }, "Add a bot") : null),
        panel(null, null, botList(bots), !allowed.ok ? h("p", { class: "hint" }, allowed.why) : null));
    }).catch(failed);
  }

  var CURRENCIES = [["USD", "US dollar (USD)"], ["KES", "Kenyan shilling (KES)"], ["NGN", "Nigerian naira (NGN)"], ["GHS", "Ghanaian cedi (GHS)"], ["ZAR", "South African rand (ZAR)"]];
  var PRICE_FIELDS = [
    ["daily_price", "daily", "Daily", 0, "24 hours."],
    ["weekly_price", "weekly", "Weekly", 0, "7 days."],
    ["monthly_price", "monthly", "Monthly", 5, "30 days."],
    ["one_time_price", "one_time", "Lifetime", 10, "Pay once, stay forever."],
    ["image_unlock_price", "image_vault", "Image vault", 20, "0 hides a plan."],
  ];
  var PRICE_NAMES = PRICE_FIELDS.map(function (x) { return x[0]; });

  /** Paystack currency, exchange rate, the currency prices are written in, and the prices. */
  function pricingFields(currency, fxRate, p) {
    p = p || {};
    var cur = select("currency", CURRENCIES, currency || "USD");
    var fx = input("fx_rate", { type: "number", min: "0.000001", step: "any", value: fxRate && currency !== "USD" ? fxRate : "", placeholder: "e.g. 129" });
    var fxField = field("Exchange rate", fx, "How many of your currency equal 1 US dollar. Used for crypto and platform fees, and for Paystack when prices are in dollars.");
    var pc = select("price_currency", [], "USD");
    var pcField = field("Set prices in", pc, "Shillings let you charge round amounts like KSh 50 a day. Switching doesn't convert the prices, so check them.");
    var labels = [];
    var grid = h("div", { class: "grid-3" }, PRICE_FIELDS.map(function (x) {
      var value = p[x[1]] !== undefined ? p[x[1]] : x[3];
      var el = field(x[2], input(x[0], { type: "number", min: "0", max: "10000000", step: "0.01", value: value, required: true }), x[4]);
      labels.push([el.querySelector("label"), x[2]]);
      return el;
    }));
    var wanted = p.currency || "USD";
    var sync = function () {
      var local = cur.value;
      fxField.hidden = local === "USD"; fx.required = local !== "USD";
      var keep = pc.value || wanted;
      pc.textContent = "";
      pc.appendChild(h("option", { value: "USD" }, "US dollars ($)"));
      if (local !== "USD") pc.appendChild(h("option", { value: local }, (CURRENCIES.filter(function (c) { return c[0] === local; })[0] || [local, local])[1]));
      pc.value = keep === local ? local : "USD";
      pcField.hidden = local === "USD";
      var unit = (SYMBOL[pc.value] || pc.value + " ").trim();
      labels.forEach(function (l) { l[0].textContent = l[1] + " (" + unit + ")"; });
    };
    cur.addEventListener("change", sync); pc.addEventListener("change", function () { wanted = pc.value; sync(); }); sync();
    return [h("div", { class: "grid-2" }, field("Paystack charges in", cur, "Crypto is always paid in US dollars."), fxField), pcField, grid];
  }
  function priceBody(v) {
    var out = { price_currency: v.currency === "USD" ? "USD" : v.price_currency || "USD" };
    PRICE_NAMES.forEach(function (k) { out[k] = num(v[k]); });
    return out;
  }
  function keyFields(current) {
    current = current || {};
    var placeholder = function (masked, fallback) { return masked ? "Saved: " + masked + " (leave blank to keep)" : fallback; };
    return [
      h("fieldset", null, h("legend", null, "Paystack · cards, bank, M-Pesa"),
        h("p", { class: "hint" }, "Paystack dashboard → Settings → API Keys & Webhooks."),
        h("div", { class: "grid-2" },
          field("Secret key", input("paystack_secret_key", { type: "password", placeholder: placeholder(current.paystack_secret_key, "sk_live_…"), pattern: "sk_.*", title: "Starts with sk_" })),
          field("Public key", input("paystack_public_key", { placeholder: current.paystack_secret_key ? "Leave blank to keep" : "pk_live_…", pattern: "pk_.*", title: "Starts with pk_" })))),
      h("fieldset", null, h("legend", null, "NOWPayments · crypto"),
        h("p", { class: "hint" }, "NOWPayments dashboard → Settings → Payments (API key) and IPN settings (IPN secret)."),
        h("div", { class: "grid-2" },
          field("API key", input("nowpayments_api_key", { type: "password", placeholder: placeholder(current.nowpayments_api_key, "Your API key") })),
          field("IPN secret", input("nowpayments_ipn_secret", { type: "password", placeholder: current.nowpayments_ipn_secret_set ? "Saved (leave blank to keep)" : "Your IPN secret" })))),
    ];
  }
  var KEY_NAMES = ["paystack_secret_key", "paystack_public_key", "nowpayments_api_key", "nowpayments_ipn_secret"];

  function viewNewBot() {
    var token = input("bot_token", { type: "password", required: true, spellcheck: "false", placeholder: "123456789:AA…" });
    setMain(pageHead("Add a bot", "It takes about five minutes. You can change everything later."),
      panel(null, null, form(function (v) {
        var body = priceBody(v);
        body.bot_token = v.bot_token; body.currency = v.currency;
        if (v.currency !== "USD") body.fx_rate = num(v.fx_rate);
        KEY_NAMES.forEach(function (k) { if (v[k]) body[k] = v[k]; });
        if (v.welcome_title) body.welcome_title = v.welcome_title;
        if (v.welcome_text) body.welcome_text = v.welcome_text;
        if (v.admin_user_ids) body.admin_user_ids = v.admin_user_ids;
        if (!KEY_NAMES.some(function (k) { return body[k]; })) throw new Error("Add Paystack or NOWPayments keys so buyers can pay.");
        return api("POST", "/api/v1/bots", body).then(showCreated);
      }, [
        h("fieldset", null, h("legend", null, "Telegram bot"),
          field("Bot token", token, "In Telegram, message @BotFather, send /newbot, follow the steps and paste the token here."),
          field("Your Telegram user ID (optional)", input("admin_user_ids", { inputmode: "numeric", placeholder: "e.g. 123456789" }), "Lets the bot recognise you as its admin. Get it from @userinfobot.")),
        h("fieldset", null, h("legend", null, "Prices"), pricingFields("USD")),
        keyFields(),
        h("fieldset", null, h("legend", null, "Welcome message (optional)"),
          field("Title", input("welcome_title", { maxlength: 256, placeholder: "VIP Access Required" })),
          field("Message", textarea("welcome_text", "", { maxlength: 2000, placeholder: "Pay to unlock this exclusive group." }))),
      ], "Create bot")));
    token.focus();
  }

  function showCreated(res) {
    setMain(pageHead((res.bot_username || "Your bot") + " is running"),
      h("div", { class: "banner ok" }, "Buyers can pay with: " + (res.payment_providers.length ? res.payment_providers.map(function (p) { return PROVIDER[p] || p; }).join(", ") : "nothing yet")),
      (res.notes || []).map(function (n) { return h("p", { class: "banner warn" }, n); }),
      panel("Finish setup", null, h("ol", { class: "steps" },
        h("li", null, h("div", { class: "stack" }, h("span", null, h("b", null, "Add the bot to your group as an admin "), "with the Ban users permission. The group links itself."))),
        h("li", null, h("div", { class: "stack" }, h("span", null, h("b", null, "Paste this into Paystack "), "(Settings → API Keys & Webhooks → Webhook URL):"), copyField(res.webhooks.paystack))),
        h("li", null, h("div", null, h("b", null, "Check the connection "), "on the bot's page to see that everything is working.")))),
      h("div", { class: "row" }, h("a", { class: "btn primary", href: "#bot/" + encodeURIComponent(res.bot_id) }, "Open bot page")));
  }

  function viewBot(id) {
    loading();
    var path = "/api/v1/bots/" + encodeURIComponent(id);
    Promise.all([api("GET", path), api("GET", path + "/members?limit=100")]).then(function (r) {
      var b = r[0], members = r[1];
      var isOwner = b.id === "owner";
      var name = b.bot_username || "Bot";

      // Header actions
      var actions = h("div", { class: "row" });
      if (b.status === "active" || b.status === "paused") {
        actions.appendChild(h("button", { type: "button", class: "btn", onclick: function (e) {
          e.target.disabled = true;
          api("PATCH", path, { status: b.status === "active" ? "paused" : "active" })
            .then(function () { toast(b.status === "active" ? "Paused. Buyers can't pay until you resume." : "Selling again."); route(); })
            .catch(function (err) { toast(err.message, true); e.target.disabled = false; });
        } }, b.status === "active" ? "Pause sales" : "Resume sales"));
      }

      // Connection check
      var checkList = h("ul", { class: "checks" });
      var verdict = h("p", { class: "muted" }, "Checks your bot token, group and payment keys with Telegram and each provider.");
      var checkBtn = h("button", { type: "button", class: "btn primary" }, "Check connection");
      checkBtn.addEventListener("click", function () {
        checkBtn.disabled = true; verdict.textContent = "Checking…"; verdict.className = "muted";
        api("GET", path + "/check").then(function (res) {
          verdict.textContent = res.ready ? "✓ Ready to take payments." : "Not ready yet. Fix the items marked ✗.";
          verdict.className = res.ready ? "banner ok" : "banner bad";
          renderChecks(checkList, res);
        }).catch(function (err) { verdict.textContent = err.message; verdict.className = "banner bad"; })
          .then(function () { checkBtn.disabled = false; });
      });

      // Webhooks
      var hooks = [h("div", { class: "stack" }, h("p", null, h("b", null, "Paystack: "), "paste this in Settings → API Keys & Webhooks → Webhook URL."), copyField(b.webhooks.paystack)),
        h("p", null, h("b", null, "NOWPayments: "), "nothing to paste. The bot sends this address with every payment.")];
      if (b.credentials && b.credentials.btcpay_url) hooks.push(h("div", { class: "stack" }, h("p", null, h("b", null, "BTCPay: "), "add this as a webhook in your store settings."), copyField(b.webhooks.btcpay)));

      // Settings
      // Only changed fields are sent, so settings that live in Cloudflare
      // (for the owner bot) don't block saving the others.
      var adminIds = (b.admin_user_ids || []).join(", ");
      var original = { daily_price: b.prices.daily, weekly_price: b.prices.weekly, one_time_price: b.prices.one_time, monthly_price: b.prices.monthly, image_unlock_price: b.prices.image_vault, price_currency: b.prices.currency || "USD", currency: b.currency || "USD", fx_rate: b.fx_rate, welcome_title: b.welcome_title || null, welcome_text: b.welcome_text || null, group_description: b.group_description || null, admin_user_ids: adminIds };
      var settings = form(function (v) {
        var next = priceBody(v);
        Object.assign(next, { currency: v.currency, welcome_title: v.welcome_title || null, welcome_text: v.welcome_text || null, group_description: v.group_description || null, admin_user_ids: v.admin_user_ids.replace(/\s+/g, "").replace(/,/g, ", ") });
        if (v.currency !== "USD") next.fx_rate = num(v.fx_rate);
        var body = {};
        Object.keys(next).forEach(function (k) { if (next[k] !== undefined && next[k] !== original[k]) body[k] = next[k]; });
        if (!Object.keys(body).length) { toast("No changes to save."); return; }
        return api("PATCH", path, body).then(function () { Object.keys(body).forEach(function (k) { original[k] = body[k]; }); toast("Saved."); });
      }, [
        isOwner ? h("p", { class: "hint" }, "Prices or currency you set in Cloudflare (ONE_TIME_PRICE_USD, MONTHLY_PRICE_USD, PAYSTACK_CURRENCY…) can only be changed there.") : null,
        pricingFields(b.currency, b.fx_rate, b.prices),
        field("Welcome title", input("welcome_title", { maxlength: 256, value: b.welcome_title || "", placeholder: "VIP Access Required" })),
        field("Welcome message", textarea("welcome_text", b.welcome_text, { maxlength: 2000, placeholder: "Pay to unlock this exclusive group." })),
        field("Group description (optional)", textarea("group_description", b.group_description, { maxlength: 2000 }), "Shown under the welcome message."),
        field("Bot admins (Telegram user IDs)", input("admin_user_ids", { value: adminIds, placeholder: "e.g. 123456789", inputmode: "numeric" }), "Admins can use /stats, /grant and /broadcast, and add content by sending it to the bot. Separate several IDs with commas. Get yours from @userinfobot."),
      ], "Save changes");

      // Payment keys
      var keys = isOwner ? h("p", { class: "muted" }, "Your own bot's keys are Cloudflare secrets. Change them in Cloudflare → Workers & Pages → telegram-paywall-bot → Settings → Variables and Secrets.")
        : form(function (v, f) {
          var body = {};
          KEY_NAMES.forEach(function (k) { if (v[k]) body[k] = v[k]; });
          if (!Object.keys(body).length) throw new Error("Type a new key to replace the saved one.");
          return api("PATCH", path, body).then(function () { toast("Keys saved."); f.reset(); route(); });
        }, keyFields(b.credentials), "Save keys");

      // Members
      var memberBox = h("div");
      var renderMembers = function (page) {
        memberBox.textContent = "";
        if (!page.members.length) { memberBox.appendChild(h("p", { class: "empty" }, "No paying members yet.")); return; }
        var rows = page.members.map(function (m) {
          var who = [m.first_name, m.username ? "@" + m.username : null].filter(Boolean).join(" · ") || "Unknown";
          var revoke = confirmButton("Remove access", "Confirm", function () {
            return api("POST", path + "/members/" + m.telegram_id + "/revoke").then(function () { toast("Access removed."); route(); });
          }, "danger");
          return h("tr", null, h("td", null, h("div", null, who), h("div", { class: "hint mono" }, String(m.telegram_id))),
            h("td", null, ACCESS[m.access_type] || m.access_type || "—"),
            h("td", null, m.access_expires ? "until " + day(m.access_expires) : "no end date"),
            h("td", { class: "num" }, revoke));
        });
        memberBox.appendChild(h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Member"), h("th", null, "Plan"), h("th", null, "Access"), h("th", { class: "num" }, ""))),
          h("tbody", null, rows))));
        if (page.total > page.members.length) memberBox.appendChild(h("p", { class: "hint" }, "Showing " + page.members.length + " of " + page.total + ". Search to find someone."));
      };
      renderMembers(members);
      var search = input("search", { type: "search", placeholder: "Search by name or @username" });
      var searchTimer = null;
      search.addEventListener("input", function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          api("GET", path + "/members?limit=100&search=" + encodeURIComponent(search.value.trim())).then(renderMembers).catch(function (err) { toast(err.message, true); });
        }, 300);
      });
      var grant = form(function (v) {
        return api("POST", path + "/members/" + encodeURIComponent(v.telegram_id) + "/grant").then(function () { toast("Free access given."); route(); });
      }, [field("Give someone free access", input("telegram_id", { inputmode: "numeric", required: true, pattern: "[0-9]+", title: "A number", placeholder: "Their Telegram user ID" }), "They get lifetime access. They can find their ID with @userinfobot.")], "Give access", "");

      // Coins and content
      var packs = (b.coins && b.coins.packs) || [];
      var packRow = function (i) {
        var p = packs[i] || {};
        return h("div", { class: "grid-2" },
          field("Pack " + (i + 1) + " coins", input("pack_coins_" + i, { type: "number", min: "1", step: "1", value: p.coins || "", placeholder: i === 0 ? "e.g. 50" : "Leave blank for no pack" })),
          field("Pack " + (i + 1) + " price ($)", input("pack_price_" + i, { type: "number", min: "0.5", step: "0.01", value: p.price || "", placeholder: i === 0 ? "e.g. 3" : "" })));
      };
      var preview = h("p", { class: "banner info" });
      var coinsForm = form(function (v) {
        var list = [];
        for (var i = 0; i < 3; i++) {
          var c = v["pack_coins_" + i], pr = v["pack_price_" + i];
          if (c === "" && pr === "") continue;
          if (c === "" || pr === "") throw new Error("Pack " + (i + 1) + " needs both a number of coins and a price.");
          list.push({ coins: Number(c), price: Number(pr) });
        }
        var body = { coins_enabled: v.coins_enabled === "on", free_coins: Number(v.free_coins), unlock_cost: Number(v.unlock_cost), coin_packs: list };
        if (body.coins_enabled && !list.length) throw new Error("Add at least one coin pack so people can buy more coins.");
        return api("PATCH", path, body).then(function () { toast(body.coins_enabled ? "Coins are on." : "Coins are off."); });
      }, [
        field("Coins", select("coins_enabled", [["off", "Off"], ["on", "On: free allowance plus coin packs"]], b.coins && b.coins.enabled ? "on" : "off")),
        h("div", { class: "grid-2" },
          field("Free coins for each new person", input("free_coins", { type: "number", min: "0", max: "100000", step: "1", required: true, value: b.coins ? b.coins.free_coins : 15 }), "Given once per Telegram account."),
          field("Coins to unlock one item", input("unlock_cost", { type: "number", min: "1", max: "100000", step: "1", required: true, value: b.coins ? b.coins.unlock_cost : 5 }))),
        preview,
        packRow(0), packRow(1), packRow(2),
        h("p", { class: "hint" }, "Members on a monthly or lifetime plan unlock everything free, so the plans work as the “go unlimited” option. Coins never expire."),
      ], "Save coin settings");
      var updatePreview = function () {
        var v = values(coinsForm);
        var free = Number(v.free_coins) || 0, cost = Math.max(1, Number(v.unlock_cost) || 1);
        var first = Number(v.pack_coins_0) || 0, firstPrice = Number(v.pack_price_0) || 0;
        var text = "New people get " + plural(Math.floor(free / cost), "free unlock") + ".";
        if (first && firstPrice) text += " The first pack buys " + plural(Math.floor(first / cost), "item") + " for " + money(firstPrice) + " (" + money(firstPrice / Math.max(1, Math.floor(first / cost))) + " each).";
        preview.textContent = text;
      };
      coinsForm.addEventListener("input", updatePreview); updatePreview();
      var contentNote = h("p", { class: "muted" }, b.content_items
        ? plural(b.content_items, "item") + " in your content vault. "
        : "Your content vault is empty. ",
        "To add content, send photos, videos, GIFs or files to " + (b.bot_username || "your bot") + " in a private chat. A caption becomes the teaser people see before unlocking. Only bot admins can add content.");

      // Joining the group
      var joinLinkBox = h("div", { class: "stack" });
      var renderJoinLink = function (link, mode, notes) {
        joinLinkBox.textContent = "";
        (notes || []).forEach(function (n) { joinLinkBox.appendChild(h("p", { class: "banner warn" }, n)); });
        if (mode !== "approve") return;
        if (link) {
          add(joinLinkBox, [h("p", null, h("b", null, "Share this link "), "instead of your old invite link. People who use it ask to join, and the bot lets them in once they've paid."), copyField(link)]);
        } else if (!(notes || []).length) {
          add(joinLinkBox, h("p", { class: "banner warn" }, "No join link yet. Add the bot to your group as an admin with the Invite users via link permission, then save again, or send /joinlink to the bot."));
        }
      };
      renderJoinLink(b.join_link, b.join_mode);
      var passNow = String(b.free_pass_hours || 0);
      var passOptions = [["0", "Off: pay to get in"], ["1", "1 hour"], ["6", "6 hours"], ["24", "1 day"], ["72", "3 days"], ["168", "7 days"]];
      if (!passOptions.some(function (o) { return o[0] === passNow; })) passOptions.push([passNow, passNow + " hours"]);
      var joinForm = form(function (v) {
        var body = {};
        if (v.join_mode !== b.join_mode) body.join_mode = v.join_mode;
        if (Number(v.free_pass_hours) !== Number(b.free_pass_hours || 0)) body.free_pass_hours = Number(v.free_pass_hours);
        if (!Object.keys(body).length) { toast("No changes to save."); return; }
        return api("PATCH", path, body).then(function (res) {
          if (body.free_pass_hours !== undefined) b.free_pass_hours = body.free_pass_hours;
          if (body.join_mode === undefined) { toast(b.free_pass_hours ? "Newcomers now get a free pass." : "Free pass turned off."); return; }
          b.join_mode = v.join_mode; b.join_link = res.join_link || null;
          renderJoinLink(b.join_link, b.join_mode, res.notes);
          toast(v.join_mode === "approve" ? "Only paying people will be let in." : "Anyone can join; unpaid members are muted.");
        });
      }, [
        field("Free pass for newcomers", select("free_pass_hours", passOptions, passNow), "New people get in free for this long, once each. Before it ends the bot offers your plans, and if they don't pay it takes their spot back."),
        field("Who can join", select("join_mode", [["mute", "Anyone can join, unpaid members are muted (read-only)"], ["approve", "People ask to join and are let in only after paying"]], b.join_mode || "mute")),
        h("p", { class: "hint" }, "With approval on, the bot needs the Ban users and Invite users via link admin permissions. When a plan or free pass runs out, the bot removes the member and they can ask to join again after renewing. Revoke your old invite links in Telegram so nobody can skip payment."),
      ], "Save");

      var parts = [
        pageHead(name, (b.group_name ? "Group: " + b.group_name : "No group linked yet. Add the bot to your group as an admin.") , h("div", { class: "row" }, botStatus(b.status), actions)),
        h("div", { class: "tiles" },
          tile("Paying members", String(b.active_members)),
          tile("Sales", b.revenue.gross, "before fees"),
          tile("Platform fee", b.revenue.platform_fee),
          tile("You earned", b.revenue.net)),
        panel("Connection", checkBtn, verdict, checkList),
        panel("Payment webhooks", null, hooks),
        panel("Prices and messages", null, settings),
        panel("Joining the group", null, joinForm, joinLinkBox),
        panel("Coins and content", null, contentNote, coinsForm),
        panel("Payment keys", null, keys),
        panel("Members", null, search, memberBox, grant),
      ];
      if (!isOwner) {
        var confirmInput = input("confirm", { placeholder: "Type DELETE" });
        var del = h("button", { type: "button", class: "btn danger" }, "Delete this bot");
        del.addEventListener("click", function () {
          if (confirmInput.value.trim() !== "DELETE") { toast("Type DELETE first.", true); confirmInput.focus(); return; }
          del.disabled = true;
          api("DELETE", path).then(function () { toast("Bot deleted."); go("bots"); }).catch(function (err) { toast(err.message, true); del.disabled = false; });
        });
        parts.push(panel("Delete bot", null, h("p", { class: "muted" }, "The bot stops working and its keys are erased. Your payment history is kept."), h("div", { class: "row" }, h("div", { class: "narrow" }, confirmInput), del)));
      }
      setMain(parts);
    }).catch(failed);
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  function viewPayments() {
    loading();
    var PAGE = 50;
    Promise.all([api("GET", "/api/v1/analytics/payments?limit=" + PAGE), api("GET", "/api/v1/bots")]).then(function (r) {
      var names = {};
      r[1].bots.forEach(function (b) { names[b.id] = b.bot_username ? "@" + String(b.bot_username).replace(/^@/, "") : b.id; });
      var tbody = h("tbody");
      var shown = 0;
      var more = h("button", { type: "button", class: "btn" }, "Load more");
      var addRows = function (page) {
        page.payments.forEach(function (p) {
          tbody.appendChild(h("tr", null,
            h("td", null, day(p.confirmed_at || p.created_at)),
            h("td", null, names[p.bot_id] || p.bot_id),
            h("td", { class: "mono" }, String(p.telegram_id)),
            h("td", null, p.access_type === "coin_pack" && p.coins ? p.coins + " coins" : ACCESS[p.access_type] || p.access_type),
            h("td", null, PROVIDER[p.provider] || p.provider),
            h("td", { class: "num" }, money(p.gross)),
            h("td", { class: "num" }, money(p.platform_fee)),
            h("td", { class: "num" }, money(p.net))));
        });
        shown += page.payments.length;
        more.hidden = shown >= page.total;
      };
      more.addEventListener("click", function () {
        more.disabled = true;
        api("GET", "/api/v1/analytics/payments?limit=" + PAGE + "&offset=" + shown).then(addRows).catch(function (err) { toast(err.message, true); }).then(function () { more.disabled = false; });
      });
      var first = r[0];
      if (!first.total) { setMain(pageHead("Payments"), panel(null, null, h("p", { class: "empty" }, "No payments yet. They appear here as soon as a buyer pays."))); return; }
      addRows(first);
      setMain(pageHead("Payments", plural(first.total, "confirmed payment") + ". Amounts in US dollars."),
        panel(null, null, h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Date"), h("th", null, "Bot"), h("th", null, "Buyer ID"), h("th", null, "Plan"), h("th", null, "Paid with"), h("th", { class: "num" }, "Paid"), h("th", { class: "num" }, "Fee"), h("th", { class: "num" }, "You get"))),
          tbody)), h("div", { class: "row" }, more)));
    }).catch(failed);
  }

  // ── Account ───────────────────────────────────────────────────────────────

  /** Pick a payment method and get a link to the provider's page. */
  function payControls(providers, label, path) {
    var box = h("div", { class: "stack" });
    if (!providers.length) { box.appendChild(h("p", { class: "hint" }, "Online payment isn't set up yet." + (PLATFORM.contact ? " Contact " + PLATFORM.contact + "." : ""))); return box; }
    var names = { paystack: "Card, bank or M-Pesa (Paystack)", nowpayments: "Crypto (NOWPayments)", btcpay: "Bitcoin (BTCPay)" };
    var result = h("div");
    var f = form(function (v) {
      return api("POST", path, { provider: v.provider }).then(function (res) {
        result.textContent = "";
        add(result, h("div", { class: "row" },
          h("a", { class: "btn primary", href: res.payment_url, target: "_blank", rel: "noopener" }, "Open payment page (" + money(res.amount) + ")"),
          h("span", { class: "hint" }, "Come back here after paying. It updates within a minute of the payment confirming.")));
      });
    }, [field("Pay with", select("provider", providers.map(function (p) { return [p, names[p] || p]; }), providers[0]))], label);
    add(box, [f, result]);
    return box;
  }

  function recoveryPanel(me) {
    var current = me.recovery_telegram_id;
    var f = form(function (v) {
      var value = v.recovery_telegram_id === "" ? null : Number(v.recovery_telegram_id);
      return api("PATCH", "/api/v1/tenants/me", { recovery_telegram_id: value }).then(function () { toast(value ? "Recovery account saved." : "Recovery account removed."); });
    }, [field("Your Telegram user ID", input("recovery_telegram_id", { inputmode: "numeric", pattern: "[0-9]*", title: "Numbers only", value: current || "", placeholder: "e.g. 123456789" }), "Get it from @userinfobot. Only this Telegram account can get a new key.")], "Save");
    return panel("Lost your key?", null,
      h("p", { class: "muted" }, "If you lose your key, send ", h("code", null, "/accountkey"), " to any of your bots in a private chat from this Telegram account. The bot replies with a new key straight away and your old key stops working."),
      current ? null : h("p", { class: "banner warn" }, "No recovery account set yet. Add one now so you can't get locked out."),
      f);
  }

  function billingPanel(b, me) {
    var rows = [];
    if (b.billing_hold) rows.push(h("p", { class: "banner bad" }, "Your bots have stopped selling because " + money(b.fees_owed_usd) + " in platform fees is unpaid. Pay below and sales restart straight away."));
    rows.push(h("div", { class: "tiles" },
      tile("Platform fees owed", money(b.fees_owed_usd), b.fee_limit_usd ? "sales pause at " + money(b.fee_limit_usd) : "pay any time"),
      tile("Fees paid so far", money(b.fees_paid_usd)),
      tile("Plan", planName(me.tier), b.plan_expires ? "renews by " + day(b.plan_expires) : me.platform_cut + " per sale")));
    if (b.fees_owed_usd >= 1) rows.push(payControls(b.payment_providers, "Pay " + money(b.fees_owed_usd), "/api/v1/tenants/pay-fees"));
    if (b.can_buy_starter) {
      rows.push(h("div", { class: "stack" },
        h("h3", null, me.tier === "starter" ? "Renew Starter" : "Upgrade to Starter"),
        h("p", { class: "muted" }, money(b.starter_price_usd) + " for " + b.plan_days + " days: unlimited bots and members, and a lower fee on every sale." + (me.tier === "starter" ? " Renewing adds " + b.plan_days + " days to your current plan." : "")),
        payControls(b.payment_providers, me.tier === "starter" ? "Renew" : "Upgrade", "/api/v1/tenants/upgrade")));
    } else if (me.tier === "free") {
      rows.push(h("p", null, PLATFORM.contact ? "To upgrade, contact " + PLATFORM.contact + " and quote your account ID:" : "To upgrade, contact the platform owner and quote your account ID:"), copyField(me.id));
    }
    return panel("Plan and billing", null, rows);
  }
  var billingPlaceholder = null;

  function viewAccount() {
    loading();
    var billing = state.admin ? Promise.resolve(null) : api("GET", "/api/v1/tenants/billing");
    Promise.all([api("GET", "/api/v1/tenants/me"), billing]).then(function (r) {
      var me = r[0];
      billingPlaceholder = r[1] ? billingPanel(r[1], me) : null;
      state.me = me;
      var mcp = location.origin + "/mcp";
      var parts = [pageHead("Account", me.email)];
      parts.push(h("div", { class: "tiles" },
        tile("Plan", state.admin ? "Owner" : planName(me.tier), me.platform_cut + " fee per sale" + nextRate(me)),
        tile("Total sales", me.total_gross, "before fees"),
        tile("You earned", me.net_earned, me.platform_fees + " in fees")));
      if (!state.admin) {
        var keyBox = h("div", { class: "stack" }, h("p", null, "Your key starts with ", h("code", null, me.api_key_hint), ". Get a new one if you think someone else has it. The old key stops working straight away, and any connected AI assistant has to sign in again."));
        keyBox.appendChild(h("div", { class: "row" }, confirmButton("Get a new key", "Yes, replace my key", function () {
          return api("POST", "/api/v1/tenants/rotate-key").then(function (res) {
            state.key = res.api_key; storeSet(res.api_key);
            keyBox.textContent = "";
            add(keyBox, [h("p", { class: "banner warn" }, "Copy your new key now. It won't be shown again."), copyField(res.api_key, "secret-key")]);
          });
        }, "danger")));
        parts.push(panel("Account key", null, keyBox));
        parts.push(recoveryPanel(me));
        parts.push(billingPlaceholder);
      }
      parts.push(panel("Use with Claude", null,
        h("p", { class: "muted" }, "Manage your bots by chatting with Claude or another AI assistant: “who paid this week?”, “raise the monthly price to $8”."),
        h("ol", { class: "steps" },
          h("li", null, h("div", null, "In Claude, open Settings → Connectors → Add custom connector.")),
          h("li", null, h("div", { class: "stack" }, h("span", null, "Paste this address and select Add, then Connect:"), copyField(mcp))),
          h("li", null, h("div", null, "Sign in with your account key when asked.")))));
      setMain(parts);
    }).catch(failed);
  }

  // ── Creators (platform owner) ─────────────────────────────────────────────

  function viewCreators() {
    loading();
    api("GET", "/admin/tenants").then(function (res) {
      var list = res.tenants;
      var owed = list.reduce(function (s, t) { return s + (t.fees_owed_usd || 0); }, 0);
      var rows = list.map(function (t) {
        var detail = h("tr", { hidden: true });
        var manageBtn = h("button", { type: "button", class: "btn small" }, "Manage");
        manageBtn.addEventListener("click", function () { detail.hidden = !detail.hidden; manageBtn.textContent = detail.hidden ? "Manage" : "Close"; });
        var planForm = form(function (v) {
          var body = { tier: v.tier };
          if (v.custom_cut !== "") body.platform_cut = Number(v.custom_cut) / 100;
          return api("POST", "/admin/tenants/" + encodeURIComponent(t.id) + "/tier", body).then(function (r2) { toast(r2.message); viewCreators(); });
        }, [h("div", { class: "grid-2" },
          field("Plan", select("tier", [["free", "Standard (rate falls with volume)"], ["starter", "Starter"], ["whitelabel", "White label"]], t.tier)),
          field("Custom fee % (optional)", input("custom_cut", { type: "number", min: "0", max: "100", step: "0.5", placeholder: "Plan default" })))], "Change plan");
        var splitForm = form(function (v) {
          return api("POST", "/admin/tenants/" + encodeURIComponent(t.id) + "/paystack-subaccount", { code: v.code || null }).then(function (r2) { toast(r2.message); viewCreators(); });
        }, [field("Paystack split code", input("code", { value: t.paystack_subaccount_code || "", placeholder: "ACCT_…", pattern: "ACCT_[A-Za-z0-9]+", title: "Looks like ACCT_xxxxxxxx" }), "Optional. A subaccount in the creator's Paystack that pays your fee to you automatically. Leave blank to remove.")], "Save split", "");
        var paidForm = form(function (v) {
          return api("POST", "/admin/tenants/" + encodeURIComponent(t.id) + "/fees-paid", { amount: Number(v.amount) }).then(function (r2) { toast(r2.message); viewCreators(); });
        }, [field("Record fees paid outside the dashboard ($)", input("amount", { type: "number", step: "0.01", required: true, placeholder: "e.g. 25" }), "For cash or bank transfers. A negative amount corrects a mistake.")], "Record payment", "");
        var keyBox = h("div", { class: "stack" });
        var resetKey = confirmButton("Reset their key", "Confirm reset", function () {
          return api("POST", "/admin/tenants/" + encodeURIComponent(t.id) + "/rotate-key").then(function (r2) {
            keyBox.textContent = "";
            add(keyBox, [h("p", { class: "banner warn" }, "Send this key to the creator privately. It won't be shown again."), copyField(r2.api_key, "secret-key")]);
          });
        }, "");
        var suspend = confirmButton(t.active ? "Suspend creator" : "Restore creator", "Confirm", function () {
          return api("POST", "/admin/tenants/" + encodeURIComponent(t.id) + "/active", { active: !t.active }).then(function (r2) { toast(r2.message); viewCreators(); });
        }, t.active ? "danger" : "");
        detail.appendChild(h("td", { colspan: "6" }, h("div", { class: "stack" },
          h("div", { class: "grid-2" }, planForm, splitForm),
          h("div", { class: "grid-2" }, paidForm, h("div", { class: "stack" }, h("p", { class: "muted" }, "Owed " + money(t.fees_owed_usd) + " · paid " + money(t.fees_paid_usd) + (t.plan_expires ? " · plan until " + day(t.plan_expires) : "")), keyBox)),
          h("div", { class: "row" }, resetKey, suspend, h("span", { class: "hint mono" }, "ID " + t.id)))));
        return [h("tr", null,
          h("td", null, h("div", null, h("b", null, t.name)), h("div", { class: "hint" }, t.email)),
          h("td", null, planName(t.tier) + " · " + Math.round(t.platform_cut * 100) + "%"),
          h("td", null, !t.active ? pill("Suspended", "bad") : t.billing_hold ? pill("Fees unpaid", "warn") : pill("Active", "ok")),
          h("td", { class: "num" }, String(t.bots)),
          h("td", { class: "num" }, money(t.processed_usd), h("div", { class: "hint" }, money(t.fees_owed_usd) + " owed")),
          h("td", { class: "num" }, manageBtn)), detail];
      });
      setMain(pageHead("Creators", plural(res.total, "creator") + " · " + money(owed) + " in fees owed to you"),
        h("p", { class: "banner info" }, "Creators are paid directly by their buyers and pay their fees to you from their dashboard (Account → Pay fees). Fees from creators with a Paystack split code reach you automatically."),
        panel(null, null, list.length ? h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Creator"), h("th", null, "Plan"), h("th", null, "Status"), h("th", { class: "num" }, "Bots"), h("th", { class: "num" }, "Sales"), h("th", { class: "num" }, ""))),
          h("tbody", null, rows))) : h("p", { class: "empty" }, "No creators yet. Share " + location.origin + " so they can sign up.")));
    }).catch(failed);
  }

  // ── Start ─────────────────────────────────────────────────────────────────

  window.addEventListener("hashchange", route);
  var saved = storeGet();
  if (saved) {
    signIn(saved).then(route, function () { storeSet(null); route(); });
  } else {
    route();
  }
})();
`;
