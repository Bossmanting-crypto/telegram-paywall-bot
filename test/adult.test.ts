import { beforeEach, describe, expect, it } from "vitest";
import {
  asAdmin,
  botToken,
  call,
  createBot,
  mockFetch,
  ownerWebhookSecret,
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
  await ownerWebhookSecret();
});

const BUYER = 7201;
const CREATOR_TG = 9301;
const privateChat = (id: number) => ({ id, type: "private" });
const message = (from: number, text: string) => ({
  message: { message_id: 1, from: user(from), chat: privateChat(from), text },
});
const press = (from: number, data: string) => ({
  callback_query: { id: "cb1", from: user(from), data, message: { message_id: 50, chat: privateChat(from) } },
});
const buttons = (body: Record<string, unknown> | null | undefined): Array<{ text: string; callback_data?: string; url?: string }> =>
  ((body?.reply_markup as any)?.inline_keyboard ?? []).flat();

async function adultBot(n = 41, overrides: Record<string, unknown> = {}) {
  const t = await signup();
  const bot = await createBot(t.headers, n, { admin_user_ids: [CREATOR_TG], ...overrides });
  const res = await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { adult: true } });
  expect(res.status, res.text).toBe(200);
  return { t, bot, res };
}

describe("adults-only label", () => {
  it("is off by default, and can be switched on and off by the creator", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 40);
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).body).toMatchObject({ adult: false, adult_locked: false });

    const on = await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { adult: true } });
    expect(on.body.notes).toEqual(["Labelled adults-only: Paystack is off for this group, crypto stays on."]);
    const detail = await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers });
    expect(detail.body).toMatchObject({ adult: true, payment_providers: ["nowpayments", "btcpay"] });
    expect((await call("GET", "/api/v1/bots", { headers: t.headers })).body.bots[0].adult).toBe(true);

    await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { adult: false } });
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).body.payment_providers).toContain("paystack");

    expect((await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { adult: "yes" } })).status).toBe(422);
  });

  it("tells the creator to add crypto when Paystack was their only way to get paid", async () => {
    const t = await signup();
    const res = await call("POST", "/api/v1/bots", {
      headers: t.headers,
      json: { bot_token: botToken(42), monthly_price: 5, paystack_secret_key: "sk_test_only", adult: true },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.payment_providers).toEqual([]);
    expect(res.body.next_steps).toBeDefined();
    const detail = await call("GET", `/api/v1/bots/${res.body.bot_id}`, { headers: t.headers });
    expect(detail.body.adult).toBe(true);
  });

  it("shows buyers crypto only, with no extra steps before the plans", async () => {
    const { bot } = await adultBot();
    await telegramUpdate(bot.id, bot.webhookSecret, message(BUYER, "/start"));
    const menu = mock.tg("sendMessage").filter((c) => c.body?.chat_id === BUYER).at(-1);
    expect(buttons(menu?.body).map((b) => b.callback_data)).toEqual(["access:monthly", "access:one_time"]);
    expect(String(menu?.body?.text)).not.toMatch(/18|age/i);

    await telegramUpdate(bot.id, bot.webhookSecret, press(BUYER, "access:monthly"));
    const methods = buttons(mock.tg("editMessageText").at(-1)?.body).map((b) => b.callback_data);
    expect(methods).toEqual(["pay:monthly:nowpayments", "pay:monthly:btcpay", "start_pay"]);
  });

  it("refuses Paystack payment links and still makes crypto ones", async () => {
    const { t, bot } = await adultBot();
    const refused = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER, access_type: "monthly", provider: "paystack" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toContain("adults-only");
    expect(mock.calls.some((c) => c.url.includes("api.paystack.co/transaction/initialize"))).toBe(false);

    const crypto = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER, access_type: "monthly", provider: "nowpayments" },
    });
    expect(crypto.status, crypto.text).toBe(200);
  });

  it("has the creator pay platform fees in crypto, not through the owner's Paystack", async () => {
    const { t } = await adultBot();
    const billing = await call("GET", "/api/v1/tenants/billing", { headers: t.headers });
    expect(billing.body.payment_providers).not.toContain("paystack");
    const res = await call("POST", "/api/v1/tenants/pay-fees", { headers: t.headers, json: { provider: "paystack" } });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("isn't available");
  });

  it("lets the owner label and lock a creator's bot, and tells the creator", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 43, { admin_user_ids: [CREATOR_TG] });

    const res = await call("POST", `/admin/bots/${bot.id}/adult`, { headers: asAdmin, json: { adult: true, lock: true } });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ adult: true, adult_locked: true });
    const alert = mock.tg("sendMessage").find((c) => c.body?.chat_id === CREATOR_TG);
    expect(String(alert?.body?.text)).toContain("crypto only");
    expect(alert?.tgToken).toBe(botToken(43));

    const undo = await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { adult: false } });
    expect(undo.status).toBe(403);
    expect(undo.body.detail).toContain("platform owner");

    const creators = await call("GET", "/admin/tenants", { headers: asAdmin });
    expect(creators.body.tenants[0].bot_list).toEqual([{ id: bot.id, username: expect.any(String), group: null, adult: true, locked: true }]);

    await call("POST", `/admin/bots/${bot.id}/adult`, { headers: asAdmin, json: { adult: false } });
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).body).toMatchObject({ adult: false, adult_locked: false });
    expect((await call("POST", `/admin/bots/${bot.id}/adult`, { headers: t.headers, json: { adult: true } })).status).toBe(401);
  });
});
