/** /admin — platform-owner routes, protected by the ADMIN_API_KEY secret. */

import { Hono } from "hono";
import { checkBot, summarise, telegramWebhookUrl } from "../checks";
import { iso, loadBot, now, type Tier } from "../db";
import { FREE_TRIAL_DAYS, OWNER_ID, TIER_CUT } from "../env";
import { encryptionConfigured } from "../lib/crypto";
import { HttpError, baseUrl, optNumber, optString, readJson, round2, type AppContext } from "../lib/http";
import { webhookUrl } from "../payments";
import { ALLOWED_UPDATES, TelegramError, looksLikeBotToken, tg } from "../telegram";
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

  const fresh = (await loadBot(c.env, OWNER_ID)) ?? bot;
  const checks = await checkBot(fresh, base);
  return c.json({
    ok: true,
    bot: me.username ? `@${me.username}` : String(me.id),
    telegram_webhook: url,
    group_chat_id: fresh.groupChatId,
    admin_user_ids: fresh.adminIds,
    prices_usd: fresh.prices,
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
  const since = now() - 30 * 86400;
  const money = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(gross_amount), 0) AS gross,
            COALESCE(SUM(platform_fee), 0) AS fees,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?1 THEN gross_amount ELSE 0 END), 0) AS gross30,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?1 THEN platform_fee ELSE 0 END), 0) AS fees30
     FROM payments WHERE status = 'confirmed'`,
  )
    .bind(since)
    .first<{ n: number; gross: number; fees: number; gross30: number; fees30: number }>();
  const own = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(gross_amount), 0) AS gross FROM payments WHERE status = 'confirmed' AND tenant_id = ?1`,
  )
    .bind(OWNER_ID)
    .first<{ gross: number }>();
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tenants WHERE id != ?1) AS tenants,
       (SELECT COUNT(*) FROM tenants WHERE id != ?1 AND tier = 'free') AS free_tenants,
       (SELECT COUNT(*) FROM bots WHERE status = 'active') AS active_bots,
       (SELECT COUNT(*) FROM members WHERE has_access = 1 AND (access_expires IS NULL OR access_expires > ?2)) AS members`,
  )
    .bind(OWNER_ID, now())
    .first<{ tenants: number; free_tenants: number; active_bots: number; members: number }>();

  return c.json({
    creators: { total: counts?.tenants ?? 0, on_free_trial: counts?.free_tenants ?? 0 },
    active_bots: counts?.active_bots ?? 0,
    active_members: counts?.members ?? 0,
    all_time: {
      transactions: money?.n ?? 0,
      processed_usd: round2(money?.gross ?? 0),
      platform_fees_usd: round2(money?.fees ?? 0),
      own_bot_sales_usd: round2(own?.gross ?? 0),
    },
    last_30_days: {
      processed_usd: round2(money?.gross30 ?? 0),
      platform_fees_usd: round2(money?.fees30 ?? 0),
    },
  });
});

admin.get("/tenants", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.email, t.name, t.tier, t.platform_cut, t.is_active, t.trial_ends_at, t.created_at,
            t.paystack_subaccount_code,
            (SELECT COUNT(*) FROM bots b WHERE b.tenant_id = t.id AND b.status != 'deleted') AS bots,
            (SELECT COALESCE(SUM(p.gross_amount), 0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'confirmed') AS gross,
            (SELECT COALESCE(SUM(p.platform_fee), 0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'confirmed') AS fees
     FROM tenants t WHERE t.id != ?1 ORDER BY t.created_at DESC LIMIT 500`,
  )
    .bind(OWNER_ID)
    .all<{
      id: string;
      email: string;
      name: string;
      tier: string;
      platform_cut: number;
      is_active: number;
      trial_ends_at: number | null;
      created_at: number;
      paystack_subaccount_code: string | null;
      bots: number;
      gross: number;
      fees: number;
    }>();
  return c.json({
    count: results.length,
    tenants: results.map((t) => ({
      id: t.id,
      email: t.email,
      name: t.name,
      tier: t.tier,
      platform_cut: t.platform_cut,
      active: t.is_active === 1,
      trial_ends: iso(t.trial_ends_at),
      bots: t.bots,
      processed_usd: round2(t.gross),
      platform_fees_usd: round2(t.fees),
      paystack_subaccount_code: t.paystack_subaccount_code,
      created_at: iso(t.created_at),
    })),
  });
});

