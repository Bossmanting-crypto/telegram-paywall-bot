/**
 * Public HTML pages: the homepage at /, the guides (see guides.ts) and the
 * creator dashboard shell at /dashboard. All load /assets/app.css; the
 * dashboard's behaviour lives in /assets/dashboard.js so every page runs under
 * a strict CSP with no inline script.
 *
 * Every price and limit shown comes from the code (env.ts) or the owner's
 * settings, so the copy can't drift from what the platform actually does.
 */

import { FREE_BOT_LIMIT, FREE_MEMBER_LIMIT, FREE_TRIAL_DAYS, PLAN_DAYS, TIER_CUT, type AppEnv } from "../env";

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
export const usd = (n: number): string => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

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
  const cta = ctx.signupsOpen ? `<a class="btn primary small" href="/dashboard#signup">Start free</a>` : "";
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
    ${ctx.contact ? `<p>Questions or upgrades: <span class="mono">${esc(ctx.contact)}</span></p>` : ""}
  </div>
  <div><h4>Guides</h4><ul>${guides.map((g) => `<li><a href="/guides/${g.slug}">${esc(g.short)}</a></li>`).join("")}</ul></div>
  <div><h4>For builders</h4><ul>
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
    free: pct(TIER_CUT.free, 0.15),
    starter: pct(TIER_CUT.starter, 0.08),
    starterPriceLine:
      ctx.starterPrice !== null ? `${usd(ctx.starterPrice)} per ${PLAN_DAYS} days, upgrade in one click` : "No monthly fee",
    noMonthlyFee: ctx.starterPrice === null,
  };
}

