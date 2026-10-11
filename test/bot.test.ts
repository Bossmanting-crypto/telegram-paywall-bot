import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  OWNER_ADMIN,
  OWNER_GROUP,
  OWNER_TOKEN,
  asAdmin,
  call,
  createBot,
  env,
  envWith,
  memberRow,
  mockFetch,
  ownerWebhookSecret,
  paymentRow,
  paystackSignature,
  resetDatabase,
  signup,
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

const BUYER = 7001;
const privateChat = (id: number) => ({ id, type: "private" });
const group = { id: OWNER_GROUP, type: "supergroup", title: "VIP Group" };

const message = (from: number, text: string, chat: Record<string, unknown> = privateChat(from)) => ({
  message: { message_id: 1, from: user(from), chat, text },
});
const press = (from: number, data: string) => ({
  callback_query: { id: "cb1", from: user(from), data, message: { message_id: 50, chat: privateChat(from) } },
});
const joined = (who: Record<string, unknown>, chat: Record<string, unknown> = group) => ({
  chat_member: {
    chat,
    from: who,
    old_chat_member: { status: "left", user: who },
    new_chat_member: { status: "member", user: who },
  },
});

const buttons = (callBody: Record<string, unknown> | null | undefined): Array<{ text: string; callback_data?: string; url?: string }> =>
  ((callBody?.reply_markup as any)?.inline_keyboard ?? []).flat();

/** Run the every-minute cron job at a given wall-clock time. */
async function runCron(at = Date.UTC(2026, 0, 1, 12, 7)): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: at, cron: "* * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("Telegram webhook endpoint", () => {
  it("rejects updates without the bot's secret token", async () => {
    expect((await telegramUpdate("owner", "wrong-secret", message(BUYER, "/start"))).status).toBe(403);
    expect((await call("POST", "/telegram/owner", { json: message(BUYER, "/start") })).status).toBe(403);
    expect((await telegramUpdate("no-such-bot", secret, message(BUYER, "/start"))).status).toBe(404);
    expect(mock.tg()).toHaveLength(0);
  });

  it("does not accept one bot's secret for another bot", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    expect((await telegramUpdate(bot.id, secret, message(BUYER, "/start"))).status).toBe(403);
    expect((await telegramUpdate(bot.id, bot.webhookSecret, message(BUYER, "/start"))).status).toBe(200);
  });

  it("still answers 200 when handling an update fails, so Telegram does not retry forever", async () => {
    mock.on((c) => (c.tgMethod === "sendMessage" ? { status: 500, json: { ok: false, error_code: 500, description: "boom" } } : undefined));
    expect((await telegramUpdate("owner", secret, message(BUYER, "/start"))).status).toBe(200);
  });
});

