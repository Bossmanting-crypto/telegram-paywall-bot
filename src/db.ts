/** Row types, the resolved per-bot configuration, and shared queries. */

import { MONTHLY_ACCESS_DAYS, OWNER_ID, type AppEnv } from "./env";
import { decryptWithKey, deriveKey, encryptionConfigured, newId } from "./lib/crypto";
import { HttpError } from "./lib/http";

export const now = (): number => Math.floor(Date.now() / 1000);
export const iso = (t: number | null | undefined): string | null =>
  t ? new Date(t * 1000).toISOString() : null;

export type Tier = "free" | "starter" | "whitelabel";
export type BotStatus = "active" | "paused" | "expired" | "deleted";
export type AccessType = "one_time" | "monthly" | "image_unlock";
export type Provider = "paystack" | "nowpayments" | "btcpay";

export const ACCESS_TYPES: readonly AccessType[] = ["one_time", "monthly", "image_unlock"];
export const PROVIDERS: readonly Provider[] = ["paystack", "nowpayments", "btcpay"];

export interface TenantRow {
  id: string;
  email: string;
  name: string;
  api_key_hash: string;
  api_key_prefix: string;
  tier: Tier;
  platform_cut: number;
  is_active: number;
  trial_ends_at: number | null;
  paystack_subaccount_code: string | null;
  created_at: number;
}

export interface BotRow {
  id: string;
  tenant_id: string;
  bot_token_enc: string | null;
  telegram_bot_id: number | null;
  bot_username: string | null;
  webhook_secret: string;
  group_chat_id: number | null;
  group_name: string | null;
  status: BotStatus;
  one_time_price: number | null;
  monthly_price: number | null;
  image_unlock_price: number | null;
  currency: string | null;
  fx_rate: number | null;
  welcome_title: string | null;
  welcome_text: string | null;
  group_description: string | null;
  admin_user_ids: string | null;
  paystack_secret_key_enc: string | null;
  paystack_public_key: string | null;
  nowpayments_api_key_enc: string | null;
  nowpayments_ipn_secret_enc: string | null;
  btcpay_url: string | null;
  btcpay_store_id: string | null;
  btcpay_api_key_enc: string | null;
  btcpay_webhook_secret_enc: string | null;
  last_notice_message_id: number | null;
  created_at: number;
}

export interface MemberRow {
  id: string;
  bot_id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  has_access: number;
  access_type: string | null;
  access_expires: number | null;
  images_unlocked: number;
  joined_at: number;
}

export interface PaymentRow {
  id: string;
  tenant_id: string;
  bot_id: string;
  telegram_id: number;
  provider: Provider;
  provider_ref: string;
  provider_invoice_id: string | null;
  access_type: AccessType;
  gross_amount: number;
  platform_fee: number;
  net_amount: number;
  currency: string;
  charge_amount_minor: number | null;
  charge_currency: string | null;
  status: "pending" | "confirmed" | "failed";
  payment_url: string | null;
  created_at: number;
  confirmed_at: number | null;
}

/** Everything needed to run one bot, with credentials decrypted. */
export interface BotConfig {
  id: string;
  tenantId: string;
  isOwner: boolean;
  /** Empty string when the bot has no token (owner bot before setup). */
  token: string;
  username: string | null;
  webhookSecret: string;
  groupChatId: number | null;
  groupName: string | null;
  status: BotStatus;
  prices: Record<AccessType, number>;
  /** Currency Paystack charges in, and how many units of it equal 1 USD. */
  currency: string;
  fxRate: number;
  paystackChannels: string[] | null;
  welcomeTitle: string;
  welcomeText: string;
  groupDescription: string | null;
  adminIds: number[];
  paystack: { secretKey: string; publicKey: string | null; subaccount: string | null } | null;
  nowpayments: { apiKey: string; ipnSecret: string | null } | null;
  btcpay: { url: string; storeId: string; apiKey: string; webhookSecret: string | null } | null;
  btcpayAcceptUnconfirmed: boolean;
  tier: Tier;
  platformCut: number;
  tenantActive: boolean;
  trialEndsAt: number | null;
  lastNoticeMessageId: number | null;
  createdAt: number;
}

