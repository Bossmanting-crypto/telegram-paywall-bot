import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  OWNER_GROUP,
  asAdmin,
  call,
  env,
  memberRow,
  mockFetch,
  ownerWebhookSecret,
  paymentRow,
  paystackSignature,
  resetDatabase,
  telegramUpdate,
  user,
  type Mock,
} from "./helpers";

let mock: Mock;
let secret: string;
beforeEach(async () => {
  mock = mockFetch();
  await resetDatabase();
  secret = await ownerWebhookSecret();
});

const BUYER = 7101;
const group = { id: OWNER_GROUP, type: "supergroup", title: "VIP Group" };
const privateChat = (id: number) => ({ id, type: "private" });
const joined = (id: number) => ({
  chat_member: {
    chat: group,
    from: user(id),
    old_chat_member: { status: "left", user: user(id) },
    new_chat_member: { status: "member", user: user(id) },
  },
});
const joinRequest = (id: number) => ({
  chat_join_request: { chat: group, from: user(id), user_chat_id: id, date: 1 },
});
const message = (from: number, text: string) => ({
  message: { message_id: 1, from: user(from), chat: privateChat(from), text },
});
const press = (from: number, data: string) => ({
  callback_query: { id: "cb1", from: user(from), data, message: { message_id: 50, chat: privateChat(from) } },
});
const buttons = (body: Record<string, unknown> | null | undefined): Array<{ text: string; callback_data?: string; url?: string }> =>
  ((body?.reply_markup as any)?.inline_keyboard ?? []).flat();
const dmsTo = (id: number) => mock.tg("sendMessage").filter((c) => c.body?.chat_id === id);
const nowSec = () => Math.floor(Date.now() / 1000);

/** Pass jobs run on odd minutes. */
async function runPassJobs(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 12, 9), cron: "* * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

async function offerPass(hours: number, extra: Record<string, unknown> = {}) {
  const res = await call("PATCH", "/api/v1/bots/owner", { headers: asAdmin, json: { free_pass_hours: hours, ...extra } });
  expect(res.status, res.text).toBe(200);
}

async function setPassExpiry(id: number, expires: number) {
  await env.DB.prepare("UPDATE members SET pass_expires = ?1 WHERE bot_id = 'owner' AND telegram_id = ?2").bind(expires, id).run();
}

async function payMonthly(id: number) {
  await telegramUpdate("owner", secret, press(id, "pay:monthly:paystack"));
  const orderId = buttons(mock.tg("editMessageText").at(-1)?.body).find((b) => b.url)!.url!.split("/").pop()!;
  const row = await paymentRow(orderId);
  mock.on((c) =>
    c.url === `https://api.paystack.co/transaction/verify/${orderId}`
      ? { json: { status: true, data: { reference: orderId, status: "success", amount: row?.charge_amount_minor, currency: "KES" } } }
      : undefined,
  );
  const raw = JSON.stringify({ event: "charge.success", data: { reference: orderId } });
  const res = await call("POST", "/webhooks/paystack/owner", {
    raw,
    headers: { "x-paystack-signature": await paystackSignature("sk_test_owner_paystack_secret", raw) },
  });
  expect(res.status).toBe(200);
}

describe("free pass setting", () => {
  it("is off by default, and can be set from 0 to 720 hours", async () => {
    expect((await call("GET", "/api/v1/bots/owner", { headers: asAdmin })).body.free_pass_hours).toBe(0);
    await offerPass(24);
    expect((await call("GET", "/api/v1/bots/owner", { headers: asAdmin })).body.free_pass_hours).toBe(24);
    const bad = await call("PATCH", "/api/v1/bots/owner", { headers: asAdmin, json: { free_pass_hours: 1000 } });
    expect(bad.status).toBe(422);
  });
});

