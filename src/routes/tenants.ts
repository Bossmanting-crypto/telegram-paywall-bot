/** /api/v1/tenants — signup, profile, API key rotation. */

import { Hono } from "hono";
import { billingStatus, createPlatformPayment } from "../billing";
import { iso, PROVIDERS, type Provider } from "../db";
import { OWNER_ID, PLAN_DAYS, TIER_CUT } from "../env";
import { HttpError, baseUrl, optNumber, optString, readJson, reqString, type AppContext } from "../lib/http";
import { accountSummary, createTenant, rotateTenantKey } from "../services";
import { requireTenant } from "./auth";

export const tenants = new Hono<AppContext>();

function telegramIdField(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = optNumber(body, key, { integer: true, min: 1 });
  return value === undefined ? undefined : value;
}

function providerField(body: Record<string, unknown>): Provider {
  const provider = optString(body, "provider", 32);
  if (!provider || !PROVIDERS.includes(provider as Provider)) {
    throw new HttpError(422, "'provider' must be one of: paystack, nowpayments, btcpay.");
  }
  return provider as Provider;
}

function percent(cut: number): string {
  return `${Math.round(cut * 100)}%`;
}

tenants.post("/signup", async (c) => {
  const body = await readJson(c);
  const created = await createTenant(c.env, {
    email: reqString(body, "email", 256),
    name: reqString(body, "name", 128),
    telegramId: telegramIdField(body, "telegram_id") ?? null,
    ip: c.req.header("cf-connecting-ip") ?? "",
  });
  const { id, email, name, apiKey, cut, trialEnds, recoveryId } = created;

  return c.json({
    message: "Account created! Save your API key — it won't be shown again.",
    id,
    email,
    name,
    tier: "free",
    api_key: apiKey,
    platform_cut: percent(cut),
    trial_ends: iso(trialEnds),
    recovery_telegram_id: recoveryId,
    next_steps: [
      "Save api_key: it is shown only once. Send it as the x-api-key header.",
      "Create a bot with POST /api/v1/bots (bot_token from @BotFather plus Paystack or NOWPayments keys).",
      "Add the bot to your Telegram group as an admin with the Ban users permission.",
    ],
  });
});

tenants.get("/me", requireTenant, async (c) => {
  const a = await accountSummary(c.env, c.get("tenant"));
  return c.json({
    id: a.id,
    email: a.email,
    name: a.name,
    tier: a.tier,
    platform_cut: percent(a.platformCut),
    api_key_hint: a.apiKeyHint,
    bots: a.bots,
    trial_ends: a.trialEndsAt,
    total_gross: `$${a.grossUsd.toFixed(2)}`,
    platform_fees: `$${a.feesUsd.toFixed(2)}`,
    net_earned: `$${a.netUsd.toFixed(2)}`,
    recovery_telegram_id: c.get("tenant").recovery_telegram_id ?? null,
  });
});

/** Change the account name or the Telegram account allowed to recover the key. */
tenants.patch("/me", requireTenant, async (c) => {
  const t = c.get("tenant");
  if (t.id === OWNER_ID) throw new HttpError(400, "The owner account is configured through Worker secrets.");
  const body = await readJson(c);
  const name = optString(body, "name", 128);
  const recovery = body.recovery_telegram_id === null ? null : telegramIdField(body, "recovery_telegram_id");
  const sets: string[] = [];
  const values: unknown[] = [];
  if (name) { sets.push(`name = ?${values.length + 1}`); values.push(name); }
  if (recovery !== undefined) { sets.push(`recovery_telegram_id = ?${values.length + 1}`); values.push(recovery); }
  if (!sets.length) throw new HttpError(400, "Nothing to update. Send name or recovery_telegram_id.");
  await c.env.DB.prepare(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?${values.length + 1}`).bind(...values, t.id).run();
  return c.json({ message: "Account updated." });
});

/** What the creator owes the platform, and how they can pay or upgrade. */
tenants.get("/billing", requireTenant, async (c) => {
  const b = await billingStatus(c.env, c.get("tenant"));
  return c.json({
    fees_owed_usd: b.feesOwedUsd,
    fees_paid_usd: b.feesPaidUsd,
    fee_limit_usd: b.feeLimitUsd,
    billing_hold: b.billingHold,
    starter_price_usd: b.starterPriceUsd,
    plan_days: b.planDays,
    plan_expires: b.planExpiresAt,
    can_buy_starter: b.canBuyStarter,
    payment_providers: b.providers,
  });
});

/** Payment link for the platform fees the creator owes. */
tenants.post("/pay-fees", requireTenant, async (c) => {
  const body = await readJson(c);
  const p = await createPlatformPayment(c.env, c.get("tenant"), "platform_fee", providerField(body), baseUrl(c));
  return c.json({ payment_url: p.paymentUrl, order_id: p.orderId, amount: p.amount, provider: p.provider });
});

tenants.post("/rotate-key", requireTenant, async (c) => {
  const t = c.get("tenant");
  if (t.id === OWNER_ID) {
    throw new HttpError(400, "The owner account uses the admin key. Change the ADMIN_API_KEY secret instead.");
  }
  const apiKey = await rotateTenantKey(c.env, t.id);
  return c.json({
    message: "New API key generated. Update your integrations immediately.",
    api_key: apiKey,
  });
});

/**
 * Plan changes are applied by the platform owner once payment is received
 * (POST /admin/tenants/{id}/tier). Creators cannot change their own cut.
 */
tenants.post("/upgrade", requireTenant, async (c) => {
  const t = c.get("tenant");
  const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
  const status = await billingStatus(c.env, t);
  if (body.provider !== undefined && status.canBuyStarter) {
    const p = await createPlatformPayment(c.env, t, "starter_plan", providerField(body), baseUrl(c));
    return c.json({ payment_url: p.paymentUrl, order_id: p.orderId, amount: p.amount, provider: p.provider, plan_days: PLAN_DAYS });
  }
  return c.json(
    {
      detail: status.canBuyStarter
        ? `Starter costs $${status.starterPriceUsd?.toFixed(2)} for ${PLAN_DAYS} days. Send {"provider": "paystack"} (or nowpayments) to get a payment link.`
        : "Upgrades are applied by the platform once payment is received. Contact the platform owner and quote your account ID.",
      account_id: t.id,
      current_tier: t.tier,
      starter_price_usd: status.starterPriceUsd,
      payment_providers: status.canBuyStarter ? status.providers : [],
      available: {
        starter: `${percent(TIER_CUT.starter ?? 0.08)} platform cut, unlimited bots and members`,
        whitelabel: "one-time purchase, no platform cut",
      },
    },
    402,
  );
});
