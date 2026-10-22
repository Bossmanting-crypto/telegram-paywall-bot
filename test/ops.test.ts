import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { alertOwner } from "../src/alerts";
import { confirmPayment } from "../src/payments";
import type { AppEnv } from "../src/env";
import {
  OWNER_ADMIN,
  asAdmin,
  botToken,
  call,
  createBot,
  env,
  envWith,
  mockFetch,
  paymentRow,
  paystackSignature,
  resetDatabase,
  signup,
  telegramUpdate,
  user,
  type Mock,
} from "./helpers";

let mock: Mock;
beforeEach(async () => {
  mock = mockFetch();
  await resetDatabase();
});

const BUYER = 8801;
const CREATOR_TG = 9901;
const privateChat = (id: number) => ({ id, type: "private" });
const message = (from: number, text: string) => ({ message: { message_id: 1, from: user(from), chat: privateChat(from), text } });

async function tenant(id: string): Promise<Record<string, any>> {
  return (await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(id).first())!;
}

/** A buyer pays a creator's bot by Paystack; returns the order ID. */
async function creatorSale(headers: Record<string, string>, botId: string, n: number, environment: AppEnv = env, buyer = BUYER): Promise<string> {
  const link = await call("POST", "/api/v1/payments/generate-link", {
    headers,
    json: { bot_id: botId, telegram_id: buyer, access_type: "one_time", provider: "paystack" },
  });
  expect(link.status, link.text).toBe(200);
  const orderId = link.body.order_id as string;
  const row = await paymentRow(orderId);
  mock.on((c) =>
    c.url === `https://api.paystack.co/transaction/verify/${orderId}`
      ? { json: { status: true, data: { reference: orderId, status: "success", amount: row?.charge_amount_minor, currency: row?.charge_currency } } }
      : undefined,
  );
  const raw = JSON.stringify({ event: "charge.success", data: { reference: orderId } });
  const res = await call("POST", `/webhooks/paystack/${botId}`, {
    raw,
    headers: { "x-paystack-signature": await paystackSignature(`sk_test_tenant_${n}`, raw) },
    env: environment,
  });
  expect(res.status).toBe(200);
  return orderId;
}

/** Confirm a payment made to the owner (fees or a plan). */
async function ownerPaid(orderId: string, environment: AppEnv = env) {
  const row = await paymentRow(orderId);
  mock.on((c) =>
    c.url === `https://api.paystack.co/transaction/verify/${orderId}`
      ? { json: { status: true, data: { reference: orderId, status: "success", amount: row?.charge_amount_minor, currency: row?.charge_currency } } }
      : undefined,
  );
  const raw = JSON.stringify({ event: "charge.success", data: { reference: orderId } });
  const res = await call("POST", "/webhooks/paystack/owner", {
    raw,
    headers: { "x-paystack-signature": await paystackSignature("sk_test_owner_paystack_secret", raw) },
    env: environment,
  });
  expect(res.status).toBe(200);
}

async function runCron(at: number, environment: AppEnv = env): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: at, cron: "* * * * *" }), environment, ctx);
  await waitOnExecutionContext(ctx);
}

// ── Signup ───────────────────────────────────────────────────────────────────

