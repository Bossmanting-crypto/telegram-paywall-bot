import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_KEY,
  OWNER_TOKEN,
  asAdmin,
  botToken,
  call,
  createBot,
  env,
  envWith,
  memberRow,
  mockFetch,
  resetDatabase,
  signup,
  type Mock,
} from "./helpers";

let mock: Mock;
beforeEach(async () => {
  mock = mockFetch();
  await resetDatabase();
});

describe("service", () => {
  it("answers on / and /health", async () => {
    expect((await call("GET", "/health")).body).toEqual({ status: "healthy" });
    const root = await call("GET", "/");
    expect(root.status).toBe(200);
    expect(root.body.status).toBe("online");
  });

  it("refuses oversized request bodies", async () => {
    const res = await call("POST", "/api/v1/tenants/signup", { raw: JSON.stringify({ email: "a@b.co", name: "x".repeat(300_000) }) });
    expect(res.status).toBe(413);
  });

  it("returns JSON 404 for unknown paths", async () => {
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Not found");
  });

  it("only allows configured browser origins", async () => {
    const ok = await call("OPTIONS", "/api/v1/bots", {
      headers: { origin: "https://dashboard.example.com", "access-control-request-method": "GET" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://dashboard.example.com");
    const other = await call("OPTIONS", "/api/v1/bots", {
      headers: { origin: "https://evil.example.com", "access-control-request-method": "GET" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("tenants", () => {
  it("signs up, shows the key once, and stores only its hash", async () => {
    const res = await call("POST", "/api/v1/tenants/signup", {
      json: { email: "New@Example.com", name: "My Brand" },
    });
    expect(res.status).toBe(200);
    expect(res.body.api_key).toMatch(/^pbk_[0-9a-f]{64}$/);
    expect(res.body.tier).toBe("free");
    expect(res.body.platform_cut).toBe("12%");

    const row = await env.DB.prepare("SELECT * FROM tenants WHERE email = 'new@example.com'").first<Record<string, any>>();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(res.body.api_key);

    const me = await call("GET", "/api/v1/tenants/me", { headers: { "x-api-key": res.body.api_key } });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("new@example.com");
    expect(JSON.stringify(me.body)).not.toContain(res.body.api_key);
  });

  it("rejects duplicate emails and bad input", async () => {
    const body = { email: "dup@example.com", name: "A" };
    expect((await call("POST", "/api/v1/tenants/signup", { json: body })).status).toBe(200);
    const dup = await call("POST", "/api/v1/tenants/signup", { json: body });
    expect(dup.status).toBe(400);
    expect(dup.body.detail).toBe("Email already registered.");
    expect((await call("POST", "/api/v1/tenants/signup", { json: { email: "not-an-email", name: "A" } })).status).toBe(422);
    expect((await call("POST", "/api/v1/tenants/signup", { raw: "{not json" })).status).toBe(400);
  });

  it("rejects missing, malformed and unknown API keys", async () => {
    expect((await call("GET", "/api/v1/tenants/me")).status).toBe(401);
    expect((await call("GET", "/api/v1/tenants/me", { headers: { "x-api-key": "nope" } })).status).toBe(401);
    const unknown = await call("GET", "/api/v1/tenants/me", { headers: { "x-api-key": `pbk_${"0".repeat(64)}` } });
    expect(unknown.status).toBe(401);
  });

  it("rotates a key: the old one stops working", async () => {
    const t = await signup();
    const rotated = await call("POST", "/api/v1/tenants/rotate-key", { headers: t.headers });
    expect(rotated.status).toBe(200);
    expect(rotated.body.api_key).not.toBe(t.apiKey);
    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).status).toBe(401);
    expect((await call("GET", "/api/v1/tenants/me", { headers: { "x-api-key": rotated.body.api_key } })).status).toBe(200);
  });

  it("does not let a creator upgrade their own plan", async () => {
    const t = await signup();
    const res = await call("POST", "/api/v1/tenants/upgrade", { headers: t.headers, json: { tier: "whitelabel" } });
    expect(res.status).toBe(402);
    const me = await call("GET", "/api/v1/tenants/me", { headers: t.headers });
    expect(me.body.tier).toBe("free");
    expect(me.body.platform_cut).toBe("12%");
  });

  it("lets the platform owner change a plan, and nobody else", async () => {
    const t = await signup();
    const path = `/admin/tenants/${t.id}/tier`;
    expect((await call("POST", path, { json: { tier: "starter" } })).status).toBe(401);
    expect((await call("POST", path, { headers: { "x-admin-key": "wrong" }, json: { tier: "starter" } })).status).toBe(401);
    expect((await call("POST", path, { headers: t.headers, json: { tier: "starter" } })).status).toBe(401);

    const ok = await call("POST", path, { headers: asAdmin, json: { tier: "starter" } });
    expect(ok.status).toBe(200);
    const me = await call("GET", "/api/v1/tenants/me", { headers: t.headers });
    expect(me.body.tier).toBe("starter");
    expect(me.body.platform_cut).toBe("5%");
    expect(me.body.trial_ends).toBeNull();
  });

  it("can close signups", async () => {
    const res = await call("POST", "/api/v1/tenants/signup", {
      json: { email: "closed@example.com", name: "A" },
      env: envWith({ ALLOW_SIGNUPS: "false" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("bots", () => {
  it("creates a bot, registers its Telegram webhook, and encrypts credentials at rest", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);

    const hook = mock.tg("setWebhook").find((c) => c.tgToken === bot.token);
    expect(hook?.body?.url).toBe(`https://paywall.test/telegram/${bot.id}`);
    expect(hook?.body?.secret_token).toBe(bot.webhookSecret);
    expect(hook?.body?.allowed_updates).toContain("chat_member");

    const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?1").bind(bot.id).first<Record<string, any>>();
    const stored = JSON.stringify(row);
    for (const secret of [bot.token, "sk_test_tenant_1", "now-key-1", "now-ipn-1", "btc-key-1", "btc-whsec-1"]) {
      expect(stored).not.toContain(secret);
    }
    expect(row?.bot_token_enc).toMatch(/^v1\./);

    const detail = await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers });
    expect(detail.status).toBe(200);
    expect(detail.body.payment_providers).toEqual(["paystack", "nowpayments", "btcpay"]);
    expect(detail.body.credentials.paystack_secret_key).toBe("sk_test_…nt_1");
    expect(detail.text).not.toContain("sk_test_tenant_1");
    expect(detail.body.webhooks.paystack).toBe(`https://paywall.test/webhooks/paystack/${bot.id}`);
  });

  it("lets creators on the standard plan run as many bots as they like", async () => {
    const t = await signup();
    await createBot(t.headers, 1);
    await createBot(t.headers, 2);
    await createBot(t.headers, 3);
    expect((await call("GET", "/api/v1/bots", { headers: t.headers })).body.count).toBe(3);
  });

  it("rejects bad tokens, tokens Telegram refuses, and bots already registered", async () => {
    const t = await signup();
    expect((await call("POST", "/api/v1/bots", { headers: t.headers, json: { bot_token: "abc" } })).status).toBe(400);
    expect((await call("POST", "/api/v1/bots", { headers: t.headers, json: { bot_token: OWNER_TOKEN } })).status).toBe(409);

    mock.on((c) =>
      c.tgMethod === "getMe" && c.tgToken === botToken(7)
        ? { status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } }
        : undefined,
    );
    const refused = await call("POST", "/api/v1/bots", { headers: t.headers, json: { bot_token: botToken(7) } });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toContain("Telegram rejected");

    await createBot(t.headers, 1);
    const other = await signup();
    const dup = await call("POST", "/api/v1/bots", { headers: other.headers, json: { bot_token: botToken(1) } });
    expect(dup.status).toBe(409);
  });

  it("removes the bot again if Telegram will not accept the webhook", async () => {
    const t = await signup();
    mock.on((c) =>
      c.tgMethod === "setWebhook" ? { status: 400, json: { ok: false, error_code: 400, description: "bad webhook" } } : undefined,
    );
    const res = await call("POST", "/api/v1/bots", { headers: t.headers, json: { bot_token: botToken(3) } });
    expect(res.status).toBe(502);
    const list = await call("GET", "/api/v1/bots", { headers: t.headers });
    expect(list.body.count).toBe(0);
  });

  it("requires an exchange rate when charging in another currency", async () => {
    const t = await signup();
    const res = await call("POST", "/api/v1/bots", {
      headers: t.headers,
      json: { bot_token: botToken(4), currency: "NGN" },
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain("fx_rate");
  });

  it("keeps creators out of each other's bots and members", async () => {
    const a = await signup("A");
    const b = await signup("B");
    const bot = await createBot(a.headers, 1);

    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: b.headers })).status).toBe(404);
    expect((await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: b.headers, json: { one_time_price: 1 } })).status).toBe(404);
    expect((await call("DELETE", `/api/v1/bots/${bot.id}`, { headers: b.headers })).status).toBe(404);
    expect((await call("GET", `/api/v1/bots/${bot.id}/members`, { headers: b.headers })).status).toBe(404);
    expect((await call("POST", `/api/v1/bots/${bot.id}/members/777/grant`, { headers: b.headers })).status).toBe(404);
    expect((await call("POST", `/api/v1/bots/${bot.id}/members/777/revoke`, { headers: b.headers })).status).toBe(404);
    expect((await call("GET", `/api/v1/bots/${bot.id}/check`, { headers: b.headers })).status).toBe(404);
    const link = await call("POST", "/api/v1/payments/generate-link", {
      headers: b.headers,
      json: { bot_id: bot.id, telegram_id: 777, access_type: "one_time", provider: "paystack" },
    });
    expect(link.status).toBe(404);
    expect(await memberRow(bot.id, 777)).toBeNull();
  });

  it("grants and revokes access, updating Telegram as well as the database", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);

    expect((await call("POST", `/api/v1/bots/${bot.id}/members/777/grant`, { headers: t.headers })).status).toBe(200);
    expect((await memberRow(bot.id, 777))?.has_access).toBe(1);
    const lifted = mock.tg("restrictChatMember").at(-1);
    expect(lifted?.body).toMatchObject({ chat_id: bot.groupId, user_id: 777 });
    expect((lifted?.body?.permissions as any).can_send_messages).toBe(true);

    const members = await call("GET", `/api/v1/bots/${bot.id}/members`, { headers: t.headers });
    expect(members.body.count).toBe(1);
    expect(members.body.members[0].access_type).toBe("manual_grant");

    expect((await call("POST", `/api/v1/bots/${bot.id}/members/777/revoke`, { headers: t.headers })).status).toBe(200);
    expect((await memberRow(bot.id, 777))?.has_access).toBe(0);
    expect((mock.tg("restrictChatMember").at(-1)?.body?.permissions as any).can_send_messages).toBe(false);

    expect((await call("POST", `/api/v1/bots/${bot.id}/members/999/revoke`, { headers: t.headers })).status).toBe(404);
  });

  it("updates settings and can replace payment keys", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const res = await call("PATCH", `/api/v1/bots/${bot.id}`, {
      headers: t.headers,
      json: { one_time_price: 25, welcome_title: "Gold Club", status: "paused", paystack_secret_key: "sk_live_rotated_9999" },
    });
    expect(res.status).toBe(200);
    const detail = await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers });
    expect(detail.body.prices.one_time).toBe(25);
    expect(detail.body.welcome_title).toBe("Gold Club");
    expect(detail.body.status).toBe("paused");
    expect(detail.body.credentials.paystack_secret_key).toBe("sk_live_…9999");

    expect((await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { status: "expired" } })).status).toBe(422);
    expect((await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: {} })).status).toBe(400);
  });

  it("deletes a bot: webhook removed, credentials wiped, token reusable", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    expect((await call("DELETE", `/api/v1/bots/${bot.id}`, { headers: t.headers })).status).toBe(200);
    expect(mock.tg("deleteWebhook").some((c) => c.tgToken === bot.token)).toBe(true);
    expect((await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers })).status).toBe(404);
    const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?1").bind(bot.id).first<Record<string, any>>();
    expect(row?.bot_token_enc).toBeNull();
    expect(row?.paystack_secret_key_enc).toBeNull();
    // Free tier is back to zero bots, and the same Telegram bot can be registered again.
    const again = await call("POST", "/api/v1/bots", { headers: t.headers, json: { bot_token: bot.token } });
    expect(again.status).toBe(200);
  });

  it("refuses to register bots when the platform has no encryption key", async () => {
    const t = await signup();
    const res = await call("POST", "/api/v1/bots", {
      headers: t.headers,
      json: { bot_token: botToken(5) },
      env: envWith({ ENCRYPTION_KEY: undefined }),
    });
    expect(res.status).toBe(503);
  });
});

