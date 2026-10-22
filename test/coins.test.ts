import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { confirmPayment } from "../src/payments";
import {
  OWNER_ADMIN,
  OWNER_GROUP,
  asAdmin,
  call,
  createBot,
  env,
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

const BUYER = 7101;
const privateChat = (id: number) => ({ id, type: "private" });
const message = (from: number, text: string) => ({
  message: { message_id: 1, from: user(from), chat: privateChat(from), text },
});
const press = (from: number, data: string) => ({
  callback_query: { id: "cb1", from: user(from), data, message: { message_id: 50, chat: privateChat(from) } },
});
const buttons = (body: Record<string, unknown> | null | undefined): Array<{ text: string; callback_data?: string; url?: string }> =>
  ((body?.reply_markup as any)?.inline_keyboard ?? []).flat();
const lastText = (m: Mock, method = "sendMessage") => String(m.tg(method).at(-1)?.body?.text ?? "");

async function enableCoins(extra: Record<string, unknown> = {}) {
  const res = await call("PATCH", "/api/v1/bots/owner", {
    headers: asAdmin,
    json: { coins_enabled: true, free_coins: 10, unlock_cost: 5, coin_packs: [{ coins: 50, price: 3 }, { coins: 150, price: 7 }], ...extra },
  });
  expect(res.status, res.text).toBe(200);
}

/** The owner admin sends content to the bot. */
async function addContent(n: number, kind: "photo" | "video" = "photo", caption?: string) {
  for (let i = 0; i < n; i++) {
    const file = { file_id: `file-${kind}-${i}`, file_unique_id: `uniq-${kind}-${i}` };
    const media = kind === "photo" ? { photo: [{ ...file, width: 10, height: 10 }] } : { video: file };
    await telegramUpdate("owner", secret, {
      message: { message_id: 1, from: user(OWNER_ADMIN), chat: privateChat(OWNER_ADMIN), ...media, ...(caption ? { caption } : {}) },
    });
  }
}

async function itemIds(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id FROM vault_images WHERE bot_id = 'owner' ORDER BY rowid").all<{ id: string }>();
  return results.map((r) => r.id);
}

async function payByPaystack(orderId: string) {
  const row = await paymentRow(orderId);
  mock.on((c) =>
    c.url === `https://api.paystack.co/transaction/verify/${orderId}`
      ? { json: { status: true, data: { reference: orderId, status: "success", amount: row?.charge_amount_minor, currency: "KES" } } }
      : undefined,
  );
  const raw = JSON.stringify({ event: "charge.success", data: { reference: orderId } });
  return call("POST", "/webhooks/paystack/owner", {
    raw,
    headers: { "x-paystack-signature": await paystackSignature("sk_test_owner_paystack_secret", raw) },
  });
}

describe("coin settings", () => {
  it("are off by default and returned with the bot", async () => {
    const res = await call("GET", "/api/v1/bots/owner", { headers: asAdmin });
    expect(res.body.coins).toEqual({
      enabled: false,
      free_coins: 15,
      unlock_cost: 5,
      packs: [{ coins: 50, price: 3 }, { coins: 150, price: 7 }, { coins: 500, price: 20 }],
    });
    expect(res.body.join_mode).toBe("mute");
    expect(res.body.content_items).toBe(0);
  });

  it("can be changed, with validation", async () => {
    await enableCoins();
    const res = await call("GET", "/api/v1/bots/owner", { headers: asAdmin });
    expect(res.body.coins).toEqual({ enabled: true, free_coins: 10, unlock_cost: 5, packs: [{ coins: 50, price: 3 }, { coins: 150, price: 7 }] });

    for (const bad of [
      { unlock_cost: 0 },
      { free_coins: -1 },
      { free_coins: 2.5 },
      { coins_enabled: "yes" },
      { coin_packs: [{ coins: 10, price: 0.1 }] },
      { coin_packs: [{ coins: 0, price: 3 }] },
      { coin_packs: [1, 2, 3, 4] },
      { join_mode: "open" },
    ]) {
      const r = await call("PATCH", "/api/v1/bots/owner", { headers: asAdmin, json: bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
  });
});

describe("adding content", () => {
  it("accepts photos and videos from bot admins, with captions as teasers", async () => {
    await addContent(1, "photo");
    await addContent(1, "video", "Behind the scenes");
    const { results } = await env.DB.prepare("SELECT kind, caption FROM vault_images ORDER BY rowid").all();
    expect(results).toEqual([
      { kind: "photo", caption: null },
      { kind: "video", caption: "Behind the scenes" },
    ]);
    expect(lastText(mock)).toContain("2 items");
  });

  it("ignores media from people who are not admins", async () => {
    await telegramUpdate("owner", secret, {
      message: { message_id: 1, from: user(BUYER), chat: privateChat(BUYER), video: { file_id: "x", file_unique_id: "y" } },
    });
    expect(await itemIds()).toHaveLength(0);
  });
});

describe("free coins", () => {
  it("are given once per person, the first time they talk to the bot", async () => {
    await enableCoins();
    await addContent(2);
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    expect((await memberRow("owner", BUYER))?.coins).toBe(10);
    const menu = mock.tg("sendMessage").at(-1);
    expect(String(menu?.body?.text)).toContain("10 coins");
    expect(buttons(menu?.body).map((b) => b.callback_data)).toContain("c:0");

    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    await telegramUpdate("owner", secret, message(BUYER, "/balance"));
    expect((await memberRow("owner", BUYER))?.coins).toBe(10);
    expect(lastText(mock)).toContain("Your coins: 10");
    const ledger = await env.DB.prepare("SELECT delta, reason FROM coin_ledger WHERE telegram_id = ?1").bind(BUYER).all();
    expect(ledger.results).toEqual([{ delta: 10, reason: "free" }]);
  });

  it("are given once even when two first messages arrive together", async () => {
    await enableCoins();
    await Promise.all([
      telegramUpdate("owner", secret, message(BUYER, "/start")),
      telegramUpdate("owner", secret, message(BUYER, "/balance")),
      telegramUpdate("owner", secret, press(BUYER, "bal")),
    ]);
    expect((await memberRow("owner", BUYER))?.coins).toBe(10);
  });

  it("are not given while coins are off", async () => {
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    expect((await memberRow("owner", BUYER))?.coins).toBe(0);
    expect((await memberRow("owner", BUYER))?.free_coins_granted).toBe(0);
  });
});

describe("unlocking content with coins", () => {
  it("shows a locked card, charges once per item, then offers packs when coins run out", async () => {
    await enableCoins();
    await addContent(3);
    const ids = await itemIds();
    await telegramUpdate("owner", secret, message(BUYER, "/start"));

    // Browsing shows a locked card with an unlock button.
    await telegramUpdate("owner", secret, press(BUYER, "c:0"));
    const card = mock.tg("sendMessage").at(-1);
    expect(String(card?.body?.text)).toContain("1 of 3");
    expect(String(card?.body?.text)).toContain("5 coins");
    expect(buttons(card?.body).map((b) => b.callback_data)).toEqual([`u:${ids[0]}`, "c:1", "coins"]);

    // Unlock: costs 5, sends the photo protected from forwarding.
    await telegramUpdate("owner", secret, press(BUYER, `u:${ids[0]}`));
    const photo = mock.tg("sendPhoto").at(-1);
    expect(photo?.body).toMatchObject({ chat_id: BUYER, photo: "file-photo-0", protect_content: true });
    expect(String(photo?.body?.caption)).toContain("· 🪙 5");
    expect(String(photo?.body?.caption)).not.toContain("left");
    expect((await memberRow("owner", BUYER))?.coins).toBe(5);

    // Unlocking the same item again is free.
    await telegramUpdate("owner", secret, press(BUYER, `u:${ids[0]}`));
    expect((await memberRow("owner", BUYER))?.coins).toBe(5);
    // Browsing to it shows the item, not a card.
    const photosBefore = mock.tg("sendPhoto").length;
    await telegramUpdate("owner", secret, press(BUYER, "c:0"));
    expect(mock.tg("sendPhoto")).toHaveLength(photosBefore + 1);
    // ...with the current balance underneath.
    expect(String(mock.tg("sendPhoto").at(-1)?.body?.caption)).toContain("· 🪙 5");

    await telegramUpdate("owner", secret, press(BUYER, `u:${ids[1]}`));
    expect((await memberRow("owner", BUYER))?.coins).toBe(0);

    // Out of coins: friendly prompt with packs and the unlimited plans.
    await telegramUpdate("owner", secret, press(BUYER, `u:${ids[2]}`));
    const prompt = mock.tg("sendMessage").at(-1);
    expect(String(prompt?.body?.text)).toContain("used your free coins");
    expect(buttons(prompt?.body).map((b) => b.callback_data)).toEqual(["cp:0", "cp:1", "access:monthly", "access:one_time"]);
    expect(buttons(prompt?.body)[0]?.text).toContain("50 coins");
    expect(buttons(prompt?.body)[2]?.text).toContain("unlimited");
    expect((await memberRow("owner", BUYER))?.coins).toBe(0);

    const unlocks = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_unlocks").first<{ n: number }>();
    expect(unlocks?.n).toBe(2);
    const spent = await env.DB.prepare("SELECT SUM(delta) AS s FROM coin_ledger WHERE reason = 'unlock'").first<{ s: number }>();
    expect(spent?.s).toBe(-10);
  });

  it("never lets a balance go negative, even with simultaneous unlocks", async () => {
    await enableCoins({ free_coins: 5 });
    await addContent(3);
    const ids = await itemIds();
    await telegramUpdate("owner", secret, message(BUYER, "/start"));
    await Promise.all(ids.map((id) => telegramUpdate("owner", secret, press(BUYER, `u:${id}`))));
    expect((await memberRow("owner", BUYER))?.coins).toBe(0);
    const unlocks = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_unlocks").first<{ n: number }>();
    expect(unlocks?.n).toBe(1);
  });

  it("gives members on a paid plan everything for free", async () => {
    await enableCoins();
    await addContent(2, "video");
    const ids = await itemIds();
    await call("POST", `/api/v1/bots/owner/members/${BUYER}/grant`, { headers: asAdmin });
    await telegramUpdate("owner", secret, press(BUYER, "c:1"));
    expect(mock.tg("sendVideo").at(-1)?.body).toMatchObject({ video: "file-video-1", protect_content: true });
    await telegramUpdate("owner", secret, press(BUYER, `u:${ids[0]}`));
    expect(mock.tg("sendVideo")).toHaveLength(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM content_unlocks").first()).toEqual({ n: 0 });
  });

  it("says so when there is no content yet", async () => {
    await enableCoins();
    await telegramUpdate("owner", secret, press(BUYER, "c:0"));
    expect(lastText(mock)).toContain("Nothing here yet");
  });
});

describe("buying coin packs", () => {
  it("credits the coins exactly once when the payment is confirmed", async () => {
    await enableCoins();
    await addContent(1);
    await telegramUpdate("owner", secret, message(BUYER, "/start"));

    await telegramUpdate("owner", secret, press(BUYER, "coins"));
    expect(buttons(mock.tg("editMessageText").at(-1)?.body).map((b) => b.callback_data)).toEqual([
      "cp:0", "cp:1", "access:monthly", "access:one_time", "bal",
    ]);
    await telegramUpdate("owner", secret, press(BUYER, "cp:1"));
    expect(buttons(mock.tg("editMessageText").at(-1)?.body).map((b) => b.callback_data)).toContain("cpay:1:paystack");

    await telegramUpdate("owner", secret, press(BUYER, "cpay:1:paystack"));
    const ready = mock.tg("editMessageText").at(-1);
    expect(String(ready?.body?.text)).toContain("150 coins");
    const orderId = buttons(ready?.body).find((b) => b.url)!.url!.split("/").pop()!;
    expect(await paymentRow(orderId)).toMatchObject({ access_type: "coin_pack", coins: 150, gross_amount: 7, status: "pending" });

    expect((await payByPaystack(orderId)).status).toBe(200);
    expect((await memberRow("owner", BUYER))?.coins).toBe(160);
    expect(mock.tg("sendMessage").some((c) => String(c.body?.text).includes("150 coins added"))).toBe(true);
    // The buyer is not given group access by buying coins.
    expect((await memberRow("owner", BUYER))?.has_access).toBe(0);

    // A replayed webhook changes nothing.
    await payByPaystack(orderId);
    expect((await memberRow("owner", BUYER))?.coins).toBe(160);
    const purchases = await env.DB.prepare("SELECT COUNT(*) AS n FROM coin_ledger WHERE reason = 'purchase'").first<{ n: number }>();
    expect(purchases?.n).toBe(1);
  });

  it("credits once even if two confirmations race with the same pending snapshot", async () => {
    await enableCoins();
    await telegramUpdate("owner", secret, press(BUYER, "cpay:0:paystack"));
    const orderId = buttons(mock.tg("editMessageText").at(-1)?.body).find((b) => b.url)!.url!.split("/").pop()!;
    const snapshot = (await paymentRow(orderId)) as any;
    const results = await Promise.all([confirmPayment(env, snapshot), confirmPayment(env, snapshot)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await memberRow("owner", BUYER))?.coins).toBe(50);
  });

  it("refuses packs that no longer exist", async () => {
    await enableCoins();
    await telegramUpdate("owner", secret, press(BUYER, "cpay:7:paystack"));
    expect(lastText(mock, "editMessageText")).toContain("coin pack has changed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM payments").first()).toEqual({ n: 0 });
  });

  it("does not sell coins while coins are off", async () => {
    await telegramUpdate("owner", secret, press(BUYER, "cpay:0:paystack"));
    expect(lastText(mock, "editMessageText")).toContain("aren't on sale");
  });

  it("counts coin sales in revenue, with the platform fee", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 3);
    await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { coins_enabled: true } });
    await telegramUpdate(bot.id, bot.webhookSecret, press(BUYER, "cpay:0:nowpayments"));
    const orderId = await env.DB.prepare("SELECT provider_ref FROM payments WHERE bot_id = ?1").bind(bot.id).first<{ provider_ref: string }>();
    expect(await paymentRow(orderId!.provider_ref)).toMatchObject({ coins: 50, gross_amount: 3, platform_fee: 0.36, net_amount: 2.64 });
  });
});

