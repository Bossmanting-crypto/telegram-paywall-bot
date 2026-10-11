/** /api/v1/bots — create and manage a creator's bots and their members. */

import { Hono } from "hono";
import { checkBot, summarise, telegramWebhookUrl } from "../checks";
import {
  countActiveMembers,
  iso,
  loadTenantBot,
  memberGrantStatement,
  now,
  parseIdList,
  revokeMemberAccess,
  type BotConfig,
  type MemberRow,
} from "../db";
import { FREE_BOT_LIMIT, OWNER_ID, type AppEnv } from "../env";
import { encryptSecret, encryptionConfigured, maskSecret, newId, randomHex } from "../lib/crypto";
import {
  HttpError,
  baseUrl,
  optNumber,
  optString,
  readJson,
  reqString,
  type AppContext,
} from "../lib/http";
import { availableProviders, deliverAccess, removeAccess, webhookUrl } from "../payments";
import { isAcceptableServerUrl } from "../providers/btcpay";
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

function paymentWebhooks(base: string, botId: string): Record<string, string> {
  return {
    paystack: webhookUrl(base, "paystack", botId),
    nowpayments: webhookUrl(base, "nowpayments", botId),
    btcpay: webhookUrl(base, "btcpay", botId),
  };
}

function prices(bot: BotConfig): Record<string, number> {
  return {
    one_time: bot.prices.one_time,
    monthly: bot.prices.monthly,
    image_vault: bot.prices.image_unlock,
  };
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

  if (tenant.tier === "free") {
    if (tenant.trial_ends_at !== null && tenant.trial_ends_at <= now()) {
      throw new HttpError(403, "Your free trial has ended. Upgrade to Starter to keep using the platform.");
    }
    const existing = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bots WHERE tenant_id = ?1 AND status != 'deleted'",
    )
      .bind(tenant.id)
      .first<{ n: number }>();
    if ((existing?.n ?? 0) >= FREE_BOT_LIMIT) {
      throw new HttpError(403, "Free tier allows 1 bot. Upgrade to Starter for unlimited bots.");
    }
  }

  const token = reqString(body, "bot_token", 256);
  if (!looksLikeBotToken(token)) {
    throw new HttpError(400, "Invalid bot token format. Get it from @BotFather.");
  }
  if (token === c.env.TELEGRAM_BOT_TOKEN) {
    throw new HttpError(409, "This Telegram bot is already registered on the platform.");
  }

  const oneTime = optNumber(body, "one_time_price", PRICE) ?? 10;
  const monthly = optNumber(body, "monthly_price", PRICE) ?? 5;
  const imageUnlock = optNumber(body, "image_unlock_price", PRICE) ?? 20;
  if (oneTime <= 0 && monthly <= 0) {
    throw new HttpError(422, "Set a price above 0 for one_time_price or monthly_price.");
  }
  const currency = (optString(body, "currency", 8) ?? "USD").toUpperCase();
  if (!CURRENCY.test(currency)) throw new HttpError(422, "'currency' must be a 3-letter code such as USD or KES.");
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
    prices: {
      one_time: `$${bot.prices.one_time}`,
      monthly: `$${bot.prices.monthly}/mo`,
      image_vault: `$${bot.prices.image_unlock}`,
    },
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
  const tenant = c.get("tenant");
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.group_name, b.group_chat_id, b.bot_username, b.status, b.created_at,
            b.one_time_price, b.monthly_price, b.image_unlock_price,
            (SELECT COUNT(*) FROM members m
              WHERE m.bot_id = b.id AND m.has_access = 1
                AND (m.access_expires IS NULL OR m.access_expires > ?2)) AS member_count
     FROM bots b WHERE b.tenant_id = ?1 AND b.status != 'deleted' ORDER BY b.created_at`,
  )
    .bind(tenant.id, now())
    .all<{
      id: string;
      group_name: string | null;
      group_chat_id: number | null;
      bot_username: string | null;
      status: string;
      created_at: number;
      one_time_price: number | null;
      monthly_price: number | null;
      image_unlock_price: number | null;
      member_count: number;
    }>();

  // The owner bot's prices and group come from Worker secrets, so resolve it properly.
  const owner = tenant.id === OWNER_ID ? await loadTenantBot(c.env, OWNER_ID, OWNER_ID) : null;

  return c.json({
    count: results.length,
    bots: results.map((b) => ({
      id: b.id,
      bot_username: b.bot_username ? `@${b.bot_username}` : null,
      group_name: b.group_name,
      group_chat_id: owner && b.id === OWNER_ID ? owner.groupChatId : b.group_chat_id,
      status: b.status,
      member_count: b.member_count,
      prices:
        owner && b.id === OWNER_ID
          ? prices(owner)
          : {
              one_time: b.one_time_price ?? 10,
              monthly: b.monthly_price ?? 5,
              image_vault: b.image_unlock_price ?? 20,
            },
      created_at: iso(b.created_at),
    })),
  });
});

bots.get("/:botId", async (c) => {
  const tenant = c.get("tenant");
  const bot = await loadTenantBot(c.env, c.req.param("botId"), tenant.id);
  const revenue = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(gross_amount), 0) AS gross, COALESCE(SUM(net_amount), 0) AS net
     FROM payments WHERE bot_id = ?1 AND status = 'confirmed'`,
  )
    .bind(bot.id)
    .first<{ gross: number; net: number }>();
  const gross = revenue?.gross ?? 0;
  const net = revenue?.net ?? 0;
  const base = baseUrl(c);

  return c.json({
    id: bot.id,
    bot_username: bot.username ? `@${bot.username}` : null,
    group_name: bot.groupName,
    group_chat_id: bot.groupChatId,
    status: bot.status,
    active_members: await countActiveMembers(c.env, bot.id),
    revenue: {
      gross: `$${gross.toFixed(2)}`,
      platform_fee: `$${(gross - net).toFixed(2)}`,
      net: `$${net.toFixed(2)}`,
    },
    prices: prices(bot),
    currency: bot.currency,
    fx_rate: bot.fxRate,
    welcome_title: bot.welcomeTitle,
    welcome_text: bot.welcomeText,
    group_description: bot.groupDescription,
    admin_user_ids: bot.adminIds,
    payment_providers: availableProviders(bot),
    // Keys are never returned in full — only enough to recognise which one is in use.
    credentials: {
      paystack_secret_key: maskSecret(bot.paystack?.secretKey),
      nowpayments_api_key: maskSecret(bot.nowpayments?.apiKey),
      nowpayments_ipn_secret_set: Boolean(bot.nowpayments?.ipnSecret),
      btcpay_url: bot.btcpay?.url ?? null,
      btcpay_api_key: maskSecret(bot.btcpay?.apiKey),
      btcpay_webhook_secret_set: Boolean(bot.btcpay?.webhookSecret),
    },
    webhooks: paymentWebhooks(base, bot.id),
    created_at: iso(bot.createdAt),
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
  const set: Record<string, unknown> = {};

  for (const [field, column] of [
    ["one_time_price", "one_time_price"],
    ["monthly_price", "monthly_price"],
    ["image_unlock_price", "image_unlock_price"],
  ] as const) {
    const value = optNumber(body, field, PRICE);
    if (value !== undefined) set[column] = value;
  }
  for (const [field, max] of [
    ["welcome_title", 256],
    ["welcome_text", 2000],
    ["group_description", 2000],
  ] as const) {
    const value = optString(body, field, max);
    if (value !== undefined) set[field] = value;
  }

  const currency = optString(body, "currency", 8);
  if (currency) {
    if (!CURRENCY.test(currency.toUpperCase())) throw new HttpError(422, "'currency' must be a 3-letter code.");
    set.currency = currency.toUpperCase();
  }
  const fxRate = optNumber(body, "fx_rate", { min: 0.000001 });
  if (fxRate !== undefined) set.fx_rate = fxRate;

  const groupChatId = optNumber(body, "group_chat_id", { integer: true });
  if (groupChatId !== undefined) set.group_chat_id = groupChatId;

  const adminIds = adminIdsField(body);
  if (adminIds !== undefined) set.admin_user_ids = adminIds;

  const status = optString(body, "status", 16);
  if (status) {
    if (status !== "active" && status !== "paused") {
      throw new HttpError(422, "'status' must be 'active' or 'paused'.");
    }
    if (bot.status === "expired") {
      throw new HttpError(403, "This bot stopped when the free trial ended. Upgrade to reactivate it.");
    }
    set.status = status;
  }

  const providers = providerFields(body);
  const sentProviderField = Object.values(providers).some((v) => v !== undefined);
  if (sentProviderField && bot.isOwner) {
    throw new HttpError(400, "The owner bot's payment keys are Worker secrets. Change them in the Cloudflare dashboard.");
  }
  for (const [field, value] of Object.entries(providers)) {
    const spec = PROVIDER_COLUMNS[field];
    if (!spec || value === undefined) continue;
    set[spec.column] = value === null ? null : spec.encrypted ? await encrypt(c.env, value) : value;
  }

  const names = Object.keys(set);
  if (names.length === 0) throw new HttpError(400, "Nothing to update.");
  await c.env.DB.prepare(
    `UPDATE bots SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(", ")} WHERE id = ?${names.length + 1}`,
  )
    .bind(...Object.values(set), bot.id)
    .run();

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
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM members
     WHERE bot_id = ?1 AND has_access = 1 AND (access_expires IS NULL OR access_expires > ?2)
     ORDER BY joined_at DESC, id LIMIT ?3 OFFSET ?4`,
  )
    .bind(bot.id, now(), limit, offset)
    .all<MemberRow>();
  return c.json({
    count: results.length,
    total: await countActiveMembers(c.env, bot.id),
    members: results.map((m) => ({
      telegram_id: m.telegram_id,
      username: m.username,
      first_name: m.first_name,
      access_type: m.access_type,
      access_expires: iso(m.access_expires),
      images_unlocked: m.images_unlocked === 1,
      joined_at: iso(m.joined_at),
    })),
  });
});

bots.post("/:botId/members/:telegramId/grant", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  const telegramId = telegramIdParam(c.req.param("telegramId"));
  await memberGrantStatement(c.env, bot.id, telegramId, "manual_grant").run();
  c.executionCtx.waitUntil(deliverAccess(c.env, bot, telegramId, "manual_grant"));
  return c.json({ message: `Access granted to ${telegramId}` });
});

bots.post("/:botId/members/:telegramId/revoke", async (c) => {
  const bot = await loadTenantBot(c.env, c.req.param("botId"), c.get("tenant").id);
  const telegramId = telegramIdParam(c.req.param("telegramId"));
  if (!(await revokeMemberAccess(c.env, bot.id, telegramId))) {
    throw new HttpError(404, "Member not found.");
  }
  c.executionCtx.waitUntil(removeAccess(bot, telegramId));
  return c.json({ message: `Access revoked for ${telegramId}` });
});
