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
  type PaymentKind,
  type PaymentRow,
  type Provider,
} from "./db";
import { balance, coinPurchaseStatements, sendContent, type ContentItem } from "./coins";
import { newId, randomHex } from "./lib/crypto";
import { HttpError, log, logError, round2 } from "./lib/http";
import * as btcpay from "./providers/btcpay";
import * as nowpayments from "./providers/nowpayments";
import * as paystack from "./providers/paystack";
import { restrictMember, sendMessage, tg, TelegramError, unrestrictMember, type InlineKeyboard } from "./telegram";

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
  accessType: PaymentKind;
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

  return startPayment(env, bot, {
    telegramId: opts.telegramId,
    kind: opts.accessType,
    amount,
    coins: null,
    description: `${bot.welcomeTitle} — ${ACCESS_LABEL[opts.accessType]}`,
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    email: opts.email,
  });
}

/** Payment link for coin pack number `packIndex` (0-based). */
export async function createCoinPayment(
  env: AppEnv,
  bot: BotConfig,
  opts: { telegramId: number; packIndex: number; provider: Provider; baseUrl: string },
): Promise<CreatedPayment & { coins: number }> {
  if (!botIsSelling(bot)) {
    throw new HttpError(409, "This bot is not accepting payments right now.");
  }
  if (!bot.coins.enabled) throw new HttpError(400, "Coins are not turned on for this bot.");
  const pack = bot.coins.packs[opts.packIndex];
  if (!pack) throw new HttpError(400, "That coin pack doesn't exist.");
  if (!availableProviders(bot).includes(opts.provider)) {
    throw new HttpError(400, `Provider '${opts.provider}' not configured for this bot.`);
  }
  const created = await startPayment(env, bot, {
    telegramId: opts.telegramId,
    kind: "coin_pack",
    amount: pack.price,
    coins: pack.coins,
    description: `${bot.welcomeTitle} — ${pack.coins} coins`,
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    email: null,
  });
  return { ...created, coins: pack.coins };
}