describe("signup for people and bots", () => {
  const signupFrom = (ip: string, n: number, environment: AppEnv = env) =>
    call("POST", "/api/v1/tenants/signup", {
      headers: { "cf-connecting-ip": ip },
      json: { name: `Agent ${n}`, email: `agent${n}-${ip}@bots.example` },
      env: environment,
    });

  it("lets many accounts sign up, but caps one network address at 20 an hour", async () => {
    for (let i = 0; i < 20; i++) expect((await signupFrom("203.0.113.5", i)).status).toBe(200);
    const blocked = await signupFrom("203.0.113.5", 99);
    expect(blocked.status).toBe(429);
    expect(blocked.body.detail).toContain("Too many signups");
    expect((await signupFrom("198.51.100.7", 1)).status).toBe(200);
    // The IP itself is never stored, only a hash.
    const stored = await env.DB.prepare("SELECT signup_ip_hash FROM tenants WHERE signup_ip_hash IS NOT NULL LIMIT 1").first<{ signup_ip_hash: string }>();
    expect(stored?.signup_ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("can have the cap changed or turned off", async () => {
    const open = envWith({ SIGNUP_LIMIT_PER_HOUR: "0" });
    for (let i = 0; i < 22; i++) expect((await signupFrom("203.0.113.9", i, open)).status).toBe(200);
    const strict = envWith({ SIGNUP_LIMIT_PER_HOUR: "1" });
    expect((await signupFrom("192.0.2.1", 1, strict)).status).toBe(200);
    expect((await signupFrom("192.0.2.1", 2, strict)).status).toBe(429);
  });

  it("returns next steps an agent can follow, and records a recovery Telegram ID", async () => {
    const res = await call("POST", "/api/v1/tenants/signup", { json: { name: "Bot Co", email: "bot@co.example", telegram_id: CREATOR_TG } });
    expect(res.body.next_steps).toHaveLength(3);
    expect(res.body.recovery_telegram_id).toBe(CREATOR_TG);
    expect((await tenant(res.body.id)).recovery_telegram_id).toBe(CREATOR_TG);
  });

  it("publishes a guide and an API description for agents", async () => {
    const guide = await call("GET", "/llms.txt");
    expect(guide.status).toBe(200);
    expect(guide.headers.get("content-type")).toContain("text/plain");
    expect(guide.text).toContain("POST https://paywall.test/api/v1/tenants/signup");
    expect(guide.text).toContain("/mcp");

    const spec = await call("GET", "/openapi.json");
    expect(spec.body.openapi).toBe("3.1.0");
    expect(spec.body.servers[0].url).toBe("https://paywall.test");
    // Every path in the description exists (unauthenticated calls are refused, never "not found").
    for (const [path, ops] of Object.entries(spec.body.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(ops).filter((m) => ["get", "post", "patch", "delete"].includes(m))) {
        const concrete = path.replace(/\{[^}]+\}/g, "x1");
        const res = await call(method.toUpperCase(), concrete, { json: method === "get" ? undefined : {} });
        expect(res.status, `${method} ${path}`).not.toBe(404);
      }
    }
  });

  it("lists Starter's price on the landing page and in the guide when it is set", async () => {
    const priced = envWith({ STARTER_PRICE_USD: "12" });
    const page = await call("GET", "/", { headers: { accept: "text/html" }, env: priced });
    expect(page.text).toContain("$12 per 30 days");
    expect(page.text).not.toContain("You only pay when you get paid");
    expect((await call("GET", "/llms.txt", { env: priced })).text).toContain("$12.00 per 30 days");
  });
});

// ── Key recovery ─────────────────────────────────────────────────────────────

describe("recovering a lost key", () => {
  it("/accountkey from the linked Telegram account issues a new key in the chat", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1, { admin_user_ids: [CREATOR_TG] });
    expect((await tenant(t.id)).recovery_telegram_id).toBe(CREATOR_TG); // set from the first bot admin

    await telegramUpdate(bot.id, bot.webhookSecret, message(CREATOR_TG, "/accountkey"));
    const sent = mock.tg("sendMessage").at(-1);
    expect(sent?.body?.chat_id).toBe(CREATOR_TG);
    expect(sent?.body?.protect_content).toBe(true);
    const newKey = /<code>(pbk_[0-9a-f]+)<\/code>/.exec(String(sent?.body?.text))?.[1];
    expect(newKey).toBeTruthy();

    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).status).toBe(401);
    expect((await call("GET", "/api/v1/tenants/me", { headers: { "x-api-key": newKey! } })).status).toBe(200);

    // Asking again straight away is refused.
    await telegramUpdate(bot.id, bot.webhookSecret, message(CREATOR_TG, "/accountkey"));
    expect(String(mock.tg("sendMessage").at(-1)?.body?.text)).toContain("wait 10 minutes");
  });

  it("refuses anyone else, without revealing whether an account exists", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 2, { admin_user_ids: [CREATOR_TG, 4444] });
    await telegramUpdate(bot.id, bot.webhookSecret, message(4444, "/accountkey")); // another bot admin
    expect(String(mock.tg("sendMessage").at(-1)?.body?.text)).toContain("isn't linked");
    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).status).toBe(200);
  });

  it("lets the creator change the recovery account", async () => {
    const t = await signup();
    expect((await call("PATCH", "/api/v1/tenants/me", { headers: t.headers, json: { recovery_telegram_id: 777 } })).status).toBe(200);
    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).body.recovery_telegram_id).toBe(777);
    expect((await call("PATCH", "/api/v1/tenants/me", { headers: t.headers, json: { recovery_telegram_id: -5 } })).status).toBe(422);
  });

  it("lets the owner reset a creator's key", async () => {
    const t = await signup();
    const res = await call("POST", `/admin/tenants/${t.id}/rotate-key`, { headers: asAdmin });
    expect(res.body.api_key).toMatch(/^pbk_/);
    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).status).toBe(401);
    expect((await call("GET", "/api/v1/tenants/me", { headers: { "x-api-key": res.body.api_key } })).status).toBe(200);
    expect((await call("POST", "/admin/tenants/owner/rotate-key", { headers: asAdmin })).status).toBe(404);
    expect((await call("POST", `/admin/tenants/${t.id}/rotate-key`, { headers: t.headers })).status).toBe(401);
  });
});

