/**
 * Public HTML pages: the homepage at /, the guides (see guides.ts) and the
 * creator dashboard shell at /dashboard. All load /assets/app.css; the
 * dashboard's behaviour lives in /assets/dashboard.js so every page runs under
 * a strict CSP with no inline script.
 *
 * Every price and limit shown comes from the code (env.ts) or the owner's
 * settings, so the copy can't drift from what the platform actually does.
 */

import { PLAN_DAYS, TIER_CUT, VOLUME_LADDER, type AppEnv } from "../env";

export interface PlatformInfo {
  name: string;
  contact: string | null;
  signupsOpen: boolean;
}

export function platformInfo(env: AppEnv): PlatformInfo {
  return {
    name: env.PLATFORM_NAME?.trim() || "Paywall Bot",
    contact: env.SUPPORT_CONTACT?.trim() || null,
    signupsOpen: env.ALLOW_SIGNUPS !== "false",
  };
}

/** Context every public page is rendered with. */
export interface SiteContext extends PlatformInfo {
  /** Absolute origin, for canonical links (APP_URL or the request's origin). */
  baseUrl: string;
  starterPrice: number | null;
  /** Username of the public bot that shows what members see, if the owner set one. */
  previewBot: string | null;
}

/** Escape for both text and double-quoted attribute contexts. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const pct = (cut: number | undefined, fallback: number): string => `${Math.round((cut ?? fallback) * 100)}%`;
export const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

function head(title: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="preload" href="/assets/fonts/newsreader.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/hanken-grotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css">
${extra}
</head>`;
}

function brand(info: PlatformInfo, href: string): string {
  return `<a class="brand" href="${href}"><span class="brand-mark" aria-hidden="true">✓</span>${esc(info.name)}</a>`;
}

/** <head> for a public, indexable page: description, canonical link and social cards. */
export function siteHead(ctx: SiteContext, page: { title: string; description: string; path: string }): string {
  const url = `${ctx.baseUrl}${page.path}`;
  return head(
    page.title,
    [
      `<meta name="description" content="${esc(page.description)}">`,
      `<link rel="canonical" href="${esc(url)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="${esc(ctx.name)}">`,
      `<meta property="og:title" content="${esc(page.title)}">`,
      `<meta property="og:description" content="${esc(page.description)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      `<meta name="twitter:card" content="summary">`,
      `<link rel="alternate" type="text/plain" title="Guide for AI agents" href="/llms.txt">`,
      `<link rel="service-desc" type="application/json" href="/openapi.json">`,
    ].join("\n"),
  );
}

export function siteHeader(ctx: SiteContext): string {
  const cta = ctx.signupsOpen ? `<a class="btn primary small" href="/dashboard#signup">Start now</a>` : "";
  return `<header class="topbar"><div class="wrap">
  ${brand(ctx, "/")}
  <nav class="nav" aria-label="Main"><a href="/guides">Guides</a><a href="/#pricing">Pricing</a><a href="/dashboard#signin">Sign in</a>${cta}</nav>
</div></header>`;
}

export function siteFooter(ctx: SiteContext, guides: Array<{ slug: string; short: string }>): string {
  return `<footer><div class="wrap footer-grid">
  <div class="stack">
    ${brand(ctx, "/")}
    <p>Your Telegram group, now a business. Runs on Cloudflare; payment keys are stored encrypted.</p>
    ${ctx.contact ? `<p>Questions, or running something bigger? <span class="mono">${esc(ctx.contact)}</span></p>` : `<p>Running something bigger? Ask us about white label.</p>`}
  </div>
  <div><h4>Guides</h4><ul>${guides.map((g) => `<li><a href="/guides/${g.slug}">${esc(g.short)}</a></li>`).join("")}</ul></div>
  <div><h4>For builders</h4><ul>
    <li><a href="/guides/telegram-paywall-for-ai-agents">Built for agents, too</a></li>
    <li><a href="/llms.txt">Guide for AI agents</a></li>
    <li><a href="/openapi.json">API description</a></li>
    <li><span class="mono">/mcp</span> MCP server</li>
    <li><a href="/dashboard">Dashboard</a></li>
  </ul></div>
</div></footer>`;
}

/** Plan facts shared by the homepage and the guides. */
export function planFacts(ctx: SiteContext): { free: string; starter: string; starterPriceLine: string; noMonthlyFee: boolean } {
  return {
    free: pct(TIER_CUT.free, 0.12),
    starter: pct(TIER_CUT.starter, 0.05),
    starterPriceLine:
      ctx.starterPrice !== null ? `${usd(ctx.starterPrice)} per ${PLAN_DAYS} days, upgrade in one click` : "No monthly fee",
    noMonthlyFee: ctx.starterPrice === null,
  };
}

/** Rough shillings per dollar, for the calculator's thresholds only. */
const KES_PER_USD = 129;

/** "12% up to $1,000 a month in sales, 10% from $1,000, …" */
function ladderLine(): string {
  const steps = [...VOLUME_LADDER].reverse();
  return (
    "Fee by sales in the last 30 days: " +
    steps.map((s) => (s.fromUsd === 0 ? `${pct(s.cut, 0)} to start` : `${pct(s.cut, 0)} from ${usd(s.fromUsd)}`)).join(", ") +
    "."
  );
}

export function landingPage(ctx: SiteContext, guides: Array<{ slug: string; short: string }>): string {
  const free = TIER_CUT.free ?? 0.12;
  const lowest = VOLUME_LADDER[0]?.cut ?? free;
  const ladder = JSON.stringify(VOLUME_LADDER.map((s) => [s.fromUsd, s.cut]));
  const starter = TIER_CUT.starter ?? 0.05;
  const build = ctx.signupsOpen
    ? `<a class="btn primary big" href="/dashboard#signup">Start now</a>`
    : `<span class="muted">New signups are paused right now.</span>`;
  const second = ctx.previewBot
    ? `<a class="btn big" href="https://t.me/${esc(ctx.previewBot)}" rel="noopener">See what members see</a>`
    : `<a class="btn big" href="#steps">How it works</a>`;
  // The calculator's starting example, rendered in full so the page is complete without script.
  const members = 60;
  const price = 5;
  const keep = (cut: number) => usd(Math.round(members * price * (1 - cut)));
  const pricingLine = ctx.starterPrice === null
    ? `Free to start. You only pay when you get paid: ${pct(free, 0.12)} of each sale, falling to ${pct(lowest, 0.06)} as you grow.`
    : `Free to start: ${pct(free, 0.12)} of each sale, falling to ${pct(lowest, 0.06)} as you grow. Or Starter: ${usd(ctx.starterPrice)} per ${PLAN_DAYS} days and a flat ${pct(starter, 0.05)}.`;
  const seg = (name: string, options: Array<[string, string]>) =>
    `<div class="seg" role="group" aria-label="${name}">${options
      .map(([value, label], i) => `<button type="button" data-${name.toLowerCase()}="${value}" aria-pressed="${i === 0}">${label}</button>`)
      .join("")}</div>`;
  const niche = (slug: string, label: string) => `<a href="/guides/${slug}">${label}</a>`;

  return `${siteHead(ctx, {
    title: `${ctx.name} · Your Telegram group, now a business`,
    description:
      "A paywall for your Telegram group. Members pay by card, M-Pesa or crypto, daily, weekly or monthly; the bot lets them in, sells your posts and handles renewals.",
    path: "/",
  })}
<body class="site">
${siteHeader(ctx)}
<main>
  <div class="wrap">
    <section class="hero">
      <div class="hero-copy">
        <h1 class="display">Your Telegram group, now a <em>business</em>.</h1>
        <p class="lead">Members pay by card, M-Pesa or crypto. The bot does the rest: it lets them in, sells your posts one by one, and handles renewals.</p>
        <div class="row">${build}${second}</div>
        <p class="hero-note">Set up in minutes. No code, no website, no card needed.</p>
      </div>
      <div class="chat" aria-label="What your members see in Telegram">
        <div class="chat-title">Studio Notes · private group</div>
        <div class="event">Amina asked to join</div>
        <div class="bubble"><span class="from">Studio Bot</span><span>🔒 <b>Members only</b><br>Weekly sessions and the full archive. You also have <b>15 free coins</b> to try a few posts.</span></div>
        <div class="kb"><span>🔄 Monthly  $5/mo</span><span>📸 Browse posts · 🪙 15</span></div>
        <div class="event"><b>✓ Paid by M-Pesa</b> · request approved</div>
        <div class="bubble"><div class="locked"><span>🔒 <b>Video 3 of 12</b><br>Behind the scenes, part 2</span><span class="coin">Unlock · 🪙 5</span></div></div>
        <div class="bubble"><span>🎬 <i>Behind the scenes, part 2</i></span><span class="muted"><i>3 of 12 · 🪙 10</i></span></div>
      </div>
    </section>

    <ol class="steps big" id="steps" aria-label="How it works">
      <li><div><h3>Create your bot</h3><p class="muted">Message @BotFather in Telegram, send /newbot and copy the token.</p></div></li>
      <li><div><h3>Connect payments</h3><p class="muted">Paste your Paystack keys for card, bank and M-Pesa, or NOWPayments for crypto.</p></div></li>
      <li><div><h3>Add it to your group</h3><p class="muted">Make the bot an admin. It starts asking new members to pay.</p></div></li>
    </ol>

    <section class="section earn" id="pricing" aria-labelledby="earn-title">
      <div class="section-head">
        <h2 id="earn-title">See what you'd keep.</h2>
        <p>${esc(pricingLine)}</p>
      </div>
      <div class="calc" data-calc data-ladder="${esc(ladder)}" data-starter="${starter}" data-kes="${KES_PER_USD}">
        <div class="calc-inputs">
          <div class="calc-switches" hidden>${seg("Currency", [["USD", "$"], ["KES", "KSh"]])}${seg("Period", [["month", "Per month"], ["day", "Per day"]])}</div>
          <label class="calc-field" for="calc-members"><span>Paying members</span><output id="calc-members-out" for="calc-members">${members}</output>
            <input id="calc-members" type="range" min="5" max="1000" step="5" value="${members}"></label>
          <label class="calc-field" for="calc-price"><span id="calc-price-label">Monthly price</span><output id="calc-price-out" for="calc-price">${usd(price)}</output>
            <input id="calc-price" type="range" min="1" max="50" step="1" value="${price}"></label>
        </div>
        <div class="calc-result" aria-live="polite">
          <span class="calc-label" id="calc-label">You keep each month</span>
          <span class="calc-keep" id="calc-keep">${keep(free)}</span>
          <span class="calc-note" id="calc-note">${members} members × ${usd(price)} a month, after the ${pct(free, 0.12)} fee. The fee falls as your sales grow.</span>
        </div>
      </div>
      <p class="hint">Before your payment provider's own fees. ${ladderLine()} Posts sold with coins count too.</p>
    </section>

    <section class="section" aria-labelledby="faq-title">
      <div class="made-for"><span class="eyebrow">Made for</span>${niche("paid-telegram-group-for-streamers", "Streamers")}${niche("paid-telegram-group-for-tutors", "Tutors")}${niche("paid-telegram-group-for-coaches", "Coaches")}${niche("paid-telegram-alerts-group", "Alert groups")}${niche("sell-pay-per-post-content-on-telegram", "Pay-per-post")}</div>
      <h2 id="faq-title" class="visually-hidden">Questions</h2>
      <div class="faq">
        <details><summary>Where does the money go?</summary><p>Straight into your own Paystack or NOWPayments account. The platform's share is added up per sale, and you pay it from your dashboard.</p></details>
        <details><summary>What happens when someone stops paying?</summary><p>When a daily, weekly or monthly plan ends, the bot takes their access away and sends them the plans with one-tap pay. Lifetime members keep their access.</p></details>
        <details><summary>Is it secure?</summary><p>Every payment is confirmed with the provider before anyone gets access, each payment counts once, and your payment keys are stored encrypted.</p></details>
      </div>
      <div class="row closing">${build}</div>
    </section>
  </div>
</main>
${siteFooter(ctx, guides)}
<script src="/assets/home.js" defer></script>
</body>
</html>`;
}

export function dashboardPage(info: PlatformInfo): string {
  const meta = [
    `<meta name="robots" content="noindex">`,
    `<meta name="pb-name" content="${esc(info.name)}">`,
    `<meta name="pb-contact" content="${esc(info.contact ?? "")}">`,
    `<meta name="pb-signups" content="${info.signupsOpen ? "open" : "closed"}">`,
    `<script src="/assets/dashboard.js" defer></script>`,
  ].join("\n");
  return `${head(`${info.name} · Dashboard`, meta)}
<body>
<header class="topbar"><div class="wrap">
  ${brand(info, "/dashboard")}
  <nav class="nav" id="nav" aria-label="Dashboard"></nav>
</div></header>
<main class="wrap" id="app"><div class="loading">Loading…</div></main>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<noscript><div class="wrap"><p class="banner bad">The dashboard needs JavaScript turned on.</p></div></noscript>
</body>
</html>`;
}
