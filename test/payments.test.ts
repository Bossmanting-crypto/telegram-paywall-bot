import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentRow } from "../src/db";
import { confirmPayment } from "../src/payments";
import {
  OWNER_GROUP,
  OWNER_TOKEN,
  asAdmin,
  btcpaySignature,
  call,
  createBot,
  env,
  envWith,
  memberRow,
  mockFetch,
  nowpaymentsSignature,
  paymentRow,
  paystackSignature,
  resetDatabase,
  signup,
  type Mock,
} from "./helpers";

let mock: Mock;
beforeEach(async () => {
  mock = mockFetch();
  await resetDatabase();
});

const BUYER = 5550001;

async function link(headers: Record<string, string>, botId: string, provider: string, accessType = "one_time", telegramId = BUYER) {
  const res = await call("POST", "/api/v1/payments/generate-link", {
    headers,
    json: { bot_id: botId, telegram_id: telegramId, access_type: accessType, provider },
  });
  if (res.status !== 200) throw new Error(`generate-link failed: ${res.status} ${res.text}`);
  return res.body as { payment_url: string; order_id: string; amount: number; platform_fee: number; net_to_creator: number };
}

/** Make Paystack's verify endpoint report this transaction. */
function paystackVerifies(reference: string, data: Record<string, unknown>): void {
  mock.on((c) =>
    c.url === `https://api.paystack.co/transaction/verify/${reference}`
      ? { json: { status: true, data: { reference, ...data } } }
      : undefined,
  );
}

function paystackEvent(reference: string, event = "charge.success"): string {
  return JSON.stringify({ event, data: { reference, status: "success", amount: 1 } });
}