export function landingPage(ctx: SiteContext, guides: Array<{ slug: string; short: string }>): string {
  const plans = planFacts(ctx);
  const start = ctx.signupsOpen
    ? `<a class="btn primary big" href="/dashboard#signup">Start your ${FREE_TRIAL_DAYS}-day free trial</a>`
    : `<span class="muted">New signups are paused right now.</span>`;
  const guide = (slug: string) => `/guides/${slug}`;

  return `${siteHead(ctx, {
    title: `${ctx.name} · Your Telegram group, now a business`,
    description:
      "A paywall bot for Telegram. Members pay by card, M-Pesa or crypto; the bot lets them in, sells your posts one by one, and removes access when a plan ends.",
    path: "/",
  })}
<body class="site">
${siteHeader(ctx)}
<main>
  <div class="wrap">
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">Paywall bot for Telegram</span>
        <h1 class="display">Your Telegram group, now a <em>business</em>.</h1>
        <p class="lead">Members pay by card, M-Pesa or crypto. The bot lets them in, sells your posts one by one, and takes access away when a plan ends, so you can get back to the part you're good at.</p>
        <div class="row">${start}<a class="btn big" href="#how">See how it works</a></div>
        <p class="hero-note">No card needed. Buyers pay straight into your own Paystack or NOWPayments account.</p>
      </div>
      <div class="chat" aria-label="Example of the bot in Telegram">
        <div class="chat-title">Studio Notes · private group</div>
        <div class="event">Amina asked to join</div>
        <div class="bubble"><span class="from">Studio Bot</span><span>🔒 <b>Members only</b><br>Join for the weekly sessions and the full archive. You also have <b>15 free coins</b> to try a few posts.</span></div>
        <div class="kb"><span>🔄 Monthly  $5/mo</span><span>📸 Browse posts · 🪙 15</span></div>
        <div class="event"><b>✓ Paid by M-Pesa</b> · request approved</div>
        <div class="bubble"><div class="locked"><span>🔒 <b>Video 3 of 12</b><br>Behind the scenes, part 2</span><span class="coin">Unlock · 🪙 5</span></div></div>
        <div class="bubble"><span>🎬 <i>Behind the scenes, part 2</i></span><span class="muted"><i>3 of 12 · 🪙 10</i></span></div>
      </div>
    </section>

    <div class="facts">
      <div><b>Card, M-Pesa, crypto</b><span>Buyers pay the way they already do.</span></div>
      <div><b>Live in 10 minutes</b><span>No code, no website, no server.</span></div>
      ${plans.noMonthlyFee
        ? `<div><b>No monthly fee</b><span>Just a small cut of each sale.</span></div>`
        : `<div><b>Free to start</b><span>${FREE_TRIAL_DAYS}-day trial, then ${usd(ctx.starterPrice ?? 0)} per ${PLAN_DAYS} days.</span></div>`}
    </div>

    <section class="section" aria-labelledby="what">
      <div class="section-head">
        <span class="eyebrow">What it does</span>
        <h2 id="what">Everything a paid group needs, without the admin.</h2>
      </div>
      <div class="features">
        <div><h3>Get paid your way</h3><p>Card, bank and M-Pesa through Paystack; crypto through NOWPayments or your own BTCPay server. The money lands in your account, not ours.</p></div>
        <div><h3>Sell posts, not just access</h3><p>Give newcomers free coins to try your content, then sell coin packs or let them go unlimited with a plan. Unlocked posts can't be forwarded or saved.</p></div>
        <div><h3>Only paying members get in</h3><p>With join approval on, the bot admits people the moment they pay and removes them when a monthly plan runs out. Or keep the group open and mute anyone who hasn't paid.</p></div>
        <div><h3>Runs itself</h3><p>Plans expire on time, renewals are one tap, and a single message reaches every paying member. If something stops sales, like a missing permission or a rejected key, your bot tells you on Telegram.</p></div>
      </div>
    </section>

    <section class="section" aria-labelledby="who">
      <div class="section-head">
        <span class="eyebrow">Made for</span>
        <h2 id="who">People who already share something worth paying for.</h2>
      </div>
      <div class="niches">
        <a class="niche" href="${guide("paid-telegram-group-for-streamers")}"><h3>Streamers</h3><p>A VIP room for your biggest fans, with clips they can unlock between streams.</p><span class="more">For streamers →</span></a>
        <a class="niche" href="${guide("paid-telegram-group-for-tutors")}"><h3>Tutors and exam prep</h3><p>Past papers and worked answers: a whole term's access, or one paper at a time.</p><span class="more">For tutors →</span></a>
        <a class="niche" href="${guide("paid-telegram-group-for-coaches")}"><h3>Coaches</h3><p>Your programme in a private group. Members who stop paying are removed for you.</p><span class="more">For coaches →</span></a>
        <a class="niche" href="${guide("paid-telegram-alerts-group")}"><h3>Alerts and leads</h3><p>Jobs, tenders, deals. People pay to hear first, and monthly plans keep them subscribed.</p><span class="more">For alert groups →</span></a>
      </div>
    </section>

    <section class="section" id="how" aria-labelledby="how-title">
      <div class="section-head">
        <span class="eyebrow">How it works</span>
        <h2 id="how-title">Three steps, about ten minutes.</h2>
      </div>
      <ol class="steps big">
        <li><div><h3>Create your bot</h3><p class="muted">Message @BotFather in Telegram, send /newbot and copy the token it gives you.</p></div></li>
        <li><div><h3>Connect how you get paid</h3><p class="muted">Paste your Paystack keys for card, bank and M-Pesa, or your NOWPayments keys for crypto. Both, if you like.</p></div></li>
        <li><div><h3>Add it to your group</h3><p class="muted">Make the bot an admin. It links itself and starts asking new members to pay.</p></div></li>
      </ol>
    </section>

    <section class="section" id="pricing" aria-labelledby="pricing-title">
      <div class="section-head">
        <span class="eyebrow">Pricing</span>
        <h2 id="pricing-title">You earn first. We take a small cut.</h2>
      </div>
      <div class="plans">
        <div class="plan">
          <h3>Free trial</h3>
          <div class="fee">${plans.free} <small>per sale</small></div>
          <ul><li>${FREE_TRIAL_DAYS} days</li><li>${FREE_BOT_LIMIT} bot</li><li>Up to ${FREE_MEMBER_LIMIT} paying members</li></ul>
        </div>
        <div class="plan featured">
          <h3>Starter</h3>
          <div class="fee">${plans.starter} <small>per sale</small></div>
          <ul><li>Unlimited bots and members</li><li>A lower fee on every sale</li><li>${esc(plans.starterPriceLine)}</li></ul>
        </div>
        <div class="plan">
          <h3>White label</h3>
          <div class="fee">0% <small>per sale</small></div>
          <ul><li>One-time purchase</li><li>No fee on your sales</li><li>Ask us for a quote</li></ul>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="agents-title">
      <div class="agents">
        <div class="stack">
          <span class="eyebrow">For builders</span>
          <h2 id="agents-title">Built for agents, too.</h2>
          <p>AI agents can sign up, launch and run a paid community through our API and MCP server. They'll need two things from you: a bot token from @BotFather and your payment keys.</p>
          <p><a href="/llms.txt">Guide for agents</a> · <a href="/openapi.json">API description</a> · <span class="mono">/mcp</span></p>
        </div>
        <pre><span class="c"># 1. Sign up (returns an API key)</span>
POST /api/v1/tenants/signup
{ "name": "Studio Notes",
  "email": "hi@studio.example" }

<span class="c"># 2. Launch the bot</span>
POST /api/v1/bots
{ "bot_token": "…",
  "paystack_secret_key": "sk_live_…",
  "monthly_price": 5 }</pre>
      </div>
    </section>

    <section class="section" aria-labelledby="faq-title">
      <div class="section-head"><span class="eyebrow">Questions</span><h2 id="faq-title">Good to know.</h2></div>
      <div class="faq">
        <details><summary>Where does the money go?</summary><p>Straight into your own Paystack or NOWPayments account. The platform's fee is added up per sale, and you pay it from your dashboard.</p></details>
        <details><summary>Do I need a website or any code?</summary><p>No. You need a Telegram group, a bot from @BotFather (it takes two minutes) and a Paystack or NOWPayments account.</p></details>
        <details><summary>What happens when someone stops paying?</summary><p>When a monthly plan ends, the bot takes their access away and sends them a button to renew. Lifetime members keep their access.</p></details>
        <details><summary>Can people read the group without paying?</summary><p>With join approval on, no: only people who have paid are let in. In open mode, newcomers can read but can't post until they pay.</p></details>
        <details><summary>Is it secure?</summary><p>Every payment is confirmed with the provider before anyone gets access, each payment counts once, and your payment keys are stored encrypted.</p></details>
      </div>
    </section>

    <section class="cta-band">
      <h2>Your group is already worth paying for.</h2>
      <div class="row">${start}</div>
    </section>
  </div>
</main>
${siteFooter(ctx, guides)}
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