// ── Volume pricing ───────────────────────────────────────────────────────────

/** Record past confirmed sales for a creator, as if they happened `daysAgo`. */
async function pastSales(tenantId: string, botId: string, usd: number, daysAgo: number) {
  const at = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  await env.DB.prepare(
    `INSERT INTO payments (id, tenant_id, bot_id, telegram_id, provider, provider_ref, access_type,
       gross_amount, platform_fee, net_amount, status, created_at, confirmed_at)
     VALUES (?1, ?2, ?3, 1, 'paystack', ?1, 'monthly', ?4, 0, ?4, 'confirmed', ?5, ?5)`,
  ).bind(`past-${daysAgo}-${usd}`, tenantId, botId, usd, at).run();
}

async function linkFee(headers: Record<string, string>, botId: string): Promise<number> {
  const link = await call("POST", "/api/v1/payments/generate-link", {
    headers,
    json: { bot_id: botId, telegram_id: BUYER, access_type: "one_time", provider: "paystack" },
  });
  expect(link.status, link.text).toBe(200);
  return (await paymentRow(link.body.order_id))?.platform_fee;
}

describe("volume pricing", () => {
  it("lowers the standard rate as a creator's last 30 days of sales grow", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 21);
    expect(await linkFee(t.headers, bot.id)).toBe(1.2); // $10 at 12%

    let me = await call("GET", "/api/v1/tenants/me", { headers: t.headers });
    expect(me.body.platform_cut).toBe("12%");
    expect(me.body.volume_pricing).toEqual({ sales_last_30_days: "$0.00", next: { from_usd: 1000, platform_cut: "10%" } });

    await pastSales(t.id, bot.id, 900, 40); // too old to count
    await pastSales(t.id, bot.id, 1000, 3);
    expect(await linkFee(t.headers, bot.id)).toBe(1); // 10%

    await pastSales(t.id, bot.id, 4000, 10);
    expect(await linkFee(t.headers, bot.id)).toBe(0.8); // 8%

    await pastSales(t.id, bot.id, 15000, 20);
    expect(await linkFee(t.headers, bot.id)).toBe(0.6); // 6%
    me = await call("GET", "/api/v1/tenants/me", { headers: t.headers });
    expect(me.body.volume_pricing).toEqual({ sales_last_30_days: "$20000.00", next: null });
  });

  it("keeps Starter and custom rates flat", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 22);
    await pastSales(t.id, bot.id, 25000, 1);
    await call("POST", `/admin/tenants/${t.id}/tier`, { headers: asAdmin, json: { tier: "starter" } });
    expect(await linkFee(t.headers, bot.id)).toBe(0.5);
    await call("POST", `/admin/tenants/${t.id}/tier`, { headers: asAdmin, json: { tier: "free", platform_cut: 0.2 } });
    expect(await linkFee(t.headers, bot.id)).toBe(2);
    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).body.volume_pricing).toBeNull();
  });
});