describe("creating payment links", () => {
  it("creates a Paystack link and records the split", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "paystack");

    expect(p.order_id).toMatch(/^5550001-[0-9a-f]{12}$/);
    expect(p.amount).toBe(10);
    expect(p.platform_fee).toBe(1.5);
    expect(p.net_to_creator).toBe(8.5);
    expect(p.payment_url).toBe(`https://checkout.paystack.com/${p.order_id}`);

    const init = mock.calls.find((c) => c.url.endsWith("/transaction/initialize"));
    expect(init?.headers.authorization).toBe("Bearer sk_test_tenant_1");
    expect(init?.body).toMatchObject({
      amount: 1000,
      currency: "USD",
      reference: p.order_id,
      email: "5550001@telegram.user",
      callback_url: "https://paywall.test/payment/success",
    });
    expect(init?.body).not.toHaveProperty("subaccount");

    const row = await paymentRow(p.order_id);
    expect(row).toMatchObject({ status: "pending", provider: "paystack", bot_id: bot.id, charge_amount_minor: 1000, charge_currency: "USD" });

    const lookup = await call("GET", `/api/v1/payments/${p.order_id}`, { headers: t.headers });
    expect(lookup.body.status).toBe("pending");
    const stranger = await signup();
    expect((await call("GET", `/api/v1/payments/${p.order_id}`, { headers: stranger.headers })).status).toBe(404);
  });

  it("charges the owner bot in KES at the configured rate, as the original bot did", async () => {
    const res = await call("POST", "/api/v1/payments/generate-link", {
      headers: asAdmin,
      json: { bot_id: "owner", telegram_id: BUYER, access_type: "one_time", provider: "paystack" },
    });
    expect(res.status).toBe(200);
    expect(res.body.platform_fee).toBe(0);
    const init = mock.calls.find((c) => c.url.endsWith("/transaction/initialize"));
    expect(init?.headers.authorization).toBe("Bearer sk_test_owner_paystack_secret");
    expect(init?.body).toMatchObject({
      amount: 129000, // $10 × 129 KES × 100
      currency: "KES",
      channels: ["card", "mobile_money", "bank"],
    });
  });

  it("creates NOWPayments and BTCPay invoices with the right callback and keys", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);

    const now = await link(t.headers, bot.id, "nowpayments", "monthly");
    const nowCall = mock.calls.find((c) => c.url === "https://api.nowpayments.io/v1/invoice");
    expect(nowCall?.headers["x-api-key"]).toBe("now-key-1");
    expect(nowCall?.body).toMatchObject({
      price_amount: 5,
      price_currency: "usd",
      order_id: now.order_id,
      ipn_callback_url: `https://paywall.test/webhooks/nowpayments/${bot.id}`,
    });

    const btc = await link(t.headers, bot.id, "btcpay");
    const btcCall = mock.calls.find((c) => c.url === "https://pay.creator.example/api/v1/stores/store1/invoices");
    expect(btcCall?.headers.authorization).toBe("token btc-key-1");
    expect(btcCall?.body).toMatchObject({ amount: "10", currency: "USD", metadata: { orderId: btc.order_id } });
    expect((await paymentRow(btc.order_id))?.provider_invoice_id).toBe("inv_btc_1");
  });

  it("marks the order failed when the provider refuses it", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    mock.on((c) =>
      c.url.endsWith("/transaction/initialize") ? { status: 401, json: { status: false, message: "Invalid key" } } : undefined,
    );
    const res = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER, access_type: "one_time", provider: "paystack" },
    });
    expect(res.status).toBe(502);
    expect(res.body.detail).toBe("paystack error: Invalid key");
    const row = await env.DB.prepare("SELECT status FROM payments WHERE bot_id = ?1").bind(bot.id).first<{ status: string }>();
    expect(row?.status).toBe("failed");
  });

  it("hides crypto providers that have no webhook secret", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1, { nowpayments_ipn_secret: undefined, btcpay_webhook_secret: undefined });
    const detail = await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers });
    expect(detail.body.payment_providers).toEqual(["paystack"]);
    const res = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER, access_type: "one_time", provider: "nowpayments" },
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("not configured");
  });

  it("validates access type and provider, and refuses paused bots", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const post = (json: Record<string, unknown>) =>
      call("POST", "/api/v1/payments/generate-link", { headers: t.headers, json: { bot_id: bot.id, telegram_id: BUYER, ...json } });
    expect((await post({ access_type: "forever", provider: "paystack" })).status).toBe(400);
    expect((await post({ access_type: "one_time", provider: "stripe" })).status).toBe(400);
    expect((await post({ access_type: "image_unlock", provider: "paystack" })).status).toBe(400); // vault is empty
    await call("PATCH", `/api/v1/bots/${bot.id}`, { headers: t.headers, json: { status: "paused" } });
    expect((await post({ access_type: "one_time", provider: "paystack" })).status).toBe(409);
  });

  it("caps the free tier at 10 paying members", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    for (let i = 1; i <= 10; i++) {
      await call("POST", `/api/v1/bots/${bot.id}/members/${9000 + i}/grant`, { headers: t.headers });
    }
    const full = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: BUYER, access_type: "one_time", provider: "paystack" },
    });
    expect(full.status).toBe(403);
    // An existing member can still renew.
    const renew = await call("POST", "/api/v1/payments/generate-link", {
      headers: t.headers,
      json: { bot_id: bot.id, telegram_id: 9001, access_type: "monthly", provider: "paystack" },
    });
    expect(renew.status).toBe(200);
  });

  it("routes the platform cut to a Paystack subaccount when one is set", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const set = await call("POST", `/admin/tenants/${t.id}/paystack-subaccount`, { headers: asAdmin, json: { code: "ACCT_abc123" } });
    expect(set.status).toBe(200);
    await link(t.headers, bot.id, "paystack");
    const init = mock.calls.find((c) => c.url.endsWith("/transaction/initialize"));
    // $10 at 15%: the creator's own account keeps $8.50, the subaccount gets the rest.
    expect(init?.body).toMatchObject({ amount: 1000, subaccount: "ACCT_abc123", transaction_charge: 850, bearer: "account" });
  });
});

