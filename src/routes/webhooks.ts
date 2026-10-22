/**
 * Payment-provider webhooks. Each one:
 *   1. verifies the provider's signature against the raw request body,
 *   2. checks the order belongs to this bot and the amount paid is the price,
 *   3. confirms the payment exactly once, then unlocks the buyer in Telegram.
 *
 * A request that fails verification never changes anything.
 */

import { Hono } from "hono";
import { loadBot, type PaymentRow } from "../db";
import { HttpError, log, type AppContext, type Ctx } from "../lib/http";
import { alertCreator } from "../alerts";
import { applyFeeLimit } from "../billing";
import { confirmPayment, deliverAccess, findPayment, findPaymentByInvoice } from "../payments";
import * as btcpay from "../providers/btcpay";
import * as nowpayments from "../providers/nowpayments";
import * as paystack from "../providers/paystack";

export const webhooks = new Hono<AppContext>();

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Body is not valid JSON.");
}

/** Small tolerance for floating-point prices such as 9.99. */
const paidAtLeast = (paid: number, price: number): boolean => Number.isFinite(paid) && paid + 0.001 >= price;

async function settle(c: Ctx, payment: PaymentRow, bot: NonNullable<Awaited<ReturnType<typeof loadBot>>>): Promise<void> {
  if (await confirmPayment(c.env, payment)) {
    // Telegram calls happen after the response so the provider isn't kept waiting.
    c.executionCtx.waitUntil(deliverAccess(c.env, bot, payment.telegram_id, payment.access_type, payment.coins));
    c.executionCtx.waitUntil(applyFeeLimit(c.env, bot).catch(() => null));
  }
}

/**
 * A payment notification with a bad signature is usually a wrong secret,
 * which means real buyers pay and never get access. Tell the creator.
 */
function badSignature(c: Ctx, bot: NonNullable<Awaited<ReturnType<typeof loadBot>>>, provider: string, check: string): void {
  log("webhook signature rejected", { bot_id: bot.id, provider });
  c.executionCtx.waitUntil(
    alertCreator(
      c.env,
      bot,
      `signature-${provider}`,
      `A ${provider} payment notification was rejected because its signature didn't match. If buyers say they paid but didn't get access, check ${check}.`,
    ),
  );
}

// ── Paystack ─────────────────────────────────────────────────────────────────

export async function paystackWebhook(c: Ctx, botId: string): Promise<Response> {
  const raw = await c.req.text();
  const bot = await loadBot(c.env, botId);
  if (!bot?.paystack) throw new HttpError(404, "Bot not found");

  const signature = c.req.header("x-paystack-signature") ?? "";
  if (!(await paystack.verifySignature(bot.paystack.secretKey, raw, signature))) {
    badSignature(c, bot, "Paystack", "your Paystack secret key and that the webhook URL in Paystack belongs to this bot");
    throw new HttpError(400, "Invalid signature");
  }

  const body = parseBody(raw);
  if (body.event === "charge.success") {
    const reference = String((body.data as { reference?: unknown } | undefined)?.reference ?? "");
    const payment = reference ? await findPayment(c.env, reference) : null;

    if (payment && payment.bot_id === bot.id && payment.provider === "paystack" && payment.status === "pending") {
      // Double-check with Paystack's API rather than trusting the webhook body.
      const txn = await paystack.verifyTransaction(bot.paystack.secretKey, reference);
      const expected = payment.charge_amount_minor;
      const paid =
        txn.status === "success" &&
        expected !== null &&
        txn.amount >= expected &&
        String(txn.currency).toUpperCase() === payment.charge_currency;
      if (paid) {
        await settle(c, payment, bot);
      } else {
        log("paystack payment did not match the order", {
          order_id: reference,
          status: txn.status,
          paid_minor: txn.amount,
          expected_minor: expected,
          currency: txn.currency,
        });
      }
    }
  }
  return c.json({ ok: true });
}

// ── NOWPayments ──────────────────────────────────────────────────────────────