// ── Fees ─────────────────────────────────────────────────────────────────────

describe("collecting platform fees", () => {
  it("tracks what a creator owes and lets them pay it through the owner's Paystack", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 3);
    await creatorSale(t.headers, bot.id, 3); // $10 at 12% → $1.20 fee
    await creatorSale(t.headers, bot.id, 3, env, BUYER + 1);

    let billing = await call("GET", "/api/v1/tenants/billing", { headers: t.headers });
    expect(billing.body).toMatchObject({ fees_owed_usd: 2.4, fees_paid_usd: 0, billing_hold: false, fee_limit_usd: null });
    expect(billing.body.payment_providers).toContain("paystack");

    const pay = await call("POST", "/api/v1/tenants/pay-fees", { headers: t.headers, json: { provider: "paystack" } });
    expect(pay.status, pay.text).toBe(200);
    expect(pay.body.amount).toBe(2.4);
    expect(pay.body.order_id).toMatch(/^fee-/);
    const row = await paymentRow(pay.body.order_id);
    expect(row).toMatchObject({ bot_id: "owner", tenant_id: "owner", access_type: "platform_fee", for_tenant_id: t.id, platform_fee: 0 });
    // Paystack is told the creator's email, and the payer returns to the dashboard.
    const init = mock.calls.filter((c) => c.url.endsWith("/transaction/initialize")).at(-1);
    expect(init?.body?.email).toMatch(/@example\.com$/);
    expect(String(init?.body?.callback_url)).toContain("/dashboard#account");

    await ownerPaid(pay.body.order_id);
    billing = await call("GET", "/api/v1/tenants/billing", { headers: t.headers });
    expect(billing.body).toMatchObject({ fees_owed_usd: 0, fees_paid_usd: 2.4 });
    // Nothing was sent to a Telegram user for a platform payment.
    expect(mock.tg("sendMessage").filter((c) => c.body?.chat_id === 0)).toHaveLength(0);

    expect((await call("POST", "/api/v1/tenants/pay-fees", { headers: t.headers, json: { provider: "paystack" } })).body.detail).toContain("don't owe");
  });

  it("does not count fees that the Paystack split already sent to the owner", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 4);
    await call("POST", `/admin/tenants/${t.id}/paystack-subaccount`, { headers: asAdmin, json: { code: "ACCT_platform1" } });
    const orderId = await creatorSale(t.headers, bot.id, 4);
    expect((await paymentRow(orderId))?.fee_collected).toBe(1);
    expect((await call("GET", "/api/v1/tenants/billing", { headers: t.headers })).body.fees_owed_usd).toBe(0);
  });

  it("pauses sales when unpaid fees reach FEE_LIMIT_USD, warns the creator, and resumes once paid", async () => {
    const limited = envWith({ FEE_LIMIT_USD: "2.4" });
    const t = await signup();
    const bot = await createBot(t.headers, 5, { admin_user_ids: [CREATOR_TG] });

    await creatorSale(t.headers, bot.id, 5, limited); // owes 1.20: below 80%
    expect(mock.tg("sendMessage").filter((c) => c.body?.chat_id === CREATOR_TG)).toHaveLength(0);
    await creatorSale(t.headers, bot.id, 5, limited, BUYER + 1); // owes 2.40: hold
    expect((await tenant(t.id)).billing_hold).toBe(1);
    const alert = mock.tg("sendMessage").filter((c) => c.body?.chat_id === CREATOR_TG).at(-1);
    expect(String(alert?.body?.text)).toContain("Sales are paused");
    expect(alert?.tgToken).toBe(botToken(5)); // sent by the creator's own bot

    // Buyers can't start new payments while on hold.
    const blocked = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER + 2, access_type: "one_time", provider: "paystack" },
      env: limited,
    });
    expect(blocked.status).toBe(409);
    expect((await call("GET", "/admin/tenants", { headers: asAdmin })).body.tenants[0]).toMatchObject({ billing_hold: true, fees_owed_usd: 2.4 });

    const pay = await call("POST", "/api/v1/tenants/pay-fees", { headers: t.headers, json: { provider: "paystack" }, env: limited });
    await ownerPaid(pay.body.order_id, limited);
    expect((await tenant(t.id)).billing_hold).toBe(0);
    const again = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER + 2, access_type: "one_time", provider: "paystack" },
      env: limited,
    });
    expect(again.status).toBe(200);
  });

  it("lets the owner record fees paid outside the dashboard", async () => {
    const limited = envWith({ FEE_LIMIT_USD: "1" });
    const t = await signup();
    const bot = await createBot(t.headers, 6);
    await creatorSale(t.headers, bot.id, 6, limited);
    expect((await tenant(t.id)).billing_hold).toBe(1);
    const res = await call("POST", `/admin/tenants/${t.id}/fees-paid`, { headers: asAdmin, json: { amount: 1.5 }, env: limited });
    expect(res.status).toBe(200);
    expect((await tenant(t.id))).toMatchObject({ fees_paid_usd: 1.5, billing_hold: 0 });
  });

  it("credits a fee payment once, even if two confirmations race", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 11);
    await creatorSale(t.headers, bot.id, 11);
    const pay = await call("POST", "/api/v1/tenants/pay-fees", { headers: t.headers, json: { provider: "paystack" } });
    const snapshot = (await paymentRow(pay.body.order_id)) as any;
    await Promise.all([confirmPayment(env, snapshot), confirmPayment(env, snapshot)]);
    expect((await tenant(t.id)).fees_paid_usd).toBe(1.2);
  });

  it("never asks the owner for fees", async () => {
    expect((await call("POST", "/api/v1/tenants/pay-fees", { headers: asAdmin, json: { provider: "paystack" } })).status).toBe(400);
  });
});