async function requireTenantId(c: { env: AppContext["Bindings"] }, id: string): Promise<void> {
  if (id === OWNER_ID) throw new HttpError(400, "The owner account cannot be changed here.");
  const found = await c.env.DB.prepare("SELECT id FROM tenants WHERE id = ?1").bind(id).first();
  if (!found) throw new HttpError(404, "Tenant not found.");
}

/** Change a creator's plan once they have paid for it. */
admin.post("/tenants/:id/tier", async (c) => {
  const id = c.req.param("id");
  await requireTenantId(c, id);
  const body = await readJson(c);
  const tier = optString(body, "tier", 16) as Tier | null | undefined;
  if (tier !== "free" && tier !== "starter" && tier !== "whitelabel") {
    throw new HttpError(400, "Invalid tier. Choose 'free', 'starter' or 'whitelabel'.");
  }
  const cut = optNumber(body, "platform_cut", { min: 0, max: 1 }) ?? TIER_CUT[tier] ?? 0;
  const trialEnds = tier === "free" ? now() + FREE_TRIAL_DAYS * 86400 : null;

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tenants SET tier = ?1, platform_cut = ?2, trial_ends_at = ?3 WHERE id = ?4").bind(
      tier,
      cut,
      trialEnds,
      id,
    ),
    // Bots that stopped when a trial ran out come back on a paid plan.
    c.env.DB.prepare("UPDATE bots SET status = 'active' WHERE tenant_id = ?1 AND status = 'expired'").bind(id),
  ]);
  return c.json({
    message: `Tenant is now on '${tier}'. Platform cut is ${Math.round(cut * 100)}%.`,
    tenant_id: id,
    tier,
    platform_cut: cut,
    trial_ends: iso(trialEnds),
  });
});

/** Suspend or restore a creator. Suspended creators' bots stop selling. */
admin.post("/tenants/:id/active", async (c) => {
  const id = c.req.param("id");
  await requireTenantId(c, id);
  const body = await readJson(c);
  if (typeof body.active !== "boolean") throw new HttpError(422, "'active' must be true or false.");
  await c.env.DB.prepare("UPDATE tenants SET is_active = ?1 WHERE id = ?2").bind(body.active ? 1 : 0, id).run();
  return c.json({ message: body.active ? "Tenant restored." : "Tenant suspended.", tenant_id: id });
});

/**
 * Optional Paystack split. `code` is a subaccount created inside the
 * creator's own Paystack account that pays out to the platform; when set,
 * the platform cut of each Paystack payment is routed to it automatically.
 */
admin.post("/tenants/:id/paystack-subaccount", async (c) => {
  const id = c.req.param("id");
  await requireTenantId(c, id);
  const body = await readJson(c);
  const code = optString(body, "code", 128);
  if (code === undefined) throw new HttpError(422, "'code' is required (send null to remove it).");
  if (code !== null && !/^ACCT_[A-Za-z0-9]+$/.test(code)) {
    throw new HttpError(422, "'code' must be a Paystack subaccount code such as ACCT_xxxxxxxx.");
  }
  await c.env.DB.prepare("UPDATE tenants SET paystack_subaccount_code = ?1 WHERE id = ?2").bind(code, id).run();
  return c.json({
    message: code ? "Paystack split enabled for this tenant." : "Paystack split removed.",
    tenant_id: id,
  });
});
