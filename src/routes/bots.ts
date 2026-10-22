/** /api/v1/bots — create and manage a creator's bots and their members. */

import { Hono } from "hono";
import { checkBot, summarise, telegramWebhookUrl } from "../checks";
import { loadTenantBot, now, parseIdList } from "../db";
import { OWNER_ID, type AppEnv } from "../env";
import { encryptSecret, encryptionConfigured, newId, randomHex } from "../lib/crypto";
import {
  HttpError,
  baseUrl,
  optNumber,
  optString,
  readJson,
  reqString,
  type AppContext,
} from "../lib/http";
import { availableProviders } from "../payments";
import { isAcceptableServerUrl } from "../providers/btcpay";
import {
  applyJoinMode,
  botDetail,
  botPrices,
  coinAndJoinSettings,
  grantAccess,
  listBots,
  listMembers,
  paymentWebhooks,
  revokeAccess,
  updateBotSettings,
  type BotSettingsUpdate,
} from "../services";
import { ALLOWED_UPDATES, TelegramError, looksLikeBotToken, tg } from "../telegram";
import { requireTenant } from "./auth";

export const bots = new Hono<AppContext>();
bots.use("*", requireTenant);

const CURRENCY = /^[A-Z]{3}$/;
const PRICE = { min: 0, max: 100000 };

async function encrypt(env: AppEnv, value: string): Promise<string> {
  if (!encryptionConfigured(env.ENCRYPTION_KEY)) {
    throw new HttpError(503, "The platform is not fully configured yet (ENCRYPTION_KEY is missing).");
  }
  return encryptSecret(env.ENCRYPTION_KEY, value);
}



/** Parse and validate the payment-provider fields shared by create and update. */
function providerFields(body: Record<string, unknown>): Record<string, string | null | undefined> {
  const f = {
    paystack_secret_key: optString(body, "paystack_secret_key", 256),
    paystack_public_key: optString(body, "paystack_public_key", 256),
    nowpayments_api_key: optString(body, "nowpayments_api_key", 256),
    nowpayments_ipn_secret: optString(body, "nowpayments_ipn_secret", 256),
    btcpay_url: optString(body, "btcpay_url", 256),
    btcpay_store_id: optString(body, "btcpay_store_id", 256),
    btcpay_api_key: optString(body, "btcpay_api_key", 256),
    btcpay_webhook_secret: optString(body, "btcpay_webhook_secret", 256),
  };
  if (f.paystack_secret_key && !f.paystack_secret_key.startsWith("sk_")) {
    throw new HttpError(422, "'paystack_secret_key' must start with sk_ (find it in Paystack → Settings → API Keys).");
  }
  if (f.paystack_public_key && !f.paystack_public_key.startsWith("pk_")) {
    throw new HttpError(422, "'paystack_public_key' must start with pk_.");
  }
  if (f.btcpay_url && !isAcceptableServerUrl(f.btcpay_url)) {
    throw new HttpError(422, "'btcpay_url' must be a public https:// address.");
  }
  return f;
}

/** Column name → whether the value is stored encrypted. */
const PROVIDER_COLUMNS: Record<string, { column: string; encrypted: boolean }> = {
  paystack_secret_key: { column: "paystack_secret_key_enc", encrypted: true },
  paystack_public_key: { column: "paystack_public_key", encrypted: false },
  nowpayments_api_key: { column: "nowpayments_api_key_enc", encrypted: true },
  nowpayments_ipn_secret: { column: "nowpayments_ipn_secret_enc", encrypted: true },
  btcpay_url: { column: "btcpay_url", encrypted: false },
  btcpay_store_id: { column: "btcpay_store_id", encrypted: false },
  btcpay_api_key: { column: "btcpay_api_key_enc", encrypted: true },
  btcpay_webhook_secret: { column: "btcpay_webhook_secret_enc", encrypted: true },
};

function adminIdsField(body: Record<string, unknown>): string | null | undefined {
  const value = body.admin_user_ids;
  if (value === undefined) return undefined;
  if (value === null) return null;
  const list = Array.isArray(value) ? value : String(value).split(",");
  const ids = parseIdList(list.join(","));
  if (ids.length !== list.filter((v) => String(v).trim() !== "").length) {
    throw new HttpError(422, "'admin_user_ids' must be a list of Telegram user IDs (numbers).");
  }
  return ids.length ? ids.join(",") : null;
}

// ── Create ───────────────────────────────────────────────────────────────────

