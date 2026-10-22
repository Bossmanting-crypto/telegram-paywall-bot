/**
 * Guides: one page per real question or audience, so a search lands on the
 * page that answers it instead of a homepage stuffed with keywords. Each guide
 * is written from what the product actually does; prices and limits come from
 * the code through the render context.
 *
 * To add a guide, append to GUIDES. It appears in /guides, the sitemap,
 * the footer and /llms.txt automatically.
 */

import { FREE_BOT_LIMIT, FREE_MEMBER_LIMIT, FREE_TRIAL_DAYS, PLAN_DAYS } from "../env";
import { esc, planFacts, siteFooter, siteHead, siteHeader, usd, type SiteContext } from "./pages";

export interface Guide {
  slug: string;
  /** Page title and h1. */
  title: string;
  /** Short name for links. */
  short: string;
  tag: string;
  /** Meta description and card text. */
  description: string;
  lead: string;
  /** Trusted HTML written here, never user input. */
  body: (ctx: SiteContext) => string;
  related: string[];
}

const start = (ctx: SiteContext, label = "Start free") =>
  ctx.signupsOpen ? `<a class="btn primary" href="/dashboard#signup">${label}</a>` : "";

function feeLine(ctx: SiteContext): string {
  const p = planFacts(ctx);
  return ctx.starterPrice !== null
    ? `The ${FREE_TRIAL_DAYS}-day free trial takes ${p.free} of each sale. Starter takes ${p.starter} and costs ${usd(ctx.starterPrice)} per ${PLAN_DAYS} days.`
    : `There's no monthly fee: the ${FREE_TRIAL_DAYS}-day free trial takes ${p.free} of each sale, and Starter takes ${p.starter}.`;
}