describe("Paystack webhook", () => {
  it("unlocks the buyer once a signed, verified payment arrives", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "paystack");
    paystackVerifies(p.order_id, { status: "success", amount: 1000, currency: "USD" });

    const raw = paystackEvent(p.order_id);
    const res = await call("POST", `/webhooks/paystack/${bot.id}`, {
      raw,
      headers: { "x-paystack-signature": await paystackSignature("sk_test_tenant_1", raw) },
    });
    expect(res.status).toBe(200);

    expect((await paymentRow(p.order_id))?.status).toBe("confirmed");
    const member = await memberRow(bot.id, BUYER);
    expect(member).toMatchObject({ has_access: 1, access_type: "one_time", access_expires: null });

    const unlock = mock.tg("restrictChatMember").find((c) => c.tgToken === bot.token);
    expect(unlock?.body).toMatchObject({ chat_id: bot.groupId, user_id: BUYER });
    expect((unlock?.body?.permissions as any).can_send_messages).toBe(true);
    const notice = mock.tg("sendMessage").find((c) => c.tgToken === bot.token && c.body?.chat_id === BUYER);
    expect(String(notice?.body?.text)).toContain("Payment confirmed");

    const overview = await call("GET", "/api/v1/analytics/overview", { headers: t.headers });
    expect(overview.body.all_time).toEqual({ gross: 10, platform_fee: 1.5, net: 8.5, transactions: 1 });
    expect(overview.body.active_members).toBe(1);
  });

  it("rejects a forged signature and changes nothing", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "paystack");
    paystackVerifies(p.order_id, { status: "success", amount: 1000, currency: "USD" });
    const raw = paystackEvent(p.order_id);

    for (const signature of ["", "deadbeef", await paystackSignature("sk_test_someone_else", raw)]) {
      const res = await call("POST", `/webhooks/paystack/${bot.id}`, { raw, headers: { "x-paystack-signature": signature } });
      expect(res.status).toBe(400);
    }
    expect((await paymentRow(p.order_id))?.status).toBe("pending");
    expect(await memberRow(bot.id, BUYER)).toBeNull();
    expect(mock.tg("restrictChatMember")).toHaveLength(0);
  });

  it("does not unlock when Paystack reports a smaller amount, another currency, or a failed charge", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    for (const data of [
      { status: "success", amount: 100, currency: "USD" },
      { status: "success", amount: 1000, currency: "NGN" },
      { status: "failed", amount: 1000, currency: "USD" },
    ]) {
      const p = await link(t.headers, bot.id, "paystack");
      paystackVerifies(p.order_id, data);
      const raw = paystackEvent(p.order_id);
      const res = await call("POST", `/webhooks/paystack/${bot.id}`, {
        raw,
        headers: { "x-paystack-signature": await paystackSignature("sk_test_tenant_1", raw) },
      });
      expect(res.status).toBe(200);
      expect((await paymentRow(p.order_id))?.status).toBe("pending");
    }
    expect(await memberRow(bot.id, BUYER)).toBeNull();
  });

  it("is idempotent: a webhook delivered twice extends a subscription once", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "paystack", "monthly");
    paystackVerifies(p.order_id, { status: "success", amount: 500, currency: "USD" });
    const raw = paystackEvent(p.order_id);
    const headers = { "x-paystack-signature": await paystackSignature("sk_test_tenant_1", raw) };

    await call("POST", `/webhooks/paystack/${bot.id}`, { raw, headers });
    const first = await memberRow(bot.id, BUYER);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(first?.access_type).toBe("monthly");
    expect(first?.access_expires).toBeGreaterThan(nowSeconds + 29 * 86400);
    expect(first?.access_expires).toBeLessThanOrEqual(nowSeconds + 30 * 86400 + 5);

    await call("POST", `/webhooks/paystack/${bot.id}`, { raw, headers });
    await call("POST", `/webhooks/paystack/${bot.id}`, { raw, headers });
    expect((await memberRow(bot.id, BUYER))?.access_expires).toBe(first?.access_expires);
    expect(mock.tg("sendMessage").filter((c) => c.body?.chat_id === BUYER)).toHaveLength(1);
  });

  it("cannot grant twice even when two deliveries race each other", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "paystack", "monthly");
    // Both deliveries read the order while it is still pending…
    const stale = (await paymentRow(p.order_id)) as unknown as PaymentRow;
    expect(stale.status).toBe("pending");
    // …then both try to confirm it.
    expect(await confirmPayment(env, stale)).toBe(true);
    const first = await memberRow(bot.id, BUYER);
    expect(await confirmPayment(env, stale)).toBe(false);
    expect((await memberRow(bot.id, BUYER))?.access_expires).toBe(first?.access_expires);
  });

  it("extends from the current expiry when a member renews early", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    for (let i = 0; i < 2; i++) {
      const p = await link(t.headers, bot.id, "paystack", "monthly");
      paystackVerifies(p.order_id, { status: "success", amount: 500, currency: "USD" });
      const raw = paystackEvent(p.order_id);
      await call("POST", `/webhooks/paystack/${bot.id}`, {
        raw,
        headers: { "x-paystack-signature": await paystackSignature("sk_test_tenant_1", raw) },
      });
    }
    const member = await memberRow(bot.id, BUYER);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(member?.access_expires).toBeGreaterThan(nowSeconds + 59 * 86400);
  });

  it("will not confirm an order through a different bot's webhook", async () => {
    const a = await signup("A");
    const b = await signup("B");
    const botA = await createBot(a.headers, 1);
    const botB = await createBot(b.headers, 2);
    const p = await link(a.headers, botA.id, "paystack");
    paystackVerifies(p.order_id, { status: "success", amount: 1000, currency: "USD" });

    // Creator B signs with their own (valid) key, naming A's order.
    const raw = paystackEvent(p.order_id);
    const res = await call("POST", `/webhooks/paystack/${botB.id}`, {
      raw,
      headers: { "x-paystack-signature": await paystackSignature("sk_test_tenant_2", raw) },
    });
    expect(res.status).toBe(200);
    expect((await paymentRow(p.order_id))?.status).toBe("pending");
    expect(await memberRow(botA.id, BUYER)).toBeNull();
  });

  it("asks Paystack to retry when the verification call fails", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "paystack");
    mock.on((c) => (c.url.includes("/transaction/verify/") ? { status: 500, json: { status: false, message: "down" } } : undefined));
    const raw = paystackEvent(p.order_id);
    const res = await call("POST", `/webhooks/paystack/${bot.id}`, {
      raw,
      headers: { "x-paystack-signature": await paystackSignature("sk_test_tenant_1", raw) },
    });
    expect(res.status).toBe(502);
    expect((await paymentRow(p.order_id))?.status).toBe("pending");
  });

  it("serves the owner bot on the original /webhook/paystack path", async () => {
    const created = await call("POST", "/api/v1/payments/generate-link", {
      headers: asAdmin,
      json: { bot_id: "owner", telegram_id: BUYER, access_type: "one_time", provider: "paystack" },
    });
    const orderId = created.body.order_id as string;
    paystackVerifies(orderId, { status: "success", amount: 129000, currency: "KES" });
    const raw = paystackEvent(orderId);
    const res = await call("POST", "/webhook/paystack", {
      raw,
      headers: { "x-paystack-signature": await paystackSignature("sk_test_owner_paystack_secret", raw) },
    });
    expect(res.status).toBe(200);
    expect((await paymentRow(orderId))?.status).toBe("confirmed");
    const unlock = mock.tg("restrictChatMember").find((c) => c.tgToken === OWNER_TOKEN);
    expect(unlock?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: BUYER });
  });

  it("returns 404 for bots that do not exist", async () => {
    const res = await call("POST", "/webhooks/paystack/nope", { raw: "{}", headers: { "x-paystack-signature": "x" } });
    expect(res.status).toBe(404);
  });
});

