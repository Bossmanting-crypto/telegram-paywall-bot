/**
 * Operations shared by the REST API, the MCP tools and the Telegram bot, so
 * each rule (ownership, limits, what a "paying member" is) lives in one place.
 *
 * Functions here take already-validated input and return plain data. Callers
 * shape it for their own audience (JSON for the API, text for MCP).
 */

import {
  countActiveMembers,
  iso,
  loadTenantBot,
  memberGrantStatement,
  now,
  revokeMemberAccess,
  type BotConfig,
  type BotStatus,
  type MemberRow,
  type PaymentRow,
  type TenantRow,
  type Tier,
} from "./db";
import { FREE_TRIAL_DAYS, OWNER_ID, TIER_CUT, type AppEnv, type Settings } from "./env";
import { maskSecret, newId } from "./lib/crypto";
import { HttpError, round2 } from "./lib/http";
import { availableProviders, deliverAccess, removeAccess, webhookUrl } from "./payments";

export type WaitUntil = (promise: Promise<unknown>) => void;

// ── Account ──────────────────────────────────────────────────────────────────

export interface AccountSummary {
  id: string;
  email: string;
  name: string;
  tier: Tier;
  platformCut: number;
  apiKeyHint: string;
  bots: number;
  trialEndsAt: string | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
}

export async function accountSummary(env: AppEnv, tenant: TenantRow): Promise<AccountSummary> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM bots WHERE tenant_id = ?1 AND status != 'deleted') AS bots,
       (SELECT COALESCE(SUM(gross_amount), 0) FROM payments WHERE tenant_id = ?1 AND status = 'confirmed') AS gross,
       (SELECT COALESCE(SUM(platform_fee), 0) FROM payments WHERE tenant_id = ?1 AND status = 'confirmed') AS fees`,
  )
    .bind(tenant.id)
    .first<{ bots: number; gross: number; fees: number }>();
  const gross = row?.gross ?? 0;
  const fees = row?.fees ?? 0;
  return {
    id: tenant.id,
    email: tenant.email,
    name: tenant.name,
    tier: tenant.tier,
    platformCut: tenant.platform_cut,
    apiKeyHint: `${tenant.api_key_prefix}…`,
    bots: row?.bots ?? 0,
    trialEndsAt: iso(tenant.trial_ends_at),
    grossUsd: round2(gross),
    feesUsd: round2(fees),
    netUsd: round2(gross - fees),
  };
}

export interface RevenueOverview {
  allTime: { grossUsd: number; platformFeeUsd: number; netUsd: number; transactions: number };
  last30Days: { grossUsd: number; netUsd: number; transactions: number };
  activeMembers: number;
  totalBots: number;
  platformCut: number;
}

export async function revenueOverview(env: AppEnv, tenant: TenantRow): Promise<RevenueOverview> {
  const at = now();
  const since = at - 30 * 86400;
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(gross_amount), 0) AS gross,
            COALESCE(SUM(platform_fee), 0) AS fee,
            COALESCE(SUM(net_amount), 0) AS net,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?2 THEN 1 ELSE 0 END), 0) AS n30,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?2 THEN gross_amount ELSE 0 END), 0) AS gross30,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?2 THEN net_amount ELSE 0 END), 0) AS net30
     FROM payments WHERE tenant_id = ?1 AND status = 'confirmed'`,
  )
    .bind(tenant.id, since)
    .first<{ n: number; gross: number; fee: number; net: number; n30: number; gross30: number; net30: number }>();

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM bots WHERE tenant_id = ?1 AND status != 'deleted') AS bots,
       (SELECT COUNT(*) FROM members m JOIN bots b ON b.id = m.bot_id
         WHERE b.tenant_id = ?1 AND b.status != 'deleted' AND m.has_access = 1
           AND (m.access_expires IS NULL OR m.access_expires > ?2)) AS members`,
  )
    .bind(tenant.id, at)
    .first<{ bots: number; members: number }>();

  return {
    allTime: {
      grossUsd: round2(totals?.gross ?? 0),
      platformFeeUsd: round2(totals?.fee ?? 0),
      netUsd: round2(totals?.net ?? 0),
      transactions: totals?.n ?? 0,
    },
    last30Days: {
      grossUsd: round2(totals?.gross30 ?? 0),
      netUsd: round2(totals?.net30 ?? 0),
      transactions: totals?.n30 ?? 0,
    },
    activeMembers: counts?.members ?? 0,
    totalBots: counts?.bots ?? 0,
    platformCut: tenant.platform_cut,
  };
}

// ── Bots ─────────────────────────────────────────────────────────────────────

export interface BotPrices {
  one_time: number;
  monthly: number;
  image_vault: number;
}

export function botPrices(bot: BotConfig): BotPrices {
  return { one_time: bot.prices.one_time, monthly: bot.prices.monthly, image_vault: bot.prices.image_unlock };
}

export interface BotSummary {
  id: string;
  botUsername: string | null;
  groupName: string | null;
  groupChatId: number | null;
  status: string;
  activeMembers: number;
  prices: BotPrices;
  createdAt: string | null;
}

export async function listBots(env: AppEnv, tenantId: string): Promise<BotSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.group_name, b.group_chat_id, b.bot_username, b.status, b.created_at,
            b.one_time_price, b.monthly_price, b.image_unlock_price,
            (SELECT COUNT(*) FROM members m
              WHERE m.bot_id = b.id AND m.has_access = 1
                AND (m.access_expires IS NULL OR m.access_expires > ?2)) AS member_count
     FROM bots b WHERE b.tenant_id = ?1 AND b.status != 'deleted' ORDER BY b.created_at`,
  )
    .bind(tenantId, now())
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
  const owner = tenantId === OWNER_ID ? await loadTenantBot(env, OWNER_ID, OWNER_ID) : null;

  return results.map((b) => {
    const isOwner = owner !== null && b.id === OWNER_ID;
    return {
      id: b.id,
      botUsername: b.bot_username ? `@${b.bot_username}` : null,
      groupName: b.group_name,
      groupChatId: isOwner ? owner.groupChatId : b.group_chat_id,
      status: b.status,
      activeMembers: b.member_count,
      prices: isOwner
        ? botPrices(owner)
        : {
            one_time: b.one_time_price ?? 10,
            monthly: b.monthly_price ?? 5,
            image_vault: b.image_unlock_price ?? 20,
          },
      createdAt: iso(b.created_at),
    };
  });
}