export async function nowpaymentsWebhook(c: Ctx, botId: string): Promise<Response> {
  const raw = await c.req.text();
  const bot = await loadBot(c.env, botId);
  if (!bot?.nowpayments) throw new HttpError(404, "Bot not found");
  if (!bot.nowpayments.ipnSecret) throw new HttpError(400, "IPN secret is not configured for this bot");

  const signature = c.req.header("x-nowpayments-sig") ?? "";
  if (!(await nowpayments.verifySignature(bot.nowpayments.ipnSecret, raw, signature))) {
    badSignature(c, bot, "NOWPayments", "the IPN secret matches the one in NOWPayments → Settings → IPN");
    throw new HttpError(400, "Invalid signature");
  }

  const body = parseBody(raw);
  if (nowpayments.CONFIRMED_STATUSES.has(String(body.payment_status ?? ""))) {
    const orderId = String(body.order_id ?? "");
    const payment = orderId ? await findPayment(c.env, orderId) : null;

    if (payment && payment.bot_id === bot.id && payment.provider === "nowpayments" && payment.status === "pending") {
      const priceOk =
        paidAtLeast(Number(body.price_amount), payment.gross_amount) &&
        String(body.price_currency ?? "").toLowerCase() === "usd";
      if (priceOk) {
        await settle(c, payment, bot);
      } else {
        log("nowpayments payment did not match the order", {
          order_id: orderId,
          price_amount: body.price_amount,
          price_currency: body.price_currency,
          expected_usd: payment.gross_amount,
        });
      }
    }
  }
  return c.json({ ok: true });
}

// ── BTCPay Server ────────────────────────────────────────────────────────────

export async function btcpayWebhook(c: Ctx, botId: string): Promise<Response> {
  const raw = await c.req.text();
  const bot = await loadBot(c.env, botId);
  if (!bot?.btcpay) throw new HttpError(404, "Bot not found");
  if (!bot.btcpay.webhookSecret) throw new HttpError(400, "Webhook secret is not configured for this bot");

  const signature = c.req.header("btcpay-sig") ?? "";
  if (!(await btcpay.verifySignature(bot.btcpay.webhookSecret, raw, signature))) {
    badSignature(c, bot, "BTCPay", "the webhook secret matches the one in your BTCPay store's webhook settings");
    throw new HttpError(400, "Invalid signature");
  }

  const body = parseBody(raw);
  const event = String(body.type ?? "");
  const accepted = (status: string): boolean =>
    status === "Settled" || (status === "Processing" && bot.btcpayAcceptUnconfirmed);

  if (event === "InvoiceSettled" || (event === "InvoiceProcessing" && bot.btcpayAcceptUnconfirmed)) {
    const invoiceId = String(body.invoiceId ?? "");
    const payment = invoiceId ? await findPaymentByInvoice(c.env, "btcpay", invoiceId) : null;

    if (payment && payment.bot_id === bot.id && payment.status === "pending") {
      // Read the invoice back from the server: it is the source of truth for
      // status, amount and which order it belongs to.
      const invoice = await btcpay.getInvoice(bot.btcpay, invoiceId);
      const matches =
        accepted(invoice.status) &&
        paidAtLeast(Number(invoice.amount), payment.gross_amount) &&
        String(invoice.currency).toUpperCase() === "USD" &&
        (invoice.metadata?.orderId === undefined || invoice.metadata.orderId === payment.provider_ref);
      if (matches) {
        await settle(c, payment, bot);
      } else {
        log("btcpay invoice did not match the order", {
          order_id: payment.provider_ref,
          invoice_status: invoice.status,
          invoice_amount: invoice.amount,
          invoice_currency: invoice.currency,
        });
      }
    }
  }
  return c.json({ ok: true });
}

webhooks.post("/paystack/:botId", (c) => paystackWebhook(c, c.req.param("botId")));
webhooks.post("/nowpayments/:botId", (c) => nowpaymentsWebhook(c, c.req.param("botId")));
webhooks.post("/btcpay/:botId", (c) => btcpayWebhook(c, c.req.param("botId")));
