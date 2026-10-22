/**
 * Machine-readable descriptions of the platform, so AI agents and other bots
 * can find it, understand it and sign up without a person in the loop:
 *   /llms.txt       a plain-text guide (the llms.txt convention)
 *   /openapi.json   an OpenAPI 3.1 description of the creator API
 */

import { PLAN_DAYS, TIER_CUT, VOLUME_LADDER } from "../env";
import { GUIDES } from "./guides";
import type { SiteContext } from "./pages";

export type AgentInfo = SiteContext;

const pct = (n: number | undefined, d: number) => `${Math.round((n ?? d) * 100)}%`;

export function llmsTxt(info: AgentInfo): string {
  const b = info.baseUrl;
  const starter = info.starterPrice !== null
    ? `$${info.starterPrice.toFixed(2)} per ${PLAN_DAYS} days, bought with POST /api/v1/tenants/upgrade`
    : "by arrangement with the platform owner";
  return `# ${info.name}

> Charge for access to a Telegram group. A creator connects a Telegram bot and their own Paystack (cards, bank, M-Pesa) or NOWPayments (crypto) account; the bot takes payments, lets paying members in (daily, weekly, monthly or lifetime plans, priced in USD or the Paystack currency such as KES), removes them when a plan ends, and can sell individual content items for coins. Buyers pay the creator directly. Agents and bots may sign up and operate accounts through the API or MCP.

## Quick start for agents

An agent can do almost all of this through the API or MCP. Two steps need a person, so ask your human for:
- **a Telegram bot token**: only people can create bots (message @BotFather, send /newbot);
- **payment keys**: a Paystack secret key (cards, bank, M-Pesa) and/or a NOWPayments API key + IPN secret (crypto). These accounts need the person's identity.

1. Sign up: POST ${b}/api/v1/tenants/signup with JSON {"name": "...", "email": "..."}. The response contains api_key (shown once). Optionally add "telegram_id" so the account key can be recovered later by sending /accountkey to the creator's bot.
2. Create a bot: POST ${b}/api/v1/bots with header x-api-key and JSON {"bot_token": "<from @BotFather>", "paystack_secret_key": "sk_...", "one_time_price": 10, "monthly_price": 5}. Use nowpayments_api_key + nowpayments_ipn_secret for crypto.
3. Add the bot to the Telegram group as an admin with the "Ban users" permission (and "Invite users via link" for join approval). The group links itself.
4. Check: GET ${b}/api/v1/bots/{bot_id}/check returns ready: true when buyers can pay.

${info.signupsOpen ? "Signups are open." : "Signups are currently closed."} Errors are JSON {"detail": "..."} with a message that says how to fix the request.

## Pricing

- Standard: free to start, no monthly fee. Platform fee per sale by the creator's confirmed sales over the last 30 days: ${[...VOLUME_LADDER].reverse().map((s) => `${pct(s.cut, 0)} from $${s.fromUsd.toLocaleString("en-US")}`).join(", ")}. GET /api/v1/tenants/me shows the current rate and the next step.
- Starter: flat ${pct(TIER_CUT.starter, 0.05)} per sale; ${starter}.
- The same rate applies to group plans (daily, weekly, monthly, lifetime) and pay-per-post (coins, Image Vault).
- Optional free pass: a bot can let newcomers in free for 1 to 720 hours (free_pass_hours), then offer the plans.
- Adult content: label the bot with "adult": true. Paystack doesn't support adult content, so labelled groups take crypto (NOWPayments or BTCPay) only, and their creators pay platform fees in crypto. Legal content of consenting adults only; nothing involving minors, no violence.
- Platform fees accrue per sale and are paid with POST /api/v1/tenants/pay-fees (see GET /api/v1/tenants/billing).

## Guides

${GUIDES.map((g) => `- [${g.title}](${b}/guides/${g.slug}): ${g.description}`).join("\n")}

## Interfaces

- REST API: ${b}/api/v1 (OpenAPI: ${b}/openapi.json). Auth: header x-api-key: pbk_...
- MCP server: ${b}/mcp (OAuth; the sign-in page also creates accounts). Tools cover bots, members, payments, revenue, coins and join settings.
- Dashboard for people: ${b}/dashboard

## Key endpoints

- POST /api/v1/tenants/signup — create an account
- GET /api/v1/tenants/me — account, plan, earnings
- GET /api/v1/tenants/billing — fees owed, limits, plan price
- POST /api/v1/tenants/pay-fees {"provider": "paystack"|"nowpayments"} — payment link for fees owed
- POST /api/v1/tenants/upgrade {"provider": ...} — buy Starter (when offered)
- POST /api/v1/bots — create a bot; GET /api/v1/bots — list; GET/PATCH/DELETE /api/v1/bots/{id}
- PATCH /api/v1/bots/{id} also sets coins (coins_enabled, free_coins, unlock_cost, coin_packs) and join_mode ("mute" | "approve")
- GET /api/v1/bots/{id}/members; POST /api/v1/bots/{id}/members/{telegram_id}/grant | /revoke
- POST /api/v1/payments/generate-link — payment link for a Telegram user
- GET /api/v1/analytics/overview; GET /api/v1/analytics/payments
${info.contact ? `\n## Contact\n\n${info.contact}\n` : ""}`;
}

