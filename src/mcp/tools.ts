/**
 * The MCP server: tools that let a creator (or the platform owner) run their
 * paywall bots from Claude or any other MCP client.
 *
 * One McpServer is built per request for one signed-in account. Admin-only
 * tools are registered only when that account is the platform owner, so other
 * accounts never even see them listed.
 *
 * Payment-provider keys are deliberately not settable here: anything typed
 * into a chat passes through the model and the client's history.
 */

import { McpServer, preloadSchemas, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { checkBot, summarise } from "../checks";
import { loadTenantBot, type AccessType, type BotConfig, type Provider, type TenantRow } from "../db";
import type { AppEnv } from "../env";
import { HttpError, ProviderError, logError, money } from "../lib/http";
import { availableProviders, createPayment } from "../payments";
import {
  accountSummary,
  botDetail,
  findTenantPayment,
  grantAccess,
  listBots,
  listConfirmedPayments,
  listCreators,
  listMembers,
  paymentView,
  platformOverview,
  queueBroadcast,
  revenueOverview,
  revokeAccess,
  setCreatorActive,
  setCreatorPlan,
  updateBotSettings,
  type BotSettingsUpdate,
  type WaitUntil,
} from "../services";

export const SERVER_NAME = "telegram-paywall-mcp-server";
export const SERVER_VERSION = "1.0.0";

export interface PaywallContext {
  env: AppEnv;
  tenant: TenantRow;
  admin: boolean;
  baseUrl: string;
  waitUntil: WaitUntil;
}

const INSTRUCTIONS = `Tools for running Telegram paywall bots: people who join a paid Telegram group are restricted until they pay, and payment unlocks them automatically.

- All prices and amounts are in US dollars.
- A member is identified by their numeric Telegram user ID (telegram_id), not their @username. paywall_list_members can search by username to find the ID.
- Most tools take an optional "bot" (a bot ID or @username). It can be left out when the account has only one bot.
- Payment-provider keys cannot be read or changed through these tools.`;

// ── Shared schemas and helpers ───────────────────────────────────────────────

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

const responseFormat = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for readable text (default), 'json' for structured data");

const botArg = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional()
  .describe("Bot ID or @username. Leave out when the account has only one bot.");

const telegramId = z
  .number()
  .int()
  .positive()
  .describe("The member's numeric Telegram user ID, e.g. 123456789 (not their @username)");

const limitArg = (fallback: number) =>
  z.number().int().min(1).max(100).default(fallback).describe("Maximum number of results to return");
const offsetArg = z.number().int().min(0).default(0).describe("Number of results to skip, for pagination");

const price = (what: string) => z.number().min(0).max(100000).optional().describe(`${what} in USD; 0 turns it off`);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

type Json = Record<string, unknown>;

function reply(format: ResponseFormat, data: Json, markdown: () => string): CallToolResult {
  if (format === ResponseFormat.JSON) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
  return { content: [{ type: "text", text: markdown() }] };
}

function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function percent(cut: number): string {
  return `${Math.round(cut * 100)}%`;
}

/** Markdown table cells: no pipes or line breaks from user-supplied text. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\|/g, "/").replace(/\s+/g, " ");
}

function pageFooter(total: number, offset: number, count: number): string {
  const next = offset + count;
  return next < total ? `\n\nShowing ${offset + 1}–${next} of ${total}. More results: call again with offset=${next}.` : "";
}

function pageMeta(total: number, offset: number, count: number): Json {
  const next = offset + count;
  return { total, count, offset, has_more: next < total, ...(next < total ? { next_offset: next } : {}) };
}

/**
 * Expected failures (a 404, a validation error, a provider refusing a key)
 * reach the model with their message, which says how to recover. Anything
 * else is logged and replaced with a generic message.
 */
function safe<A>(name: string, handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof HttpError) return { isError: true, content: [{ type: "text", text: error.message }] };
      if (error instanceof ProviderError) {
        return {
          isError: true,
          content: [{ type: "text", text: `${error.provider} refused the request: ${error.message}` }],
        };
      }
      logError("mcp tool failed", error, { tool: name });
      return { isError: true, content: [{ type: "text", text: "Something went wrong on the server. Try again shortly." }] };
    }
  };
}