export const GUIDES: Guide[] = [
  {
    slug: "how-to-charge-for-a-telegram-group",
    title: "How to charge for a Telegram group",
    short: "Charge for a Telegram group",
    tag: "Guide",
    description:
      "Turn a Telegram group into paid membership: a bot takes card, M-Pesa or crypto payments, lets members in and removes them when their plan ends.",
    lead: "Telegram doesn't have a members-only switch for groups, but a bot can be the doorman. Here's how to set one up in about seven minutes.",
    related: ["telegram-paid-group-mpesa", "sell-pay-per-post-content-on-telegram"],
    body: (ctx) => `
<p>A paid group needs three things: a way to take money, a way to let payers in, and a way to take access away when a plan ends. A paywall bot does all three inside Telegram, so you never chase anyone for a payment.</p>
<h2>1. Create a bot</h2>
<p>Open Telegram, message <b>@BotFather</b>, send <code>/newbot</code> and pick a name and username. BotFather replies with a token: a long line of letters and numbers. Keep it private; it's the key to your bot.</p>
<h2>2. Connect a payment provider</h2>
<p>Buyers pay straight into your own account, so you need one of these:</p>
<ul>
  <li><b>Paystack</b> for card, bank and M-Pesa. In Paystack, open <i>Settings → API Keys &amp; Webhooks</i> and copy your secret and public keys.</li>
  <li><b>NOWPayments</b> for crypto. Copy your API key and IPN secret from its settings.</li>
</ul>
<p>You can use both. Buyers then choose how to pay.</p>
<h2>3. Set your prices and launch</h2>
<p>Create an account, then <i>Bots → Add a bot</i>: paste the token and your keys, and set a lifetime price, a monthly price, or both. ${esc(feeLine(ctx))}</p>
<h2>4. Add the bot to your group</h2>
<p>Add the bot to your group and make it an admin with the <b>Ban users</b> permission. It links itself to the group straight away.</p>
<h2>Open group or paid entry?</h2>
<p>Pick how strict the door is:</p>
<ul>
  <li><b>Open:</b> anyone can join, but newcomers are muted. They can read and can't post until they pay.</li>
  <li><b>Join approval:</b> people ask to join, the bot sends them the payment menu, and it lets them in the moment they pay. Give the bot the <b>Invite users via link</b> permission too, and share the join link it creates. Use this when the content itself is what you sell.</li>
</ul>
<p>Either way, when a monthly plan ends the bot takes access away and sends a one-tap renew button.</p>
<div class="example"><b>Example:</b> 60 members at $5 a month is <b>$300 a month</b> before fees, collected and renewed without a single reminder from you.</div>`,
  },
  {
    slug: "telegram-paid-group-mpesa",
    title: "Accept M-Pesa for a paid Telegram group",
    short: "Accept M-Pesa on Telegram",
    tag: "Payments",
    description:
      "Let members pay for your Telegram group with M-Pesa, cards or bank transfer through Paystack, and unlock access automatically once the payment clears.",
    lead: "Most of your members already pay with M-Pesa. Here's how to let them pay for your group the same way, with access unlocked automatically.",
    related: ["how-to-charge-for-a-telegram-group", "paid-telegram-group-for-tutors"],
    body: (ctx) => `
<p>The bot takes M-Pesa through <b>Paystack</b>, which also handles cards and bank payments. The buyer taps a plan in Telegram, picks <i>Card / M-Pesa</i>, pays on Paystack's page, and is let in as soon as Paystack confirms the payment.</p>
<h2>What you need</h2>
<ul>
  <li>A <b>Paystack</b> account for Kenya, with M-Pesa switched on in your payment channels.</li>
  <li>Your Paystack <b>secret key</b> and <b>public key</b> (<i>Settings → API Keys &amp; Webhooks</i>).</li>
</ul>
<h2>Charge in shillings</h2>
<p>Prices are set in US dollars and charged in your currency at an exchange rate you choose. On your bot's page, under <i>Prices and messages</i>, set <b>Paystack charges in</b> to <b>Kenyan shilling (KES)</b> and enter how many shillings make a dollar. The rate is fixed, so check it now and then against today's rate.</p>
<div class="example"><b>Example:</b> a monthly price of $4 at a rate of 129 charges <b>KSh 516</b>.</div>
<h2>Paste the webhook into Paystack</h2>
<p>Your bot's page shows a <b>Paystack webhook</b> address. Paste it into Paystack under <i>Settings → API Keys &amp; Webhooks → Webhook URL</i>. This is how Paystack tells the bot a payment went through. Every notification is checked against your key, and the payment is confirmed with Paystack again before anyone gets access.</p>
<h2>Check it works</h2>
<p>Press <b>Check connection</b> on your bot's page. You'll see a tick for Telegram, your group and Paystack. Then try a small payment from a second Telegram account.</p>
<p>${esc(feeLine(ctx))} Paystack's own fees apply as usual.</p>`,
  },
  {
    slug: "sell-pay-per-post-content-on-telegram",
    title: "Sell pay-per-post content on Telegram",
    short: "Sell pay-per-post content",
    tag: "Coins",
    description:
      "Sell individual photos, videos and files on Telegram with coins: free coins to start, coin packs to buy more, and unlimited access for members.",
    lead: "Not everyone wants a subscription. Coins let people try a few posts for free, then pay for the ones they want, or go unlimited.",
    related: ["paid-telegram-group-for-streamers", "how-to-charge-for-a-telegram-group"],
    body: () => `
<p>Coins turn your best posts into things people can buy one at a time, in a private chat with your bot.</p>
<h2>How it works for your audience</h2>
<ol>
  <li>New people get <b>free coins</b> the first time they message your bot: 15 by default, enough for three posts.</li>
  <li>They browse your posts. Each locked post shows its caption as a teaser and a price in coins (5 by default).</li>
  <li>When the coins run out, the bot offers <b>coin packs</b> (50 for $3, 150 for $7 and 500 for $20 by default) and your monthly or lifetime plan as the "go unlimited" option.</li>
  <li>Members with a plan see everything free. Everyone can check their balance with <code>/balance</code>.</li>
</ol>
<p>Unlocked posts are sent with Telegram's content protection, so they can't be forwarded or saved in the app.</p>
<h2>Adding posts</h2>
<p>Send photos, videos, GIFs or files to your bot in a private chat from your admin account. Write a caption: it's the teaser people see before they unlock. That's all; the post is on sale straight away.</p>
<h2>Setting it up</h2>
<p>On your bot's page, open <i>Coins and content</i>, switch coins on, and adjust the free allowance, the price per post and up to three packs. The page works out what your settings mean ("new people get 3 free unlocks…") as you type.</p>
<blockquote>Free coins get people through the door; packs and plans are how they stay.</blockquote>
<p>Coin sales go into your Paystack or NOWPayments account like any other sale.</p>`,
  },
  {
    slug: "paid-telegram-group-for-streamers",
    title: "A paid Telegram group for streamers",
    short: "For streamers",
    tag: "Streamers",
    description:
      "Give your biggest fans a paid VIP room on Telegram: monthly access, clips they can unlock between streams, and a direct line when you go live.",
    lead: "Your community shouldn't depend on one platform's rules. A paid Telegram group gives your biggest fans somewhere to belong, and gives you income you control.",
    related: ["sell-pay-per-post-content-on-telegram", "how-to-charge-for-a-telegram-group"],
    body: (ctx) => `
<h2>Why Telegram</h2>
<p>Your fans already have it on their phones, notifications actually arrive, and the group is yours. If a streaming platform changes its rules, your paying members and their payments stay with you.</p>
<h2>What to put inside</h2>
<ul>
  <li><b>VIP chat</b> with you between streams.</li>
  <li><b>Clips and behind-the-scenes</b> sold one by one with coins, free for members.</li>
  <li><b>"Going live" pings:</b> send <code>/broadcast</code> to your bot and the message reaches every paying member.</li>
</ul>
<h2>Pricing that works for fans</h2>
<p>A monthly plan for regulars, plus coins for fans who only want the occasional clip. New fans get free coins to try a few clips first.</p>
<div class="example"><b>Example:</b> 200 members at $4 a month is <b>$800 a month</b> before fees.</div>
<h2>Set up in seven minutes</h2>
<p>Create a bot with @BotFather, connect Paystack or NOWPayments, and add the bot to your group as an admin. Turn on join approval if you only want paying fans inside. ${esc(feeLine(ctx))}</p>
<p>Share the join link in your stream description or chat, and you're done.</p>`,
  },
  {
    slug: "paid-telegram-group-for-tutors",
    title: "A paid Telegram group for tutors and exam prep",
    short: "For tutors and exam prep",
    tag: "Education",
    description:
      "Run paid revision and tutoring groups on Telegram: term access by subscription, past papers and worked answers sold one at a time.",
    lead: "Students already swap notes on Telegram. Here's how to charge for the good stuff: your revision sessions, past papers and worked answers.",
    related: ["telegram-paid-group-mpesa", "sell-pay-per-post-content-on-telegram"],
    body: (ctx) => `
<h2>Two ways to sell</h2>
<ul>
  <li><b>Term access:</b> a monthly plan for your revision group, with daily questions, live sessions and the full archive.</li>
  <li><b>One paper at a time:</b> post each past paper's worked answers as a coin item. Students unlock just the ones they need; members get them all.</li>
</ul>
<h2>Parents can pay the way they already do</h2>
<p>M-Pesa, card or bank through Paystack. Payments go straight to your account and the student is let in automatically. When the month ends, the bot sends them a one-tap renew button.</p>
<div class="example"><b>Example:</b> 40 students at $4 a month is <b>$160 a month</b> before fees. Add a few dozen paper unlocks at 5 coins each and you've covered your printing.</div>
<h2>Keep the group tidy</h2>
<p>Turn on join approval so only paying students get in, and give the bot the <b>Ban users</b> and <b>Invite users via link</b> permissions. Students whose plan ends are removed for you, so the group stays fair to those who paid.</p>
<p>${esc(feeLine(ctx))} The free trial covers ${FREE_BOT_LIMIT} group and up to ${FREE_MEMBER_LIMIT} paying students.</p>`,
  },
  {
    slug: "paid-telegram-group-for-coaches",
    title: "A paid Telegram group for coaches",
    short: "For coaches",
    tag: "Coaching",
    description:
      "Deliver your coaching programme in a paid Telegram group: monthly membership, automatic removal when payments stop, and one-tap renewals.",
    lead: "Your programme lives in a group chat anyway. Let a bot handle payments, renewals and removals so you can spend the time coaching.",
    related: ["how-to-charge-for-a-telegram-group", "paid-telegram-alerts-group"],
    body: (ctx) => `
<h2>What changes</h2>
<p>No more spreadsheets of who has paid, no awkward reminders, no removing people by hand. Clients pay by card, M-Pesa or crypto, the bot lets them in, and when a monthly plan ends it takes their access away and offers a renew button.</p>
<h2>A structure that works</h2>
<ul>
  <li><b>Monthly membership</b> for the group: check-ins, Q&amp;A, accountability.</li>
  <li><b>Programme content</b> (workouts, worksheets, recorded sessions) as coin items, free for members.</li>
  <li><b>Announcements</b> to every paying member with <code>/broadcast</code>.</li>
</ul>
<div class="example"><b>Example:</b> 25 clients at $20 a month is <b>$500 a month</b> before fees.</div>
<h2>Give someone access for free</h2>
<p>For a scholarship, a friend or a refund, open your bot's page in the dashboard and use <i>Give someone free access</i>, or send <code>/grant</code> and their Telegram ID to your bot.</p>
<p>${esc(feeLine(ctx))}</p>`,
  },
  {
    slug: "paid-telegram-alerts-group",
    title: "A paid Telegram group for alerts and leads",
    short: "For alerts and leads",
    tag: "Alerts",
    description:
      "Charge for job leads, tenders, deals or scholarship alerts on Telegram. Members pay monthly to hear first; the bot handles payments and renewals.",
    lead: "If people already ask you where you find the good leads, they'll pay to get them first. A paid alerts group is the simplest business on Telegram.",
    related: ["how-to-charge-for-a-telegram-group", "telegram-paid-group-mpesa"],
    body: (ctx) => `
<h2>What people pay for</h2>
<p>Speed and curation. Job leads, freelance gigs, government tenders, scholarships, flight and product deals, supplier lists. The value is hearing first, without wading through noise.</p>
<h2>Why monthly works best</h2>
<p>Alerts are a habit. A monthly plan keeps members subscribed, and when someone's month ends the bot removes them and sends a renew button, so the alerts stay exclusive to people who pay.</p>
<h2>Use join approval</h2>
<p>An alert loses its value once it's shared around. Turn on join approval so only paying members are inside, and revoke any old invite links.</p>
<div class="example"><b>Example:</b> 150 members at $3 a month is <b>$450 a month</b> before fees.</div>
<h2>Post once, reach everyone</h2>
<p>Post in the group as usual, or send <code>/broadcast</code> to your bot to message every paying member directly.</p>
<p>${esc(feeLine(ctx))}</p>`,
  },
  {
    slug: "telegram-paywall-for-ai-agents",
    title: "Let an AI agent run your paid Telegram group",
    short: "For AI agents and developers",
    tag: "Builders",
    description:
      "Set up and manage a paid Telegram community through an API and MCP server. What an agent can do on its own, and the two things it needs from you.",
    lead: "Your AI assistant can set up and run your paid group: prices, members, payments and revenue. Here's what it can do alone, and the two things it needs from you.",
    related: ["how-to-charge-for-a-telegram-group", "sell-pay-per-post-content-on-telegram"],
    body: () => `
<h2>What an agent can do</h2>
<ul>
  <li>Create an account and get an API key.</li>
  <li>Launch the bot, set prices, switch on coins or join approval.</li>
  <li>See members, payments and revenue; give or remove access; create payment links; message members.</li>
</ul>
<h2>What it needs from you</h2>
<ol>
  <li><b>A bot token.</b> Telegram only lets people create bots: message @BotFather, send <code>/newbot</code>, and give the token to your agent.</li>
  <li><b>Payment keys.</b> Paystack and NOWPayments accounts need your identity, so you open them and hand over the keys.</li>
</ol>
<p>After that, your agent can run it day to day.</p>
<h2>Connect it</h2>
<ul>
  <li><b>Claude and other MCP clients:</b> add a custom connector with the address <code>/mcp</code> on this site. You can create an account on the sign-in page.</li>
  <li><b>Any agent or script:</b> the REST API is described at <a href="/openapi.json">/openapi.json</a>, and <a href="/llms.txt">/llms.txt</a> explains the platform in plain text.</li>
</ul>
<p>Agents and bots are welcome to sign up.</p>`,
  },
];