/** OpenAPI 3.1 for the creator API. Kept deliberately compact. */
export function openApi(info: AgentInfo): Record<string, unknown> {
  const json = (schema: Record<string, unknown>) => ({ content: { "application/json": { schema } } });
  const ok = (description: string) => ({ "200": { description, ...json({ type: "object" }) } });
  const id = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });
  const secured = [{ apiKey: [] }];
  const provider = { type: "string", enum: ["paystack", "nowpayments", "btcpay"] };
  const price = { type: "number", minimum: 0, maximum: 100000, description: "USD" };
  const botSettings = {
    type: "object",
    properties: {
      one_time_price: price,
      monthly_price: price,
      image_unlock_price: price,
      currency: { type: "string", example: "KES", description: "Currency Paystack charges in" },
      fx_rate: { type: "number", description: "Units of currency per 1 USD (required when currency isn't USD)" },
      welcome_title: { type: "string", maxLength: 256 },
      welcome_text: { type: "string", maxLength: 2000 },
      group_description: { type: "string", maxLength: 2000 },
      admin_user_ids: { type: "array", items: { type: "integer" } },
      status: { type: "string", enum: ["active", "paused"] },
      join_mode: { type: "string", enum: ["mute", "approve"] },
      free_pass_hours: { type: "integer", minimum: 0, maximum: 720 },
      adult: { type: "boolean", description: "Adults-only group: crypto payments only (Paystack doesn't support adult content)" },
      coins_enabled: { type: "boolean" },
      free_coins: { type: "integer", minimum: 0 },
      unlock_cost: { type: "integer", minimum: 1 },
      coin_packs: {
        type: "array",
        maxItems: 3,
        items: { type: "object", required: ["coins", "price"], properties: { coins: { type: "integer" }, price: { type: "number" } } },
      },
      paystack_secret_key: { type: "string", pattern: "^sk_" },
      paystack_public_key: { type: "string", pattern: "^pk_" },
      nowpayments_api_key: { type: "string" },
      nowpayments_ipn_secret: { type: "string" },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: `${info.name} API`,
      version: "2",
      description: "Charge for access to Telegram groups. Sign up, create a bot, and manage members, payments, coins and join approval. Errors are JSON {detail}.",
    },
    servers: [{ url: info.baseUrl }],
    components: {
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "pbk_… key from signup" } },
    },
    paths: {
      "/api/v1/tenants/signup": {
        post: {
          summary: "Create an account (free to start)",
          requestBody: json({
            type: "object",
            required: ["name", "email"],
            properties: { name: { type: "string" }, email: { type: "string", format: "email" }, telegram_id: { type: "integer", description: "Telegram account allowed to recover the key with /accountkey" } },
          }),
          responses: { ...ok("Account created; api_key is shown once"), "429": { description: "Too many signups from this network this hour" } },
        },
      },
      "/api/v1/tenants/me": {
        get: { summary: "Account, plan and earnings", security: secured, responses: ok("Account") },
        patch: {
          summary: "Change name or recovery Telegram ID",
          security: secured,
          requestBody: json({ type: "object", properties: { name: { type: "string" }, recovery_telegram_id: { type: ["integer", "null"] } } }),
          responses: ok("Updated"),
        },
      },
      "/api/v1/tenants/rotate-key": { post: { summary: "Replace the API key", security: secured, responses: ok("New key") } },
      "/api/v1/tenants/billing": { get: { summary: "Fees owed, fee limit, Starter price", security: secured, responses: ok("Billing status") } },
      "/api/v1/tenants/pay-fees": {
        post: { summary: "Payment link for platform fees owed", security: secured, requestBody: json({ type: "object", required: ["provider"], properties: { provider } }), responses: ok("Payment link") },
      },
      "/api/v1/tenants/upgrade": {
        post: { summary: "Buy Starter (when offered); without provider, describes the options", security: secured, requestBody: json({ type: "object", properties: { provider } }), responses: { ...ok("Payment link"), "402": { description: "How to upgrade" } } },
      },
      "/api/v1/bots": {
        get: { summary: "List bots", security: secured, responses: ok("Bots") },
        post: {
          summary: "Create a bot",
          security: secured,
          requestBody: json({ ...botSettings, required: ["bot_token"], properties: { bot_token: { type: "string", description: "From @BotFather" }, ...botSettings.properties } }),
          responses: ok("Bot created, with webhook URLs and next steps"),
        },
      },
      "/api/v1/bots/{botId}": {
        parameters: [id("botId")],
        get: { summary: "Bot details", security: secured, responses: ok("Bot") },
        patch: { summary: "Change settings (only fields sent change)", security: secured, requestBody: json(botSettings), responses: ok("Updated") },
        delete: { summary: "Delete the bot (payment history kept)", security: secured, responses: ok("Deleted") },
      },
      "/api/v1/bots/{botId}/check": { parameters: [id("botId")], get: { summary: "Live check of Telegram and payment credentials", security: secured, responses: ok("Checks") } },
      "/api/v1/bots/{botId}/members": {
        parameters: [id("botId")],
        get: { summary: "Paying members", security: secured, parameters: [{ name: "search", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer" } }, { name: "offset", in: "query", schema: { type: "integer" } }], responses: ok("Members") },
      },
      "/api/v1/bots/{botId}/members/{telegramId}/grant": { parameters: [id("botId"), id("telegramId")], post: { summary: "Give free access", security: secured, responses: ok("Granted") } },
      "/api/v1/bots/{botId}/members/{telegramId}/revoke": { parameters: [id("botId"), id("telegramId")], post: { summary: "Remove access", security: secured, responses: ok("Revoked") } },
      "/api/v1/payments/generate-link": {
        post: {
          summary: "Payment link for a Telegram user",
          security: secured,
          requestBody: json({ type: "object", required: ["bot_id", "telegram_id", "access_type", "provider"], properties: { bot_id: { type: "string" }, telegram_id: { type: "integer" }, access_type: { type: "string", enum: ["one_time", "monthly", "image_unlock"] }, provider } }),
          responses: ok("Payment link"),
        },
      },
      "/api/v1/payments/{orderId}": { parameters: [id("orderId")], get: { summary: "Payment status", security: secured, responses: ok("Payment") } },
      "/api/v1/analytics/overview": { get: { summary: "Revenue and members", security: secured, responses: ok("Overview") } },
      "/api/v1/analytics/payments": { get: { summary: "Confirmed payments", security: secured, responses: ok("Payments") } },
    },
  };
}