describe("admin coin commands", () => {
  it("/givecoins adds coins and tells the person", async () => {
    await enableCoins();
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, `/givecoins ${BUYER} 25`));
    expect((await memberRow("owner", BUYER))?.coins).toBe(25);
    expect(mock.tg("sendMessage").some((c) => c.body?.chat_id === BUYER && String(c.body?.text).includes("25 coins"))).toBe(true);
    await telegramUpdate("owner", secret, message(OWNER_ADMIN, `/givecoins ${BUYER} -100`));
    expect((await memberRow("owner", BUYER))?.coins).toBe(0);
  });

  it("ignores /givecoins from non-admins", async () => {
    await enableCoins();
    await telegramUpdate("owner", secret, message(BUYER, `/givecoins ${BUYER} 1000`));
    expect((await memberRow("owner", BUYER))?.coins).toBe(10); // just the free allowance
  });
});

// ── Join approval ────────────────────────────────────────────────────────────

const joinRequest = (from: number) => ({
  chat_join_request: { chat: { id: OWNER_GROUP, type: "supergroup", title: "VIP Group" }, from: user(from), user_chat_id: from, date: 1 },
});

async function approveMode() {
  mock.on((c) =>
    c.tgMethod === "createChatInviteLink" && c.body?.creates_join_request
      ? { json: { ok: true, result: { invite_link: "https://t.me/+joinRequestLink" } } }
      : undefined,
  );
  const res = await call("PATCH", "/api/v1/bots/owner", { headers: asAdmin, json: { join_mode: "approve" } });
  expect(res.status, res.text).toBe(200);
  return res;
}

