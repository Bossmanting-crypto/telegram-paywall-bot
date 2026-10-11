/**
 * Payment flow shared by the Telegram bot, the API and the provider webhooks:
 * create a payment link, confirm it exactly once, then unlock the member.
 */

import {
  FREE_MEMBER_LIMIT,
  MAX_VAULT_IMAGES,
  type AppEnv,
} from "./env";
import {
  botIsSelling,
  countActiveMembers,
  countVaultImages,
  getMember,
  hasValidAccess,
  memberGrantStatement,
  now,
  vaultUnlockStatement,
  type AccessType,
  type BotConfig,
  type PaymentRow,
  type Provider,
} from "./db";
import { newId, randomHex } from "./lib/crypto";
import { HttpError, log, logError, round2 } from "./lib/http";
import * as btcpay from "./providers/btcpay";
import * as nowpayments from "./providers/nowpayments";
import * as paystack from "./providers/paystack";
import { restrictMember, sendMessage, tg, unrestrictMember } from "./telegram";

export const ACCESS_LABEL: Record<AccessType, string> = {
  one_time: "One-Time Access",
  monthly: "Monthly Access",
  image_unlock: "Image Vault",
};

/**
 * Providers a bot can actually take money through. A crypto provider is only
 * offered when its webhook secret is set too — without it a payment could
 * never be verified, so the buyer would pay and stay locked out.
 */
export function availableProviders(bot: BotConfig): Provider[] {
  const list: Provider[] = [];
  if (bot.paystack) list.push("paystack");
  if (bot.nowpayments?.ipnSecret) list.push("nowpayments");
  if (bot.btcpay?.webhookSecret) list.push("btcpay");
  return list;
}

export function webhookUrl(baseUrl: string, provider: Provider, botId: string): string {
  return `${baseUrl}/webhooks/${provider}/${botId}`;
}

export interface CreatedPayment {
  paymentUrl: string;
  orderId: string;
  provider: Provider;
  accessType: AccessType;
  amount: number;
  platformFee: number;
  net: number;
}