type BotJoinRow = BotRow & {
  t_tier: Tier;
  t_platform_cut: number;
  t_is_active: number;
  t_trial_ends_at: number | null;
  t_paystack_subaccount_code: string | null;
};

const BOT_JOIN_SQL = `
  SELECT b.*,
         t.tier AS t_tier,
         t.platform_cut AS t_platform_cut,
         t.is_active AS t_is_active,
         t.trial_ends_at AS t_trial_ends_at,
         t.paystack_subaccount_code AS t_paystack_subaccount_code
  FROM bots b JOIN tenants t ON t.id = b.tenant_id`;

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseIdList(value: string | null | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isSafeInteger(n) && n !== 0);
}

function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Decrypt a set of stored credentials, deriving the key once for all of them. */
async function decryptFields(env: AppEnv, blobs: Array<string | null>): Promise<Array<string | null>> {
  if (blobs.every((blob) => !blob)) return blobs.map(() => null);
  if (!encryptionConfigured(env.ENCRYPTION_KEY)) {
    throw new HttpError(503, "ENCRYPTION_KEY is not configured on the platform.");
  }
  try {
    const key = await deriveKey(env.ENCRYPTION_KEY);
    return await Promise.all(blobs.map((blob) => (blob ? decryptWithKey(key, blob) : null)));
  } catch {
    throw new HttpError(
      503,
      "Stored credentials could not be decrypted. ENCRYPTION_KEY has probably changed since they were saved.",
    );
  }
}

async function resolveBot(env: AppEnv, row: BotJoinRow): Promise<BotConfig> {
  const isOwner = row.id === OWNER_ID;

  const base = {
    id: row.id,
    tenantId: row.tenant_id,
    isOwner,
    username: row.bot_username,
    webhookSecret: row.webhook_secret,
    groupName: row.group_name,
    status: row.status,
    welcomeTitle: row.welcome_title || "VIP Access Required",
    welcomeText: row.welcome_text || "Pay to unlock this exclusive group.",
    groupDescription: row.group_description,
    tier: row.t_tier,
    platformCut: row.t_platform_cut,
    tenantActive: row.t_is_active === 1,
    trialEndsAt: row.t_trial_ends_at,
    lastNoticeMessageId: row.last_notice_message_id,
    createdAt: row.created_at,
  };

  if (isOwner) {
    // The owner bot reads its credentials from Worker secrets, using the same
    // variable names as the original Python deployment.
    const currency = (env.PAYSTACK_CURRENCY || row.currency || "KES").toUpperCase();
    const channels = (env.PAYSTACK_CHANNELS ?? "card,mobile_money,bank")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ...base,
      token: env.TELEGRAM_BOT_TOKEN ?? "",
      groupChatId: envNumber(env.GROUP_CHAT_ID) || row.group_chat_id,
      prices: {
        one_time: envNumber(env.ONE_TIME_PRICE_USD) ?? row.one_time_price ?? 10,
        monthly: envNumber(env.MONTHLY_PRICE_USD) ?? row.monthly_price ?? 5,
        image_unlock: envNumber(env.IMAGE_UNLOCK_PRICE_USD) ?? row.image_unlock_price ?? 0,
      },
      currency,
      fxRate: envNumber(env.PAYSTACK_FX_RATE) ?? row.fx_rate ?? (currency === "KES" ? 129 : 1),
      paystackChannels: channels.length ? channels : null,
      adminIds: [...new Set([...parseIdList(env.ADMIN_USER_IDS), ...parseIdList(row.admin_user_ids)])],
      paystack: env.PAYSTACK_SECRET_KEY
        ? {
            secretKey: env.PAYSTACK_SECRET_KEY,
            publicKey: env.PAYSTACK_PUBLIC_KEY ?? null,
            subaccount: null,
          }
        : null,
      nowpayments: env.NOWPAYMENTS_API_KEY
        ? { apiKey: env.NOWPAYMENTS_API_KEY, ipnSecret: env.NOWPAYMENTS_IPN_SECRET ?? null }
        : null,
      btcpay:
        env.BTCPAY_URL && env.BTCPAY_STORE_ID && env.BTCPAY_API_KEY
          ? {
              url: normaliseUrl(env.BTCPAY_URL),
              storeId: env.BTCPAY_STORE_ID,
              apiKey: env.BTCPAY_API_KEY,
              webhookSecret: env.BTCPAY_WEBHOOK_SECRET ?? null,
            }
          : null,
      btcpayAcceptUnconfirmed: env.BTCPAY_ACCEPT_UNCONFIRMED !== "false",
    };
  }

  const [token, paystackKey, nowKey, nowIpn, btcKey, btcSecret] = await decryptFields(env, [
    row.bot_token_enc,
    row.paystack_secret_key_enc,
    row.nowpayments_api_key_enc,
    row.nowpayments_ipn_secret_enc,
    row.btcpay_api_key_enc,
    row.btcpay_webhook_secret_enc,
  ]);

  return {
    ...base,
    token: token ?? "",
    groupChatId: row.group_chat_id,
    prices: {
      one_time: row.one_time_price ?? 10,
      monthly: row.monthly_price ?? 5,
      image_unlock: row.image_unlock_price ?? 20,
    },
    currency: (row.currency || "USD").toUpperCase(),
    fxRate: row.fx_rate ?? 1,
    paystackChannels: null,
    adminIds: parseIdList(row.admin_user_ids),
    paystack: paystackKey
      ? {
          secretKey: paystackKey,
          publicKey: row.paystack_public_key,
          subaccount: row.t_paystack_subaccount_code,
        }
      : null,
    nowpayments: nowKey ? { apiKey: nowKey, ipnSecret: nowIpn ?? null } : null,
    btcpay:
      row.btcpay_url && row.btcpay_store_id && btcKey
        ? {
            url: normaliseUrl(row.btcpay_url),
            storeId: row.btcpay_store_id,
            apiKey: btcKey,
            webhookSecret: btcSecret ?? null,
          }
        : null,
    btcpayAcceptUnconfirmed: true,
  };
}

