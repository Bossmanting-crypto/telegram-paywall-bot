# Paywall Bot

A Telegram paywall bot platform that runs on Cloudflare Workers.

- **Your own bot** — people who join your group are restricted until they pay by card / M-Pesa (Paystack) or crypto (NOWPayments, BTCPay). Payment unlocks them automatically.
- **A platform for other creators** — creators sign up through the API, connect their own bot, group and payment keys, and you record a cut of every payment.
- **Run it from Claude** — an MCP server lets you, and each creator, manage bots by chatting with Claude or any other MCP client: "who paid this week?", "give @jane free access", "raise the monthly price to $8".

It runs as a single Worker with a D1 database. There is no server to keep running: Telegram and the payment providers call the Worker when something happens.

---

## Launch checklist

You need a Cloudflare account and this repository on GitHub. Nothing has to be installed on your computer.

### 1. Create the database — done

The D1 database already exists and its ID is set in [`wrangler.jsonc`](wrangler.jsonc). The Worker creates its own tables the first time it runs.

To move to a different database later: create one under **Storage & Databases → D1 SQL Database → Create**, then replace the `database_id` in `wrangler.jsonc` with the new Database ID. The ID is not a secret.

### 2. Deploy from GitHub

1. Open **Workers & Pages → Create application → Import a repository**.
2. Pick this repository. Keep the project name **`telegram-paywall-bot`** — it has to match the `name` in `wrangler.jsonc`, or the build fails.
3. Leave the deploy command as `npx wrangler deploy` and select **Save and Deploy**.

Cloudflare redeploys on every push to `main`. Your Worker's address looks like `https://telegram-paywall-bot.<your-subdomain>.workers.dev`.

### 3. Add your secrets

In the Worker open **Settings → Variables and Secrets** and add each value as type **Secret**. Never put these in the repository or in a chat.

| Name | Needed | What it is |
|---|---|---|
| `ADMIN_API_KEY` | Always | A password you invent for yourself, 24+ characters. Unlocks `/admin`. |
| `ENCRYPTION_KEY` | Always | A second invented password, 32+ characters. Encrypts creators' keys in the database. **Never change it afterwards** — stored keys become unreadable. |
| `TELEGRAM_BOT_TOKEN` | Your bot | From @BotFather. |
| `ADMIN_USER_IDS` | Your bot | Your Telegram user ID (comma-separate several). Send `/id` to the bot to see yours. |
| `GROUP_CHAT_ID` | Optional | Your group's ID, e.g. `-1001234567890`. If you leave it out, the bot links itself to the first group that makes it an admin. |
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` | For Paystack | `sk_live_…` / `pk_live_…` |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | For NOWPayments | Both are required. |
| `BTCPAY_URL`, `BTCPAY_STORE_ID`, `BTCPAY_API_KEY`, `BTCPAY_WEBHOOK_SECRET` | For BTCPay | All four are required. |

These names are the same ones the original Python bot used, so existing values copy straight across.

Optional settings (add as plain **Text** variables; the defaults are shown):

| Name | Default | Meaning |
|---|---|---|
| `ONE_TIME_PRICE_USD` | `10` | Price of lifetime access. |
| `MONTHLY_PRICE_USD` | `5` | Price of 30 days' access. |
| `IMAGE_UNLOCK_PRICE_USD` | `0` (off) | Price of the image vault. |
| `PAYSTACK_CURRENCY` | `KES` | Currency Paystack charges in. |
| `PAYSTACK_FX_RATE` | `129` | How many units of that currency equal 1 USD. **Check this against today's rate** — it is a fixed number, not a live rate. Use `1` if the currency is `USD`. |
| `PAYSTACK_CHANNELS` | `card,mobile_money,bank` | Payment methods offered on the Paystack page. |
| `BTCPAY_ACCEPT_UNCONFIRMED` | `true` | `true` unlocks as soon as a Bitcoin payment is seen; `false` waits for confirmations. |
| `APP_URL` | the Worker's own address | Set this if you use a custom domain. |
| `CORS_ORIGINS` | none | Websites allowed to call the API from a browser, comma-separated. |
| `ALLOW_SIGNUPS` | `true` | `false` closes creator signup. |

### 4. Run setup and check your credentials

Open `https://<your-worker-address>/admin`, enter your `ADMIN_API_KEY`, and press **Run setup**. This connects Telegram to the Worker and then asks Telegram, Paystack, NOWPayments and BTCPay whether each key is accepted. Every item should show ✓. **Check credentials** repeats the check at any time without changing anything.