describe("buying access through the bot", () => {
  it("shows the plans on /start", async () => {
    await telegramUpdate("owner", secret, message(BUYER, "/start pay"));
    const sent = mock.tg("sendMessage").at(-1);
    expect(sent?.tgToken).toBe(OWNER_TOKEN);
    expect(sent?.body?.chat_id).toBe(BUYER);
    expect(buttons(sent?.body).map((b) => b.callback_data)).toEqual(["access:one_time", "access:monthly"]);
    expect(buttons(sent?.body)[0]?.text).toContain("$10");
    expect(buttons(sent?.body)[1]?.text).toContain("$5/mo");
    expect((await memberRow("owner", BUYER))?.first_name).toBe("Ada");
  });

  it("offers the configured payment methods, then produces a pay link", async () => {
    await telegramUpdate("owner", secret, press(BUYER, "access:monthly"));
    const menu = mock.tg("editMessageText").at(-1);
    expect(String(menu?.body?.text)).toContain("$5.00");
    expect(buttons(menu?.body).map((b) => b.callback_data)).toEqual([
      "pay:monthly:paystack",
      "pay:monthly:nowpayments",
      "pay:monthly:btcpay",
      "start_pay",
    ]);
    expect(buttons(menu?.body)[0]?.text).toContain("M-Pesa");
    expect(mock.tg("answerCallbackQuery")).toHaveLength(1);

    await telegramUpdate("owner", secret, press(BUYER, "pay:monthly:paystack"));
    const ready = mock.tg("editMessageText").at(-1);
    expect(String(ready?.body?.text)).toContain("Payment Link Ready");
    const pay = buttons(ready?.body).find((b) => b.url);
    expect(pay?.url).toMatch(/^https:\/\/checkout\.paystack\.com\/7001-[0-9a-f]{12}$/);
    const orderId = pay!.url!.split("/").pop()!;
    expect(await paymentRow(orderId)).toMatchObject({ status: "pending", access_type: "monthly", telegram_id: BUYER, gross_amount: 5 });
  });

  it("understands buttons sent by the original bot", async () => {
    await telegramUpdate("owner", secret, press(BUYER, "access:onetime"));
    expect(buttons(mock.tg("editMessageText").at(-1)?.body)[0]?.callback_data).toBe("pay:one_time:paystack");
  });

  it("tells the buyer when a payment link cannot be created", async () => {
    mock.on((c) => (c.url.endsWith("/transaction/initialize") ? { status: 401, json: { status: false, message: "Invalid key" } } : undefined));
    await telegramUpdate("owner", secret, press(BUYER, "pay:one_time:paystack"));
    expect(String(mock.tg("editMessageText").at(-1)?.body?.text)).toContain("Failed to generate a payment link");
  });

  it("completes the whole journey: join → restricted → pay → unlocked → /start confirms", async () => {
    // 1. Joins the group: restricted and sent the menu.
    await telegramUpdate("owner", secret, joined(user(BUYER)));
    const restrict = mock.tg("restrictChatMember").at(-1);
    expect(restrict?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: BUYER });
    expect((restrict?.body?.permissions as any).can_send_messages).toBe(false);
    expect(mock.tg("sendMessage").at(-1)?.body?.chat_id).toBe(BUYER);

    // 2. Picks a plan and a provider.
    await telegramUpdate("owner", secret, press(BUYER, "pay:one_time:paystack"));
    const orderId = buttons(mock.tg("editMessageText").at(-1)?.body).find((b) => b.url)!.url!.split("/").pop()!;

    // 3. Pays; Paystack calls the webhook.
    mock.on((c) =>
      c.url === `https://api.paystack.co/transaction/verify/${orderId}`
        ? { json: { status: true, data: { reference: orderId, status: "success", amount: 129000, currency: "KES" } } }
        : undefined,
    );
    const raw = JSON.stringify({ event: "charge.success", data: { reference: orderId } });
    await call("POST", "/webhooks/paystack/owner", {
      raw,
      headers: { "x-paystack-signature": await paystackSignature("sk_test_owner_paystack_secret", raw) },
    });
    expect((mock.tg("restrictChatMember").at(-1)?.body?.permissions as any).can_send_messages).toBe(true);
    expect((await memberRow("owner", BUYER))?.has_access).toBe(1);

    // 4. /start now reports access instead of asking for money.
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    const reply = mock.tg("sendMessage").at(-1);
    expect(String(reply?.body?.text)).toContain("You have active access");
    expect(buttons(reply?.body)).toHaveLength(0);

    // 5. Leaving and rejoining does not restrict a paid member.
    const before = mock.tg("restrictChatMember").length;
    await telegramUpdate("owner", secret, joined(user(BUYER)));
    expect(mock.tg("restrictChatMember")).toHaveLength(before + 1);
    expect((mock.tg("restrictChatMember").at(-1)?.body?.permissions as any).can_send_messages).toBe(true);
  });
});