/** Find the bot the caller means: by ID, by @username, or the only one they have. */
async function resolveBot(ctx: PaywallContext, bot: string | undefined): Promise<BotConfig> {
  const bots = await listBots(ctx.env, ctx.tenant.id);
  if (bot) {
    const wanted = bot.replace(/^@/, "").toLowerCase();
    const match = bots.find((b) => b.id === bot || b.botUsername?.replace(/^@/, "").toLowerCase() === wanted);
    if (!match) {
      throw new HttpError(404, `No bot "${bot}" on this account. ${describeChoices(bots)}`);
    }
    return loadTenantBot(ctx.env, match.id, ctx.tenant.id);
  }
  const only = bots[0];
  if (bots.length === 1 && only) return loadTenantBot(ctx.env, only.id, ctx.tenant.id);
  if (bots.length === 0) {
    throw new HttpError(404, "This account has no bots yet. Register one through the API first (POST /api/v1/bots).");
  }
  throw new HttpError(400, `This account has ${bots.length} bots, so say which one. ${describeChoices(bots)}`);
}

function describeChoices(bots: Array<{ id: string; botUsername: string | null }>): string {
  if (bots.length === 0) return "The account has no bots.";
  return `Bots on this account: ${bots.map((b) => (b.botUsername ? `${b.botUsername} (${b.id})` : b.id)).join(", ")}.`;
}

function botLabel(bot: BotConfig): string {
  return bot.username ? `@${bot.username}` : bot.id;
}

// ── Tool inputs ──────────────────────────────────────────────────────────────
// Built once per isolate rather than on every request: Workers bill CPU per
// request but not module start-up, and the free plan allows 10 ms a request.

preloadSchemas();

const FORMAT_ONLY = z.strictObject({ response_format: responseFormat });

const BOT_AND_FORMAT = z.strictObject({ bot: botArg, response_format: responseFormat });

const UPDATE_BOT_INPUT = z.strictObject({
  bot: botArg,
  one_time_price: price("Price of lifetime access"),
  monthly_price: price("Price of 30 days' access"),
  image_unlock_price: price("Price of the image vault"),
  welcome_title: z.string().trim().max(256).optional().describe("Heading of the payment menu newcomers see"),
  welcome_text: z.string().trim().max(2000).optional().describe("Text under the heading"),
  group_description: z.string().trim().max(2000).optional().describe("Optional line describing the group"),
  admin_user_ids: z
    .array(z.number().int().positive())
    .max(50)
    .optional()
    .describe("Telegram user IDs allowed to use the bot's admin commands. Replaces the current list."),
  status: z.enum(["active", "paused"]).optional().describe("'paused' stops selling, 'active' resumes"),
      });

const LIST_MEMBERS_INPUT = z.strictObject({
  bot: botArg,
  search: z.string().trim().max(64).optional().describe("Part of a @username or first name"),
  limit: limitArg(20),
  offset: offsetArg,
  response_format: responseFormat,
      });

const GRANT_ACCESS_INPUT = z.strictObject({ bot: botArg, telegram_id: telegramId });

const REVOKE_ACCESS_INPUT = z.strictObject({ bot: botArg, telegram_id: telegramId });

const CREATE_PAYMENT_LINK_INPUT = z.strictObject({
  bot: botArg,
  telegram_id: telegramId,
  access_type: z.enum(["one_time", "monthly", "image_unlock"]).describe("What the user is buying"),
  provider: z
    .enum(["paystack", "nowpayments", "btcpay"])
    .optional()
    .describe("'paystack' (card / M-Pesa), 'nowpayments' (crypto) or 'btcpay' (Bitcoin)"),
      });

const GET_PAYMENT_INPUT = z.strictObject({
  order_id: z.string().trim().min(3).max(128).describe("The order reference"),
  response_format: responseFormat,
      });