Run setup again whenever you change a secret or the Worker's address.

### 5. Finish in Telegram and the payment dashboards

1. Add the bot to your group as an **admin** with the **Ban users** permission.
2. Paste the webhook URLs that setup shows you:
   - **Paystack** → Settings → API Keys & Webhooks → Webhook URL: `https://<your-worker-address>/webhooks/paystack/owner`
   - **BTCPay** → Store → Settings → Webhooks: `https://<your-worker-address>/webhooks/btcpay/owner`, using the same secret as `BTCPAY_WEBHOOK_SECRET`
   - **NOWPayments** needs nothing: the callback address is sent with every invoice.
3. Press **Check credentials** on the admin page again: the group line should now show ✓.
4. Make one small real payment yourself before announcing the bot.

---

## How it works

1. Someone joins your group. The bot restricts them (they can read but not post) and sends them the payment menu privately. If it cannot message them yet, it posts a short notice in the group with an **Unlock access** button.
2. They choose a plan and a payment method and get a payment link.
3. The provider notifies the Worker. The Worker checks the provider's signature and the amount paid, records the payment once, lifts the restriction and tells the buyer.
4. Every minute a scheduled job removes access from monthly subscriptions that have run out and asks those members to renew.

Because a restricted member can still read the group, this protects *posting*, not *viewing*. If the content itself is what you sell, keep the group's invite link private.

### Bot commands for admins

| Command | What it does |
|---|---|
| `/stats` | Members and payments. |
| `/grant <user_id>` | Give someone access for free. |
| `/revoke <user_id>` | Remove someone's access. |
| `/broadcast <message>` | Message every paying member (delivered in batches, about 20 a minute). |
| `/vault` | Image vault status. Send photos to the bot privately to add them. |
| `/clearvault` | Empty the vault. |
| `/id` | Show the chat ID and your user ID. |

The **image vault** is a set of photos sold separately: once `IMAGE_UNLOCK_PRICE_USD` is above 0 and the vault has images, buyers see an extra button, and the bot sends them the images after payment.

---

## Creator platform

Other creators use the API with their own key. You, as the owner, can use the same API for your own bot by sending `x-admin-key` instead of `x-api-key`.

### Plans

| Tier | Platform cut | Limits |
|---|---|---|
| `free` | 15% | 1 bot, 10 paying members, 14 days — then the bot stops selling until upgraded |
| `starter` | 8% | Unlimited bots and members |
| `whitelabel` | 0% | Unlimited |

Creators cannot change their own plan. After they pay you, set it yourself:

```bash
curl -X POST https://<worker>/admin/tenants/<tenant_id>/tier \
  -H "x-admin-key: <ADMIN_API_KEY>" -H "content-type: application/json" \
  -d '{"tier": "starter"}'
```

**How the cut is collected.** Each creator's payments go to that creator's own Paystack / NOWPayments / BTCPay account. The platform records your cut on every payment (`GET /admin/overview`, `GET /admin/tenants`) so you can invoice it. For Paystack only, you can have it routed automatically: the creator adds a *subaccount* in their Paystack dashboard that pays out to you, and you register its code with `POST /admin/tenants/<tenant_id>/paystack-subaccount`. This split has not been exercised against a live Paystack account — try it in Paystack test mode first.

### Sign up and create a bot

```bash
curl -X POST https://<worker>/api/v1/tenants/signup \
  -H "content-type: application/json" \
  -d '{"email": "creator@example.com", "name": "My Brand"}'
# → { "api_key": "pbk_…", "tier": "free", ... }   The key is shown once.

curl -X POST https://<worker>/api/v1/bots \
  -H "x-api-key: pbk_…" -H "content-type: application/json" \
  -d '{
    "bot_token": "1234567890:AA…",
    "one_time_price": 10,
    "monthly_price": 5,
    "image_unlock_price": 20,
    "paystack_secret_key": "sk_live_…",
    "paystack_public_key": "pk_live_…",
    "welcome_title": "VIP Art Club",
    "group_description": "Exclusive art community"
  }'
```