export function findGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

const footerLinks = () => GUIDES.map((g) => ({ slug: g.slug, short: g.short }));

export function guidesIndexPage(ctx: SiteContext): string {
  return `${siteHead(ctx, {
    title: `Guides · ${ctx.name}`,
    description: "Practical guides to running a paid Telegram group: taking M-Pesa, card and crypto payments, selling posts with coins, and setups for streamers, tutors, coaches and alert groups.",
    path: "/guides",
  })}
<body class="site">
${siteHeader(ctx)}
<main><div class="wrap">
  <header class="guide-head">
    <span class="eyebrow">Guides</span>
    <h1 class="display">Run a paid Telegram group, <em>well</em>.</h1>
    <p class="lead">Short, practical guides. Each one is written from what the bot actually does.</p>
  </header>
  <div class="guide-list">
    ${GUIDES.map((g) => `<a class="guide-card" href="/guides/${g.slug}"><span class="tag">${esc(g.tag)}</span><h2>${esc(g.title)}</h2><p>${esc(g.description)}</p></a>`).join("\n    ")}
  </div>
</div></main>
${siteFooter(ctx, footerLinks())}
</body>
</html>`;
}

export function guidePage(ctx: SiteContext, guide: Guide): string {
  const related = guide.related.map(findGuide).filter((g): g is Guide => Boolean(g));
  return `${siteHead(ctx, { title: `${guide.title} · ${ctx.name}`, description: guide.description, path: `/guides/${guide.slug}` })}
<body class="site">
${siteHeader(ctx)}
<main><div class="wrap">
  <header class="guide-head">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/guides">Guides</a> · ${esc(guide.tag)}</nav>
    <h1 class="display">${esc(guide.title)}</h1>
    <p class="lead">${esc(guide.lead)}</p>
  </header>
  <div class="guide-layout">
    <article class="prose">${guide.body(ctx)}
    </article>
    <aside class="aside">
      <h3>Your group, now a business</h3>
      <p>Card, M-Pesa and crypto payments. Build yours in 7 minutes.</p>
      ${start(ctx, `Start your ${FREE_TRIAL_DAYS}-day free trial`)}
      ${related.length ? `<div class="stack"><p class="eyebrow">Related</p>${related.map((r) => `<a href="/guides/${r.slug}">${esc(r.title)}</a>`).join("")}</div>` : ""}
    </aside>
  </div>
</div></main>
${siteFooter(ctx, footerLinks())}
</body>
</html>`;
}

export function sitemapXml(ctx: SiteContext): string {
  const urls = ["/", "/guides", ...GUIDES.map((g) => `/guides/${g.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(ctx.baseUrl + u)}</loc></url>`).join("\n")}
</urlset>
`;
}

export function robotsTxt(ctx: SiteContext): string {
  return `# People and bots are welcome. Agents: start at /llms.txt.
User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /admin
Disallow: /api/
Disallow: /authorize

Sitemap: ${ctx.baseUrl}/sitemap.xml
`;
}