describe("NOWPayments webhook", () => {
  const ipn = (orderId: string, status: string, extra: Record<string, unknown> = {}) => ({
    payment_id: 4455667788,
    payment_status: status,
    pay_address: "bc1qexample",
    price_amount: 10,
    price_currency: "usd",
    pay_amount: 0.00015,
    actually_paid: 0.00015,
    pay_currency: "btc",
    order_id: orderId,
    order_description: "VIP",
    fee: { currency: "btc", depositFee: 0.000001, withdrawalFee: 0, serviceFee: 0 },
    ...extra,
  });

  it("unlocks on a correctly signed finished payment", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "nowpayments");
    const payload = ipn(p.order_id, "finished");
    const res = await call("POST", `/webhooks/nowpayments/${bot.id}`, {
      // Key order on the wire differs from the sorted order that is signed.
      raw: JSON.stringify(payload),
      headers: { "x-nowpayments-sig": await nowpaymentsSignature("now-ipn-1", payload) },
    });
    expect(res.status).toBe(200);
    expect((await paymentRow(p.order_id))?.status).toBe("confirmed");
    expect((await memberRow(bot.id, BUYER))?.has_access).toBe(1);
  });

  it("ignores partial payments, waiting payments and underpriced invoices", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "nowpayments");
    for (const payload of [
      ipn(p.order_id, "partially_paid"),
      ipn(p.order_id, "waiting"),
      ipn(p.order_id, "failed"),
      ipn(p.order_id, "finished", { price_amount: 0.5 }),
      ipn(p.order_id, "finished", { price_currency: "ngn" }),
    ]) {
      const res = await call("POST", `/webhooks/nowpayments/${bot.id}`, {
        raw: JSON.stringify(payload),
        headers: { "x-nowpayments-sig": await nowpaymentsSignature("now-ipn-1", payload) },
      });
      expect(res.status).toBe(200);
    }
    expect((await paymentRow(p.order_id))?.status).toBe("pending");
    expect(await memberRow(bot.id, BUYER)).toBeNull();
  });

  it("rejects unsigned and wrongly signed notifications", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "nowpayments");
    const payload = ipn(p.order_id, "finished");
    const raw = JSON.stringify(payload);
    expect((await call("POST", `/webhooks/nowpayments/${bot.id}`, { raw })).status).toBe(400);
    expect(
      (await call("POST", `/webhooks/nowpayments/${bot.id}`, { raw, headers: { "x-nowpayments-sig": await nowpaymentsSignature("guess", payload) } })).status,
    ).toBe(400);
    // Signature for a different body does not carry over.
    const other = await nowpaymentsSignature("now-ipn-1", ipn("someone-else", "finished"));
    expect((await call("POST", `/webhooks/nowpayments/${bot.id}`, { raw, headers: { "x-nowpayments-sig": other } })).status).toBe(400);
    expect((await paymentRow(p.order_id))?.status).toBe("pending");
  });

  it("serves the owner bot on the original /webhook/nowpayments path", async () => {
    const created = await call("POST", "/api/v1/payments/generate-link", {
      headers: asAdmin,
      json: { bot_id: "owner", telegram_id: BUYER, access_type: "monthly", provider: "nowpayments" },
    });
    const payload = ipn(created.body.order_id, "confirmed", { price_amount: 5 });
    const res = await call("POST", "/webhook/nowpayments", {
      raw: JSON.stringify(payload),
      headers: { "x-nowpayments-sig": await nowpaymentsSignature("owner-nowpayments-ipn-secret", payload) },
    });
    expect(res.status).toBe(200);
    expect((await paymentRow(created.body.order_id))?.status).toBe("confirmed");
  });
});