const LIST_PAYMENTS_INPUT = z.strictObject({
  bot: z.string().trim().min(1).max(64).optional().describe("Only this bot (ID or @username). Leave out for all bots."),
  limit: limitArg(20),
  offset: offsetArg,
  response_format: responseFormat,
      });

const SEND_BROADCAST_INPUT = z.strictObject({
  bot: botArg,
  message: z.string().trim().min(1).max(4000).describe("The message, as plain text"),
      });

const ADMIN_LIST_CREATORS_INPUT = z.strictObject({ limit: limitArg(20), offset: offsetArg, response_format: responseFormat });

const ADMIN_SET_CREATOR_PLAN_INPUT = z.strictObject({
  creator_id: z.string().trim().min(1).max(64).describe("From paywall_admin_list_creators"),
  plan: z.enum(["free", "starter", "whitelabel"]),
  platform_cut_percent: z.number().min(0).max(100).optional().describe("Custom cut, e.g. 5 for 5%"),
      });

const ADMIN_SET_CREATOR_ACTIVE_INPUT = z.strictObject({
  creator_id: z.string().trim().min(1).max(64).describe("From paywall_admin_list_creators"),
  active: z.boolean().describe("false suspends, true restores"),
      });

// ── Server factory ───────────────────────────────────────────────────────────

export function buildServer(ctx: PaywallContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerCreatorTools(server, ctx);
  if (ctx.admin) registerAdminTools(server, ctx);
  return server;
}