/** Load a bot by ID. Deleted bots are treated as missing. */
export async function loadBot(env: AppEnv, botId: string): Promise<BotConfig | null> {
  const row = await env.DB.prepare(`${BOT_JOIN_SQL} WHERE b.id = ?1 AND b.status != 'deleted'`)
    .bind(botId)
    .first<BotJoinRow>();
  return row ? resolveBot(env, row) : null;
}

/** Load a bot only if it belongs to `tenantId`; otherwise 404. */
export async function loadTenantBot(env: AppEnv, botId: string, tenantId: string): Promise<BotConfig> {
  const row = await env.DB.prepare(
    `${BOT_JOIN_SQL} WHERE b.id = ?1 AND b.tenant_id = ?2 AND b.status != 'deleted'`,
  )
    .bind(botId, tenantId)
    .first<BotJoinRow>();
  if (!row) throw new HttpError(404, "Bot not found.");
  return resolveBot(env, row);
}

export function botIsSelling(bot: BotConfig): boolean {
  return bot.status === "active" && bot.tenantActive && bot.token !== "";
}

// ── Members ──────────────────────────────────────────────────────────────────

export function hasValidAccess(member: MemberRow | null, at: number = now()): boolean {
  if (!member || member.has_access !== 1) return false;
  return member.access_expires === null || member.access_expires > at;
}

export async function getMember(env: AppEnv, botId: string, telegramId: number): Promise<MemberRow | null> {
  return env.DB.prepare("SELECT * FROM members WHERE bot_id = ?1 AND telegram_id = ?2")
    .bind(botId, telegramId)
    .first<MemberRow>();
}

