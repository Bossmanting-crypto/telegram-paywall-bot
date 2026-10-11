/** /api/v1/payments — create payment links and look up orders. */

import { Hono } from "hono";
import { ACCESS_TYPES, PROVIDERS, iso, loadTenantBot, type AccessType, type PaymentRow, type Provider } from "../db";
import { HttpError, baseUrl, optNumber, optString, readJson, reqString, type AppContext } from "../lib/http";
import { createPayment } from "../payments";
import { requireTenant } from "./auth";

export const payments = new Hono<AppContext>();
payments.use("*", requireTenant);

/**
 * Generate a payment link for one Telegram user. The bot does this itself
 * when someone taps a button; this endpoint is for doing it manually.
 */
payments.post("/generate-link", async (c) => {
  const tenant = c.get("tenant");
  const body = await readJson(c);

  const botId = reqString(body, "bot_id", 64);
  const telegramId = optNumber(body, "telegram_id", { integer: true, min: 1 });
  if (telegramId === undefined) throw new HttpError(422, "'telegram_id' is required.");

  const accessType = reqString(body, "access_type", 32) as AccessType;
  if (!ACCESS_TYPES.includes(accessType)) {
    throw new HttpError(400, "Invalid access_type. Use one_time, monthly, or image_unlock.");
  }
  const provider = reqString(body, "provider", 32) as Provider;
  if (!PROVIDERS.includes(provider)) {
    throw new HttpError(400, "Invalid provider. Use paystack, nowpayments, or btcpay.");
  }
  const email = optString(body, "user_email", 256);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(422, "'user_email' is not a valid email address.");
  }

  const bot = await loadTenantBot(c.env, botId, tenant.id);
  const payment = await createPayment(c.env, bot, {
    telegramId,
    accessType,
    provider,
    baseUrl: baseUrl(c),
    email,
  });

  return c.json({
    payment_url: payment.paymentUrl,
    order_id: payment.orderId,
    amount: payment.amount,
    currency: "USD",
    platform_fee: payment.platformFee,
    net_to_creator: payment.net,
  });
});

payments.get("/:orderId", async (c) => {
  const p = await c.env.DB.prepare("SELECT * FROM payments WHERE provider_ref = ?1 AND tenant_id = ?2")
    .bind(c.req.param("orderId"), c.get("tenant").id)
    .first<PaymentRow>();
  if (!p) throw new HttpError(404, "Payment not found.");
  return c.json({
    order_id: p.provider_ref,
    bot_id: p.bot_id,
    telegram_id: p.telegram_id,
    status: p.status,
    provider: p.provider,
    access_type: p.access_type,
    gross: p.gross_amount,
    platform_fee: p.platform_fee,
    net: p.net_amount,
    currency: p.currency,
    created_at: iso(p.created_at),
    confirmed_at: iso(p.confirmed_at),
  });
});
