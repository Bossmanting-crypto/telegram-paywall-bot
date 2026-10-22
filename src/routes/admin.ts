/** /admin — platform-owner routes, protected by the ADMIN_API_KEY secret. */

import { Hono } from "hono";
import { checkBot, summarise, telegramWebhookUrl } from "../checks";
import { loadBot, type Tier } from "../db";
import { OWNER_ID } from "../env";
import { encryptionConfigured } from "../lib/crypto";
import { HttpError, baseUrl, optNumber, optString, readJson, type AppContext } from "../lib/http";
import { webhookUrl } from "../payments";
import { recordFeesPaid } from "../billing";
import {
  listCreators,
  rotateTenantKey,
  platformOverview,
  setCreatorActive,
  setCreatorPaystackSubaccount,
  setCreatorPlan,
} from "../services";
import { ALLOWED_UPDATES, TelegramError, looksLikeBotToken, tg } from "../telegram";
import { ensureJoinLink } from "../group";
import { ADMIN_PAGE } from "./admin-page";
import { requireAdmin } from "./auth";

export const admin = new Hono<AppContext>();

// The page itself holds no secrets: it asks for the admin key and sends it
// with each request, so it is safe to serve without authentication.
admin.get("/", (c) =>
  c.html(ADMIN_PAGE, 200, {
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  }),
);

admin.use("*", requireAdmin);

/**
 * One-time (and safely repeatable) setup for the owner bot: points Telegram
 * at this Worker and reports whether every credential is working.
 */
admin.post("/setup", async (c) => {
  const bot = await loadBot(c.env, OWNER_ID);
  if (!bot) throw new HttpError(500, "Owner bot record is missing.");
  if (!bot.token) {
    throw new HttpError(
      400,
      "TELEGRAM_BOT_TOKEN is not set. Add it under Worker → Settings → Variables and Secrets, then run setup again.",
    );
  }
  if (!looksLikeBotToken(bot.token)) {
    throw new HttpError(400, "TELEGRAM_BOT_TOKEN does not look like a bot token. Copy it again from @BotFather.");
  }

  let me: { id: number; username?: string };
  try {
    me = await tg<{ id: number; username?: string }>(bot.token, "getMe");
  } catch (error) {
    if (error instanceof TelegramError) {
      throw new HttpError(400, `Telegram rejected TELEGRAM_BOT_TOKEN: ${error.description}`);
    }
    throw error;
  }

  const base = baseUrl(c);
  const url = telegramWebhookUrl(base, OWNER_ID);
  try {
    await tg(bot.token, "setWebhook", {
      url,
      secret_token: bot.webhookSecret,
      allowed_updates: ALLOWED_UPDATES,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `Could not register the webhook with Telegram: ${reason}`);
  }

  // If a creator registered this same bot through the API, hand it back to the owner.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE bots SET telegram_bot_id = NULL WHERE telegram_bot_id = ?1 AND id != ?2").bind(
      me.id,
      OWNER_ID,
    ),
    c.env.DB.prepare("UPDATE bots SET bot_username = ?1, telegram_bot_id = ?2 WHERE id = ?3").bind(
      me.username ?? null,
      me.id,
      OWNER_ID,
    ),
  ]);
  await tg(bot.token, "setMyCommands", {
    commands: [{ command: "start", description: "Get access to the group" }],
  }).catch(() => undefined);

  let fresh = (await loadBot(c.env, OWNER_ID)) ?? bot;
  if (fresh.joinMode === "approve" && fresh.groupChatId && !fresh.joinLink) {
    await ensureJoinLink(c.env, fresh).catch(() => undefined);
    fresh = (await loadBot(c.env, OWNER_ID)) ?? fresh;
  }
  const checks = await checkBot(fresh, base);
  return c.json({
    ok: true,
    bot: me.username ? `@${me.username}` : String(me.id),
    telegram_webhook: url,
    group_chat_id: fresh.groupChatId,
    admin_user_ids: fresh.adminIds,
    prices_usd: fresh.prices,
    join_mode: fresh.joinMode,
    ...(fresh.joinLink ? { join_link: fresh.joinLink } : {}),
    payment_webhooks: {
      paystack: webhookUrl(base, "paystack", OWNER_ID),
      btcpay: webhookUrl(base, "btcpay", OWNER_ID),
      nowpayments: "Nothing to set — the callback URL is sent with every invoice.",
    },
    ...summarise(checks),
    checks,
  });
});