async function runCron(at: number): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: at, cron: "* * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("join approval", () => {
  it("switching it on re-registers the webhook and creates a join-request link", async () => {
    const res = await approveMode();
    expect(res.body.join_link).toBe("https://t.me/+joinRequestLink");
    const hook = mock.tg("setWebhook").at(-1);
    expect(hook?.body?.allowed_updates).toContain("chat_join_request");
    expect(hook?.body?.secret_token).toBe(secret);
    const detail = await call("GET", "/api/v1/bots/owner", { headers: asAdmin });
    expect(detail.body).toMatchObject({ join_mode: "approve", join_link: "https://t.me/+joinRequestLink" });
  });

  it("reports what to fix when the link can't be created", async () => {
    mock.on((c) =>
      c.tgMethod === "createChatInviteLink" ? { status: 400, json: { ok: false, error_code: 400, description: "not enough rights" } } : undefined,
    );
    const res = await call("PATCH", "/api/v1/bots/owner", { headers: asAdmin, json: { join_mode: "approve" } });
    expect(res.status).toBe(200);
    expect(res.body.join_link).toBeNull();
    expect(res.body.notes.join(" ")).toContain("Invite users via link");
  });

  it("messages people who ask to join, and approves them once they pay", async () => {
    await approveMode();
    await telegramUpdate("owner", secret, joinRequest(BUYER));
    const menu = mock.tg("sendMessage").at(-1);
    expect(menu?.body?.chat_id).toBe(BUYER);
    expect(String(menu?.body?.text)).toContain("asking to join");
    expect(buttons(menu?.body).map((b) => b.callback_data)).toEqual(["access:monthly", "access:one_time"]);
    expect(mock.tg("approveChatJoinRequest")).toHaveLength(0);

    await telegramUpdate("owner", secret, press(BUYER, "pay:monthly:paystack"));
    const orderId = buttons(mock.tg("editMessageText").at(-1)?.body).find((b) => b.url)!.url!.split("/").pop()!;
    await payByPaystack(orderId);

    expect(mock.tg("approveChatJoinRequest").at(-1)?.body).toEqual({ chat_id: OWNER_GROUP, user_id: BUYER });
    expect(mock.tg("sendMessage").some((c) => String(c.body?.text).includes("request to join was approved"))).toBe(true);
  });

  it("sends a single-use link when there is no pending request", async () => {
    await approveMode();
    mock.on((c) =>
      c.tgMethod === "approveChatJoinRequest"
        ? { status: 400, json: { ok: false, error_code: 400, description: "HIDE_REQUESTER_MISSING" } }
        : c.tgMethod === "createChatInviteLink" && c.body?.member_limit === 1
          ? { json: { ok: true, result: { invite_link: "https://t.me/+oneTimeLink" } } }
          : undefined,
    );
    await call("POST", `/api/v1/bots/owner/members/${BUYER}/grant`, { headers: asAdmin });
    const link = mock.tg("createChatInviteLink").find((c) => c.body?.member_limit === 1);
    expect(link?.body).toMatchObject({ chat_id: OWNER_GROUP, member_limit: 1 });
    const sent = mock.tg("sendMessage").find((c) => c.body?.chat_id === BUYER);
    expect(buttons(sent?.body)[0]).toMatchObject({ url: "https://t.me/+oneTimeLink" });
  });

  it("approves members who have already paid straight away", async () => {
    await approveMode();
    await call("POST", `/api/v1/bots/owner/members/${BUYER}/grant`, { headers: asAdmin });
    const before = mock.tg("approveChatJoinRequest").length;
    await telegramUpdate("owner", secret, joinRequest(BUYER));
    expect(mock.tg("approveChatJoinRequest")).toHaveLength(before + 1);
  });

  it("leaves join requests to the group's admins in mute mode", async () => {
    await telegramUpdate("owner", secret, joinRequest(BUYER));
    expect(mock.tg("approveChatJoinRequest")).toHaveLength(0);
    expect(mock.tg("sendMessage")).toHaveLength(0);
  });

  it("removes members from the group when a monthly plan runs out", async () => {
    await approveMode();
    const at = Date.UTC(2026, 0, 1, 12, 0);
    await env.DB.prepare(
      `INSERT INTO members (id, bot_id, telegram_id, has_access, access_type, access_expires, joined_at)
       VALUES ('m1', 'owner', ?1, 1, 'monthly', ?2, 0)`,
    ).bind(BUYER, at / 1000 - 60).run();
    await runCron(at);
    expect(mock.tg("banChatMember").at(-1)?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: BUYER });
    expect(mock.tg("unbanChatMember").at(-1)?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: BUYER, only_if_banned: true });
    expect(mock.tg("restrictChatMember")).toHaveLength(0);
  });

  it("flags a missing 'Invite users' permission in the connection check", async () => {
    await approveMode();
    mock.on((c) =>
      c.tgMethod === "getChatMember"
        ? { json: { ok: true, result: { status: "administrator", can_restrict_members: true, can_invite_users: false, user: { id: 1 } } } }
        : undefined,
    );
    const res = await call("GET", "/api/v1/bots/owner/check", { headers: asAdmin });
    expect(res.body.checks.telegram_group.ok).toBe(false);
    expect(res.body.checks.telegram_group.detail).toContain("Invite users via link");
  });
});
