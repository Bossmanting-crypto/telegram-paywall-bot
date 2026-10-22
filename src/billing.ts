/**
 * Collecting the platform's cut.
 *
 * Creators' buyers pay the creator directly, so the platform fee on each sale
 * is owed to the owner. The ledger is simple:
 *   owed = fees on the creator's confirmed sales (minus any the Paystack split
 *          already routed to the owner) − fees the creator has paid.
 * Creators pay what they owe from the dashboard through the owner's own
 * payment providers. If FEE_LIMIT_USD is set, a creator's sales pause once
 * what they owe reaches it, and resume the moment they pay.
 *
 * STARTER_PRICE_USD, when set, lets creators buy 30 days of Starter
 * themselves the same way.
 */

import { alertCreator } from "./alerts";
import { loadBot, type BotConfig, type Provider, type TenantRow } from "./db";
import { OWNER_ID, PLAN_DAYS, TIER_CUT, type AppEnv } from "./env";
import { HttpError, round2 } from "./lib/http";
import { ADULT_BLOCKED, availableProviders, startPayment, type CreatedPayment } from "./payments";
import { tenantHasAdult } from "./services";

/** Sales whose fee counts towards what a creator owes. */
const FEE_BEARING = "status = 'confirmed' AND fee_collected = 0 AND access_type NOT IN ('platform_fee', 'starter_plan')";
const MIN_FEE_PAYMENT = 1;

function envAmount(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

export const feeLimit = (env: AppEnv): number | null => envAmount(env.FEE_LIMIT_USD);
export const starterPrice = (env: AppEnv): number | null => envAmount(env.STARTER_PRICE_USD);

export async function feesOwed(env: AppEnv, tenantId: string): Promise<{ accrued: number; paid: number; owed: number }> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(platform_fee), 0) FROM payments WHERE tenant_id = ?1 AND ${FEE_BEARING}) AS accrued,
            (SELECT fees_paid_usd FROM tenants WHERE id = ?1) AS paid`,
  )
    .bind(tenantId)
    .first<{ accrued: number; paid: number | null }>();
  const accrued = round2(row?.accrued ?? 0);
  const paid = round2(row?.paid ?? 0);
  return { accrued, paid, owed: round2(Math.max(0, accrued - paid)) };
}

export interface BillingStatus {
  feesOwedUsd: number;
  feesPaidUsd: number;
  feeLimitUsd: number | null;
  billingHold: boolean;
  starterPriceUsd: number | null;
  planDays: number;
  planExpiresAt: string | null;
  canBuyStarter: boolean;
  /** Ways the creator can pay the owner. */
  providers: Provider[];
}

async function ownerBot(env: AppEnv): Promise<BotConfig | null> {
  return loadBot(env, OWNER_ID);
}

/**
 * Ways a creator can pay the owner. A creator with an adults-only group pays
 * with crypto, so adult revenue never reaches the owner's Paystack account.
 */
async function feeProviders(env: AppEnv, tenantId: string, owner: BotConfig | null): Promise<Provider[]> {
  if (!owner) return [];
  const all = availableProviders(owner);
  if (!(await tenantHasAdult(env, tenantId))) return all;
  return all.filter((p) => !ADULT_BLOCKED.has(p));
}

export async function billingStatus(env: AppEnv, tenant: TenantRow): Promise<BillingStatus> {
  const [fees, owner] = await Promise.all([feesOwed(env, tenant.id), ownerBot(env)]);
  const price = starterPrice(env);
  return {
    feesOwedUsd: fees.owed,
    feesPaidUsd: fees.paid,
    feeLimitUsd: feeLimit(env),
    billingHold: tenant.billing_hold === 1,
    starterPriceUsd: price,
    planDays: PLAN_DAYS,
    planExpiresAt: tenant.plan_expires_at ? new Date(tenant.plan_expires_at * 1000).toISOString() : null,
    // A Starter plan with no end date was set by the owner; there's nothing to buy.
    canBuyStarter:
      price !== null &&
      tenant.id !== OWNER_ID &&
      (tenant.tier === "free" || (tenant.tier === "starter" && tenant.plan_expires_at !== null)),
    providers: await feeProviders(env, tenant.id, owner),
  };
}

/** Payment link for a creator to pay the owner: what they owe, or a Starter period. */
export async function createPlatformPayment(
  env: AppEnv,
  tenant: TenantRow,
  kind: "platform_fee" | "starter_plan",
  provider: Provider,
  baseUrl: string,
): Promise<CreatedPayment> {
  if (tenant.id === OWNER_ID) throw new HttpError(400, "The platform owner doesn't pay platform fees.");
  const owner = await ownerBot(env);
  const allowed = await feeProviders(env, tenant.id, owner);
  if (!owner || !allowed.includes(provider)) {
    throw new HttpError(400, `Paying by ${provider} isn't available. Choose one of: ${allowed.join(", ") || "none"}.`);
  }

  let amount: number;
  let description: string;
  if (kind === "platform_fee") {
    amount = (await feesOwed(env, tenant.id)).owed;
    if (amount < MIN_FEE_PAYMENT) {
      throw new HttpError(400, amount > 0 ? `You owe ${`$${amount.toFixed(2)}`}; payments start at $${MIN_FEE_PAYMENT}.` : "You don't owe any platform fees.");
    }
    description = `Platform fees for ${tenant.name}`;
  } else {
    const status = await billingStatus(env, tenant);
    if (!status.canBuyStarter || status.starterPriceUsd === null) {
      throw new HttpError(400, "Starter can't be bought here. Contact the platform owner.");
    }
    amount = status.starterPriceUsd;
    description = `Starter plan, ${PLAN_DAYS} days, for ${tenant.name}`;
  }

  return startPayment(env, owner, {
    telegramId: 0,
    kind,
    amount,
    coins: null,
    description,
    provider,
    baseUrl,
    email: tenant.email,
    forTenantId: tenant.id,
    successPath: "/dashboard#account",
    refPrefix: kind === "platform_fee" ? "fee" : "plan",
  });
}