// ── Self-serve Starter ───────────────────────────────────────────────────────

describe("buying Starter", () => {
  const priced = envWith({ STARTER_PRICE_USD: "12" });

  it("upgrades the creator for 30 days, restarts stopped bots, and renewing adds time", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 7);
    await env.DB.prepare("UPDATE bots SET status = 'expired' WHERE id = ?1").bind(bot.id).run();

    const billing = await call("GET", "/api/v1/tenants/billing", { headers: t.headers, env: priced });
    expect(billing.body).toMatchObject({ starter_price_usd: 12, can_buy_starter: true, plan_days: 30 });

    const info = await call("POST", "/api/v1/tenants/upgrade", { headers: t.headers, env: priced });
    expect(info.status).toBe(402);
    expect(info.body.detail).toContain("$12.00");

    const buy = await call("POST", "/api/v1/tenants/upgrade", { headers: t.headers, json: { provider: "paystack" }, env: priced });
    expect(buy.status, buy.text).toBe(200);
    expect(buy.body.amount).toBe(12);
    await ownerPaid(buy.body.order_id, priced);

    const after = await tenant(t.id);
    expect(after).toMatchObject({ tier: "starter", platform_cut: 0.05, trial_ends_at: null });
    const days = (after.plan_expires_at - Date.now() / 1000) / 86400;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect((await env.DB.prepare("SELECT status FROM bots WHERE id = ?1").bind(bot.id).first())?.status).toBe("active");

    const renew = await call("POST", "/api/v1/tenants/upgrade", { headers: t.headers, json: { provider: "paystack" }, env: priced });
    await ownerPaid(renew.body.order_id, priced);
    expect((await tenant(t.id)).plan_expires_at).toBe(after.plan_expires_at + 30 * 86400);
  });

  it("ends the plan when it runs out and tells the creator", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 8, { admin_user_ids: [CREATOR_TG] });
    const at = Date.UTC(2026, 0, 1, 12, 0);
    await env.DB.prepare("UPDATE tenants SET tier = 'starter', platform_cut = 0.05, trial_ends_at = NULL, plan_expires_at = ?1 WHERE id = ?2")
      .bind(at / 1000 - 60, t.id)
      .run();
    await runCron(at);
    expect(await tenant(t.id)).toMatchObject({ tier: "free", platform_cut: 0.12, plan_expires_at: null });
    // The bot keeps selling; only the fee goes back to the standard rate.
    expect((await env.DB.prepare("SELECT status FROM bots WHERE id = ?1").bind(bot.id).first())?.status).toBe("active");
    expect(mock.tg("sendMessage").some((c) => c.body?.chat_id === CREATOR_TG && String(c.body?.text).includes("Starter plan has ended"))).toBe(true);
  });

  it("isn't offered when no price is set, or to plans the owner set by hand", async () => {
    const t = await signup();
    expect((await call("GET", "/api/v1/tenants/billing", { headers: t.headers })).body.can_buy_starter).toBe(false);
    await call("POST", `/admin/tenants/${t.id}/tier`, { headers: asAdmin, json: { tier: "starter" } });
    expect((await call("GET", "/api/v1/tenants/billing", { headers: t.headers, env: priced })).body.can_buy_starter).toBe(false);
    expect((await call("POST", "/api/v1/tenants/upgrade", { headers: t.headers, json: { provider: "paystack" }, env: priced })).status).toBe(402);
  });
});