export interface BotDetail {
  id: string;
  botUsername: string | null;
  groupName: string | null;
  groupChatId: number | null;
  status: BotStatus;
  activeMembers: number;
  revenue: { grossUsd: number; platformFeeUsd: number; netUsd: number };
  prices: BotPrices;
  currency: string;
  fxRate: number;
  welcomeTitle: string;
  welcomeText: string;
  groupDescription: string | null;
  adminUserIds: number[];
  paymentProviders: string[];
  credentials: {
    paystack_secret_key: string | null;
    nowpayments_api_key: string | null;
    nowpayments_ipn_secret_set: boolean;
    btcpay_url: string | null;
    btcpay_api_key: string | null;
    btcpay_webhook_secret_set: boolean;
  };
  webhooks: Record<string, string>;
  createdAt: string | null;
}

export function paymentWebhooks(base: string, botId: string): Record<string, string> {
  return {
    paystack: webhookUrl(base, "paystack", botId),
    nowpayments: webhookUrl(base, "nowpayments", botId),
    btcpay: webhookUrl(base, "btcpay", botId),
  };
}

export async function botDetail(env: AppEnv, bot: BotConfig, base: string): Promise<BotDetail> {
  const revenue = await env.DB.prepare(
    `SELECT COALESCE(SUM(gross_amount), 0) AS gross, COALESCE(SUM(net_amount), 0) AS net
     FROM payments WHERE bot_id = ?1 AND status = 'confirmed'`,
  )
    .bind(bot.id)
    .first<{ gross: number; net: number }>();
  const gross = revenue?.gross ?? 0;
  const net = revenue?.net ?? 0;
  return {
    id: bot.id,
    botUsername: bot.username ? `@${bot.username}` : null,
    groupName: bot.groupName,
    groupChatId: bot.groupChatId,
    status: bot.status,
    activeMembers: await countActiveMembers(env, bot.id),
    revenue: { grossUsd: round2(gross), platformFeeUsd: round2(gross - net), netUsd: round2(net) },
    prices: botPrices(bot),
    currency: bot.currency,
    fxRate: bot.fxRate,
    welcomeTitle: bot.welcomeTitle,
    welcomeText: bot.welcomeText,
    groupDescription: bot.groupDescription,
    adminUserIds: bot.adminIds,
    paymentProviders: availableProviders(bot),
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
    createdAt: iso(bot.createdAt),
  };
}