/** Create the member if new, refresh their name if not, and return the row. */
export async function upsertMember(
  env: AppEnv,
  botId: string,
  user: { id: number; username?: string; first_name?: string },
): Promise<MemberRow> {
  const row = await env.DB.prepare(
    `INSERT INTO members (id, bot_id, telegram_id, username, first_name, joined_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(bot_id, telegram_id) DO UPDATE SET
       username   = COALESCE(excluded.username, members.username),
       first_name = COALESCE(excluded.first_name, members.first_name)
     RETURNING *`,
  )
    .bind(newId(), botId, user.id, user.username ?? null, user.first_name ?? null, now())
    .first<MemberRow>();
  if (!row) throw new Error("Member upsert returned no row");
  return row;
}

export async function countActiveMembers(env: AppEnv, botId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM members
     WHERE bot_id = ?1 AND has_access = 1 AND (access_expires IS NULL OR access_expires > ?2)`,
  )
    .bind(botId, now())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Statement that records a member has paid (or been granted access).
 *
 * Monthly access extends from the current expiry if it is still running, so
 * renewing early never loses days, and never downgrades lifetime access.
 *
 * When `pendingPaymentId` is given the statement only takes effect while that
 * payment is still pending. Run it in the same batch as the statement that
 * marks the payment confirmed and a replayed webhook cannot grant twice.
 */
export function memberGrantStatement(
  env: AppEnv,
  botId: string,
  telegramId: number,
  accessType: "one_time" | "monthly" | "manual_grant",
  pendingPaymentId: string | null = null,
): D1PreparedStatement {
  const at = now();
  const guard = `WHERE (?6 IS NULL OR EXISTS (SELECT 1 FROM payments WHERE id = ?6 AND status = 'pending'))`;
  if (accessType === "monthly") {
    return env.DB.prepare(
      `INSERT INTO members (id, bot_id, telegram_id, has_access, access_type, access_expires, joined_at)
       SELECT ?1, ?2, ?3, 1, 'monthly', ?4 + ?5, ?4
       ${guard}
       ON CONFLICT(bot_id, telegram_id) DO UPDATE SET
         access_type = CASE
           WHEN members.has_access = 1 AND members.access_expires IS NULL THEN members.access_type
           ELSE 'monthly' END,
         access_expires = CASE
           WHEN members.has_access = 1 AND members.access_expires IS NULL THEN NULL
           WHEN members.has_access = 1 AND members.access_expires > ?4 THEN members.access_expires + ?5
           ELSE ?4 + ?5 END,
         has_access = 1`,
    ).bind(newId(), botId, telegramId, at, MONTHLY_ACCESS_DAYS * 86400, pendingPaymentId);
  }
  return env.DB.prepare(
    `INSERT INTO members (id, bot_id, telegram_id, has_access, access_type, access_expires, joined_at)
     SELECT ?1, ?2, ?3, 1, ?5, NULL, ?4
     ${guard}
     ON CONFLICT(bot_id, telegram_id) DO UPDATE SET
       has_access = 1, access_type = excluded.access_type, access_expires = NULL`,
  ).bind(newId(), botId, telegramId, at, accessType, pendingPaymentId);
}

/** Statement that marks the image vault as unlocked for a member. */
export function vaultUnlockStatement(
  env: AppEnv,
  botId: string,
  telegramId: number,
  pendingPaymentId: string | null = null,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO members (id, bot_id, telegram_id, images_unlocked, joined_at)
     SELECT ?1, ?2, ?3, 1, ?4
     WHERE (?5 IS NULL OR EXISTS (SELECT 1 FROM payments WHERE id = ?5 AND status = 'pending'))
     ON CONFLICT(bot_id, telegram_id) DO UPDATE SET images_unlocked = 1`,
  ).bind(newId(), botId, telegramId, now(), pendingPaymentId);
}

export async function revokeMemberAccess(env: AppEnv, botId: string, telegramId: number): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE members SET has_access = 0, access_expires = NULL WHERE bot_id = ?1 AND telegram_id = ?2",
  )
    .bind(botId, telegramId)
    .run();
  return result.meta.changes > 0;
}

export async function countVaultImages(env: AppEnv, botId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_images WHERE bot_id = ?1")
    .bind(botId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
