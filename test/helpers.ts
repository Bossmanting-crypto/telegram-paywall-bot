/**
 * Test harness: calls the app directly inside the Workers runtime and replaces
 * `fetch` with a fake Telegram / Paystack / NOWPayments / BTCPay, recording
 * every outbound request so tests can assert on what the Worker tried to do.
 */

import { createExecutionContext, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import { app } from "../src/app";
import type { AppEnv, Settings } from "../src/env";
import { ensureReady, forgetSchemaCheck } from "../src/schema";

export const env = testEnv as unknown as AppEnv;

/** The test environment with some settings changed or removed (undefined). */
export function envWith(overrides: { [K in keyof Settings]?: string | undefined }): AppEnv {
  return { ...env, ...overrides } as AppEnv;
}
export const BASE = "https://paywall.test";
export const ADMIN_KEY = "test-admin-key-0123456789abcdef";
export const OWNER_TOKEN = "111111111:AAownerTokenAbcdefghijklmnopqrstuvwxyz";
export const OWNER_GROUP = -1001111111111;
export const OWNER_ADMIN = 42;

export interface OutboundCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  /** For Telegram calls: the bot token and API method. */
  tgToken?: string;
  tgMethod?: string;
}

type Reply = { status?: number; json: unknown };
type Responder = (call: OutboundCall) => Reply | undefined;

export interface Mock {
  calls: OutboundCall[];
  /** Telegram calls, optionally filtered by method. */
  tg(method?: string): OutboundCall[];
  /** Override responses. Return undefined to fall through to the defaults. */
  on(responder: Responder): void;
}

let messageId = 1000;

function defaults(call: OutboundCall): Reply {
  if (call.tgMethod) {
    const botId = Number(call.tgToken?.split(":")[0]);
    switch (call.tgMethod) {
      case "getMe":
        return { json: { ok: true, result: { id: botId, is_bot: true, username: `bot${botId}` } } };
      case "sendMessage":
        return { json: { ok: true, result: { message_id: ++messageId, chat: { id: call.body?.chat_id } } } };
      case "getWebhookInfo":
        return { json: { ok: true, result: { url: "", pending_update_count: 0 } } };
      case "getChat":
        return { json: { ok: true, result: { id: call.body?.chat_id, title: "VIP Group" } } };
      case "getChatMember":
        return { json: { ok: true, result: { status: "administrator", can_restrict_members: true, user: { id: botId } } } };
      default:
        return { json: { ok: true, result: true } };
    }
  }
  const { url, method, body } = call;
  if (url === "https://api.paystack.co/transaction/initialize") {
    return {
      json: {
        status: true,
        data: {
          authorization_url: `https://checkout.paystack.com/${body?.reference}`,
          access_code: "ac_1",
          reference: body?.reference,
        },
      },
    };
  }
  if (url === "https://api.paystack.co/balance") {
    return { json: { status: true, data: [{ currency: "KES", balance: 0 }] } };
  }
  if (url === "https://api.nowpayments.io/v1/invoice") {
    return { json: { id: 555001, invoice_url: `https://nowpayments.io/payment/?iid=555001&o=${body?.order_id}` } };
  }
  if (url === "https://api.nowpayments.io/v1/currencies") {
    return { json: { currencies: ["btc", "eth"] } };
  }
  if (/\/api\/v1\/stores\/[^/]+\/invoices$/.test(url) && method === "POST") {
    return { json: { id: "inv_btc_1", checkoutLink: "https://btcpay.example.com/i/inv_btc_1", status: "New" } };
  }
  if (/\/api\/v1\/stores\/[^/]+$/.test(url)) {
    return { json: { id: "store", name: "My Store" } };
  }
  return { status: 404, json: { message: `unmocked request: ${method} ${url}` } };
}

export function mockFetch(): Mock {
  const calls: OutboundCall[] = [];
  const responders: Responder[] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const call: OutboundCall = {
      url: request.url,
      method: request.method,
      body,
      headers: Object.fromEntries(request.headers),
    };
    const tgMatch = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(request.url);
    if (tgMatch) {
      call.tgToken = tgMatch[1];
      call.tgMethod = tgMatch[2];
    }
    calls.push(call);

    let reply: Reply | undefined;
    for (const responder of responders) {
      reply = responder(call);
      if (reply) break;
    }
    reply ??= defaults(call);
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  return {
    calls,
    tg: (method) => calls.filter((c) => c.tgMethod && (!method || c.tgMethod === method)),
    on: (responder) => {
      responders.unshift(responder);
    },
  };
}