bots.post("/", async (c) => {
  const tenant = c.get("tenant");
  if (tenant.id === OWNER_ID) {
    throw new HttpError(400, "The owner bot is configured through Worker secrets, not this endpoint.");
  }
  const body = await readJson(c);

  const token = reqString(body, "bot_token", 256);
  if (!looksLikeBotToken(token)) {
    throw new HttpError(400, "Invalid bot token format. Get it from @BotFather.");
  }
  if (token === c.env.TELEGRAM_BOT_TOKEN) {
    throw new HttpError(409, "This Telegram bot is already registered on the platform.");
  }

  const oneTime = optNumber(body, "one_time_price", PRICE) ?? 10;
  const monthly = optNumber(body, "monthly_price", PRICE) ?? 5;
  const daily = optNumber(body, "daily_price", PRICE) ?? 0;
  const weekly = optNumber(body, "weekly_price", PRICE) ?? 0;
  const imageUnlock = optNumber(body, "image_unlock_price", PRICE) ?? 20;
  if (oneTime <= 0 && monthly <= 0 && daily <= 0 && weekly <= 0) {
    throw new HttpError(422, "Set a price above 0 for at least one plan: daily_price, weekly_price, monthly_price or one_time_price.");
  }
  const currency = (optString(body, "currency", 8) ?? "USD").toUpperCase();
  if (!CURRENCY.test(currency)) throw new HttpError(422, "'currency' must be a 3-letter code such as USD or KES.");
  const priceCurrency = (optString(body, "price_currency", 8) ?? "USD").toUpperCase();
  if (priceCurrency !== "USD" && priceCurrency !== currency) {
    throw new HttpError(422, `'price_currency' must be USD or the currency Paystack charges in (${currency}).`);
  }
  const fxRate = optNumber(body, "fx_rate", { min: 0.000001 }) ?? 1;
  if (currency !== "USD" && body.fx_rate === undefined) {
    throw new HttpError(
      422,
      `Prices are in USD. To charge in ${currency} through Paystack, also send 'fx_rate' (how many ${currency} equal 1 USD).`,
    );
  }
  const providers = providerFields(body);
  const adminIds = adminIdsField(body);

  // Ask Telegram who this token belongs to: proves it is real and working.
  let me: { id: number; username?: string };
  try {
    me = await tg<{ id: number; username?: string }>(token, "getMe");
  } catch (error) {
    if (error instanceof TelegramError) {
      throw new HttpError(400, "Telegram rejected this bot token. Copy it again from @BotFather.");
    }
    throw error;
  }
  const taken = await c.env.DB.prepare("SELECT id FROM bots WHERE telegram_bot_id = ?1").bind(me.id).first();
  if (taken) throw new HttpError(409, "This Telegram bot is already registered on the platform.");

  const id = newId();
  const webhookSecret = randomHex(24);
  const columns: Record<string, unknown> = {
    id,
    tenant_id: tenant.id,
    bot_token_enc: await encrypt(c.env, token),
    telegram_bot_id: me.id,
    bot_username: me.username ?? null,
    webhook_secret: webhookSecret,
    status: "active",
    one_time_price: oneTime,
    monthly_price: monthly,
    daily_price: daily,
    weekly_price: weekly,
    price_currency: priceCurrency,
    image_unlock_price: imageUnlock,
    currency,
    fx_rate: fxRate,
    welcome_title: optString(body, "welcome_title", 256) ?? null,
    welcome_text: optString(body, "welcome_text", 2000) ?? null,
    group_description: optString(body, "group_description", 2000) ?? null,
    admin_user_ids: adminIds ?? null,
    created_at: now(),
  };
  for (const [field, value] of Object.entries(providers)) {
    const spec = PROVIDER_COLUMNS[field];
    if (!spec || !value) continue;
    columns[spec.column] = spec.encrypted ? await encrypt(c.env, value) : value;
  }
  const names = Object.keys(columns);
  await c.env.DB.prepare(
    `INSERT INTO bots (${names.join(", ")}) VALUES (${names.map((_, i) => `?${i + 1}`).join(", ")})`,
  )
    .bind(...Object.values(columns))
    .run();

  // Point Telegram at this Worker. If that fails the bot would be dead on
  // arrival, so undo the insert and report the problem.
  const base = baseUrl(c);
  try {
    await tg(token, "setWebhook", {
      url: telegramWebhookUrl(base, id),
      secret_token: webhookSecret,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: true,
    });
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM bots WHERE id = ?1").bind(id).run();
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `Could not register the webhook with Telegram: ${reason}`);
  }

  const bot = await loadTenantBot(c.env, id, tenant.id);
  // The first admin becomes the Telegram account that can recover the API key.
  if (tenant.recovery_telegram_id === null && bot.adminIds[0]) {
    await c.env.DB.prepare("UPDATE tenants SET recovery_telegram_id = ?1 WHERE id = ?2 AND recovery_telegram_id IS NULL")
      .bind(bot.adminIds[0], tenant.id)
      .run();
  }
  const offered = availableProviders(bot);
  const notes: string[] = [];
  if (bot.nowpayments && !bot.nowpayments.ipnSecret) {
    notes.push("NOWPayments is hidden from buyers until you also send 'nowpayments_ipn_secret'.");
  }
  if (bot.btcpay && !bot.btcpay.webhookSecret) {
    notes.push("BTCPay is hidden from buyers until you also send 'btcpay_webhook_secret'.");
  }
  if (offered.length === 0) notes.push("No payment provider is ready yet, so buyers cannot pay.");

  return c.json({
    message: "Bot created and running!",
    bot_id: id,
    bot_username: me.username ? `@${me.username}` : null,
    status: bot.status,
    prices: botPrices(bot),
    payment_providers: offered,
    webhooks: paymentWebhooks(base, id),
    next_steps: [
      "Add the bot to your Telegram group as an admin with the 'Ban users' permission — the group links itself.",
      "Paste the Paystack / BTCPay webhook URL above into that provider's dashboard.",
      `Call GET /api/v1/bots/${id}/check to confirm everything is connected.`,
    ],
    ...(notes.length ? { notes } : {}),
  });
});