export async function createPayment(
  env: AppEnv,
  bot: BotConfig,
  opts: {
    telegramId: number;
    accessType: AccessType;
    provider: Provider;
    baseUrl: string;
    email?: string | null;
  },
): Promise<CreatedPayment> {
  if (!botIsSelling(bot)) {
    throw new HttpError(409, "This bot is not accepting payments right now.");
  }

  const amount = bot.prices[opts.accessType];
  if (!(amount > 0)) {
    throw new HttpError(400, `'${opts.accessType}' is not for sale on this bot.`);
  }
  if (!availableProviders(bot).includes(opts.provider)) {
    throw new HttpError(400, `Provider '${opts.provider}' not configured for this bot.`);
  }
  if (opts.accessType === "image_unlock" && (await countVaultImages(env, bot.id)) === 0) {
    throw new HttpError(400, "The image vault is empty, so there is nothing to sell yet.");
  }

  // Free tier: capped number of paying members.
  if (bot.tier === "free" && opts.accessType !== "image_unlock") {
    const existing = await getMember(env, bot.id, opts.telegramId);
    if (!hasValidAccess(existing) && (await countActiveMembers(env, bot.id)) >= FREE_MEMBER_LIMIT) {
      throw new HttpError(
        403,
        `Free tier is limited to ${FREE_MEMBER_LIMIT} members. Upgrade to Starter for unlimited members.`,
      );
    }
  }

  const platformFee = round2(amount * bot.platformCut);
  const net = round2(amount - platformFee);
  // Paystack references may only contain letters, digits, "-", "." and "=".
  const orderId = `${opts.telegramId}-${randomHex(6)}`;
  const description = `${bot.welcomeTitle} — ${ACCESS_LABEL[opts.accessType]}`;
  const successUrl = `${opts.baseUrl}/payment/success`;
  const cancelUrl = `${opts.baseUrl}/payment/cancel`;

  const chargeMinor = opts.provider === "paystack" ? paystack.toMinorUnits(amount, bot.fxRate) : null;
  const chargeCurrency = opts.provider === "paystack" ? bot.currency : null;

  // Record the order before calling the provider, so a payment can never
  // arrive for an order we have no record of.
  const paymentId = newId();
  await env.DB.prepare(
    `INSERT INTO payments
       (id, tenant_id, bot_id, telegram_id, provider, provider_ref, access_type,
        gross_amount, platform_fee, net_amount, currency,
        charge_amount_minor, charge_currency, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'USD', ?11, ?12, 'pending', ?13)`,
  )
    .bind(
      paymentId,
      bot.tenantId,
      bot.id,
      opts.telegramId,
      opts.provider,
      orderId,
      opts.accessType,
      amount,
      platformFee,
      net,
      chargeMinor,
      chargeCurrency,
      now(),
    )
    .run();

  let paymentUrl: string;
  let invoiceId: string | null = null;
  try {
    if (opts.provider === "paystack" && bot.paystack && chargeMinor !== null) {
      const feeMinor = paystack.toMinorUnits(platformFee, bot.fxRate);
      const result = await paystack.initializeTransaction(bot.paystack.secretKey, {
        email: opts.email || `${opts.telegramId}@telegram.user`,
        amountMinor: chargeMinor,
        currency: bot.currency,
        reference: orderId,
        callbackUrl: successUrl,
        cancelUrl,
        description,
        channels: bot.paystackChannels,
        split:
          bot.paystack.subaccount && feeMinor > 0
            ? { subaccount: bot.paystack.subaccount, mainAccountShareMinor: chargeMinor - feeMinor }
            : null,
      });
      paymentUrl = result.paymentUrl;
    } else if (opts.provider === "nowpayments" && bot.nowpayments) {
      const result = await nowpayments.createInvoice(bot.nowpayments.apiKey, {
        amountUsd: amount,
        orderId,
        description,
        ipnCallbackUrl: webhookUrl(opts.baseUrl, "nowpayments", bot.id),
        successUrl,
        cancelUrl,
      });
      paymentUrl = result.paymentUrl;
      invoiceId = result.invoiceId;
    } else if (opts.provider === "btcpay" && bot.btcpay) {
      const result = await btcpay.createInvoice(bot.btcpay, {
        amountUsd: amount,
        orderId,
        description,
        redirectUrl: successUrl,
      });
      paymentUrl = result.paymentUrl;
      invoiceId = result.invoiceId;
    } else {
      throw new HttpError(400, `Provider '${opts.provider}' not configured for this bot.`);
    }
  } catch (error) {
    await env.DB.prepare("UPDATE payments SET status = 'failed' WHERE id = ?1").bind(paymentId).run();
    throw error;
  }

  await env.DB.prepare("UPDATE payments SET payment_url = ?1, provider_invoice_id = ?2 WHERE id = ?3")
    .bind(paymentUrl, invoiceId, paymentId)
    .run();

  return {
    paymentUrl,
    orderId,
    provider: opts.provider,
    accessType: opts.accessType,
    amount,
    platformFee,
    net,
  };
}

export function findPayment(env: AppEnv, orderId: string): Promise<PaymentRow | null> {
  return env.DB.prepare("SELECT * FROM payments WHERE provider_ref = ?1").bind(orderId).first<PaymentRow>();
}

export function findPaymentByInvoice(
  env: AppEnv,
  provider: Provider,
  invoiceId: string,
): Promise<PaymentRow | null> {
  return env.DB.prepare("SELECT * FROM payments WHERE provider = ?1 AND provider_invoice_id = ?2")
    .bind(provider, invoiceId)
    .first<PaymentRow>();
}

/**
 * Mark a pending payment confirmed and grant what was bought, in one
 * transaction. Returns false when the payment was already confirmed, so a
 * webhook delivered twice has no further effect.
 */
