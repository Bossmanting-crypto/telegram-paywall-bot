/**
 * Paystack — cards, M-Pesa / mobile money, bank.
 * Docs: https://paystack.com/docs/api/
 */

import { hmacHex, safeEqual } from "../lib/crypto";
import { ProviderError } from "../lib/http";

const API = "https://api.paystack.co";

interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

async function call<T>(secretKey: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as PaystackEnvelope<T> | null;
  if (!res.ok || !json?.status || json.data === undefined) {
    throw new ProviderError("paystack", res.status, json?.message ?? `HTTP ${res.status}`);
  }
  return json.data;
}

/** Convert a USD price to the charge currency's smallest unit (cents, kobo…). */
export function toMinorUnits(amountUsd: number, fxRate: number): number {
  return Math.round(amountUsd * fxRate * 100);
}

export interface InitializeParams {
  email: string;
  amountMinor: number;
  currency: string;
  reference: string;
  callbackUrl: string;
  cancelUrl: string;
  description: string;
  channels: string[] | null;
  /** Optional split: `subaccount` receives everything except `mainAccountShareMinor`. */
  split?: { subaccount: string; mainAccountShareMinor: number } | null;
}

export async function initializeTransaction(
  secretKey: string,
  p: InitializeParams,
): Promise<{ reference: string; paymentUrl: string }> {
  const payload: Record<string, unknown> = {
    email: p.email,
    amount: p.amountMinor,
    currency: p.currency,
    reference: p.reference,
    // Where the buyer's browser lands after paying (a page, not the webhook).
    callback_url: p.callbackUrl,
    metadata: {
      order_id: p.reference,
      description: p.description,
      cancel_action: p.cancelUrl,
    },
  };
  if (p.channels?.length) payload.channels = p.channels;
  if (p.split) {
    payload.subaccount = p.split.subaccount;
    payload.transaction_charge = p.split.mainAccountShareMinor;
    payload.bearer = "account";
  }
  const data = await call<{ reference: string; authorization_url: string }>(
    secretKey,
    "POST",
    "/transaction/initialize",
    payload,
  );
  return { reference: data.reference, paymentUrl: data.authorization_url };
}

export interface VerifiedTransaction {
  status: string;
  amount: number;
  currency: string;
  reference: string;
}

/** Ask Paystack directly whether a reference was paid — never trust the webhook alone. */
export function verifyTransaction(secretKey: string, reference: string): Promise<VerifiedTransaction> {
  return call<VerifiedTransaction>(secretKey, "GET", `/transaction/verify/${encodeURIComponent(reference)}`);
}

/** Paystack signs webhooks with HMAC-SHA512 of the raw body, keyed by the secret key. */
export async function verifySignature(secretKey: string, rawBody: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const expected = await hmacHex("SHA-512", secretKey, rawBody);
  return safeEqual(expected, signature.trim().toLowerCase());
}

/** Cheap authenticated call used to confirm a secret key is accepted. */
export async function checkSecretKey(secretKey: string): Promise<{ currencies: string[] }> {
  const balances = await call<Array<{ currency: string }>>(secretKey, "GET", "/balance");
  return { currencies: Array.isArray(balances) ? balances.map((b) => b.currency) : [] };
}

export function keyMode(key: string | null | undefined): "live" | "test" | "unknown" {
  if (!key) return "unknown";
  if (/^(sk|pk)_live_/.test(key)) return "live";
  if (/^(sk|pk)_test_/.test(key)) return "test";
  return "unknown";
}