describe("people joining the group", () => {
  it("falls back to a notice in the group when the bot cannot message the newcomer", async () => {
    await call("POST", "/admin/setup", { headers: asAdmin }); // records the bot's @username
    mock.on((c) =>
      c.tgMethod === "sendMessage" && c.body?.chat_id === BUYER
        ? { status: 403, json: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } }
        : undefined,
    );
    await telegramUpdate("owner", secret, joined(user(BUYER, "<b>Mallory</b>")));
    const notice = mock.tg("sendMessage").find((c) => c.body?.chat_id === OWNER_GROUP);
    expect(notice).toBeDefined();
    expect(buttons(notice?.body)[0]?.url).toBe("https://t.me/bot111111111?start=pay");
    // Names are escaped, so a display name cannot inject markup.
    expect(String(notice?.body?.text)).toContain("&lt;b&gt;Mallory&lt;/b&gt;");

    // The next newcomer's notice replaces the previous one.
    const firstNoticeId = (await env.DB.prepare("SELECT last_notice_message_id AS id FROM bots WHERE id = 'owner'").first<{ id: number }>())?.id;
    mock.on((c) =>
      c.tgMethod === "sendMessage" && c.body?.chat_id === 7002
        ? { status: 403, json: { ok: false, error_code: 403, description: "Forbidden" } }
        : undefined,
    );
    await telegramUpdate("owner", secret, joined(user(7002)));
    expect(mock.tg("deleteMessage").at(-1)?.body).toMatchObject({ chat_id: OWNER_GROUP, message_id: firstNoticeId });
  });

  it("ignores its own restriction echo, admins, bots, departures and other groups", async () => {
    const who = user(BUYER);
    const updates = [
      // Telegram echoes our restrictChatMember call back as a chat_member update.
      { chat_member: { chat: group, from: who, old_chat_member: { status: "member", user: who }, new_chat_member: { status: "restricted", is_member: true, user: who } } },
      { chat_member: { chat: group, from: who, old_chat_member: { status: "member", user: who }, new_chat_member: { status: "left", user: who } } },
      { chat_member: { chat: group, from: who, old_chat_member: { status: "left", user: who }, new_chat_member: { status: "administrator", user: who } } },
      joined({ id: 999, is_bot: true, first_name: "OtherBot" }),
      joined(user(OWNER_ADMIN)),
      joined(who, { id: -100999, type: "supergroup", title: "Some other group" }),
    ];
    for (const update of updates) {
      expect((await telegramUpdate("owner", secret, update)).status).toBe(200);
    }
    expect(mock.tg()).toHaveLength(0);
  });

  it("restricts someone who was restricted, left, and came back", async () => {
    const who = user(BUYER);
    await telegramUpdate("owner", secret, {
      chat_member: {
        chat: group,
        from: who,
        old_chat_member: { status: "restricted", is_member: false, user: who },
        new_chat_member: { status: "restricted", is_member: true, user: who },
      },
    });
    expect(mock.tg("restrictChatMember")).toHaveLength(1);
  });

  it("leaves the group open while the bot is paused", async () => {
    await call("PATCH", "/api/v1/bots/owner", { headers: asAdmin, json: { status: "paused" } });
    await telegramUpdate("owner", secret, joined(user(BUYER)));
    expect(mock.tg("restrictChatMember")).toHaveLength(0);
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    expect(String(mock.tg("sendMessage").at(-1)?.body?.text)).toContain("not taking payments");
  });

  it("links a creator's bot to the first group that makes it an admin", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    await env.DB.prepare("UPDATE bots SET group_chat_id = NULL WHERE id = ?1").bind(bot.id).run();
    const me = { id: 200000001, is_bot: true, first_name: "Bot" };
    const promoted = (chatId: number) => ({
      my_chat_member: {
        chat: { id: chatId, type: "supergroup", title: "Creators Club" },
        from: user(1),
        old_chat_member: { status: "left", user: me },
        new_chat_member: { status: "administrator", user: me },
      },
    });
    await telegramUpdate(bot.id, bot.webhookSecret, promoted(-100555));
    const detail = await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers });
    expect(detail.body.group_chat_id).toBe(-100555);
    expect(detail.body.group_name).toBe("Creators Club");

    // A second group cannot take the bot over.
    await telegramUpdate(bot.id, bot.webhookSecret, promoted(-100666));
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).body.group_chat_id).toBe(-100555);
  });
});