export async function confirmPayment(env: AppEnv, payment: PaymentRow): Promise<boolean> {
  const grant =
    payment.access_type === "image_unlock"
      ? vaultUnlockStatement(env, payment.bot_id, payment.telegram_id, payment.id)
      : memberGrantStatement(env, payment.bot_id, payment.telegram_id, payment.access_type, payment.id);

  const results = await env.DB.batch([
    grant,
    env.DB.prepare(
      "UPDATE payments SET status = 'confirmed', confirmed_at = ?1 WHERE id = ?2 AND status = 'pending'",
    ).bind(now(), payment.id),
  ]);
  const confirmed = (results[1]?.meta.changes ?? 0) === 1;
  if (confirmed) {
    log("payment confirmed", {
      order_id: payment.provider_ref,
      provider: payment.provider,
      bot_id: payment.bot_id,
      telegram_id: payment.telegram_id,
      access_type: payment.access_type,
    });
  }
  return confirmed;
}

// ── Telegram side effects ────────────────────────────────────────────────────

/**
 * Lift the group restriction and tell the buyer. Never throws: the payment is
 * already recorded, and the buyer can send /start to retry the unlock.
 */
export async function deliverAccess(
  env: AppEnv,
  bot: BotConfig,
  telegramId: number,
  accessType: AccessType | "manual_grant",
): Promise<void> {
  if (!bot.token) return;
  if (accessType === "image_unlock") {
    try {
      await deliverVault(env, bot, telegramId);
    } catch (error) {
      logError("could not deliver vault", error, { bot_id: bot.id, telegram_id: telegramId });
    }
    return;
  }
  try {
    if (bot.groupChatId) {
      await unrestrictMember(bot.token, bot.groupChatId, telegramId);
    }
  } catch (error) {
    logError("could not unlock member in Telegram", error, { bot_id: bot.id, telegram_id: telegramId });
  }
  try {
    await sendMessage(
      bot.token,
      telegramId,
      accessType === "manual_grant"
        ? "✅ <b>Access granted!</b> You now have full access to the group. 🎉"
        : "✅ <b>Payment confirmed!</b> You're in! 🎉\n\nHead back to the group — you now have full access. 🔥",
    );
  } catch (error) {
    logError("could not notify member", error, { bot_id: bot.id, telegram_id: telegramId });
  }
}

/** Put the unpaid restriction back on a member. Never throws. */
export async function removeAccess(bot: BotConfig, telegramId: number): Promise<void> {
  if (!bot.token || !bot.groupChatId) return;
  try {
    await restrictMember(bot.token, bot.groupChatId, telegramId);
  } catch (error) {
    logError("could not restrict member in Telegram", error, { bot_id: bot.id, telegram_id: telegramId });
  }
}

/** Send every vault image to the buyer, in albums of ten. */
export async function deliverVault(env: AppEnv, bot: BotConfig, telegramId: number): Promise<number> {
  const { results } = await env.DB.prepare(
    // rowid keeps the order the images were added in, even within one second.
    "SELECT file_id FROM vault_images WHERE bot_id = ?1 ORDER BY rowid LIMIT ?2",
  )
    .bind(bot.id, MAX_VAULT_IMAGES)
    .all<{ file_id: string }>();

  if (results.length === 0) {
    await sendMessage(
      bot.token,
      telegramId,
      "🖼 The vault is empty right now. Send /vault later to receive the images once they are added.",
    );
    return 0;
  }

  await sendMessage(
    bot.token,
    telegramId,
    `🖼 <b>Vault unlocked!</b> Sending ${results.length} image${results.length === 1 ? "" : "s"}…`,
  );
  for (let i = 0; i < results.length; i += 10) {
    const chunk = results.slice(i, i + 10);
    const first = chunk[0];
    if (chunk.length === 1 && first) {
      await tg(bot.token, "sendPhoto", { chat_id: telegramId, photo: first.file_id, protect_content: true });
    } else {
      await tg(bot.token, "sendMediaGroup", {
        chat_id: telegramId,
        media: chunk.map((img) => ({ type: "photo", media: img.file_id })),
        protect_content: true,
      });
    }
  }
  return results.length;
}