// ── Read ─────────────────────────────────────────────────────────────────────

bots.get("/", async (c) => {
  const list = await listBots(c.env, c.get("tenant").id);
  return c.json({
    count: list.length,
    bots: list.map((b) => ({
      id: b.id,
      bot_username: b.botUsername,
      group_name: b.groupName,
      group_chat_id: b.groupChatId,
      status: b.status,
      member_count: b.activeMembers,
      prices: b.prices,
      created_at: b.createdAt,
    })),
  });
});

bots.get("/:botId", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  const d = await botDetail(c.env, bot, baseUrl(c));
  return c.json({
    id: d.id,
    bot_username: d.botUsername,
    group_name: d.groupName,
    group_chat_id: d.groupChatId,
    status: d.status,
    active_members: d.activeMembers,
    revenue: {
      gross: `$${d.revenue.grossUsd.toFixed(2)}`,
      platform_fee: `$${d.revenue.platformFeeUsd.toFixed(2)}`,
      net: `$${d.revenue.netUsd.toFixed(2)}`,
    },
    prices: d.prices,
    currency: d.currency,
    fx_rate: d.fxRate,
    welcome_title: d.welcomeTitle,
    welcome_text: d.welcomeText,
    group_description: d.groupDescription,
    admin_user_ids: d.adminUserIds,
    payment_providers: d.paymentProviders,
    join_mode: d.joinMode,
    join_link: d.joinLink,
    free_pass_hours: d.freePassHours,
    coins: {
      enabled: d.coins.enabled,
      free_coins: d.coins.freeCoins,
      unlock_cost: d.coins.unlockCost,
      packs: d.coins.packs,
    },
    content_items: d.contentItems,
    credentials: d.credentials,
    webhooks: d.webhooks,
    created_at: d.createdAt,
  });
});

/** Live check of this bot's Telegram and payment credentials. */
bots.get("/:botId/check", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  const checks = await checkBot(bot, baseUrl(c));
  return c.json({ bot_id: bot.id, ...summarise(checks), checks });
});

// ── Update ───────────────────────────────────────────────────────────────────