admin.get("/check-credentials", async (c) => {
  const bot = await loadBot(c.env, OWNER_ID);
  if (!bot) throw new HttpError(500, "Owner bot record is missing.");
  const base = baseUrl(c);
  const checks = await checkBot(bot, base);
  return c.json({
    app_url: base,
    platform: {
      admin_api_key: "set",
      encryption_key: encryptionConfigured(c.env.ENCRYPTION_KEY)
        ? "set"
        : "MISSING — creators cannot register bots until ENCRYPTION_KEY (32+ characters) is added",
      signups: c.env.ALLOW_SIGNUPS === "false" ? "closed" : "open",
    },
    owner_bot: {
      ...summarise(checks),
      group_chat_id: bot.groupChatId,
      admin_user_ids: bot.adminIds,
      prices_usd: bot.prices,
      checks,
    },
  });
});

/** Platform-wide numbers: what the platform itself has earned. */
admin.get("/overview", async (c) => {
  const o = await platformOverview(c.env);
  return c.json({
    creators: { total: o.creators.total, on_free_trial: o.creators.onFreeTrial },
    active_bots: o.activeBots,
    active_members: o.activeMembers,
    all_time: {
      transactions: o.allTime.transactions,
      processed_usd: o.allTime.processedUsd,
      platform_fees_usd: o.allTime.platformFeesUsd,
      own_bot_sales_usd: o.allTime.ownBotSalesUsd,
    },
    last_30_days: {
      processed_usd: o.last30Days.processedUsd,
      platform_fees_usd: o.last30Days.platformFeesUsd,
    },
  });
});

admin.get("/tenants", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const page = await listCreators(c.env, { limit, offset });
  return c.json({ count: page.creators.length, total: page.total, tenants: page.creators });
});

/** Change a creator's plan once they have paid for it. */
admin.post("/tenants/:id/tier", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  const tier = optString(body, "tier", 16) as Tier | null | undefined;
  if (tier !== "free" && tier !== "starter" && tier !== "whitelabel") {
    throw new HttpError(400, "Invalid tier. Choose 'free', 'starter' or 'whitelabel'.");
  }
  const result = await setCreatorPlan(c.env, id, tier, optNumber(body, "platform_cut", { min: 0, max: 1 }));
  return c.json({
    message: `Tenant is now on '${tier}'. Platform cut is ${Math.round(result.platformCut * 100)}%.`,
    tenant_id: id,
    tier,
    platform_cut: result.platformCut,
    trial_ends: result.trialEndsAt,
  });
});

/** Give a creator a new API key, e.g. when they've lost theirs. Shown once. */
admin.post("/tenants/:id/rotate-key", async (c) => {
  const apiKey = await rotateTenantKey(c.env, c.req.param("id"));
  return c.json({ message: "New key created. Pass it to the creator; it won't be shown again.", api_key: apiKey });
});

/** Record platform fees a creator paid outside the dashboard. A negative amount corrects a mistake. */
admin.post("/tenants/:id/fees-paid", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  const amount = optNumber(body, "amount", { min: -100000, max: 100000 });
  if (amount === undefined || amount === 0) throw new HttpError(422, "'amount' (USD) is required.");
  const found = await c.env.DB.prepare("SELECT id FROM tenants WHERE id = ?1 AND id != ?2").bind(id, OWNER_ID).first();
  if (!found) throw new HttpError(404, "Tenant not found.");
  await recordFeesPaid(c.env, id, amount);
  return c.json({ message: `Recorded $${amount.toFixed(2)} of fees paid.`, tenant_id: id });
});

/** Suspend or restore a creator. Suspended creators' bots stop selling. */
admin.post("/tenants/:id/active", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  if (typeof body.active !== "boolean") throw new HttpError(422, "'active' must be true or false.");
  await setCreatorActive(c.env, id, body.active);
  return c.json({ message: body.active ? "Tenant restored." : "Tenant suspended.", tenant_id: id });
});

/**
 * Optional Paystack split. `code` is a subaccount created inside the
 * creator's own Paystack account that pays out to the platform; when set,
 * the platform cut of each Paystack payment is routed to it automatically.
 */
admin.post("/tenants/:id/paystack-subaccount", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  const code = optString(body, "code", 128);
  if (code === undefined) throw new HttpError(422, "'code' is required (send null to remove it).");
  if (code !== null && !/^ACCT_[A-Za-z0-9]+$/.test(code)) {
    throw new HttpError(422, "'code' must be a Paystack subaccount code such as ACCT_xxxxxxxx.");
  }
  await setCreatorPaystackSubaccount(c.env, id, code);
  return c.json({
    message: code ? "Paystack split enabled for this tenant." : "Paystack split removed.",
    tenant_id: id,
  });
});