describe("admin commands", () => {
  it("ignores admin commands from ordinary users", async () => {
    await telegramUpdate("owner", secret, message(BUYER, "/grant 123"));
    expect(await memberRow("owner", 123)).toBeNull();
    // Falls through to the normal menu instead.
    expect(buttons(mock.tg("sendMessage").at(-1)?.body).length).toBeGreaterThan(0);
    await telegramUpdate("owner", secret, message(BUYER, "/grant 123", group));
    expect(await memberRow("owner", 123)).toBeNull();
  });

  it("/grant and /revoke change access in the database and in Telegram", async () => {
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/grant 123"));
    expect(await memberRow("owner", 123)).toMatchObject({ has_access: 1, access_type: "manual_grant" });
    expect(mock.tg("restrictChatMember").at(-1)?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: 123 });
    expect(String(mock.tg("sendMessage").at(-1)?.body?.text)).toContain("Granted access");

    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/revoke@bot111111111 123"));
    expect((await memberRow("owner", 123))?.has_access).toBe(0);
    expect((mock.tg("restrictChatMember").at(-1)?.body?.permissions as any).can_send_messages).toBe(false);

    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/grant"));
    expect(String(mock.tg("sendMessage").at(-1)?.body?.text)).toContain("Usage: /grant");
  });

  it("/stats reports members and payments", async () => {
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/grant 123"));
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/stats"));
    const text = String(mock.tg("sendMessage").at(-1)?.body?.text);
    expect(text).toContain("Total users: <b>2</b>");
    expect(text).toContain("Active access: <b>1</b>");
  });

  it("/id reports the chat and user IDs", async () => {
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/id", group));
    const text = String(mock.tg("sendMessage").at(-1)?.body?.text);
    expect(text).toContain(String(OWNER_GROUP));
    expect(text).toContain(String(OWNER_ADMIN));
  });

  it("/broadcast queues a message that the cron job delivers to paying members only", async () => {
    for (const id of [301, 302, 303]) await telegramUpdate("owner", secret, message(OWNER_ADMIN, `/grant ${id}`));
    await telegramUpdate("owner", secret, message(BUYER, "/start")); // known, but has not paid
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/broadcast New drop <b>tonight</b>!"));
    expect(String(mock.tg("sendMessage").at(-1)?.body?.text)).toContain("queued for <b>3</b>");

    mock.calls.length = 0;
    mock.on((c) => (c.tgMethod === "sendMessage" && c.body?.chat_id === 302 ? { status: 403, json: { ok: false, error_code: 403, description: "blocked" } } : undefined));
    await runCron();
    const delivered = mock.tg("sendMessage").filter((c) => c.body?.text === "New drop <b>tonight</b>!");
    expect(delivered.map((c) => c.body?.chat_id).sort()).toEqual([301, 302, 303]);
    expect(delivered.every((c) => c.body?.parse_mode === undefined)).toBe(true); // sent as plain text
    const report = mock.tg("sendMessage").find((c) => c.body?.chat_id === OWNER_ADMIN);
    expect(String(report?.body?.text)).toContain("sent to <b>2</b> of 3");

    mock.calls.length = 0;
    await runCron();
    expect(mock.tg("sendMessage")).toHaveLength(0); // not sent twice
  });
});

describe("image vault", () => {
  const photo = (from: number, unique: string) => ({
    message: {
      message_id: 9,
      from: user(from),
      chat: privateChat(from),
      photo: [
        { file_id: `small-${unique}`, file_unique_id: `s-${unique}`, width: 90, height: 90 },
        { file_id: `large-${unique}`, file_unique_id: unique, width: 1280, height: 1280 },
      ],
    },
  });

  it("lets an admin fill the vault and sells it to members", async () => {
    const withVault = envWith({ IMAGE_UNLOCK_PRICE_USD: "20" });
    const send = (update: Record<string, unknown>) =>
      call("POST", "/telegram/owner", { headers: { "x-telegram-bot-api-secret-token": secret }, json: { update_id: 1, ...update }, env: withVault });

    await send(photo(BUYER, "x1")); // not an admin: ignored
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_images").first<{ n: number }>())?.n).toBe(0);

    await send(photo(OWNER_ADMIN, "a1"));
    await send(photo(OWNER_ADMIN, "a2"));
    await send(photo(OWNER_ADMIN, "a2")); // duplicate
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_images").first<{ n: number }>())?.n).toBe(2);

    await send(message(BUYER, "/start"));
    expect(buttons(mock.tg("sendMessage").at(-1)?.body).map((b) => b.callback_data)).toContain("access:image_unlock");

    await send(press(BUYER, "pay:image_unlock:paystack"));
    const orderId = buttons(mock.tg("editMessageText").at(-1)?.body).find((b) => b.url)!.url!.split("/").pop()!;
    mock.on((c) =>
      c.url === `https://api.paystack.co/transaction/verify/${orderId}`
        ? { json: { status: true, data: { reference: orderId, status: "success", amount: 258000, currency: "KES" } } }
        : undefined,
    );
    const raw = JSON.stringify({ event: "charge.success", data: { reference: orderId } });
    await call("POST", "/webhooks/paystack/owner", {
      raw,
      headers: { "x-paystack-signature": await paystackSignature("sk_test_owner_paystack_secret", raw) },
      env: withVault,
    });

    const album = mock.tg("sendMediaGroup").at(-1);
    expect(album?.body?.chat_id).toBe(BUYER);
    expect((album?.body?.media as any[]).map((m) => m.media)).toEqual(["large-a1", "large-a2"]);
    expect(album?.body?.protect_content).toBe(true);
    const member = await memberRow("owner", BUYER);
    expect(member).toMatchObject({ images_unlocked: 1, has_access: 0 }); // vault only, not group access
    // No group restriction was touched for a vault-only purchase.
    expect(mock.tg("restrictChatMember")).toHaveLength(0);

    // The buyer can ask for the images again; others cannot.
    await send(message(BUYER, "/vault"));
    expect(mock.tg("sendMediaGroup")).toHaveLength(2);
    await send(message(7999, "/vault"));
    expect(mock.tg("sendMediaGroup")).toHaveLength(2);
  });
});