describe("free pass in mute mode", () => {
  it("lets a newcomer in without muting them, and shows the plans", async () => {
    await offerPass(24);
    await telegramUpdate("owner", secret, joined(BUYER));
    expect(mock.tg("restrictChatMember")).toHaveLength(0);
    const welcome = dmsTo(BUYER).at(-1);
    expect(String(welcome?.body?.text)).toContain("free 1 day pass");
    expect(buttons(welcome?.body).map((b) => b.callback_data)).toEqual(["access:monthly", "access:one_time"]);
    const row = await memberRow("owner", BUYER);
    expect(row?.pass_used).toBe(1);
    expect(row?.pass_expires).toBeGreaterThan(nowSec() + 86000);
  });

  it("mutes people as usual when the bot offers no pass", async () => {
    await telegramUpdate("owner", secret, joined(BUYER));
    expect(mock.tg("restrictChatMember")).toHaveLength(1);
    expect((await memberRow("owner", BUYER))?.pass_used).toBe(0);
  });

  it("gives the pass only once per person", async () => {
    await offerPass(6);
    await telegramUpdate("owner", secret, joined(BUYER));
    await env.DB.prepare("UPDATE members SET pass_expires = NULL, pass_ended_at = ?1 WHERE telegram_id = ?2").bind(nowSec(), BUYER).run();
    await telegramUpdate("owner", secret, joined(BUYER));
    expect(mock.tg("restrictChatMember")).toHaveLength(1);
  });

  it("shows the time left on /start", async () => {
    await offerPass(6);
    await telegramUpdate("owner", secret, joined(BUYER));
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    const reply = dmsTo(BUYER).at(-1);
    expect(String(reply?.body?.text)).toContain("free pass");
    expect(String(reply?.body?.text)).toContain("6 hours");
    expect(buttons(reply?.body).map((b) => b.callback_data)).toContain("access:monthly");
  });
});

describe("free pass in approve mode", () => {
  it("approves the request straight away and starts the pass", async () => {
    mock.on((c) =>
      c.tgMethod === "createChatInviteLink" ? { json: { ok: true, result: { invite_link: "https://t.me/+joinRequestLink" } } } : undefined,
    );
    await offerPass(72, { join_mode: "approve" });
    await telegramUpdate("owner", secret, joinRequest(BUYER));
    expect(mock.tg("approveChatJoinRequest").at(-1)?.body).toEqual({ chat_id: OWNER_GROUP, user_id: BUYER });
    expect(String(dmsTo(BUYER).at(-1)?.body?.text)).toContain("free 3 days pass");
    expect((await memberRow("owner", BUYER))?.pass_used).toBe(1);
  });
});

describe("when a free pass runs out", () => {
  it("warns once, ends the pass with a plan offer, then follows up once a day later", async () => {
    await offerPass(24);
    await telegramUpdate("owner", secret, joined(BUYER));

    // Two hours left: one heads-up.
    await setPassExpiry(BUYER, nowSec() + 7200);
    mock.calls.length = 0;
    await runPassJobs();
    await runPassJobs();
    const warnings = dmsTo(BUYER);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.body?.text)).toContain("ends in about 2 hours");
    expect(buttons(warnings[0]?.body).map((b) => b.callback_data)).toContain("access:monthly");

    // Over: muted, and offered the plans.
    await setPassExpiry(BUYER, nowSec() - 5);
    mock.calls.length = 0;
    await runPassJobs();
    expect(mock.tg("restrictChatMember").at(-1)?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: BUYER });
    const ended = dmsTo(BUYER).at(-1);
    expect(String(ended?.body?.text)).toContain("Your free pass has ended");
    expect(buttons(ended?.body).map((b) => b.callback_data)).toEqual(["access:monthly", "access:one_time"]);
    const row = await memberRow("owner", BUYER);
    expect(row?.pass_expires).toBeNull();
    expect(row?.pass_ended_at).toBeGreaterThan(0);

    // Nothing more until a day has passed.
    mock.calls.length = 0;
    await runPassJobs();
    expect(dmsTo(BUYER)).toHaveLength(0);

    await env.DB.prepare("UPDATE members SET pass_ended_at = ?1 WHERE telegram_id = ?2").bind(nowSec() - 86401, BUYER).run();
    await runPassJobs();
    await runPassJobs();
    const followups = dmsTo(BUYER);
    expect(followups).toHaveLength(1);
    expect(String(followups[0]?.body?.text)).toContain("Still thinking it over");
  });

  it("leaves people who paid during the pass alone", async () => {
    await offerPass(24);
    await telegramUpdate("owner", secret, joined(BUYER));
    await payMonthly(BUYER);
    const row = await memberRow("owner", BUYER);
    expect(row?.has_access).toBe(1);
    expect(row?.pass_expires).toBeNull();

    mock.calls.length = 0;
    await setPassExpiry(BUYER, nowSec() - 5);
    await runPassJobs();
    expect(mock.tg("restrictChatMember")).toHaveLength(0);
    expect(dmsTo(BUYER).some((c) => String(c.body?.text).includes("free pass has ended"))).toBe(false);
  });

  it("offers one-tap pay with the method they used before", async () => {
    await offerPass(24);
    await telegramUpdate("owner", secret, joined(BUYER));
    await telegramUpdate("owner", secret, press(BUYER, "pay:monthly:paystack")); // started, never paid
    await setPassExpiry(BUYER, nowSec() - 5);
    mock.calls.length = 0;
    await runPassJobs();
    const quick = buttons(dmsTo(BUYER).at(-1)?.body).find((b) => b.callback_data === "pay:monthly:paystack");
    expect(quick?.text).toContain("M-Pesa");
  });
});