// ── Alerts ───────────────────────────────────────────────────────────────────

describe("failure alerts", () => {
  it("tell the creator through their bot when buyers can't get a payment link, at most once an hour", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 9, { admin_user_ids: [CREATOR_TG] });
    mock.on((c) => (c.url.endsWith("/transaction/initialize") ? { status: 401, json: { status: false, message: "Invalid key" } } : undefined));
    const press = (id: number) => ({ callback_query: { id: "cb", from: user(id), data: "pay:one_time:paystack", message: { message_id: 5, chat: privateChat(id) } } });

    await telegramUpdate(bot.id, bot.webhookSecret, press(BUYER));
    await telegramUpdate(bot.id, bot.webhookSecret, press(BUYER + 1));
    const alerts = mock.tg("sendMessage").filter((c) => c.body?.chat_id === CREATOR_TG);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]?.body?.text)).toContain("couldn't get a paystack payment link");

    // An hour later the next one goes out and says how many were held back.
    await env.DB.prepare("UPDATE alerts SET last_sent_at = last_sent_at - 3601").run();
    await telegramUpdate(bot.id, bot.webhookSecret, press(BUYER + 2));
    const next = mock.tg("sendMessage").filter((c) => c.body?.chat_id === CREATOR_TG);
    expect(next).toHaveLength(2);
    expect(String(next[1]?.body?.text)).toContain("1 more like this");
  });

  it("tell the creator when a payment notification has a bad signature", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 10, { admin_user_ids: [CREATOR_TG] });
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "x" } });
    const res = await call("POST", `/webhooks/paystack/${bot.id}`, { raw, headers: { "x-paystack-signature": "bad" } });
    expect(res.status).toBe(400);
    expect(mock.tg("sendMessage").some((c) => c.body?.chat_id === CREATOR_TG && String(c.body?.text).includes("signature"))).toBe(true);
  });

  it("go to the owner's admins for platform problems, or to ALERT_CHAT_ID", async () => {
    await alertOwner(env, "test", "Something broke");
    expect(mock.tg("sendMessage").at(-1)?.body).toMatchObject({ chat_id: OWNER_ADMIN });
    await alertOwner(envWith({ ALERT_CHAT_ID: "-100555" }), "test2", "Again");
    expect(mock.tg("sendMessage").at(-1)?.body?.chat_id).toBe(-100555);
    const before = mock.tg("sendMessage").length;
    await alertOwner(envWith({ ALERTS: "off" }), "test3", "Quiet");
    expect(mock.tg("sendMessage")).toHaveLength(before);
  });
});
