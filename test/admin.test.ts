import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hmacHex, maskSecret, safeEqual } from "../src/lib/crypto";
import * as btcpay from "../src/providers/btcpay";
import * as nowpayments from "../src/providers/nowpayments";
import * as paystack from "../src/providers/paystack";
import { ADMIN_KEY, OWNER_TOKEN, asAdmin, call, envWith, hmac, mockFetch, ownerWebhookSecret, resetDatabase, type Mock } from "./helpers";

let mock: Mock;
beforeEach(async () => {
  mock = mockFetch();
  await resetDatabase();
});

const OWNER_SECRETS = [
  ADMIN_KEY,
  OWNER_TOKEN,
  "sk_test_owner_paystack_secret",
  "owner-nowpayments-api-key",
  "owner-nowpayments-ipn-secret",
  "owner-btcpay-api-key",
  "owner-btcpay-webhook-secret",
  "test-encryption-passphrase-0123456789abcdef",
];

describe("admin access", () => {
  it("serves the admin page without exposing anything", async () => {
    const res = await call("GET", "/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    for (const secret of OWNER_SECRETS) expect(res.text).not.toContain(secret);
  });

  it("requires the admin key on every admin route", async () => {
    for (const [method, path] of [
      ["POST", "/admin/setup"],
      ["GET", "/admin/check-credentials"],
      ["GET", "/admin/overview"],
      ["GET", "/admin/tenants"],
    ] as const) {
      expect((await call(method, path)).status).toBe(401);
      expect((await call(method, path, { headers: { "x-admin-key": `${ADMIN_KEY}x` } })).status).toBe(401);
      expect((await call(method, path, { headers: { "x-api-key": ADMIN_KEY } })).status).toBe(401);
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses to run with a missing or weak admin key", async () => {
    for (const weak of [undefined, "short"]) {
      const res = await call("GET", "/admin/overview", {
        headers: { "x-admin-key": weak ?? "" },
        env: envWith({ ADMIN_API_KEY: weak }),
      });
      expect(res.status).toBe(503);
    }
  });

  it("accepts the key as a bearer token too", async () => {
    expect((await call("GET", "/admin/overview", { headers: { authorization: `Bearer ${ADMIN_KEY}` } })).status).toBe(200);
  });
});

describe("setup", () => {
  it("points Telegram at this Worker and reports the result", async () => {
    mock.on((c) =>
      c.tgMethod === "getWebhookInfo"
        ? { json: { ok: true, result: { url: "https://paywall.test/telegram/owner", pending_update_count: 0 } } }
        : undefined,
    );
    const res = await call("POST", "/admin/setup", { headers: asAdmin });
    expect(res.status).toBe(200);

    const hook = mock.tg("setWebhook")[0];
    expect(hook?.tgToken).toBe(OWNER_TOKEN);
    expect(hook?.body).toMatchObject({
      url: "https://paywall.test/telegram/owner",
      secret_token: await ownerWebhookSecret(),
    });
    expect(hook?.body?.allowed_updates).toEqual(["message", "callback_query", "chat_member", "my_chat_member", "chat_join_request"]);

    expect(res.body).toMatchObject({
      ok: true,
      ready: true,
      problems: [],
      bot: "@bot111111111",
      group_chat_id: -1001111111111,
      admin_user_ids: [42],
      prices_usd: { one_time: 10, monthly: 5, image_unlock: 0 },
    });
    expect(res.body.payment_webhooks.paystack).toBe("https://paywall.test/webhooks/paystack/owner");
    expect(res.body.checks.paystack).toMatchObject({ ok: true, mode: "test", charges_in: "KES", usd_rate: 129 });
    expect(res.body.checks.paystack.warnings[0]).toContain("TEST key");
    for (const secret of OWNER_SECRETS) expect(res.text).not.toContain(secret);
  });

  it("uses APP_URL when it is set, e.g. for a custom domain", async () => {
    await call("POST", "/admin/setup", { headers: asAdmin, env: envWith({ APP_URL: "https://pay.mybrand.com/" }) });
    expect(mock.tg("setWebhook")[0]?.body?.url).toBe("https://pay.mybrand.com/telegram/owner");
  });

  it("explains what is wrong when the bot token is missing or refused", async () => {
    const missing = await call("POST", "/admin/setup", { headers: asAdmin, env: envWith({ TELEGRAM_BOT_TOKEN: undefined }) });
    expect(missing.status).toBe(400);
    expect(missing.body.detail).toContain("TELEGRAM_BOT_TOKEN is not set");

    mock.on((c) => (c.tgMethod === "getMe" ? { status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } } : undefined));
    const refused = await call("POST", "/admin/setup", { headers: asAdmin });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toContain("Telegram rejected TELEGRAM_BOT_TOKEN");
    expect(mock.tg("setWebhook")).toHaveLength(0);
  });
});

describe("credential check", () => {
  it("reports each credential as accepted or rejected by its provider", async () => {
    mock.on((c) => {
      if (c.url === "https://api.paystack.co/balance") return { status: 401, json: { status: false, message: "Invalid key" } };
      if (c.url === "https://api.nowpayments.io/v1/currencies") return { status: 403, json: { message: "Invalid api key" } };
      if (c.tgMethod === "getChatMember") return { json: { ok: true, result: { status: "member", user: { id: 1 } } } };
      return undefined;
    });
    const res = await call("GET", "/admin/check-credentials", { headers: asAdmin });
    expect(res.status).toBe(200);
    const checks = res.body.owner_bot.checks;
    expect(checks.telegram_token.ok).toBe(true);
    expect(checks.telegram_webhook.ok).toBe(false); // setup has not been run
    expect(checks.telegram_group.ok).toBe(false);
    expect(checks.telegram_group.detail).toContain("not an admin");
    expect(checks.paystack.ok).toBe(false);
    expect(checks.paystack.detail).toContain("Invalid key");
    expect(checks.nowpayments.ok).toBe(false);
    expect(checks.btcpay.ok).toBe(true);
    expect(res.body.owner_bot.ready).toBe(false);
    expect(res.body.platform.encryption_key).toBe("set");
    for (const secret of OWNER_SECRETS) expect(res.text).not.toContain(secret);

    // Each provider was asked with the right credential.
    expect(mock.calls.find((c) => c.url === "https://api.paystack.co/balance")?.headers.authorization).toBe("Bearer sk_test_owner_paystack_secret");
    expect(mock.calls.find((c) => c.url.endsWith("/v1/currencies"))?.headers["x-api-key"]).toBe("owner-nowpayments-api-key");
    expect(mock.calls.find((c) => c.url === "https://btcpay.example.com/api/v1/stores/ownerStore")?.headers.authorization).toBe("token owner-btcpay-api-key");
  });

  it("treats unconfigured providers as skipped, and flags missing webhook secrets", async () => {
    const res = await call("GET", "/admin/check-credentials", {
      headers: asAdmin,
      env: envWith({ PAYSTACK_SECRET_KEY: undefined, NOWPAYMENTS_IPN_SECRET: undefined, BTCPAY_WEBHOOK_SECRET: undefined, GROUP_CHAT_ID: undefined }),
    });
    const checks = res.body.owner_bot.checks;
    expect(checks.paystack.ok).toBeNull();
    expect(checks.nowpayments.ok).toBe(false);
    expect(checks.nowpayments.detail).toContain("IPN secret is missing");
    expect(checks.btcpay.ok).toBe(false);
    expect(checks.telegram_group.ok).toBeNull();
    expect(res.body.owner_bot.problems.join(" ")).toContain("No payment provider is working");
  });

  it("warns when live and test Paystack keys are mixed", async () => {
    const res = await call("GET", "/admin/check-credentials", {
      headers: asAdmin,
      env: envWith({ PAYSTACK_SECRET_KEY: "sk_live_realkey_abcd", PAYSTACK_PUBLIC_KEY: "pk_test_other" }),
    });
    const check = res.body.owner_bot.checks.paystack;
    expect(check.mode).toBe("live");
    expect(check.key).toBe("sk_live_…abcd");
    expect(check.warnings.join(" ")).toContain("Secret key is live but public key is test");
  });
});

describe("platform overview", () => {
  it("lists creators and totals", async () => {
    await call("POST", "/api/v1/tenants/signup", { json: { email: "a@example.com", name: "A" } });
    const overview = await call("GET", "/admin/overview", { headers: asAdmin });
    expect(overview.body.creators).toEqual({ total: 1, on_free_trial: 1 });
    const tenants = await call("GET", "/admin/tenants", { headers: asAdmin });
    expect(tenants.body.count).toBe(1);
    expect(tenants.body.tenants[0]).toMatchObject({ email: "a@example.com", tier: "free", platform_cut: 0.15, active: true });
    expect(tenants.text).not.toContain("pbk_");
  });

  it("suspends a creator: their key stops working", async () => {
    const signup = await call("POST", "/api/v1/tenants/signup", { json: { email: "s@example.com", name: "S" } });
    const headers = { "x-api-key": signup.body.api_key };
    await call("POST", `/admin/tenants/${signup.body.id}/active`, { headers: asAdmin, json: { active: false } });
    expect((await call("GET", "/api/v1/tenants/me", { headers })).status).toBe(401);
    await call("POST", `/admin/tenants/${signup.body.id}/active`, { headers: asAdmin, json: { active: true } });
    expect((await call("GET", "/api/v1/tenants/me", { headers })).status).toBe(200);
  });
});

describe("crypto helpers", () => {
  it("encrypts with a fresh IV each time and round-trips", async () => {
    const pass = "a-passphrase-that-is-at-least-32-chars";
    const a = await encryptSecret(pass, "sk_live_secret");
    const b = await encryptSecret(pass, "sk_live_secret");
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk_live_secret");
    expect(await decryptSecret(pass, a)).toBe("sk_live_secret");
    await expect(decryptSecret("a-different-passphrase-of-32-chars!!", a)).rejects.toThrow();
    const tampered = a.slice(0, -4) + (a.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptSecret(pass, tampered)).rejects.toThrow();
  });

  it("computes HMACs that match the published RFC 4231 test vectors", async () => {
    // RFC 4231, test case 2.
    const key = "Jefe";
    const data = "what do ya want for nothing?";
    expect(await hmacHex("SHA-256", key, data)).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(await hmacHex("SHA-512", key, data)).toBe(
      "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554" +
        "9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
    );
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
  });

  it("verifies provider signatures", async () => {
    const body = '{"z":1,"a":{"y":2,"b":3}}';
    const paystackSig = await hmac("SHA-512", "sk", body);
    expect(await paystack.verifySignature("sk", body, paystackSig)).toBe(true);
    expect(await paystack.verifySignature("sk", body, paystackSig.toUpperCase())).toBe(true);
    expect(await paystack.verifySignature("sk", `${body} `, paystackSig)).toBe(false);
    expect(await paystack.verifySignature("other", body, paystackSig)).toBe(false);

    // NOWPayments signs the key-sorted, compact form of the body.
    const nowSig = await hmac("SHA-512", "ipn", '{"a":{"b":3,"y":2},"z":1}');
    expect(await nowpayments.verifySignature("ipn", body, nowSig)).toBe(true);
    expect(await nowpayments.verifySignature("ipn", '{ "z": 1, "a": { "y": 2, "b": 3 } }', nowSig)).toBe(true);
    expect(await nowpayments.verifySignature("ipn", '{"z":2,"a":{"y":2,"b":3}}', nowSig)).toBe(false);
    expect(await nowpayments.verifySignature("ipn", "not json", nowSig)).toBe(false);

    const btcSig = await hmac("SHA-256", "wh", body);
    expect(await btcpay.verifySignature("wh", body, `sha256=${btcSig}`)).toBe(true);
    expect(await btcpay.verifySignature("wh", body, btcSig)).toBe(true);
    expect(await btcpay.verifySignature("wh", body, "sha256=00")).toBe(false);
  });

  it("masks secrets and vets server URLs", () => {
    expect(maskSecret("sk_live_abcdefgh1234")).toBe("sk_live_…1234");
    expect(maskSecret("plainapikey9876")).toBe("…9876");
    expect(maskSecret(null)).toBeNull();
    expect(btcpay.isAcceptableServerUrl("https://btcpay.example.com")).toBe(true);
    for (const bad of ["http://btcpay.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "ftp://x.com", "nonsense"]) {
      expect(btcpay.isAcceptableServerUrl(bad)).toBe(false);
    }
    expect(paystack.toMinorUnits(10, 129)).toBe(129000);
    expect(paystack.toMinorUnits(9.99, 1)).toBe(999);
  });
});
