/**
 * Public HTML pages: the landing page at / and the creator dashboard shell at
 * /dashboard. Both load /assets/app.css; the dashboard's behaviour lives in
 * /assets/dashboard.js so the pages can run under a strict CSP with no inline
 * script.
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

/** Escape for both text and double-quoted attribute contexts. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const pct = (cut: number | undefined, fallback: number): string => `${Math.round((cut ?? fallback) * 100)}%`;

function head(title: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/assets/app.css">
${extra}
</head>`;
}

function brand(info: PlatformInfo, href: string): string {
  return `<a class="brand" href="${href}"><span class="brand-mark" aria-hidden="true">✓</span>${esc(info.name)}</a>`;
}

export function landingPage(info: PlatformInfo, starterPrice: number | null = null): string {
  const free = pct(TIER_CUT.free, 0.15);
  const starter = pct(TIER_CUT.starter, 0.08);
  const cta = info.signupsOpen
    ? `<a class="btn primary big" href="/dashboard#signup">Start ${FREE_TRIAL_DAYS}-day free trial</a>`
    : `<span class="muted">New signups are paused right now.</span>`;
  const contact = info.contact
    ? `<p>Questions or upgrades: <span class="mono">${esc(info.contact)}</span></p>`
    : "";

  return `${head(
    `${info.name} · Get paid for your Telegram group`,
    '<meta name="description" content="A Telegram bot that charges for access to your group. Card, M-Pesa and crypto payments.">\n<link rel="alternate" type="text/plain" title="Guide for AI agents" href="/llms.txt">\n<link rel="service-desc" type="application/json" href="/openapi.json">',
  )}
<body>
<header class="topbar"><div class="wrap">
  ${brand(info, "/")}
  <nav class="nav" aria-label="Main"><a href="/dashboard#signin">Sign in</a></nav>
</div></header>
<main>
  <div class="wrap">
    <section class="hero">
      <div class="stack">
        <h1>Get paid for your Telegram group</h1>
        <p class="lead">Your bot mutes new members until they pay, unlocks them the moment the payment lands, and mutes them again when a monthly plan runs out. Buyers pay by card or M-Pesa through Paystack, or in crypto through NOWPayments.</p>
        <div class="row">${cta}<a class="btn big" href="/dashboard#signin">Sign in</a></div>
        <p class="hint">No card needed for the trial. Buyers pay into your own Paystack or NOWPayments account.</p>
      </div>
      <div class="chat" aria-label="Example of the bot in a Telegram chat">
        <div class="chat-title">VIP Lounge · Telegram</div>
        <div class="event">Amina joined the group</div>
        <div class="bubble">
          <span class="from">VIP Bot</span>
          <span>🔒 <b>VIP Access Required</b><br>Pay to unlock this exclusive group.<br><br>Choose your access plan:</span>
        </div>
        <div class="kb"><span>🔑 One-Time Access  $10</span><span>🔄 Monthly Access  $5/mo</span></div>
        <div class="event"><b>✓ Payment confirmed</b> · Amina can now post</div>
      </div>
    </section>

    <section class="section" aria-labelledby="how">
      <h2 id="how">Live in about ten minutes</h2>
      <ol class="steps">
        <li><div><h3>Create a bot</h3><p class="muted">Message @BotFather in Telegram, send /newbot, and copy the token it gives you.</p></div></li>
        <li><div><h3>Connect a way to get paid</h3><p class="muted">Paste your Paystack keys for cards, bank and M-Pesa, or your NOWPayments keys for crypto. Both if you like.</p></div></li>
        <li><div><h3>Add the bot to your group</h3><p class="muted">Make it an admin with the Ban users permission. It links itself and starts asking new members to pay.</p></div></li>
      </ol>
    </section>

    <section class="section" aria-labelledby="pricing">
      <h2 id="pricing">Pricing</h2>
      <div class="plans">
        <div class="plan">
          <h3>Free trial</h3>
          <div class="fee">${free} <small>per sale</small></div>
          <ul><li>${FREE_TRIAL_DAYS} days</li><li>${FREE_BOT_LIMIT} bot</li><li>Up to ${FREE_MEMBER_LIMIT} paying members</li></ul>
        </div>
        <div class="plan featured">
          <h3>Starter</h3>
          <div class="fee">${starter} <small>per sale</small></div>
          <ul><li>Unlimited bots</li><li>Unlimited members</li><li>${starterPrice !== null ? `$${starterPrice.toFixed(2)} per ${PLAN_DAYS} days, upgrade in one click` : "Lower fee on every sale"}</li></ul>
        </div>
        <div class="plan">
          <h3>White label</h3>
          <div class="fee">0% <small>per sale</small></div>
          <ul><li>One-time purchase</li><li>No fee on your sales</li><li>Ask us for a quote</li></ul>
        </div>
      </div>
    </section>
  </div>
</main>
<footer><div class="wrap stack">
  ${contact}
  <p>${esc(info.name)} runs on Cloudflare. Payment keys are stored encrypted.</p>
  <p>Building an agent or bot? Read <a href="/llms.txt">/llms.txt</a>, the <a href="/openapi.json">API description</a>, or connect the MCP server at <span class="mono">/mcp</span>. Bots are welcome to sign up.</p>
</div></footer>
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
