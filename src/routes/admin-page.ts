/**
 * A small page at /admin for running setup and credential checks from a
 * browser, so no command line is needed. The admin key is typed in, kept in
 * memory only, and sent as a header with each request.
 */
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Paywall Bot — Admin</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#15181d; --muted:#5b6472; --line:#dde1e7; --accent:#1f6feb; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0e1116; --card:#161b22; --text:#e6edf3; --muted:#9aa4b1; --line:#2b323c; --accent:#58a6ff; --ok:#3fb950; --bad:#ff7b72; --warn:#d29922; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:720px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  p.lead { color:var(--muted); margin:0 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  label { display:block; font-weight:600; margin-bottom:6px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  .row { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  button { padding:10px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; font-weight:600; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.55; cursor:progress; }
  button:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  #verdict { font-weight:700; margin:0 0 8px; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:10px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  li:first-child { border-top:0; }
  .name { font-weight:600; }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .skip { color:var(--muted); }
  .detail { color:var(--muted); font-size:.93rem; }
  .detail.warn { color:var(--warn); }
  code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.88rem; }
  pre { margin:0; padding:12px; background:var(--bg); border-radius:8px; overflow-x:auto; font-size:.82rem; }
  details { margin-top:12px; } summary { cursor:pointer; color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Paywall Bot — Admin</h1>
  <p class="lead">Run setup after each change to your secrets, then check that everything is connected.</p>

  <div class="card">
    <label for="key">Admin key</label>
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="The ADMIN_API_KEY secret you set in Cloudflare">
    <div class="row">
      <button class="primary" data-method="POST" data-path="/admin/setup">Run setup</button>
      <button data-method="GET" data-path="/admin/check-credentials">Check credentials</button>
      <button data-method="GET" data-path="/admin/overview">Platform overview</button>
    </div>
  </div>

  <div class="card" id="out" hidden>
    <p id="verdict"></p>
    <ul id="list"></ul>
    <details id="more"><summary>Full response</summary><pre id="raw"></pre></details>
  </div>
</main>
<script>
(function () {
  var out = document.getElementById("out");
  var verdict = document.getElementById("verdict");
  var list = document.getElementById("list");
  var raw = document.getElementById("raw");
  var more = document.getElementById("more");
  var buttons = Array.prototype.slice.call(document.querySelectorAll("button[data-path]"));

  function line(name, cls, mark, detail, extra) {
    var li = document.createElement("li");
    var head = document.createElement("div");
    var badge = document.createElement("span");
    badge.className = cls; badge.textContent = mark + " ";
    var title = document.createElement("span");
    title.className = "name"; title.textContent = name;
    head.appendChild(badge); head.appendChild(title);
    li.appendChild(head);
    if (detail) { var d = document.createElement("div"); d.className = "detail"; d.textContent = detail; li.appendChild(d); }
    (extra || []).forEach(function (text) {
      var e = document.createElement("div"); e.className = "detail warn"; e.textContent = text; li.appendChild(e);
    });
    list.appendChild(li);
  }

  function render(status, body) {
    out.hidden = false; list.textContent = "";
    raw.textContent = JSON.stringify(body, null, 2);
    if (status >= 400) {
      more.open = false;
      verdict.className = "bad";
      verdict.textContent = "Error " + status + ": " + (body && body.detail ? body.detail : "request failed");
      return;
    }
    var scope = body.owner_bot || body;
    var checks = scope.checks;
    more.open = !checks;
    if (!checks) { verdict.className = ""; verdict.textContent = "Done — details below."; return; }
    verdict.className = scope.ready ? "ok" : "bad";
    verdict.textContent = scope.ready ? "Ready to take payments." : "Not ready yet — see the items marked ✗ below.";
    Object.keys(checks).forEach(function (name) {
      var c = checks[name];
      var cls = c.ok === true ? "ok" : c.ok === false ? "bad" : "skip";
      var mark = c.ok === true ? "✓" : c.ok === false ? "✗" : "–";
      var extra = (c.warnings || []).slice();
      Object.keys(c).forEach(function (k) {
        if (k.indexOf("webhook_url_to_set") === 0) extra.push("Webhook URL to paste into the provider dashboard: " + c[k]);
      });
      line(name.replace(/_/g, " "), cls, mark, c.detail, extra);
    });
  }

  buttons.forEach(function (button) {
    button.addEventListener("click", function () {
      var key = document.getElementById("key").value.trim();
      if (!key) { render(400, { detail: "Enter your admin key first." }); return; }
      buttons.forEach(function (b) { b.disabled = true; });
      fetch(button.dataset.path, { method: button.dataset.method, headers: { "x-admin-key": key } })
        .then(function (res) { return res.json().then(function (body) { render(res.status, body); }); })
        .catch(function (err) { render(500, { detail: String(err) }); })
        .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
    });
  });
})();
</script>
</body>
</html>`;
