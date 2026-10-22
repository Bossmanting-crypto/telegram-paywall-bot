/** Stylesheet shared by the public landing page and the creator dashboard (served at /assets/app.css). */
export const APP_CSS = String.raw`
@font-face { font-family: "Newsreader"; src: url("/assets/fonts/newsreader.woff2") format("woff2"); font-weight: 200 800; font-style: normal; font-display: swap; }
@font-face { font-family: "Newsreader"; src: url("/assets/fonts/newsreader-italic.woff2") format("woff2"); font-weight: 200 800; font-style: italic; font-display: swap; }
@font-face { font-family: "Hanken Grotesk"; src: url("/assets/fonts/hanken-grotesk.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
:root {
  --bg: #f4f5f2; --surface: #ffffff; --ink: #16201d; --muted: #5c6863; --line: #d9ddd8;
  --accent: #0d7a68; --accent-ink: #ffffff; --accent-soft: #e1f1ec;
  --ok: #1b7f3b; --ok-soft: #e3f2e7; --bad: #c0362c; --bad-soft: #fbe7e5; --warn: #8a5a00; --warn-soft: #fbf0d9;
  --chat: #e7eef5; --bubble: #ffffff; --tg: #2b7fd0;
  --sans: "Hanken Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --display: "Newsreader", "Iowan Old Style", Georgia, "Times New Roman", serif;
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
h1, h2 { font-family: var(--display); font-weight: 500; }
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

/* ── Public site: homepage and guides ─────────────────────────────────────── */
/* Layout: an editorial page. Generous whitespace, a serif display voice, one
   Telegram-chat illustration as the hero image, hairline rules instead of boxes. */
.site { --measure: 66ch; }
.site main { padding-bottom: 0; }
.site .topbar { background: color-mix(in srgb, var(--bg) 86%, transparent); backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px); }
.site .nav { align-items: center; gap: 4px; }
.site .nav .btn { margin-left: 6px; }
.eyebrow { font-size: .78rem; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.display { font-family: var(--display); font-weight: 450; letter-spacing: -0.02em; line-height: 1.02; }
.display em { font-style: italic; color: var(--accent); font-weight: 400; }
.hero { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 56px; align-items: center; padding-block: 72px 56px; }
@media (max-width: 860px) { .hero { grid-template-columns: 1fr; gap: 40px; padding-block: 40px 32px; } }
.hero h1 { font-size: clamp(2.7rem, 7vw, 5rem); }
.hero .lead { font-size: clamp(1.05rem, 1.6vw, 1.2rem); color: var(--muted); max-width: 52ch; line-height: 1.6; }
.hero-copy { display: grid; gap: 22px; }
.hero-note { color: var(--muted); font-size: .88rem; }

/* The chat illustration */
.chat { background: var(--chat); border-radius: 22px; padding: 20px 18px; display: grid; gap: 10px; max-width: 400px; width: 100%; justify-self: center; box-shadow: 0 30px 60px -30px color-mix(in srgb, var(--ink) 35%, transparent), 0 0 0 1px var(--line); }
.chat-title { font-size: .78rem; color: var(--muted); text-align: center; letter-spacing: .02em; }
.bubble { background: var(--bubble); border-radius: 16px 16px 16px 4px; padding: 12px 14px; display: grid; gap: 6px; font-size: .92rem; line-height: 1.45; box-shadow: 0 1px 1px rgba(0,0,0,.05); }
.bubble.me { justify-self: end; border-radius: 16px 16px 4px 16px; background: color-mix(in srgb, var(--tg) 14%, var(--bubble)); }
.bubble .from { color: var(--tg); font-weight: 600; font-size: .82rem; }
.kb { display: grid; gap: 6px; }
.kb span { background: var(--bubble); color: var(--tg); border-radius: 10px; text-align: center; padding: 8px; font-size: .86rem; font-weight: 600; box-shadow: 0 1px 1px rgba(0,0,0,.06); }
.event { text-align: center; font-size: .78rem; color: var(--muted); }
.event b { color: var(--ok); font-weight: 600; }
.locked { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.locked .coin { font-variant-numeric: tabular-nums; color: var(--muted); font-size: .85rem; white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) {
  .chat > * { animation: rise .5s both cubic-bezier(.2,.7,.2,1); }
  .chat > *:nth-child(2) { animation-delay: .15s } .chat > *:nth-child(3) { animation-delay: .35s }
  .chat > *:nth-child(4) { animation-delay: .55s } .chat > *:nth-child(5) { animation-delay: .8s }
  .chat > *:nth-child(6) { animation-delay: 1.05s } .chat > *:nth-child(7) { animation-delay: 1.3s }
  @keyframes rise { from { opacity: .001; transform: translateY(6px); } to { opacity: 1; transform: none; } }
}

/* Sections */
.section { padding-block: 72px 8px; display: grid; gap: 32px; }
@media (max-width: 720px) { .section { padding-block: 48px 0; gap: 24px; } }
.section-head { display: grid; gap: 10px; max-width: 46rem; }
.section-head h2 { font-family: var(--display); font-weight: 450; font-size: clamp(1.9rem, 4vw, 2.8rem); letter-spacing: -0.02em; line-height: 1.08; }
.section-head p { color: var(--muted); font-size: 1.05rem; max-width: 56ch; }

ol.steps.big > li::before { width: 34px; height: 34px; font-family: var(--display); font-size: 1.05rem; font-weight: 500; }
ol.steps.big { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; }
ol.steps.big > li { grid-template-columns: 1fr; gap: 14px; }
ol.steps.big h3 { font-family: var(--display); font-weight: 500; font-size: 1.3rem; margin-bottom: 4px; }
@media (max-width: 760px) { ol.steps.big { grid-template-columns: 1fr; } ol.steps.big > li { grid-template-columns: 40px minmax(0, 1fr); } }

.faq { display: grid; max-width: 46rem; }
.faq details { border-top: 1px solid var(--line); padding-block: 18px; }
.faq details:last-child { border-bottom: 1px solid var(--line); }
.faq summary { cursor: pointer; font-family: var(--display); font-size: 1.25rem; font-weight: 500; list-style: none; display: flex; justify-content: space-between; gap: 16px; }
.faq summary::-webkit-details-marker { display: none; }
.faq summary::after { content: "+"; color: var(--accent); font-family: var(--sans); font-weight: 400; transition: transform .2s; }
.faq details[open] summary::after { transform: rotate(45deg); }
.faq details p { color: var(--muted); margin-top: 10px; max-width: 60ch; }

footer { border-top: 1px solid var(--line); padding-block: 36px 48px; color: var(--muted); font-size: .9rem; }
.footer-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) repeat(2, minmax(0, 1fr)); gap: 32px; }
.footer-grid h4 { margin: 0 0 10px; font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; color: var(--ink); }
.footer-grid ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.footer-grid a { color: var(--muted); text-decoration: none; }
.footer-grid a:hover { color: var(--ink); }
@media (max-width: 720px) { .footer-grid { grid-template-columns: 1fr; } }

/* Lean homepage */
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
#steps { border-block: 1px solid var(--line); padding-block: 28px; }
.earn .section-head { justify-items: start; }
.calc { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 22px; overflow: hidden; }
@media (max-width: 780px) { .calc { grid-template-columns: 1fr; } }
.calc-inputs { display: grid; gap: 28px; padding: clamp(22px, 4vw, 36px); }
.calc-field { display: grid; grid-template-columns: 1fr auto; gap: 12px 16px; align-items: baseline; }
.calc-field > span { color: var(--muted); font-size: .95rem; }
.calc-field output { font-family: var(--display); font-size: 1.6rem; font-weight: 500; font-variant-numeric: tabular-nums; }
.calc-field input[type=range] { grid-column: 1 / -1; width: 100%; padding: 0; border: 0; background: transparent; height: 28px; -webkit-appearance: none; appearance: none; --fill: 0%; }
.calc-field input[type=range]:focus { box-shadow: none; }
.calc-field input[type=range]::-webkit-slider-runnable-track { height: 6px; border-radius: 99px; background: linear-gradient(to right, var(--accent) var(--fill), var(--line) var(--fill)); }
.calc-field input[type=range]::-moz-range-track { height: 6px; border-radius: 99px; background: var(--line); }
.calc-field input[type=range]::-moz-range-progress { height: 6px; border-radius: 99px; background: var(--accent); }
.calc-field input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; margin-top: -8px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); box-shadow: 0 2px 6px rgba(0,0,0,.15); }
.calc-field input[type=range]::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); }
.calc-field input[type=range]:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 8px; }
.calc-result { display: grid; gap: 8px; align-content: center; padding: clamp(22px, 4vw, 36px); background: var(--accent-soft); }
.calc-label { color: var(--muted); font-size: .9rem; letter-spacing: .02em; }
.calc-keep { font-family: var(--display); font-weight: 450; font-size: clamp(3rem, 7vw, 4.6rem); line-height: 1; letter-spacing: -0.03em; color: var(--accent); font-variant-numeric: tabular-nums; }
.calc-note { color: var(--muted); font-size: .92rem; max-width: 38ch; }
.made-for { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 22px; padding-bottom: 8px; }
.made-for .eyebrow { margin-right: 4px; }
.made-for a { font-family: var(--display); font-size: 1.35rem; color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line); transition: border-color .2s, color .2s; }
.made-for a:hover { color: var(--accent); border-color: var(--accent); }
.closing { padding-block: 40px 88px; justify-content: center; }

/* Guides */
.guide-head { padding-block: 56px 28px; display: grid; gap: 14px; max-width: 46rem; }
.guide-head h1 { font-size: clamp(2.2rem, 5.5vw, 3.6rem); }
.guide-head .lead { color: var(--muted); font-size: 1.15rem; line-height: 1.6; }
.crumbs { font-size: .85rem; color: var(--muted); }
.crumbs a { color: var(--muted); }
.guide-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 56px; align-items: start; padding-bottom: 72px; }
@media (max-width: 900px) { .guide-layout { grid-template-columns: 1fr; gap: 32px; } }
.prose { max-width: var(--measure); font-size: 1.06rem; line-height: 1.72; }
.prose > * + * { margin-top: 1.1em; }
.prose h2 { font-family: var(--display); font-weight: 500; font-size: 1.75rem; letter-spacing: -0.01em; margin-top: 1.8em; }
.prose h3 { font-size: 1.05rem; margin-top: 1.5em; }
.prose ul, .prose ol { padding-left: 1.3em; }
.prose li + li { margin-top: .4em; }
.prose blockquote { margin: 1.4em 0; padding: 4px 0 4px 18px; border-left: 2px solid var(--accent); color: var(--muted); font-family: var(--display); font-size: 1.2rem; font-style: italic; }
.prose .example { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; font-size: .98rem; }
.prose .example b { font-variant-numeric: tabular-nums; }
.aside { position: sticky; top: 84px; display: grid; gap: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
.aside h3 { font-family: var(--display); font-weight: 500; font-size: 1.2rem; }
.aside p { color: var(--muted); font-size: .92rem; }
.guide-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; padding-bottom: 72px; }
.guide-card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 22px; display: grid; gap: 8px; text-decoration: none; color: inherit; transition: border-color .2s; }
.guide-card:hover { border-color: var(--accent); }
.guide-card h2 { font-family: var(--display); font-weight: 500; font-size: 1.3rem; line-height: 1.2; }
.guide-card p { color: var(--muted); font-size: .94rem; }
.guide-card .tag { font-size: .74rem; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.auth { max-width: 460px; margin: 40px auto 0; }
.tabs { display: grid; grid-template-columns: 1fr 1fr; background: var(--bg); border-radius: 9px; padding: 4px; gap: 4px; }
.tabs a { text-align: center; padding: 8px; border-radius: 7px; text-decoration: none; color: var(--muted); font-weight: 600; font-size: .95rem; }
.tabs a[aria-current="page"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
@media (prefers-reduced-motion: no-preference) { .btn, .nav a, input { transition: background-color .15s, border-color .15s, box-shadow .15s; } }
`;