/** Wipe all data and re-create the built-in owner rows. */
export async function resetDatabase(): Promise<void> {
  await ensureReady(env);
  await env.DB.batch(
    ["broadcasts", "coin_ledger", "content_unlocks", "vault_images", "payments", "members", "bots", "tenants"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
  forgetSchemaCheck();
  await ensureReady(env);
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

/** Call the Worker's HTTP app and wait for any background work to finish. */
export async function call<T = any>(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; json?: unknown; raw?: string; env?: AppEnv } = {},
): Promise<ApiResponse<T>> {
  const headers = new Headers(opts.headers);
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers.set("content-type", "application/json");
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${BASE}${path}`, { method, headers, body }), opts.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed as T, text, headers: res.headers };
}

export const asAdmin = { "x-admin-key": ADMIN_KEY };

let counter = 0;

/** Sign up a creator and return their API key. */
export async function signup(name = "Creator"): Promise<{ id: string; apiKey: string; headers: Record<string, string> }> {
  counter++;
  const res = await call("POST", "/api/v1/tenants/signup", {
    json: { email: `creator${counter}-${Date.now()}@example.com`, name },
  });
  if (res.status !== 200) throw new Error(`signup failed: ${res.text}`);
  return { id: res.body.id, apiKey: res.body.api_key, headers: { "x-api-key": res.body.api_key } };
}

export function botToken(n: number): string {
  return `${200000000 + n}:AAtenantToken${String(n).padStart(4, "0")}abcdefghijklmnopqrstu`;
}

/** Register a bot with all three providers configured, linked to a group. */
export async function createBot(
  headers: Record<string, string>,
  n: number,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; token: string; groupId: number; webhookSecret: string }> {
  const token = botToken(n);
  const res = await call("POST", "/api/v1/bots", {
    headers,
    json: {
      bot_token: token,
      one_time_price: 10,
      monthly_price: 5,
      image_unlock_price: 20,
      paystack_secret_key: `sk_test_tenant_${n}`,
      paystack_public_key: `pk_test_tenant_${n}`,
      nowpayments_api_key: `now-key-${n}`,
      nowpayments_ipn_secret: `now-ipn-${n}`,
      btcpay_url: "https://pay.creator.example",
      btcpay_store_id: `store${n}`,
      btcpay_api_key: `btc-key-${n}`,
      btcpay_webhook_secret: `btc-whsec-${n}`,
      ...overrides,
    },
  });
  if (res.status !== 200) throw new Error(`createBot failed: ${res.status} ${res.text}`);
  const groupId = -1002000000000 - n;
  await env.DB.prepare("UPDATE bots SET group_chat_id = ?1 WHERE id = ?2").bind(groupId, res.body.bot_id).run();
  const row = await env.DB.prepare("SELECT webhook_secret FROM bots WHERE id = ?1")
    .bind(res.body.bot_id)
    .first<{ webhook_secret: string }>();
  return { id: res.body.bot_id, token, groupId, webhookSecret: row?.webhook_secret ?? "" };
}

export async function ownerWebhookSecret(): Promise<string> {
  const row = await env.DB.prepare("SELECT webhook_secret FROM bots WHERE id = 'owner'").first<{
    webhook_secret: string;
  }>();
  return row?.webhook_secret ?? "";
}

/** Deliver a Telegram update to a bot's webhook, as Telegram would. */
export function telegramUpdate(botId: string, secret: string, update: Record<string, unknown>): Promise<ApiResponse> {
  return call("POST", `/telegram/${botId}`, {
    headers: { "x-telegram-bot-api-secret-token": secret },
    json: { update_id: ++messageId, ...update },
  });
}

export const user = (id: number, first_name = "Ada") => ({ id, is_bot: false, first_name, username: `user${id}` });

// ── Signatures, computed here rather than with the Worker's own helpers ──────
// (src/lib/crypto.ts is checked separately against published RFC 4231 vectors.)

export async function hmac(hash: "SHA-256" | "SHA-512", key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function paystackSignature(secretKey: string, rawBody: string): Promise<string> {
  return hmac("SHA-512", secretKey, rawBody);
}

/** NOWPayments' documented recipe: sort keys recursively, JSON.stringify, HMAC-SHA512. */
export function nowpaymentsSignature(ipnSecret: string, payload: Record<string, unknown>): Promise<string> {
  const sort = (value: unknown): unknown =>
    value && typeof value === "object"
      ? Object.keys(value as object)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = sort((value as Record<string, unknown>)[key]);
            return acc;
          }, {})
      : value;
  return hmac("SHA-512", ipnSecret, JSON.stringify(sort(payload)));
}

export async function btcpaySignature(webhookSecret: string, rawBody: string): Promise<string> {
  return `sha256=${await hmac("SHA-256", webhookSecret, rawBody)}`;
}

export async function paymentRow(orderId: string): Promise<Record<string, any> | null> {
  return env.DB.prepare("SELECT * FROM payments WHERE provider_ref = ?1").bind(orderId).first();
}

export async function memberRow(botId: string, telegramId: number): Promise<Record<string, any> | null> {
  return env.DB.prepare("SELECT * FROM members WHERE bot_id = ?1 AND telegram_id = ?2")
    .bind(botId, telegramId)
    .first();
}