describe("owner account through the creator API", () => {
  it("lets the admin key act as the owner tenant", async () => {
    const list = await call("GET", "/api/v1/bots", { headers: asAdmin });
    expect(list.status).toBe(200);
    expect(list.body.bots[0].id).toBe("owner");
    expect(list.body.bots[0].prices).toEqual({ currency: "USD", daily: 0, weekly: 0, monthly: 5, one_time: 10, image_vault: 0 });
    expect(list.body.bots[0].group_chat_id).toBe(-1001111111111);

    const overview = await call("GET", "/api/v1/analytics/overview", { headers: asAdmin });
    expect(overview.status).toBe(200);
    expect(overview.body.platform_cut).toBe("0%");
  });

  it("keeps the owner bot's keys out of the API", async () => {
    const patch = await call("PATCH", "/api/v1/bots/owner", {
      headers: asAdmin,
      json: { paystack_secret_key: "sk_live_x" },
    });
    expect(patch.status).toBe(400);
    expect((await call("DELETE", "/api/v1/bots/owner", { headers: asAdmin })).status).toBe(400);
    expect((await call("POST", "/api/v1/bots", { headers: asAdmin, json: { bot_token: botToken(9) } })).status).toBe(400);
    const detail = await call("GET", "/api/v1/bots/owner", { headers: asAdmin });
    expect(detail.text).not.toContain("sk_test_owner_paystack_secret");
    expect(detail.text).not.toContain(OWNER_TOKEN);
    expect(detail.text).not.toContain(ADMIN_KEY);
  });
});