describe("scheduled jobs", () => {
  it("revokes monthly access when it runs out, once", async () => {
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 86400;
    await env.DB.prepare("UPDATE members SET has_access = 1, access_type = 'monthly', access_expires = ?1 WHERE telegram_id = ?2").bind(past, BUYER).run();
    await telegramUpdate("owner", secret, message(8002, "/start"));
    await env.DB.prepare("UPDATE members SET has_access = 1, access_type = 'monthly', access_expires = ?1 WHERE telegram_id = 8002").bind(future).run();
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, "/grant 8003")); // lifetime

    mock.calls.length = 0;
    await runCron();
    expect((await memberRow("owner", BUYER))?.has_access).toBe(0);
    expect((await memberRow("owner", 8002))?.has_access).toBe(1);
    expect((await memberRow("owner", 8003))?.has_access).toBe(1);
    const restricted = mock.tg("restrictChatMember");
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: BUYER });
    expect(String(mock.tg("sendMessage").at(-1)?.body?.text)).toContain("subscription has expired");

    mock.calls.length = 0;
    await runCron();
    expect(mock.tg()).toHaveLength(0);
  });

  it("an expired subscriber is asked to pay again on /start", async () => {
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    const past = Math.floor(Date.now() / 1000) - 60;
    await env.DB.prepare("UPDATE members SET has_access = 1, access_type = 'monthly', access_expires = ?1 WHERE telegram_id = ?2").bind(past, BUYER).run();
    // Even before the cron job has run, expired access is not honoured.
    mock.calls.length = 0;
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    const reply = mock.tg("sendMessage").at(-1);
    expect(String(reply?.body?.text)).not.toContain("active access");
    expect(String(reply?.body?.text)).toContain("Choose your access plan");
    expect(buttons(reply?.body).map((b) => b.callback_data)).toContain("access:monthly");
    expect(mock.tg("restrictChatMember")).toHaveLength(0); // restriction is not lifted
  });

  it("stops a creator's bot when the free trial ends, and restarts it on upgrade", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    await env.DB.prepare("UPDATE tenants SET trial_ends_at = ?1 WHERE id = ?2").bind(Math.floor(Date.now() / 1000) - 10, t.id).run();

    await runCron(Date.UTC(2026, 0, 1, 12, 7)); // trial check only runs every 15 minutes
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).body.status).toBe("active");
    await runCron(Date.UTC(2026, 0, 1, 12, 15));
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).body.status).toBe("expired");

    const link = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER, access_type: "one_time", provider: "paystack" },
    });
    expect(link.status).toBe(409);
    expect((await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { status: "active" } })).status).toBe(403);

    await call("POST", `/admin/tenants/${t.id}/tier`, { headers: asAdmin, json: { tier: "starter" } });
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).body.status).toBe("active");
  });
});
