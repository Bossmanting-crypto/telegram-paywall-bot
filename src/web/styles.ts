/** Stylesheet shared by the public landing page and the creator dashboard (served at /assets/app.css). */
export const APP_CSS = String.raw`
:root {
  --bg: #f4f5f2; --surface: #ffffff; --ink: #16201d; --muted: #5c6863; --line: #d9ddd8;
  --accent: #0d7a68; --accent-ink: #ffffff; --accent-soft: #e1f1ec;
  --ok: #1b7f3b; --ok-soft: #e3f2e7; --bad: #c0362c; --bad-soft: #fbe7e5; --warn: #8a5a00; --warn-soft: #fbf0d9;
  --chat: #e7eef5; --bubble: #ffffff; --tg: #2b7fd0;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --radius: 10px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1513; --surface: #161e1b; --ink: #e5ece9; --muted: #95a29d; --line: #2a3531;
    --accent: #3cc2a8; --accent-ink: #07201b; --accent-soft: #143029;
    --ok: #4cc27a; --ok-soft: #13301f; --bad: #ff7a6e; --bad-soft: #3a1a17; --warn: #e0b04a; --warn-soft: #33280f;
    --chat: #1b2530; --bubble: #232f3b; --tg: #6ab2f2;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 var(--sans); }
a { color: var(--accent); }
h1, h2, h3 { line-height: 1.15; margin: 0; text-wrap: balance; }
h1 { font-size: clamp(1.7rem, 4.5vw, 2.6rem); letter-spacing: -0.02em; }
h2 { font-size: 1.25rem; letter-spacing: -0.01em; }
h3 { font-size: 1rem; }
p { margin: 0; }
code, .mono { font-family: var(--mono); font-size: .88em; }
.muted { color: var(--muted); }
.wrap { max-width: 1040px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.stack { display: grid; gap: 16px; }
.stack-lg { display: grid; gap: 28px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.spread { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.spread > * { min-width: 0; }

/* Top bar */
.topbar { background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
.topbar .wrap { display: flex; align-items: center; gap: 16px; min-height: 58px; flex-wrap: wrap; padding-block: 6px; }
.brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; color: var(--ink); text-decoration: none; letter-spacing: -0.01em; }
.brand-mark { width: 26px; height: 26px; border-radius: 7px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: 14px; }
.nav { display: flex; flex-wrap: wrap; gap: 2px; margin-left: auto; }
.nav a, .nav button { color: var(--muted); text-decoration: none; padding: 7px 11px; border-radius: 8px; font: inherit; font-size: .95rem; background: none; border: 0; cursor: pointer; }
.nav a:hover, .nav button:hover { color: var(--ink); background: var(--bg); }
.nav a[aria-current="page"] { color: var(--ink); background: var(--accent-soft); font-weight: 600; }

/* Buttons and forms */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 15px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: inherit; font-weight: 600; font-size: .95rem; cursor: pointer; text-decoration: none; line-height: 1.2; }
.btn:hover { border-color: var(--muted); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { filter: brightness(1.06); }
.btn.danger { color: var(--bad); border-color: var(--bad); background: var(--surface); }
.btn.danger.solid { background: var(--bad); color: #fff; }
.btn.small { padding: 5px 10px; font-size: .85rem; }
.btn.big { padding: 13px 22px; font-size: 1.05rem; }
.btn:disabled { opacity: .55; cursor: progress; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
form { display: grid; gap: 14px; }
.field { display: grid; gap: 5px; min-width: 0; }
.field label { font-weight: 600; font-size: .92rem; }
.hint { color: var(--muted); font-size: .85rem; }
input, select, textarea { width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; font-size: .95rem; }
textarea { min-height: 84px; resize: vertical; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 640px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 12px; min-width: 0; }
legend { font-weight: 700; padding: 0; margin-bottom: 4px; }
.form-error { color: var(--bad); background: var(--bad-soft); padding: 9px 12px; border-radius: 8px; font-size: .92rem; }
.narrow { max-width: 220px; width: 100%; }
.check { display: flex; gap: 10px; align-items: flex-start; font-size: .95rem; }
.check input { width: auto; margin-top: 4px; }

/* Panels */
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; display: grid; gap: 14px; min-width: 0; }
.panel > *, .stack > *, .stack-lg > *, main > * { min-width: 0; }
.panel-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; }
.page-head { display: grid; gap: 6px; padding-top: 28px; }
.page-head .spread { align-items: flex-start; }
.banner { border-radius: var(--radius); padding: 12px 16px; font-size: .95rem; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
.banner.warn { background: var(--warn-soft); color: var(--warn); }
.banner.bad { background: var(--bad-soft); color: var(--bad); }
.banner.ok { background: var(--ok-soft); color: var(--ok); }
.banner.info { background: var(--accent-soft); color: var(--ink); }

/* Figures */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; display: grid; gap: 4px; align-content: start; }
.tile .label { color: var(--muted); font-size: .85rem; }
.tile .value { font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.tile .note { color: var(--muted); font-size: .85rem; }

/* Status pills */
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: .78rem; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; background: var(--bg); color: var(--muted); }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad { background: var(--bad-soft); color: var(--bad); }

/* Lists and tables */
.list { display: grid; }
.list > * { border-top: 1px solid var(--line); padding: 12px 0; }
.list > *:first-child { border-top: 0; padding-top: 0; }
.bot-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; align-items: center; text-decoration: none; color: inherit; }
.bot-row:hover .bot-name { color: var(--accent); }
.bot-name { font-weight: 700; }
.table-wrap { overflow-x: auto; margin: 0 -4px; padding: 0 4px; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
.empty { color: var(--muted); padding: 18px 0; text-align: center; }

/* Check results */
.checks { list-style: none; padding: 0; margin: 0; display: grid; }
.checks li { padding: 10px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; display: grid; grid-template-columns: 22px 1fr; gap: 2px 8px; }
.checks li:first-child { border-top: 0; }
.checks .mark { font-weight: 700; }
.checks .mark.ok { color: var(--ok); } .checks .mark.bad { color: var(--bad); } .checks .mark.skip { color: var(--muted); }
.checks .name { font-weight: 600; text-transform: capitalize; }
.checks .detail { grid-column: 2; color: var(--muted); font-size: .9rem; }
.checks .detail.warn { color: var(--warn); }

/* Copy field */
.copy { display: flex; gap: 8px; align-items: center; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 6px 6px 12px; min-width: 0; }
.copy code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .85rem; }
.secret-key { font-size: 1rem; }

ol.steps { list-style: none; counter-reset: step; padding: 0; margin: 0; display: grid; gap: 12px; }
ol.steps > li { counter-increment: step; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; align-items: start; }
ol.steps > li::before { content: counter(step); width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: .85rem; display: grid; place-items: center; }

.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(20px + env(safe-area-inset-bottom, 0px)); background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 8px; font-size: .92rem; z-index: 20; max-width: calc(100% - 32px); box-shadow: 0 6px 24px rgba(0,0,0,.18); }
.toast.bad { background: var(--bad); color: #fff; }
.loading { color: var(--muted); padding: 40px 0; text-align: center; }
main { padding-bottom: 64px; }
#app { display: grid; gap: 20px; align-content: start; }
#app > .page-head { padding-bottom: 4px; }

/* Landing */
.hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 40px; align-items: center; padding-block: 56px 40px; }
@media (max-width: 820px) { .hero { grid-template-columns: 1fr; padding-top: 32px; } }
.hero .lead { font-size: 1.12rem; color: var(--muted); max-width: 56ch; }
.chat { background: var(--chat); border-radius: 16px; padding: 18px; display: grid; gap: 10px; max-width: 420px; width: 100%; justify-self: center; }
.chat-title { font-size: .8rem; color: var(--muted); text-align: center; }
.bubble { background: var(--bubble); border-radius: 14px 14px 14px 4px; padding: 12px 14px; display: grid; gap: 8px; font-size: .93rem; box-shadow: 0 1px 1px rgba(0,0,0,.06); }
.bubble .from { color: var(--tg); font-weight: 600; font-size: .85rem; }
.kb { display: grid; gap: 6px; }
.kb span { background: var(--bubble); color: var(--tg); border-radius: 8px; text-align: center; padding: 8px; font-size: .88rem; font-weight: 600; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
.event { text-align: center; font-size: .8rem; color: var(--muted); }
.event b { color: var(--ok); }
.section { padding-block: 36px; display: grid; gap: 20px; }
.plans { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 820px) { .plans { grid-template-columns: 1fr; } }
.plan { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; display: grid; gap: 10px; align-content: start; }
.plan.featured { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.plan .fee { font-size: 2rem; font-weight: 800; letter-spacing: -0.03em; }
.plan .fee small { font-size: .9rem; font-weight: 500; color: var(--muted); letter-spacing: 0; }
.plan ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; color: var(--muted); font-size: .93rem; }
footer { border-top: 1px solid var(--line); padding-block: 24px 40px; color: var(--muted); font-size: .88rem; }
.auth { max-width: 460px; margin: 40px auto 0; }
.tabs { display: grid; grid-template-columns: 1fr 1fr; background: var(--bg); border-radius: 9px; padding: 4px; gap: 4px; }
.tabs a { text-align: center; padding: 8px; border-radius: 7px; text-decoration: none; color: var(--muted); font-weight: 600; font-size: .95rem; }
.tabs a[aria-current="page"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
@media (prefers-reduced-motion: no-preference) { .btn, .nav a, input { transition: background-color .15s, border-color .15s, box-shadow .15s; } }
`;