The response lists the webhook URLs to paste into the creator's payment dashboards. The bot starts working as soon as it is made an admin of a group.

Other fields accepted when creating or updating a bot: `welcome_text`, `admin_user_ids`, `nowpayments_api_key` + `nowpayments_ipn_secret`, `btcpay_url` + `btcpay_store_id` + `btcpay_api_key` + `btcpay_webhook_secret`, and `currency` + `fx_rate` to have Paystack charge in a currency other than USD (prices are always set in USD).

### API reference

Creator endpoints need `x-api-key: pbk_…`. Errors come back as `{ "detail": "…" }`.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/tenants/signup` | Create an account (no key needed) |
| GET | `/api/v1/tenants/me` | Profile and earnings |
| POST | `/api/v1/tenants/rotate-key` | Replace the API key |
| POST | `/api/v1/bots` | Create a bot |
| GET | `/api/v1/bots` | List bots |
| GET | `/api/v1/bots/{id}` | Bot details |
| GET | `/api/v1/bots/{id}/check` | Live check of the bot's Telegram and payment credentials |
| PATCH | `/api/v1/bots/{id}` | Update prices, texts, keys, or `status` (`active` / `paused`) |
| DELETE | `/api/v1/bots/{id}` | Delete a bot |
| GET | `/api/v1/bots/{id}/members` | Paying members |
| POST | `/api/v1/bots/{id}/members/{telegram_id}/grant` | Give access |
| POST | `/api/v1/bots/{id}/members/{telegram_id}/revoke` | Remove access |
| POST | `/api/v1/payments/generate-link` | Create a payment link manually |
| GET | `/api/v1/payments/{order_id}` | Look up an order |
| GET | `/api/v1/analytics/overview` | Revenue summary |
| GET | `/api/v1/analytics/payments` | Payment history |

Owner endpoints need `x-admin-key`:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/admin` | Setup page (asks for the key) |
| POST | `/admin/setup` | Connect Telegram and check everything |
| GET | `/admin/check-credentials` | Check everything without changing anything |
| GET | `/admin/overview` | Platform totals and your fees |
| GET | `/admin/tenants` | All creators |
| POST | `/admin/tenants/{id}/tier` | Change a creator's plan |
| POST | `/admin/tenants/{id}/active` | Suspend or restore a creator |
| POST | `/admin/tenants/{id}/paystack-subaccount` | Enable or remove the Paystack split |

Webhooks (called by Telegram and the providers, not by you): `/telegram/{bot_id}`, `/webhooks/paystack/{bot_id}`, `/webhooks/nowpayments/{bot_id}`, `/webhooks/btcpay/{bot_id}`. The original bot's `/webhook/paystack`, `/webhook/nowpayments` and `/webhook/btcpay` paths still work for the owner bot.

---

## Manage it from Claude (MCP server)

The Worker includes an MCP server at `https://<your-worker-address>/mcp`. Anyone with an account key can connect it to Claude: you with your `ADMIN_API_KEY`, each creator with their own `pbk_…` key. Each person sees only their own bots, and only you see the platform-owner tools.

### Connect Claude

1. In Claude, open **Customize → Connectors → Add custom connector** (on Team and Enterprise plans an owner adds it under **Organization settings → Connectors**).
2. Enter `https://<your-worker-address>/mcp` and select **Add**, then **Connect**.
3. A sign-in page opens. Paste your key, check that it names the app you are connecting, and select **Allow**.

Claude Code: `claude mcp add --transport http paywall https://<your-worker-address>/mcp`, then run `/mcp` to sign in.

The key is checked on that page and is never handed to Claude, which gets its own token instead. Rotating a creator key, changing `ADMIN_API_KEY` or suspending a creator ends every connection made with the old key.

### What it can do