describe("BTCPay webhook", () => {
  const invoiceUrl = "https://pay.creator.example/api/v1/stores/store1/invoices/inv_btc_1";
  const serverSays = (invoice: Record<string, unknown>) =>
    mock.on((c) => (c.url === invoiceUrl && c.method === "GET" ? { json: { id: "inv_btc_1", ...invoice } } : undefined));
  const event = (type: string) => JSON.stringify({ type, invoiceId: "inv_btc_1", storeId: "store1" });

  it("unlocks when the server confirms the invoice is settled", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "btcpay");
    serverSays({ status: "Settled", amount: "10", currency: "USD", metadata: { orderId: p.order_id } });
    const raw = event("InvoiceSettled");
    const res = await call("POST", `/webhooks/btcpay/${bot.id}`, { raw, headers: { "btcpay-sig": await btcpaySignature("btc-whsec-1", raw) } });
    expect(res.status).toBe(200);
    expect((await paymentRow(p.order_id))?.status).toBe("confirmed");
    expect((await memberRow(bot.id, BUYER))?.has_access).toBe(1);
  });

  it("trusts the server over the webhook: an unpaid or mismatched invoice does not unlock", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "btcpay");
    const raw = event("InvoiceSettled");
    const headers = { "btcpay-sig": await btcpaySignature("btc-whsec-1", raw) };
    for (const invoice of [
      { status: "New", amount: "10", currency: "USD", metadata: { orderId: p.order_id } },
      { status: "Settled", amount: "1", currency: "USD", metadata: { orderId: p.order_id } },
      { status: "Settled", amount: "10", currency: "USD", metadata: { orderId: "another-order" } },
    ]) {
      serverSays(invoice);
      expect((await call("POST", `/webhooks/btcpay/${bot.id}`, { raw, headers })).status).toBe(200);
      expect((await paymentRow(p.order_id))?.status).toBe("pending");
    }
  });

  it("rejects a bad signature", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const p = await link(t.headers, bot.id, "btcpay");
    serverSays({ status: "Settled", amount: "10", currency: "USD" });
    const raw = event("InvoiceSettled");
    expect((await call("POST", `/webhooks/btcpay/${bot.id}`, { raw, headers: { "btcpay-sig": await btcpaySignature("wrong", raw) } })).status).toBe(400);
    expect((await call("POST", `/webhooks/btcpay/${bot.id}`, { raw })).status).toBe(400);
    expect((await paymentRow(p.order_id))?.status).toBe("pending");
  });

  it("can be told to wait for confirmations (owner setting)", async () => {
    const created = await call("POST", "/api/v1/payments/generate-link", {
      headers: asAdmin,
      json: { bot_id: "owner", telegram_id: BUYER, access_type: "one_time", provider: "btcpay" },
    });
    const orderId = created.body.order_id as string;
    mock.on((c) =>
      c.url === "https://btcpay.example.com/api/v1/stores/ownerStore/invoices/inv_btc_1"
        ? { json: { id: "inv_btc_1", status: "Processing", amount: "10", currency: "USD", metadata: { orderId } } }
        : undefined,
    );
    const raw = JSON.stringify({ type: "InvoiceProcessing", invoiceId: "inv_btc_1" });
    const headers = { "btcpay-sig": await btcpaySignature("owner-btcpay-webhook-secret", raw) };

    const strict = envWith({ BTCPAY_ACCEPT_UNCONFIRMED: "false" });
    expect((await call("POST", "/webhook/btcpay", { raw, headers, env: strict })).status).toBe(200);
    expect((await paymentRow(orderId))?.status).toBe("pending");

    // Default behaviour (as in the original bot): unlock while confirmations are pending.
    expect((await call("POST", "/webhook/btcpay", { raw, headers })).status).toBe(200);
    expect((await paymentRow(orderId))?.status).toBe("confirmed");
  });
});
