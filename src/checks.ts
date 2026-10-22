/**
 * Live credential checks: asks Telegram and each payment provider whether the
 * configured keys are accepted. Reports status only — never the keys.
 */

import type { BotConfig } from "./db";
import { maskSecret } from "./lib/crypto";
import { webhookUrl } from "./payments";
import * as btcpay from "./providers/btcpay";
import * as nowpayments from "./providers/nowpayments";
import * as paystack from "./providers/paystack";
import { tg, type TgChatMember } from "./telegram";

export interface CheckResult {
  /** true = working, false = broken, null = not configured (nothing to check). */
  ok: boolean | null;
  detail: string;
  [extra: string]: unknown;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function telegramWebhookUrl(baseUrl: string, botId: string): string {
  return `${baseUrl}/telegram/${botId}`;
}

async function checkTelegram(bot: BotConfig, baseUrl: string): Promise<Record<string, CheckResult>> {
  const out: Record<string, CheckResult> = {};
  if (!bot.token) {
    out.telegram_token = { ok: null, detail: "No bot token is configured." };
    return out;
  }

  let me: { id: number; username?: string };
  try {
    me = await tg<{ id: number; username?: string }>(bot.token, "getMe");
    out.telegram_token = { ok: true, detail: `Token accepted — bot is @${me.username ?? me.id}.` };
  } catch (error) {
    out.telegram_token = { ok: false, detail: `Telegram rejected the bot token: ${message(error)}` };
    return out;
  }

  const expected = telegramWebhookUrl(baseUrl, bot.id);
  try {
    const info = await tg<{
      url: string;
      pending_update_count: number;
      last_error_message?: string;
      allowed_updates?: string[];
    }>(bot.token, "getWebhookInfo");
    // Telegram omits allowed_updates when every type is allowed.
    const missingJoinRequests =
      Array.isArray(info.allowed_updates) && !info.allowed_updates.includes("chat_join_request");
    if (info.url !== expected) {
      out.telegram_webhook = {
        ok: false,
        detail: info.url
          ? `Telegram is sending updates to a different URL (${info.url}). Run setup to point it here.`
          : "No webhook registered with Telegram yet. Run setup.",
        expected,
      };
    } else if (info.last_error_message) {
      out.telegram_webhook = {
        ok: false,
        detail: `Webhook registered, but Telegram's last delivery failed: ${info.last_error_message}`,
        pending_updates: info.pending_update_count,
      };
    } else if (missingJoinRequests && bot.joinMode === "approve") {
      out.telegram_webhook = {
        ok: false,
        detail: "Telegram isn't sending join requests to the bot yet. Run setup again (or save the join setting again) to fix it.",
        url: expected,
      };
    } else {
      out.telegram_webhook = { ok: true, detail: "Webhook registered and delivering.", url: expected };
    }
  } catch (error) {
    out.telegram_webhook = { ok: false, detail: message(error) };
  }

  if (!bot.groupChatId) {
    out.telegram_group = {
      ok: null,
      detail: "No group linked yet. Add the bot to your group as an admin and it will link automatically.",
    };
    return out;
  }
  try {
    const chat = await tg<{ title?: string }>(bot.token, "getChat", { chat_id: bot.groupChatId });
    const self = await tg<TgChatMember>(bot.token, "getChatMember", {
      chat_id: bot.groupChatId,
      user_id: me.id,
    });
    if (self.status !== "administrator") {
      out.telegram_group = {
        ok: false,
        detail: `The bot is in "${chat.title ?? bot.groupChatId}" but is not an admin, so it cannot restrict members.`,
      };
    } else if (self.can_restrict_members !== true) {
      out.telegram_group = {
        ok: false,
        detail: `The bot is an admin of "${chat.title ?? bot.groupChatId}" but lacks the "Ban users" permission.`,
      };
    } else if (bot.joinMode === "approve" && self.can_invite_users !== true) {
      out.telegram_group = {
        ok: false,
        detail: `The bot is an admin of "${chat.title ?? bot.groupChatId}" but lacks the "Invite users via link" permission, which it needs to let paying members in.`,
      };
    } else {
      out.telegram_group = {
        ok: true,
        detail:
          bot.joinMode === "approve"
            ? `Admin of "${chat.title ?? bot.groupChatId}" and able to approve join requests.${bot.joinLink ? "" : " Send /joinlink to the bot to get the link to share."}`
            : `Admin of "${chat.title ?? bot.groupChatId}" with permission to restrict members.`,
      };
    }
  } catch (error) {
    out.telegram_group = {
      ok: false,
      detail: `Could not reach group ${bot.groupChatId}: ${message(error)}`,
    };
  }
  return out;
}

async function checkPaystack(bot: BotConfig, baseUrl: string): Promise<CheckResult> {
  if (!bot.paystack) return { ok: null, detail: "Not configured." };
  const mode = paystack.keyMode(bot.paystack.secretKey);
  const extra: Record<string, unknown> = {
    key: maskSecret(bot.paystack.secretKey),
    mode,
    charges_in: bot.currency,
    usd_rate: bot.fxRate,
    webhook_url_to_set_in_paystack: webhookUrl(baseUrl, "paystack", bot.id),
  };
  try {
    const { currencies } = await paystack.checkSecretKey(bot.paystack.secretKey);
    const warnings: string[] = [];
    if (mode === "test") warnings.push("This is a TEST key: no real money will be collected.");
    const publicMode = paystack.keyMode(bot.paystack.publicKey);
    if (bot.paystack.publicKey && publicMode !== "unknown" && publicMode !== mode) {
      warnings.push(`Secret key is ${mode} but public key is ${publicMode}.`);
    }
    if (currencies.length && !currencies.includes(bot.currency)) {
      warnings.push(
        `This account reports balances in ${currencies.join(", ")}, not ${bot.currency}. Charges in ${bot.currency} may be refused.`,
      );
    }
    return {
      ok: true,
      detail: "Secret key accepted by Paystack.",
      ...extra,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    return { ok: false, detail: `Paystack rejected the secret key: ${message(error)}`, ...extra };
  }
}

async function checkNowpayments(bot: BotConfig): Promise<CheckResult> {
  if (!bot.nowpayments) return { ok: null, detail: "Not configured." };
  try {
    await nowpayments.checkApiKey(bot.nowpayments.apiKey);
  } catch (error) {
    return { ok: false, detail: `NOWPayments rejected the API key: ${message(error)}` };
  }
  if (!bot.nowpayments.ipnSecret) {
    return {
      ok: false,
      detail:
        "API key accepted, but the IPN secret is missing. Without it payments cannot be verified, so this provider is hidden from buyers.",
    };
  }
  return {
    ok: true,
    detail:
      "API key accepted and IPN secret is set. (The IPN secret itself can only be proven by a real payment notification.)",
  };
}

async function checkBtcpay(bot: BotConfig, baseUrl: string): Promise<CheckResult> {
  if (!bot.btcpay) return { ok: null, detail: "Not configured." };
  const extra = { webhook_url_to_set_in_btcpay: webhookUrl(baseUrl, "btcpay", bot.id) };
  let name: string | null;
  try {
    ({ name } = await btcpay.checkStore(bot.btcpay));
  } catch (error) {
    return { ok: false, detail: `BTCPay rejected the URL / store ID / API key: ${message(error)}`, ...extra };
  }
  if (!bot.btcpay.webhookSecret) {
    return {
      ok: false,
      detail:
        "Store reachable, but the webhook secret is missing. Without it payments cannot be verified, so this provider is hidden from buyers.",
      ...extra,
    };
  }
  return {
    ok: true,
    detail: `Store "${name ?? bot.btcpay.storeId}" reachable and webhook secret is set. (The webhook secret itself can only be proven by a real notification.)`,
    ...extra,
  };
}

export async function checkBot(bot: BotConfig, baseUrl: string): Promise<Record<string, CheckResult>> {
  const [telegram, paystackResult, nowResult, btcResult] = await Promise.all([
    checkTelegram(bot, baseUrl),
    checkPaystack(bot, baseUrl),
    checkNowpayments(bot),
    checkBtcpay(bot, baseUrl),
  ]);
  return { ...telegram, paystack: paystackResult, nowpayments: nowResult, btcpay: btcResult };
}

/** One-line verdict across all checks. */
export function summarise(checks: Record<string, CheckResult>): { ready: boolean; problems: string[] } {
  const problems = Object.entries(checks)
    .filter(([, result]) => result.ok === false)
    .map(([name, result]) => `${name}: ${result.detail}`);
  const anyProvider = (["paystack", "nowpayments", "btcpay"] as const).some((p) => checks[p]?.ok === true);
  if (!anyProvider) problems.push("No payment provider is working, so buyers cannot pay.");
  if (checks.telegram_token?.ok === null) problems.push("No Telegram bot token is configured.");
  return { ready: problems.length === 0, problems: [...new Set(problems)] };
}
