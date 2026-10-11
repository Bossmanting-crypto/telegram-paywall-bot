/**
 * NOWPayments — hosted crypto invoices.
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt
 */

import { hmacHex, safeEqual } from "../lib/crypto";
import { ProviderError } from "../lib/http";

const API = "https://api.nowpayments.io/v1";

/**
 * Statuses that mean the invoice was paid in full.
 * `partially_paid` is deliberately excluded: accepting it would let someone
 * unlock access by sending a fraction of the price.
 */
export const CONFIRMED_STATUSES = new Set(["finished", "confirmed", "sending"]);

async function call<T>(apiKey: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || json === null) {
    throw new ProviderError("nowpayments", res.status, json?.message ?? `HTTP ${res.status}`);
  }
  return json;
}

export interface InvoiceParams {
  amountUsd: number;
  orderId: string;
  description: string;
  ipnCallbackUrl: string;
  successUrl: string;
  cancelUrl: string;
}

export async function createInvoice(
  apiKey: string,
  p: InvoiceParams,
): Promise<{ invoiceId: string; paymentUrl: string }> {
  const data = await call<{ id: string | number; invoice_url: string }>(apiKey, "POST", "/invoice", {
    price_amount: p.amountUsd,
    price_currency: "usd",
    order_id: p.orderId,
    order_description: p.description,
    ipn_callback_url: p.ipnCallbackUrl,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    is_fixed_rate: true,
    is_fee_paid_by_user: false,
  });
  if (!data.invoice_url) throw new ProviderError("nowpayments", 502, "No invoice URL in response");
  return { invoiceId: String(data.id), paymentUrl: data.invoice_url };
}

/** Recursively sort object keys, exactly as NOWPayments' reference implementation does. */
function sortObject(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortObject(source[key]);
  return sorted;
}

/**
 * IPN signature: HMAC-SHA512 over the JSON body re-serialised with sorted
 * keys and no whitespace (JSON.stringify), keyed by the IPN secret.
 */
export async function verifySignature(ipnSecret: string, rawBody: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const expected = await hmacHex("SHA-512", ipnSecret, JSON.stringify(sortObject(parsed)));
  return safeEqual(expected, signature.trim().toLowerCase());
}

/** Authenticated call used to confirm an API key is accepted. */
export async function checkApiKey(apiKey: string): Promise<void> {
  await call<unknown>(apiKey, "GET", "/currencies");
}