/** Bot settings that are not credentials. `null` clears a text field. */
export interface BotSettingsUpdate {
  one_time_price?: number;
  monthly_price?: number;
  image_unlock_price?: number;
  welcome_title?: string | null;
  welcome_text?: string | null;
  group_description?: string | null;
  currency?: string;
  fx_rate?: number;
  group_chat_id?: number;
  admin_user_ids?: string | null;
  status?: "active" | "paused";
}

const OWNER_ENV_OVERRIDES: ReadonlyArray<readonly [keyof BotSettingsUpdate, keyof Settings]> = [
  ["one_time_price", "ONE_TIME_PRICE_USD"],
  ["monthly_price", "MONTHLY_PRICE_USD"],
  ["image_unlock_price", "IMAGE_UNLOCK_PRICE_USD"],
  ["group_chat_id", "GROUP_CHAT_ID"],
  ["currency", "PAYSTACK_CURRENCY"],
  ["fx_rate", "PAYSTACK_FX_RATE"],
];

/**
 * Write a validated settings update (plus any already-encrypted credential
 * columns the API sends). Returns the names of the columns changed.
 */
export async function updateBotSettings(
  env: AppEnv,
  bot: BotConfig,
  update: BotSettingsUpdate,
  credentialColumns: Record<string, string | null> = {},
): Promise<string[]> {
  if (update.status !== undefined && bot.status === "expired") {
    throw new HttpError(403, "This bot stopped when the free trial ended. Upgrade to reactivate it.");
  }
  if (bot.isOwner) {
    // The owner bot reads these from Worker settings first, so writing the
    // database column would silently change nothing.
    for (const [field, variable] of OWNER_ENV_OVERRIDES) {
      if (update[field] !== undefined && env[variable]) {
        throw new HttpError(
          400,
          `Your bot's ${field} is set by the ${variable} setting in Cloudflare (Worker → Settings → Variables and Secrets). Change it there.`,
        );
      }
    }
  }
  const set: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(update)) {
    if (value !== undefined) set[column] = value;
  }
  Object.assign(set, credentialColumns);

  const names = Object.keys(set);
  if (names.length === 0) throw new HttpError(400, "Nothing to update.");
  await env.DB.prepare(
    `UPDATE bots SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(", ")} WHERE id = ?${names.length + 1}`,
  )
    .bind(...Object.values(set), bot.id)
    .run();
  return names;
}

// ── Members ──────────────────────────────────────────────────────────────────

export interface MemberView {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  access_type: string | null;
  access_expires: string | null;
  images_unlocked: boolean;
  joined_at: string | null;
}

export function memberView(m: MemberRow): MemberView {
  return {
    telegram_id: m.telegram_id,
    username: m.username,
    first_name: m.first_name,
    access_type: m.access_type,
    access_expires: iso(m.access_expires),
    images_unlocked: m.images_unlocked === 1,
    joined_at: iso(m.joined_at),
  };
}