async function startPayment(
  env: AppEnv,
  bot: BotConfig,
  opts: {
    telegramId: number;
    kind: PaymentKind;
    amount: number;
    coins: number | null;
    description: string;
    provider: Provider;
    baseUrl: string;
    email?: string | null;
  },
): Promise<CreatedPayment> {
  const amount = opts.amount;
  const platformFee = round2(amount * bot.platformCut);
  const net = round2(amount - platformFee);
  // Paystack references may only contain letters, digits, "-", "." and "=".
  const orderId = `${opts.telegramId}-${randomHex(6)}`;
  const description = opts.description;
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
        charge_amount_minor, charge_currency, status, created_at, coins)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'USD', ?11, ?12, 'pending', ?13, ?14)`,
  )
    .bind(
      paymentId,
      bot.tenantId,
      bot.id,
      opts.telegramId,
      opts.provider,
      orderId,
      opts.kind,
      amount,
      platformFee,
      net,
      chargeMinor,
      chargeCurrency,
      now(),
      opts.coins,
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
    accessType: opts.kind,
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
    payment.access_type === "coin_pack"
      ? coinPurchaseStatements(env, payment)
      : payment.access_type === "image_unlock"
        ? [vaultUnlockStatement(env, payment.bot_id, payment.telegram_id, payment.id)]
        : [memberGrantStatement(env, payment.bot_id, payment.telegram_id, payment.access_type, payment.id)];

  const results = await env.DB.batch([
    ...grant,
    env.DB.prepare(
      "UPDATE payments SET status = 'confirmed', confirmed_at = ?1 WHERE id = ?2 AND status = 'pending'",
    ).bind(now(), payment.id),
  ]);
  const confirmed = (results[grant.length]?.meta.changes ?? 0) === 1;
  if (confirmed) {
    log("payment confirmed", {
      order_id: payment.provider_ref,
      provider: payment.provider,
      bot_id: payment.bot_id,
      telegram_id: payment.telegram_id,
      access_type: payment.access_type,
      ...(payment.coins ? { coins: payment.coins } : {}),
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
  accessType: PaymentKind | "manual_grant",
  coins: number | null = null,
): Promise<void> {
  if (!bot.token) return;
  if (accessType === "coin_pack") {
    try {
      const left = await balance(env, bot.id, telegramId);
      await sendMessage(
        bot.token,
        telegramId,
        `🪙 <b>Payment confirmed!</b> ${coins ?? 0} coins added.\n\nYour balance: <b>${left} coins</b>.`,
        { reply_markup: { inline_keyboard: [[{ text: "📸 Browse content", callback_data: "c:0" }]] } },
      );
    } catch (error) {
      logError("could not notify coin buyer", error, { bot_id: bot.id, telegram_id: telegramId });
    }
    return;
  }
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
    // Expected in approve mode when the buyer isn't in the group yet.
    if (bot.joinMode !== "approve") {
      logError("could not unlock member in Telegram", error, { bot_id: bot.id, telegram_id: telegramId });
    }
  }

  let text =
    accessType === "manual_grant"
      ? "✅ <b>Access granted!</b> You now have full access to the group. 🎉"
      : "✅ <b>Payment confirmed!</b> You're in! 🎉\n\nHead back to the group — you now have full access. 🔥";
  let keyboard: InlineKeyboard | undefined;
  if (bot.joinMode === "approve" && bot.groupChatId) {
    const admitted = await admitToGroup(bot, telegramId);
    if (admitted.approved) {
      text = `${accessType === "manual_grant" ? "✅ <b>Access granted!</b>" : "✅ <b>Payment confirmed!</b>"} Your request to join was approved. Open the group from your chat list. 🎉`;
    } else if (admitted.inviteLink) {
      text = `${accessType === "manual_grant" ? "✅ <b>Access granted!</b>" : "✅ <b>Payment confirmed!</b>"} Tap below to join the group. The link works once, for you only. 🎉`;
      keyboard = { inline_keyboard: [[{ text: "🚪 Join the group", url: admitted.inviteLink }]] };
    }
  }
  try {
    await sendMessage(bot.token, telegramId, text, keyboard ? { reply_markup: keyboard } : {});
  } catch (error) {
    logError("could not notify member", error, { bot_id: bot.id, telegram_id: telegramId });
  }
}

/**
 * Approve mode: let a paying member into the group. Approves their pending
 * join request if there is one; otherwise creates a single-use invite link
 * that expires in a day. Never throws.
 */
export async function admitToGroup(
  bot: BotConfig,
  telegramId: number,
): Promise<{ approved: boolean; inviteLink: string | null }> {
  if (!bot.token || !bot.groupChatId) return { approved: false, inviteLink: null };
  try {
    await tg(bot.token, "approveChatJoinRequest", { chat_id: bot.groupChatId, user_id: telegramId });
    return { approved: true, inviteLink: null };
  } catch (error) {
    if (!(error instanceof TelegramError)) {
      logError("could not approve join request", error, { bot_id: bot.id, telegram_id: telegramId });
    }
    // No pending request (or already a member): fall through to a link.
  }
  try {
    const link = await tg<{ invite_link: string }>(bot.token, "createChatInviteLink", {
      chat_id: bot.groupChatId,
      name: `Paid ${telegramId}`.slice(0, 32),
      member_limit: 1,
      expire_date: now() + 86400,
    });
    return { approved: false, inviteLink: link.invite_link };
  } catch (error) {
    logError("could not create invite link", error, { bot_id: bot.id, telegram_id: telegramId });
    return { approved: false, inviteLink: null };
  }
}

/**
 * Take group access away. Mute mode: put the unpaid restriction back.
 * Approve mode: remove them from the group (ban, then unban straight away so
 * they can ask to join again after renewing). Never throws.
 */
export async function removeAccess(bot: BotConfig, telegramId: number): Promise<void> {
  if (!bot.token || !bot.groupChatId) return;
  try {
    if (bot.joinMode === "approve") {
      await tg(bot.token, "banChatMember", { chat_id: bot.groupChatId, user_id: telegramId });
      await tg(bot.token, "unbanChatMember", { chat_id: bot.groupChatId, user_id: telegramId, only_if_banned: true });
    } else {
      await restrictMember(bot.token, bot.groupChatId, telegramId);
    }
  } catch (error) {
    logError("could not remove member access in Telegram", error, { bot_id: bot.id, telegram_id: telegramId });
  }
}

/** Send every vault item to the buyer: photos and videos in albums of ten, the rest one by one. */
export async function deliverVault(env: AppEnv, bot: BotConfig, telegramId: number): Promise<number> {
  const { results: all } = await env.DB.prepare(
    // rowid keeps the order the items were added in, even within one second.
    "SELECT id, file_id, kind, caption FROM vault_images WHERE bot_id = ?1 ORDER BY rowid LIMIT ?2",
  )
    .bind(bot.id, MAX_VAULT_IMAGES)
    .all<ContentItem>();
  const results = all.filter((item) => item.kind === "photo" || item.kind === "video" || !item.kind);
  const singles = all.filter((item) => item.kind === "animation" || item.kind === "document");

  if (all.length === 0) {
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
    `🖼 <b>Vault unlocked!</b> Sending ${all.length} item${all.length === 1 ? "" : "s"}…`,
  );
  for (let i = 0; i < results.length; i += 10) {
    const chunk = results.slice(i, i + 10);
    const first = chunk[0];
    if (chunk.length === 1 && first) {
      await sendContent(bot, telegramId, first, null);
    } else {
      await tg(bot.token, "sendMediaGroup", {
        chat_id: telegramId,
        media: chunk.map((item) => ({ type: item.kind === "video" ? "video" : "photo", media: item.file_id })),
        protect_content: true,
      });
    }
  }
  for (const item of singles) {
    await sendContent(bot, telegramId, item, null);
  }
  return all.length;
}