bots.patch("/:botId", async (c) => {
  const tenant = c.get("tenant");
  const bot = await loadTenantBot(c.env, c.req.param("botId"), tenant.id);
  const body = await readJson(c);
  const update: BotSettingsUpdate = {};

  for (const field of ["one_time_price", "monthly_price", "daily_price", "weekly_price", "image_unlock_price"] as const) {
    const value = optNumber(body, field, PRICE);
    if (value !== undefined) update[field] = value;
  }
  for (const [field, max] of [
    ["welcome_title", 256],
    ["welcome_text", 2000],
    ["group_description", 2000],
  ] as const) {
    const value = optString(body, field, max);
    if (value !== undefined) update[field] = value;
  }

  const currency = optString(body, "currency", 8);
  if (currency) {
    if (!CURRENCY.test(currency.toUpperCase())) throw new HttpError(422, "'currency' must be a 3-letter code.");
    update.currency = currency.toUpperCase();
  }
  const fxRate = optNumber(body, "fx_rate", { min: 0.000001 });
  if (fxRate !== undefined) update.fx_rate = fxRate;

  const priceCurrency = optString(body, "price_currency", 8);
  if (priceCurrency) {
    const wanted = priceCurrency.toUpperCase();
    const charging = update.currency ?? bot.currency;
    if (wanted !== "USD" && wanted !== charging) {
      throw new HttpError(422, `'price_currency' must be USD or the currency Paystack charges in (${charging}).`);
    }
    update.price_currency = wanted;
  }

  const groupChatId = optNumber(body, "group_chat_id", { integer: true });
  if (groupChatId !== undefined) update.group_chat_id = groupChatId;

  const adminIds = adminIdsField(body);
  if (adminIds !== undefined) update.admin_user_ids = adminIds;

  const status = optString(body, "status", 16);
  if (status) {
    if (status !== "active" && status !== "paused") {
      throw new HttpError(422, "'status' must be 'active' or 'paused'.");
    }
    update.status = status;
  }

  Object.assign(
    update,
    coinAndJoinSettings({
      join_mode: body.join_mode,
      coins_enabled: body.coins_enabled,
      free_coins: body.free_coins,
      unlock_cost: body.unlock_cost,
      coin_packs: body.coin_packs,
      free_pass_hours: body.free_pass_hours,
    }),
  );

  const providers = providerFields(body);
  const sentProviderField = Object.values(providers).some((v) => v !== undefined);
  if (sentProviderField && bot.isOwner) {
    throw new HttpError(400, "The owner bot's payment keys are Worker secrets. Change them in the Cloudflare dashboard.");
  }
  const credentials: Record<string, string | null> = {};
  for (const [field, value] of Object.entries(providers)) {
    const spec = PROVIDER_COLUMNS[field];
    if (!spec || value === undefined) continue;
    credentials[spec.column] = value === null ? null : spec.encrypted ? await encrypt(c.env, value) : value;
  }

  await updateBotSettings(c.env, bot, update, credentials);

  // Switching join mode needs Telegram-side setup: do it now and report.
  if (update.join_mode !== undefined && update.join_mode !== bot.joinMode) {
    const fresh = await loadTenantBot(c.env, bot.id, tenant.id);
    const applied = await applyJoinMode(c.env, fresh, baseUrl(c));
    return c.json({
      message: "Bot updated.",
      bot_id: bot.id,
      join_mode: fresh.joinMode,
      join_link: applied.joinLink,
      ...(applied.notes.length ? { notes: applied.notes } : {}),
    });
  }
  return c.json({ message: "Bot updated.", bot_id: bot.id });
});

// ── Delete ───────────────────────────────────────────────────────────────────

bots.delete("/:botId", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  if (bot.isOwner) {
    throw new HttpError(400, "The owner bot cannot be deleted. Remove TELEGRAM_BOT_TOKEN to switch it off.");
  }
  if (bot.token) {
    await tg(bot.token, "deleteWebhook").catch(() => undefined);
  }
  // Payments are kept as the ledger; the bot's credentials are wiped.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE bots SET status = 'deleted', bot_token_enc = NULL, telegram_bot_id = NULL,
         paystack_secret_key_enc = NULL, paystack_public_key = NULL,
         nowpayments_api_key_enc = NULL, nowpayments_ipn_secret_enc = NULL,
         btcpay_url = NULL, btcpay_store_id = NULL, btcpay_api_key_enc = NULL, btcpay_webhook_secret_enc = NULL
       WHERE id = ?1`,
    ).bind(bot.id),
    c.env.DB.prepare("DELETE FROM vault_images WHERE bot_id = ?1").bind(bot.id),
    c.env.DB.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE bot_id = ?1 AND status = 'pending'").bind(bot.id),
  ]);
  return c.json({ message: "Bot deleted." });
});

// ── Members ──────────────────────────────────────────────────────────────────

function telegramIdParam(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(422, "telegram_id must be a positive number.");
  return id;
}

bots.get("/:botId/members", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const page = await listMembers(c.env, bot.id, { limit, offset, search: c.req.query("search") });
  return c.json({ count: page.members.length, total: page.total, members: page.members });
});

bots.post("/:botId/members/:telegramId/grant", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  const telegramId = telegramIdParam(c.req.param("telegramId"));
  await grantAccess(c.env, bot, telegramId, (p) => c.executionCtx.waitUntil(p));
  return c.json({ message: `Access granted to ${telegramId}` });
});

bots.post("/:botId/members/:telegramId/revoke", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  const telegramId = telegramIdParam(c.req.param("telegramId"));
  if (!(await revokeAccess(c.env, bot, telegramId, (p) => c.executionCtx.waitUntil(p)))) {
    throw new HttpError(404, "Member not found.");
  }
  return c.json({ message: `Access revoked for ${telegramId}` });
});