/** Paying members, newest first. `search` matches username or first name. */
export async function listMembers(
  env: AppEnv,
  botId: string,
  opts: { limit: number; offset: number; search?: string | null },
): Promise<{ total: number; members: MemberView[] }> {
  const at = now();
  const search = opts.search?.trim().replace(/^@/, "") || null;
  // LIKE wildcards in the search text are escaped so they match literally.
  const pattern = search ? `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const where = `bot_id = ?1 AND has_access = 1 AND (access_expires IS NULL OR access_expires > ?2)
     AND (?3 IS NULL OR username LIKE ?3 ESCAPE '\\' OR first_name LIKE ?3 ESCAPE '\\')`;

  const [page, count] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM members WHERE ${where} ORDER BY joined_at DESC, id LIMIT ?4 OFFSET ?5`).bind(
      botId,
      at,
      pattern,
      opts.limit,
      opts.offset,
    ),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE ${where}`).bind(botId, at, pattern),
  ]);
  const rows = (page?.results ?? []) as MemberRow[];
  const total = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  return { total, members: rows.map(memberView) };
}

/** Give a member access for free, in the database and in the Telegram group. */
export async function grantAccess(env: AppEnv, bot: BotConfig, telegramId: number, waitUntil: WaitUntil): Promise<void> {
  await memberGrantStatement(env, bot.id, telegramId, "manual_grant").run();
  waitUntil(deliverAccess(env, bot, telegramId, "manual_grant"));
}

/** Remove a member's access. Returns false when the bot has no record of them. */
export async function revokeAccess(
  env: AppEnv,
  bot: BotConfig,
  telegramId: number,
  waitUntil: WaitUntil,
): Promise<boolean> {
  const found = await revokeMemberAccess(env, bot.id, telegramId);
  if (found) waitUntil(removeAccess(bot, telegramId));
  return found;
}

/** Queue a message to every paying member; the cron job delivers it. Returns the recipient count. */
export async function queueBroadcast(
  env: AppEnv,
  botId: string,
  text: string,
  requestedBy: number | null,
): Promise<number> {
  const [, recipients] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO broadcasts (id, bot_id, text, requested_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(newId(), botId, text.slice(0, 4000), requestedBy, now()),
    env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE bot_id = ?1 AND has_access = 1").bind(botId),
  ]);
  return ((recipients?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
}

// ── Payments ─────────────────────────────────────────────────────────────────

export interface PaymentView {
  id: string;
  order_id: string;
  bot_id: string;
  telegram_id: number;
  provider: string;
  access_type: string;
  status: string;
  gross: number;
  platform_fee: number;
  net: number;
  currency: string;
  created_at: string | null;
  confirmed_at: string | null;
}

export function paymentView(p: PaymentRow): PaymentView {
  return {
    id: p.id,
    order_id: p.provider_ref,
    bot_id: p.bot_id,
    telegram_id: p.telegram_id,
    provider: p.provider,
    access_type: p.access_type,
    status: p.status,
    gross: p.gross_amount,
    platform_fee: p.platform_fee,
    net: p.net_amount,
    currency: p.currency,
    created_at: iso(p.created_at),
    confirmed_at: iso(p.confirmed_at),
  };
}

export function findTenantPayment(env: AppEnv, tenantId: string, orderId: string): Promise<PaymentRow | null> {
  return env.DB.prepare("SELECT * FROM payments WHERE provider_ref = ?1 AND tenant_id = ?2")
    .bind(orderId, tenantId)
    .first<PaymentRow>();
}

/** Confirmed payments, newest first, optionally for one bot. */
export async function listConfirmedPayments(
  env: AppEnv,
  tenantId: string,
  opts: { limit: number; offset: number; botId?: string | null },
): Promise<{ total: number; payments: PaymentView[] }> {
  const where = "tenant_id = ?1 AND status = 'confirmed' AND (?2 IS NULL OR bot_id = ?2)";
  const botId = opts.botId ?? null;
  const [page, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM payments WHERE ${where} ORDER BY confirmed_at DESC, id LIMIT ?3 OFFSET ?4`,
    ).bind(tenantId, botId, opts.limit, opts.offset),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM payments WHERE ${where}`).bind(tenantId, botId),
  ]);
  const rows = (page?.results ?? []) as PaymentRow[];
  const total = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  return { total, payments: rows.map(paymentView) };
}

// ── Platform owner ───────────────────────────────────────────────────────────

export interface PlatformOverview {
  creators: { total: number; onFreeTrial: number };
  activeBots: number;
  activeMembers: number;
  allTime: { transactions: number; processedUsd: number; platformFeesUsd: number; ownBotSalesUsd: number };
  last30Days: { processedUsd: number; platformFeesUsd: number };
}

export async function platformOverview(env: AppEnv): Promise<PlatformOverview> {
  const at = now();
  const since = at - 30 * 86400;
  const money = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(gross_amount), 0) AS gross,
            COALESCE(SUM(platform_fee), 0) AS fees,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?1 THEN gross_amount ELSE 0 END), 0) AS gross30,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?1 THEN platform_fee ELSE 0 END), 0) AS fees30,
            COALESCE(SUM(CASE WHEN tenant_id = ?2 THEN gross_amount ELSE 0 END), 0) AS own
     FROM payments WHERE status = 'confirmed'`,
  )
    .bind(since, OWNER_ID)
    .first<{ n: number; gross: number; fees: number; gross30: number; fees30: number; own: number }>();
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tenants WHERE id != ?1) AS tenants,
       (SELECT COUNT(*) FROM tenants WHERE id != ?1 AND tier = 'free') AS free_tenants,
       (SELECT COUNT(*) FROM bots WHERE status = 'active') AS active_bots,
       (SELECT COUNT(*) FROM members WHERE has_access = 1 AND (access_expires IS NULL OR access_expires > ?2)) AS members`,
  )
    .bind(OWNER_ID, at)
    .first<{ tenants: number; free_tenants: number; active_bots: number; members: number }>();

  return {
    creators: { total: counts?.tenants ?? 0, onFreeTrial: counts?.free_tenants ?? 0 },
    activeBots: counts?.active_bots ?? 0,
    activeMembers: counts?.members ?? 0,
    allTime: {
      transactions: money?.n ?? 0,
      processedUsd: round2(money?.gross ?? 0),
      platformFeesUsd: round2(money?.fees ?? 0),
      ownBotSalesUsd: round2(money?.own ?? 0),
    },
    last30Days: { processedUsd: round2(money?.gross30 ?? 0), platformFeesUsd: round2(money?.fees30 ?? 0) },
  };
}

export interface CreatorView {
  id: string;
  email: string;
  name: string;
  tier: string;
  platform_cut: number;
  active: boolean;
  trial_ends: string | null;
  bots: number;
  processed_usd: number;
  platform_fees_usd: number;
  paystack_subaccount_code: string | null;
  created_at: string | null;
}

/** Creators (everyone but the owner), newest first. */
export async function listCreators(
  env: AppEnv,
  opts: { limit: number; offset: number },
): Promise<{ total: number; creators: CreatorView[] }> {
  const [page, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.id, t.email, t.name, t.tier, t.platform_cut, t.is_active, t.trial_ends_at, t.created_at,
              t.paystack_subaccount_code,
              (SELECT COUNT(*) FROM bots b WHERE b.tenant_id = t.id AND b.status != 'deleted') AS bots,
              (SELECT COALESCE(SUM(p.gross_amount), 0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'confirmed') AS gross,
              (SELECT COALESCE(SUM(p.platform_fee), 0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'confirmed') AS fees
       FROM tenants t WHERE t.id != ?1 ORDER BY t.created_at DESC, t.id LIMIT ?2 OFFSET ?3`,
    ).bind(OWNER_ID, opts.limit, opts.offset),
    env.DB.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id != ?1").bind(OWNER_ID),
  ]);
  type Row = {
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
  };
  const rows = (page?.results ?? []) as Row[];
  const total = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  return {
    total,
    creators: rows.map((t) => ({
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
  };
}

async function requireCreator(env: AppEnv, id: string): Promise<void> {
  if (id === OWNER_ID) throw new HttpError(400, "The owner account cannot be changed here.");
  const found = await env.DB.prepare("SELECT id FROM tenants WHERE id = ?1").bind(id).first();
  if (!found) throw new HttpError(404, "Tenant not found.");
}

/** Change a creator's plan. A paid plan also restarts bots stopped by an expired trial. */
export async function setCreatorPlan(
  env: AppEnv,
  id: string,
  tier: Tier,
  platformCut?: number,
): Promise<{ tier: Tier; platformCut: number; trialEndsAt: string | null }> {
  await requireCreator(env, id);
  const cut = platformCut ?? TIER_CUT[tier] ?? 0;
  const trialEnds = tier === "free" ? now() + FREE_TRIAL_DAYS * 86400 : null;
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET tier = ?1, platform_cut = ?2, trial_ends_at = ?3 WHERE id = ?4").bind(
      tier,
      cut,
      trialEnds,
      id,
    ),
    env.DB.prepare("UPDATE bots SET status = 'active' WHERE tenant_id = ?1 AND status = 'expired'").bind(id),
  ]);
  return { tier, platformCut: cut, trialEndsAt: iso(trialEnds) };
}

/** Suspend or restore a creator. A suspended creator's key and bots stop working. */
export async function setCreatorActive(env: AppEnv, id: string, active: boolean): Promise<void> {
  await requireCreator(env, id);
  await env.DB.prepare("UPDATE tenants SET is_active = ?1 WHERE id = ?2").bind(active ? 1 : 0, id).run();
}

export async function setCreatorPaystackSubaccount(env: AppEnv, id: string, code: string | null): Promise<void> {
  await requireCreator(env, id);
  await env.DB.prepare("UPDATE tenants SET paystack_subaccount_code = ?1 WHERE id = ?2").bind(code, id).run();
}