describe("daily and weekly plans priced in shillings", () => {
  async function shillingBot() {
    const { signup, createBot } = await import("./helpers");
    const t = await signup();
    const bot = await createBot(t.headers, 31, {
      currency: "KES",
      fx_rate: 130,
      price_currency: "KES",
      daily_price: 50,
      weekly_price: 300,
      monthly_price: 1000,
      one_time_price: 0,
      image_unlock_price: 0,
    });
    return { t, bot };
  }

  it("shows shilling prices in the bot, weekly first, with the monthly saving", async () => {
    const { bot } = await shillingBot();
    await telegramUpdate(bot.id, bot.webhookSecret, message(BUYER, "/start"));
    const menu = dmsTo(BUYER).at(-1);
    const labels = buttons(menu?.body).map((b) => b.text);
    expect(labels.join(" | ")).toContain("KSh 50/day");
    expect(labels.join(" | ")).toContain("KSh 300/week");
    expect(labels.join(" | ")).toContain("KSh 1,000/mo");
  });

  it("charges exactly the shilling price, and records the sale and fee in dollars", async () => {
    const { t, bot } = await shillingBot();
    const link = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER, access_type: "daily", provider: "paystack" },
    });
    expect(link.status, link.text).toBe(200);
    const row = await paymentRow(link.body.order_id);
    expect(row).toMatchObject({ access_type: "daily", charge_amount_minor: 5000, charge_currency: "KES", gross_amount: 0.38 });
    expect(row?.platform_fee).toBeCloseTo(0.05, 2); // 12%
  });

  it("gives a day's access for a daily plan, and adds a week on top for a weekly one", async () => {
    const { t, bot } = await shillingBot();
    const pay = async (type: string) => {
      const link = await call("POST", "/api/v1/payments/generate-link", {
        headers: t.headers,
        json: { bot_id: bot.id, telegram_id: BUYER, access_type: type, provider: "paystack" },
      });
      const orderId = link.body.order_id;
      const row = await paymentRow(orderId);
      mock.on((c) =>
        c.url === `https://api.paystack.co/transaction/verify/${orderId}`
          ? { json: { status: true, data: { reference: orderId, status: "success", amount: row?.charge_amount_minor, currency: "KES" } } }
          : undefined,
      );
      const raw = JSON.stringify({ event: "charge.success", data: { reference: orderId } });
      const res = await call("POST", `/webhooks/paystack/${bot.id}`, {
        raw,
        headers: { "x-paystack-signature": await paystackSignature("sk_test_tenant_31", raw) },
      });
      expect(res.status).toBe(200);
    };
    await pay("daily");
    let m = await memberRow(bot.id, BUYER);
    expect(m).toMatchObject({ has_access: 1, access_type: "daily" });
    expect(m?.access_expires - nowSec()).toBeGreaterThan(86000);
    expect(m?.access_expires - nowSec()).toBeLessThanOrEqual(86400);
    await pay("weekly");
    m = await memberRow(bot.id, BUYER);
    expect(m?.access_type).toBe("weekly");
    expect(m?.access_expires - nowSec()).toBeGreaterThan(8 * 86400 - 100);
  });

  it("rejects a price currency Paystack doesn't charge in", async () => {
    const { signup, createBot } = await import("./helpers");
    const t = await signup();
    await expect(createBot(t.headers, 32, { currency: "KES", fx_rate: 130, price_currency: "NGN" })).rejects.toThrow(/422/);
  });
});
