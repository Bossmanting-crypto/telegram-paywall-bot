/**
 * BTCPay Server — Bitcoin on-chain and Lightning (Greenfield API).
 * Docs: https://docs.btcpayserver.org/API/Greenfield/v1/
 */

import { hmacHex, safeEqual } from "../lib/crypto";
import { ProviderError } from "../lib/http";

export interface BtcpayConfig {
  url: string;
  storeId: string;
  apiKey: string;
}

async function call<T>(cfg: BtcpayConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.url}/api/v1/stores/${encodeURIComponent(cfg.storeId)}${path}`, {
    method,
    headers: { authorization: `token ${cfg.apiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || json === null) {
    throw new ProviderError("btcpay", res.status, json?.message ?? `HTTP ${res.status}`);
  }
  return json;
}

export interface BtcpayInvoice {
  id: string;
  status: "New" | "Processing" | "Expired" | "Invalid" | "Settled" | string;
  amount: string;
  currency: string;
  checkoutLink?: string;
  metadata?: { orderId?: string };
}

export async function createInvoice(
  cfg: BtcpayConfig,
  p: { amountUsd: number; orderId: string; description: string; redirectUrl: string },
): Promise<{ invoiceId: string; paymentUrl: string }> {
  const data = await call<BtcpayInvoice>(cfg, "POST", "/invoices", {
    amount: String(p.amountUsd),
    currency: "USD",
    metadata: { orderId: p.orderId, itemDesc: p.description },
    checkout: { redirectURL: p.redirectUrl, redirectAutomatically: true },
  });
  if (!data.checkoutLink) throw new ProviderError("btcpay", 502, "No checkout link in response");
  return { invoiceId: data.id, paymentUrl: data.checkoutLink };
}

export function getInvoice(cfg: BtcpayConfig, invoiceId: string): Promise<BtcpayInvoice> {
  return call<BtcpayInvoice>(cfg, "GET", `/invoices/${encodeURIComponent(invoiceId)}`);
}

/** BTCPay sends `BTCPay-Sig: sha256=<hex>` — HMAC-SHA256 of the raw body. */
export async function verifySignature(webhookSecret: string, rawBody: string, header: string): Promise<boolean> {
  if (!header) return false;
  const received = header.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = await hmacHex("SHA-256", webhookSecret, rawBody);
  return safeEqual(expected, received);
}

/** Confirms the URL, store ID and API key work together. */
export async function checkStore(cfg: BtcpayConfig): Promise<{ name: string | null }> {
  const store = await call<{ name?: string }>(cfg, "GET", "");
  return { name: store.name ?? null };
}

/** Only https URLs on public hostnames are accepted for creator-supplied servers. */
export function isAcceptableServerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false; // IP literals
  return true;
}