/**
 * After one of a creator's sales is confirmed: pause their sales if what they
 * owe has reached FEE_LIMIT_USD, warn at 80%, and tell them through their bot.
 */
export async function applyFeeLimit(env: AppEnv, bot: BotConfig): Promise<"held" | "warned" | null> {
  const limit = feeLimit(env);
  if (limit === null || bot.isOwner) return null;
  const { owed } = await feesOwed(env, bot.tenantId);
  if (owed >= limit) {
    const result = await env.DB.prepare("UPDATE tenants SET billing_hold = 1 WHERE id = ?1 AND billing_hold = 0")
      .bind(bot.tenantId)
      .run();
    if (result.meta.changes > 0) {
      await alertCreator(
        env,
        bot,
        "billing-hold",
        `Sales are paused: you owe $${owed.toFixed(2)} in platform fees. Pay them in the dashboard (Account → Pay fees) and sales resume straight away. Paying members keep their access.`,
      );
      return "held";
    }
    return null;
  }
  if (owed >= limit * 0.8) {
    await alertCreator(
      env,
      bot,
      "billing-warning",
      `You owe $${owed.toFixed(2)} in platform fees. Sales pause at $${limit.toFixed(2)}, so pay in the dashboard (Account → Pay fees) to keep selling.`,
    );
    return "warned";
  }
  return null;
}

/** Owner records fees paid outside the dashboard (cash, bank transfer). */
export async function recordFeesPaid(env: AppEnv, tenantId: string, amount: number): Promise<void> {
  await env.DB.prepare("UPDATE tenants SET fees_paid_usd = MAX(fees_paid_usd + ?1, 0) WHERE id = ?2")
    .bind(round2(amount), tenantId)
    .run();
  const limit = feeLimit(env);
  const { owed } = await feesOwed(env, tenantId);
  if (limit === null || owed < limit) {
    await env.DB.prepare("UPDATE tenants SET billing_hold = 0 WHERE id = ?1").bind(tenantId).run();
  }
}

/** Starter plans bought in the dashboard that have run out go back to the standard rate. Bots keep selling. */
export async function expireStarterPlans(env: AppEnv, at: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `UPDATE tenants SET tier = 'free', platform_cut = MAX(platform_cut, ?2), trial_ends_at = NULL, plan_expires_at = NULL
     WHERE tier = 'starter' AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?1
     RETURNING id`,
  )
    .bind(at, TIER_CUT.free ?? 0.12)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