function registerCreatorTools(server: McpServer, ctx: PaywallContext): void {
  const { env } = ctx;

  server.registerTool(
    "paywall_get_account",
    {
      title: "Get account",
      description:
        "Show the signed-in account: plan, platform cut, number of bots, trial end date and lifetime earnings. Use paywall_get_revenue for recent revenue.",
      inputSchema: FORMAT_ONLY,
      annotations: READ_ONLY,
    },
    safe("paywall_get_account", async ({ response_format }) => {
      const a = await accountSummary(env, ctx.tenant);
      const data = {
        id: a.id,
        name: a.name,
        email: a.email,
        plan: a.tier,
        platform_cut: a.platformCut,
        platform_owner: ctx.admin,
        bots: a.bots,
        trial_ends: a.trialEndsAt,
        gross_usd: a.grossUsd,
        platform_fees_usd: a.feesUsd,
        net_usd: a.netUsd,
      };
      return reply(response_format, data, () =>
        [
          `# ${a.name}${ctx.admin ? " (platform owner)" : ""}`,
          `- Plan: ${a.tier}, platform cut ${percent(a.platformCut)}`,
          `- Bots: ${a.bots}`,
          ...(a.trialEndsAt ? [`- Free trial ends: ${a.trialEndsAt.slice(0, 10)}`] : []),
          `- Earned so far: ${usd(a.grossUsd)} gross, ${usd(a.feesUsd)} platform fees, ${usd(a.netUsd)} net`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "paywall_list_bots",
    {
      title: "List bots",
      description: "List the account's bots with their status, linked group, paying-member count and prices.",
      inputSchema: FORMAT_ONLY,
      annotations: READ_ONLY,
    },
    safe("paywall_list_bots", async ({ response_format }) => {
      const bots = await listBots(env, ctx.tenant.id);
      const data = {
        count: bots.length,
        bots: bots.map((b) => ({
          id: b.id,
          username: b.botUsername,
          group: b.groupName,
          group_chat_id: b.groupChatId,
          status: b.status,
          active_members: b.activeMembers,
          prices_usd: b.prices,
        })),
      };
      return reply(response_format, data, () => {
        if (bots.length === 0) return "This account has no bots yet.";
        const rows = bots.map(
          (b) =>
            `| ${cell(b.botUsername)} | ${b.id} | ${cell(b.groupName)} | ${b.status} | ${b.activeMembers} | ${usd(b.prices.one_time)} / ${usd(b.prices.monthly)} / ${usd(b.prices.image_vault)} |`,
        );
        return [
          `# Bots (${bots.length})`,
          "",
          "| Bot | ID | Group | Status | Paying members | One-time / monthly / vault |",
          "| --- | --- | --- | --- | --- | --- |",
          ...rows,
        ].join("\n");
      });
    }),
  );

  server.registerTool(
    "paywall_get_bot",
    {
      title: "Get bot details",
      description:
        "Show one bot in full: status, group, prices, welcome texts, admins, which payment methods buyers are offered, revenue, and the webhook addresses to paste into payment dashboards.",
      inputSchema: BOT_AND_FORMAT,
      annotations: READ_ONLY,
    },
    safe("paywall_get_bot", async ({ bot, response_format }) => {
      const b = await resolveBot(ctx, bot);
      const d = await botDetail(env, b, ctx.baseUrl);
      const data = {
        id: d.id,
        username: d.botUsername,
        group: d.groupName,
        group_chat_id: d.groupChatId,
        status: d.status,
        active_members: d.activeMembers,
        revenue_usd: { gross: d.revenue.grossUsd, platform_fee: d.revenue.platformFeeUsd, net: d.revenue.netUsd },
        prices_usd: d.prices,
        paystack_currency: d.currency,
        paystack_rate_per_usd: d.fxRate,
        welcome_title: d.welcomeTitle,
        welcome_text: d.welcomeText,
        group_description: d.groupDescription,
        admin_user_ids: d.adminUserIds,
        payment_methods: d.paymentProviders,
        webhooks: d.webhooks,
      };
      return reply(response_format, data, () =>
        [
          `# ${d.botUsername ?? d.id}`,
          `- ID: ${d.id}`,
          `- Status: ${d.status}`,
          `- Group: ${d.groupName ?? "not linked yet"}${d.groupChatId ? ` (${d.groupChatId})` : ""}`,
          `- Paying members: ${d.activeMembers}`,
          `- Prices: one-time ${usd(d.prices.one_time)}, monthly ${usd(d.prices.monthly)}, image vault ${d.prices.image_vault > 0 ? usd(d.prices.image_vault) : "off"}`,
          `- Paystack charges in ${d.currency} at ${d.fxRate} per USD`,
          `- Payment methods offered: ${d.paymentProviders.length ? d.paymentProviders.join(", ") : "none — buyers cannot pay"}`,
          `- Revenue: ${usd(d.revenue.grossUsd)} gross, ${usd(d.revenue.netUsd)} net`,
          `- Welcome: "${d.welcomeTitle}" — ${d.welcomeText}`,
          ...(d.groupDescription ? [`- Group description: ${d.groupDescription}`] : []),
          `- Bot admins (Telegram IDs): ${d.adminUserIds.length ? d.adminUserIds.join(", ") : "none"}`,
          "",
          "Webhook addresses for payment dashboards:",
          `- Paystack: ${d.webhooks.paystack}`,
          `- BTCPay: ${d.webhooks.btcpay}`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "paywall_check_bot",
    {
      title: "Check bot connections",
      description:
        "Ask Telegram and each configured payment provider whether the bot's credentials work: bot token, webhook, admin rights in the group, and each provider's key. Use it when payments or unlocks are not working. Never reveals the keys.",
      inputSchema: BOT_AND_FORMAT,
      annotations: { ...READ_ONLY, idempotentHint: true, openWorldHint: true },
    },
    safe("paywall_check_bot", async ({ bot, response_format }) => {
      const b = await resolveBot(ctx, bot);
      const checks = await checkBot(b, ctx.baseUrl);
      const verdict = summarise(checks);
      const data = { bot_id: b.id, ready: verdict.ready, problems: verdict.problems, checks };
      return reply(response_format, data, () => {
        const lines = Object.entries(checks).map(([name, result]) => {
          const mark = result.ok === true ? "✓" : result.ok === false ? "✗" : "–";
          const warnings = Array.isArray(result.warnings) ? ` Warning: ${result.warnings.join(" ")}` : "";
          return `- ${mark} ${name.replace(/_/g, " ")}: ${result.detail}${warnings}`;
        });
        return [
          `# Connection check for ${botLabel(b)}`,
          verdict.ready ? "Ready to take payments." : "Not ready yet.",
          "",
          ...lines,
        ].join("\n");
      });
    }),
  );

  server.registerTool(
    "paywall_update_bot",
    {
      title: "Update bot settings",
      description: `Change a bot's prices, welcome message, group description or admins, or pause and resume it. Only the fields you pass change.

Pausing stops the bot asking newcomers to pay and leaves the group open; paying members keep their access.
Payment-provider keys cannot be changed here.

Examples:
  - "Raise the monthly price to $8" -> monthly_price=8
  - "Pause the bot" -> status="paused"`,
      inputSchema: UPDATE_BOT_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe("paywall_update_bot", async ({ bot, admin_user_ids, ...fields }) => {
      const b = await resolveBot(ctx, bot);
      const update: BotSettingsUpdate = {};
      if (fields.one_time_price !== undefined) update.one_time_price = fields.one_time_price;
      if (fields.monthly_price !== undefined) update.monthly_price = fields.monthly_price;
      if (fields.image_unlock_price !== undefined) update.image_unlock_price = fields.image_unlock_price;
      if (fields.welcome_title !== undefined) update.welcome_title = fields.welcome_title || null;
      if (fields.welcome_text !== undefined) update.welcome_text = fields.welcome_text || null;
      if (fields.group_description !== undefined) update.group_description = fields.group_description || null;
      if (fields.status !== undefined) update.status = fields.status;
      if (admin_user_ids !== undefined) update.admin_user_ids = admin_user_ids.length ? admin_user_ids.join(",") : null;
      if (Object.keys(update).length === 0) {
        throw new HttpError(400, "Nothing to change: pass at least one setting, such as monthly_price or status.");
      }
      const oneTime = update.one_time_price ?? b.prices.one_time;
      const monthly = update.monthly_price ?? b.prices.monthly;
      if (oneTime <= 0 && monthly <= 0) {
        throw new HttpError(400, "At least one of one_time_price and monthly_price must stay above 0.");
      }
      const changed = await updateBotSettings(env, b, update);
      return text(`Updated ${botLabel(b)}: ${changed.join(", ")}.`);
    }),
  );

  server.registerTool(
    "paywall_list_members",
    {
      title: "List paying members",
      description: `List a bot's members who currently have access (paid, or granted for free), newest first, with their Telegram ID, access type and expiry.

Use "search" to find someone by @username or first name, for example to get the telegram_id needed by paywall_grant_access or paywall_revoke_access.`,
      inputSchema: LIST_MEMBERS_INPUT,
      annotations: READ_ONLY,
    },
    safe("paywall_list_members", async ({ bot, search, limit, offset, response_format }) => {
      const b = await resolveBot(ctx, bot);
      const page = await listMembers(env, b.id, { limit, offset, search });
      const data = { bot_id: b.id, ...pageMeta(page.total, offset, page.members.length), members: page.members };
      return reply(response_format, data, () => {
        if (page.members.length === 0) {
          return search
            ? `No paying member of ${botLabel(b)} matches "${search}".`
            : offset > 0
              ? `No more members (there are ${page.total}).`
              : `${botLabel(b)} has no paying members yet.`;
        }
        const rows = page.members.map(
          (m) =>
            `| ${m.telegram_id} | ${cell(m.username ? `@${m.username}` : null)} | ${cell(m.first_name)} | ${cell(m.access_type)} | ${m.access_expires ? m.access_expires.slice(0, 10) : "never"} |`,
        );
        return [
          `# Paying members of ${botLabel(b)}${search ? ` matching "${search}"` : ""}`,
          "",
          "| Telegram ID | Username | Name | Access | Expires |",
          "| --- | --- | --- | --- | --- |",
          ...rows,
        ].join("\n") + pageFooter(page.total, offset, page.members.length);
      });
    }),
  );

  server.registerTool(
    "paywall_grant_access",
    {
      title: "Grant access",
      description:
        "Give someone access to the paid group for free (a gift, a refund, a manual payment). Lifts their restriction in the Telegram group and messages them. Their access does not expire.",
      inputSchema: GRANT_ACCESS_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe("paywall_grant_access", async ({ bot, telegram_id }) => {
      const b = await resolveBot(ctx, bot);
      await grantAccess(env, b, telegram_id, ctx.waitUntil);
      return text(`Granted ${telegram_id} lasting access to ${botLabel(b)}'s group. They are being unlocked and notified.`);
    }),
  );

  server.registerTool(
    "paywall_revoke_access",
    {
      title: "Revoke access",
      description:
        "Remove someone's access: they stay in the Telegram group but can no longer post. Does not refund any payment.",
      inputSchema: REVOKE_ACCESS_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe("paywall_revoke_access", async ({ bot, telegram_id }) => {
      const b = await resolveBot(ctx, bot);
      if (!(await revokeAccess(env, b, telegram_id, ctx.waitUntil))) {
        throw new HttpError(
          404,
          `${botLabel(b)} has no record of Telegram user ${telegram_id}. Use paywall_list_members to find the right ID.`,
        );
      }
      return text(`Revoked ${telegram_id}'s access to ${botLabel(b)}'s group.`);
    }),
  );

  server.registerTool(
    "paywall_create_payment_link",
    {
      title: "Create payment link",
      description: `Create a payment link for one Telegram user, to send them directly. When they pay, they are unlocked automatically, exactly as if they had paid through the bot.

access_type: 'one_time' (lifetime access), 'monthly' (30 days) or 'image_unlock' (the image vault).
provider is optional; by default the first payment method the bot offers is used.`,
      inputSchema: CREATE_PAYMENT_LINK_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe("paywall_create_payment_link", async ({ bot, telegram_id, access_type, provider }) => {
      const b = await resolveBot(ctx, bot);
      const offered = availableProviders(b);
      const chosen: Provider | undefined = provider ?? offered[0];
      if (!chosen) {
        throw new HttpError(400, `${botLabel(b)} has no working payment method. Run paywall_check_bot to see why.`);
      }
      const payment = await createPayment(env, b, {
        telegramId: telegram_id,
        accessType: access_type as AccessType,
        provider: chosen,
        baseUrl: ctx.baseUrl,
      });
      return text(
        [
          `Payment link for Telegram user ${telegram_id} (${access_type.replace("_", "-")}, ${usd(payment.amount)} via ${chosen}):`,
          payment.paymentUrl,
          "",
          `Order: ${payment.orderId}. Your share after the platform fee: ${usd(payment.net)}.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "paywall_get_payment",
    {
      title: "Look up an order",
      description:
        "Look up one order by its order ID (the reference shown to the buyer, e.g. 123456789-a1b2c3d4e5f6): who it was for, what was bought, and whether it has been paid.",
      inputSchema: GET_PAYMENT_INPUT,
      annotations: READ_ONLY,
    },
    safe("paywall_get_payment", async ({ order_id, response_format }) => {
      const p = await findTenantPayment(env, ctx.tenant.id, order_id);
      if (!p) throw new HttpError(404, `No order "${order_id}" on this account. Check the reference and try again.`);
      const v = paymentView(p);
      return reply(response_format, { ...v }, () =>
        [
          `# Order ${v.order_id}`,
          `- Status: ${v.status}${v.confirmed_at ? ` (paid ${v.confirmed_at.slice(0, 16).replace("T", " ")} UTC)` : ""}`,
          `- Telegram user: ${v.telegram_id}`,
          `- Bought: ${v.access_type.replace("_", "-")} via ${v.provider}`,
          `- Amount: ${usd(v.gross)} (platform fee ${usd(v.platform_fee)}, your share ${usd(v.net)})`,
          `- Created: ${v.created_at?.slice(0, 16).replace("T", " ")} UTC`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "paywall_list_payments",
    {
      title: "List payments",
      description:
        "List completed payments, newest first, across all bots or for one bot. Use paywall_get_revenue for totals.",
      inputSchema: LIST_PAYMENTS_INPUT,
      annotations: READ_ONLY,
    },
    safe("paywall_list_payments", async ({ bot, limit, offset, response_format }) => {
      const botId = bot ? (await resolveBot(ctx, bot)).id : null;
      const page = await listConfirmedPayments(env, ctx.tenant.id, { limit, offset, botId });
      const data = { ...pageMeta(page.total, offset, page.payments.length), payments: page.payments };
      return reply(response_format, data, () => {
        if (page.payments.length === 0) return offset > 0 ? "No more payments." : "No completed payments yet.";
        const rows = page.payments.map(
          (p) =>
            `| ${p.confirmed_at?.slice(0, 16).replace("T", " ") ?? "—"} | ${p.telegram_id} | ${p.access_type.replace("_", "-")} | ${p.provider} | ${usd(p.gross)} | ${usd(p.net)} | ${p.order_id} |`,
        );
        return [
          "# Completed payments",
          "",
          "| Paid (UTC) | Telegram ID | Bought | Via | Amount | Your share | Order |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...rows,
        ].join("\n") + pageFooter(page.total, offset, page.payments.length);
      });
    }),
  );

  server.registerTool(
    "paywall_get_revenue",
    {
      title: "Get revenue",
      description:
        "Revenue totals across all the account's bots, all time and for the last 30 days, plus the number of paying members.",
      inputSchema: FORMAT_ONLY,
      annotations: READ_ONLY,
    },
    safe("paywall_get_revenue", async ({ response_format }) => {
      const o = await revenueOverview(env, ctx.tenant);
      const data = {
        all_time: {
          gross_usd: o.allTime.grossUsd,
          platform_fee_usd: o.allTime.platformFeeUsd,
          net_usd: o.allTime.netUsd,
          payments: o.allTime.transactions,
        },
        last_30_days: { gross_usd: o.last30Days.grossUsd, net_usd: o.last30Days.netUsd, payments: o.last30Days.transactions },
        active_members: o.activeMembers,
        bots: o.totalBots,
        platform_cut: o.platformCut,
      };
      return reply(response_format, data, () =>
        [
          "# Revenue",
          "",
          "| Period | Payments | Gross | Your share |",
          "| --- | --- | --- | --- |",
          `| Last 30 days | ${o.last30Days.transactions} | ${usd(o.last30Days.grossUsd)} | ${usd(o.last30Days.netUsd)} |`,
          `| All time | ${o.allTime.transactions} | ${usd(o.allTime.grossUsd)} | ${usd(o.allTime.netUsd)} |`,
          "",
          `${o.activeMembers} paying member${o.activeMembers === 1 ? "" : "s"} across ${o.totalBots} bot${o.totalBots === 1 ? "" : "s"}. Platform cut: ${percent(o.platformCut)}.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "paywall_send_broadcast",
    {
      title: "Message paying members",
      description:
        "Send a plain-text message from the bot to every member who currently has access. Messages go out in batches of about 20 a minute; the bot's first listed admin gets a report when it finishes. Each call sends a new broadcast, so do not repeat it.",
      inputSchema: SEND_BROADCAST_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe("paywall_send_broadcast", async ({ bot, message }) => {
      const b = await resolveBot(ctx, bot);
      const recipients = await queueBroadcast(env, b.id, message, b.adminIds[0] ?? null);
      return text(
        recipients === 0
          ? `${botLabel(b)} has no paying members, so nobody will receive this. The broadcast was queued anyway and will finish immediately.`
          : `Queued for ${recipients} member${recipients === 1 ? "" : "s"} of ${botLabel(b)}. Delivery starts within a minute.`,
      );
    }),
  );
}

// ── Platform owner only ──────────────────────────────────────────────────────

function registerAdminTools(server: McpServer, ctx: PaywallContext): void {
  const { env } = ctx;

  server.registerTool(
    "paywall_admin_get_platform_overview",
    {
      title: "Platform overview (owner)",
      description:
        "Platform-wide totals for the owner: creators, active bots, paying members, money processed and the platform fees earned, all time and for the last 30 days.",
      inputSchema: FORMAT_ONLY,
      annotations: READ_ONLY,
    },
    safe("paywall_admin_get_platform_overview", async ({ response_format }) => {
      const o = await platformOverview(env);
      const data = {
        creators: o.creators.total,
        creators_on_free_trial: o.creators.onFreeTrial,
        active_bots: o.activeBots,
        active_members: o.activeMembers,
        all_time: {
          payments: o.allTime.transactions,
          processed_usd: o.allTime.processedUsd,
          platform_fees_usd: o.allTime.platformFeesUsd,
          own_bot_sales_usd: o.allTime.ownBotSalesUsd,
        },
        last_30_days: { processed_usd: o.last30Days.processedUsd, platform_fees_usd: o.last30Days.platformFeesUsd },
      };
      return reply(response_format, data, () =>
        [
          "# Platform overview",
          `- Creators: ${o.creators.total} (${o.creators.onFreeTrial} on the free trial)`,
          `- Active bots: ${o.activeBots}, paying members: ${o.activeMembers}`,
          "",
          "| Period | Processed | Platform fees |",
          "| --- | --- | --- |",
          `| Last 30 days | ${usd(o.last30Days.processedUsd)} | ${usd(o.last30Days.platformFeesUsd)} |`,
          `| All time | ${usd(o.allTime.processedUsd)} | ${usd(o.allTime.platformFeesUsd)} |`,
          "",
          `Your own bot's sales, all time: ${usd(o.allTime.ownBotSalesUsd)}.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "paywall_admin_list_creators",
    {
      title: "List creators (owner)",
      description:
        "List the creators on the platform, newest first, with plan, platform cut, bots, money processed and fees earned. Gives the creator_id used by the other admin tools.",
      inputSchema: ADMIN_LIST_CREATORS_INPUT,
      annotations: READ_ONLY,
    },
    safe("paywall_admin_list_creators", async ({ limit, offset, response_format }) => {
      const page = await listCreators(env, { limit, offset });
      const data = { ...pageMeta(page.total, offset, page.creators.length), creators: page.creators };
      return reply(response_format, data, () => {
        if (page.creators.length === 0) return offset > 0 ? "No more creators." : "No creators have signed up yet.";
        const rows = page.creators.map(
          (t) =>
            `| ${cell(t.name)} | ${cell(t.email)} | ${t.id} | ${t.tier} | ${percent(t.platform_cut)} | ${t.active ? "active" : "suspended"} | ${t.bots} | ${usd(t.processed_usd)} | ${usd(t.platform_fees_usd)} |`,
        );
        return [
          "# Creators",
          "",
          "| Name | Email | Creator ID | Plan | Cut | State | Bots | Processed | Fees |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...rows,
        ].join("\n") + pageFooter(page.total, offset, page.creators.length);
      });
    }),
  );

  server.registerTool(
    "paywall_admin_set_creator_plan",
    {
      title: "Change a creator's plan (owner)",
      description: `Move a creator to another plan once they have paid for it. Plans: 'free' (15% cut, 1 bot, 10 members, a fresh 14-day trial), 'starter' (8%, unlimited) or 'whitelabel' (0%). A paid plan also restarts bots stopped by an expired trial.

platform_cut_percent overrides the plan's usual cut.`,
      inputSchema: ADMIN_SET_CREATOR_PLAN_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe("paywall_admin_set_creator_plan", async ({ creator_id, plan, platform_cut_percent }) => {
      const cut = platform_cut_percent === undefined ? undefined : platform_cut_percent / 100;
      const result = await setCreatorPlan(env, creator_id, plan, cut);
      return text(
        `Creator ${creator_id} is now on '${plan}' with a ${money(result.platformCut * 100)}% platform cut.${result.trialEndsAt ? ` Trial ends ${result.trialEndsAt.slice(0, 10)}.` : ""}`,
      );
    }),
  );

  server.registerTool(
    "paywall_admin_set_creator_active",
    {
      title: "Suspend or restore a creator (owner)",
      description:
        "Suspend a creator (their API key and MCP sign-in stop working and their bots stop selling) or restore them.",
      inputSchema: ADMIN_SET_CREATOR_ACTIVE_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe("paywall_admin_set_creator_active", async ({ creator_id, active }) => {
      await setCreatorActive(env, creator_id, active);
      return text(active ? `Creator ${creator_id} restored.` : `Creator ${creator_id} suspended.`);
    }),
  );
}