| Tool | Does |
|---|---|
| `paywall_get_account` | Plan, platform cut, bots, lifetime earnings |
| `paywall_list_bots`, `paywall_get_bot` | Bots, their prices, group, payment methods, webhook addresses |
| `paywall_check_bot` | Live check of the bot token, group admin rights and payment keys |
| `paywall_update_bot` | Change prices, welcome texts, admins; pause or resume |
| `paywall_list_members` | Paying members, searchable by @username or name |
| `paywall_grant_access`, `paywall_revoke_access` | Give or remove access, in Telegram too |
| `paywall_create_payment_link` | A payment link for one person |
| `paywall_get_payment`, `paywall_list_payments` | Look up orders and completed payments |
| `paywall_get_revenue` | Revenue, all time and last 30 days |
| `paywall_send_broadcast` | Message every paying member |
| `paywall_admin_*` (owner only) | Platform totals, list creators, change a creator's plan, suspend or restore |

Payment-provider keys cannot be read or changed through the MCP server, because anything typed in a chat passes through the AI model and the chat history. Set them through the API or the Cloudflare dashboard.

### Notes

- Sign-in records live in a KV namespace (`OAUTH_KV`) that Cloudflare creates on the first deploy. If that deploy fails with a permissions error about KV, create a namespace under **Storage & Databases → KV**, then add `"id": "<namespace id>"` to the `OAUTH_KV` entry in `wrangler.jsonc`.
- If you set `APP_URL` (a custom domain), connect Claude with that address, not the `workers.dev` one.
- KV on the free plan allows 1,000 writes a day. Each sign-in uses a handful, and each connected app refreshes its token about once an hour, so this covers a few dozen active connections. The bot itself does not use KV, so hitting the limit only pauses new MCP sign-ins until the next day.
- On the free Workers plan, the first MCP request after Cloudflare starts a fresh copy of the Worker uses more CPU than the 10 ms per-request allowance. Cloudflare tolerates occasional overruns; if Claude shows errors such as "Worker exceeded resource limits", the $5/month Workers plan removes the limit. Later requests use a few milliseconds each.

---

## Security

- Payment webhooks are accepted only with a valid provider signature. Paystack and BTCPay payments are then confirmed again with the provider's own API, and the amount and currency must match the order.
- A payment is confirmed exactly once, even if a provider delivers the same notification several times.
- Telegram updates are accepted only with the per-bot secret that was registered with Telegram.
- Creator API keys are stored as hashes. Creators' bot tokens and payment keys are encrypted in the database with `ENCRYPTION_KEY`. Your own keys live only in Worker secrets.
- A creator can only see and change their own bots, members and payments, through the API and through the MCP server alike.
- MCP connections use OAuth 2.1 with PKCE. The sign-in page shows which app is asking and where access will be sent, and cannot be framed or submitted from another site. Tokens, codes and client secrets are stored only as hashes.
- Signup is open by default. Set `ALLOW_SIGNUPS=false` to close it, or add a Cloudflare rate-limiting rule on `/api/v1/tenants/signup` if it is abused.

---

## Costs

The Worker is written to fit Cloudflare's free plan: it does little computation per request and the scheduled job works in small batches. The free plan has daily limits on requests and on database reads and writes; when a limit is reached, requests or database queries fail until the limit resets, so move to the paid Workers plan before you depend on it for a busy group. Current limits: [Workers](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

---

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in test values; never commit this file
npm run dev                      # local Worker on http://localhost:8787
npm run check                    # type check + tests
```

Tests run inside the real Workers runtime with a local D1 database. Telegram and the payment providers are replaced by fakes, so tests never touch the network.

| Path | Contents |
|---|---|
| `src/index.ts`, `src/app.ts` | Worker entry point, routing, error handling |
| `src/bot/handlers.ts` | Telegram bot logic |
| `src/payments.ts` | Create payment links, confirm payments, unlock members |
| `src/providers/` | Paystack, NOWPayments, BTCPay clients and signature checks |
| `src/routes/` | API, admin and webhook routes |
| `src/services.ts` | Operations shared by the API, the MCP tools and the bot |
| `src/mcp/` | MCP tools and the OAuth sign-in page |
| `src/checks.ts` | Live credential checks |
| `src/cron.ts` | Subscription expiry, trial expiry, broadcasts |
| `src/schema.ts` | Database tables (applied automatically) |

The previous Python version of this bot is in the repository history (commit `dd191ea`).
