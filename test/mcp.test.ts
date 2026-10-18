/**
 * MCP server, end to end inside the Workers runtime: OAuth discovery,
 * client registration, the sign-in page, the token exchange, then a real MCP
 * client calling the tools — over both the 2025 and the 2026-07-28 protocol.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  ADMIN_KEY,
  BASE,
  OWNER_GROUP,
  asAdmin,
  call,
  createBot,
  env,
  envWith,
  memberRow,
  mockFetch,
  paymentRow,
  resetDatabase,
  signup,
  type Mock,
} from "./helpers";
import type { AppEnv } from "../src/env";

let mock: Mock;
beforeEach(async () => {
  mock = mockFetch();
  await resetDatabase();
});

const REDIRECT = "https://client.example/callback";

/** Send a request to the whole Worker (not just the HTTP app), as Cloudflare would. */
async function send(request: Request, environment: AppEnv = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64url(random.buffer);
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function register(): Promise<string> {
  const res = await send(
    new Request(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

interface SignInPage {
  url: string;
  handle: string;
  cookie: string;
  html: string;
  verifier: string;
  clientId: string;
}

async function openSignIn(): Promise<SignInPage> {
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const url =
    `${BASE}/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123",
      scope: "paywall",
      resource: `${BASE}/mcp`,
    });
  const res = await send(new Request(url));
  const html = await res.text();
  expect(res.status, html).toBe(200);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  return { url, handle: handle!, cookie: cookiesFrom(res), html, verifier, clientId };
}

function submit(pageInfo: SignInPage, fields: Record<string, string>, cookie = pageInfo.cookie): Promise<Response> {
  return send(
    new Request(pageInfo.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ handle: pageInfo.handle, ...fields }),
    }),
  );
}

async function exchange(pageInfo: SignInPage, code: string): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await send(
    new Request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: pageInfo.clientId,
        code_verifier: pageInfo.verifier,
        resource: `${BASE}/mcp`,
      }),
    }),
  );
  const body = (await res.json()) as { access_token: string; refresh_token?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

/** The whole sign-in, as Claude would do it: returns an access token for the MCP endpoint. */
async function signIn(key: string): Promise<string> {
  const pageInfo = await openSignIn();
  const res = await submit(pageInfo, { decision: "approve", key });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("state-123");
  return (await exchange(pageInfo, location.searchParams.get("code")!)).access_token;
}

type Mode = "legacy" | "modern";

async function connect(token: string, mode: Mode = "legacy", environment: AppEnv = env): Promise<Client> {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    mode === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => send(new Request(input, init), environment),
  });
  await client.connect(transport);
  return client;
}

/**
 * Over the 2025 protocol a tool result streams back as server-sent events, so
 * Telegram calls made in the background can land just after the result does.
 */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

// ── Discovery and sign-in ────────────────────────────────────────────────────

describe("MCP sign-in", () => {
  it("challenges unauthenticated requests and publishes discovery metadata", async () => {
    const res = await send(new Request(`${BASE}/mcp`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);

    const resource = (await (await send(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`))).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });

    const as = (await (await send(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      client_id_metadata_document_supported: true,
    });
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("shows who is asking and where access goes, escaped, with framing blocked", async () => {
    const pageInfo = await openSignIn();
    expect(pageInfo.html).toContain("Allow Test Client to manage your paywall bots?");
    expect(pageInfo.html).toContain("client.example");
    expect(pageInfo.html).toContain('type="password"');
    expect(pageInfo.cookie).toContain("__Host-");

    const res = await send(new Request(pageInfo.url));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // A form-action rule would make browsers block the redirect back to the app after Allow.
    expect(res.headers.get("content-security-policy")).not.toContain("form-action");
  });

  it("escapes a malicious client name", async () => {
    const reg = await send(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: '<script>alert(1)</script>', redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
      }),
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = await pkce();
    const res = await send(
      new Request(
        `${BASE}/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`,
      ),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;");
  });

  it("refuses a wrong key without using up the page, then accepts the right one", async () => {
    const t = await signup();
    const pageInfo = await openSignIn();

    const wrong = await submit(pageInfo, { decision: "approve", key: `pbk_${"0".repeat(64)}` });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("That key was not recognised");

    const admin = await submit(pageInfo, { decision: "approve", key: "not-the-admin-key-but-long-enough" });
    expect(admin.status).toBe(401);

    const right = await submit(pageInfo, { decision: "approve", key: t.apiKey });
    expect(right.status).toBe(302);
    expect(new URL(right.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("sends the person back with access_denied when they click Deny", async () => {
    const pageInfo = await openSignIn();
    const res = await submit(pageInfo, { decision: "deny" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
  });

  it("rejects a form posted without the browser's consent cookie (cross-site request)", async () => {
    const t = await signup();
    const pageInfo = await openSignIn();
    const res = await submit(pageInfo, { decision: "approve", key: t.apiKey }, "");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("will not approve the same page twice", async () => {
    const t = await signup();
    const pageInfo = await openSignIn();
    expect((await submit(pageInfo, { decision: "approve", key: t.apiKey })).status).toBe(302);
    expect((await submit(pageInfo, { decision: "approve", key: t.apiKey })).status).toBe(400);
  });

  it("rejects a token exchange without the right PKCE verifier", async () => {
    const t = await signup();
    const pageInfo = await openSignIn();
    const res = await submit(pageInfo, { decision: "approve", key: t.apiKey });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const bad = await send(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: pageInfo.clientId, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-123" }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("rejects made-up bearer tokens and raw API keys at the MCP endpoint", async () => {
    const t = await signup();
    for (const token of ["nonsense", t.apiKey, ADMIN_KEY]) {
      const res = await send(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(res.status).toBe(401);
    }
  });

  it("leaves the bot, the API and the webhooks untouched", async () => {
    expect((await send(new Request(`${BASE}/health`))).status).toBe(200);
    expect((await send(new Request(`${BASE}/api/v1/bots`, { headers: asAdmin }))).status).toBe(200);
    expect((await send(new Request(`${BASE}/telegram/owner`, { method: "POST", body: "{}" }))).status).toBe(403);
  });
});

// ── Tools ────────────────────────────────────────────────────────────────────

const CREATOR_TOOLS = [
  "paywall_check_bot",
  "paywall_create_payment_link",
  "paywall_get_account",
  "paywall_get_bot",
  "paywall_get_payment",
  "paywall_get_revenue",
  "paywall_grant_access",
  "paywall_list_bots",
  "paywall_list_members",
  "paywall_list_payments",
  "paywall_revoke_access",
  "paywall_send_broadcast",
  "paywall_update_bot",
];
const ADMIN_TOOLS = [
  "paywall_admin_get_platform_overview",
  "paywall_admin_list_creators",
  "paywall_admin_set_creator_active",
  "paywall_admin_set_creator_plan",
];

describe.each<Mode>(["legacy", "modern"])("MCP tools over the %s protocol", (mode) => {
  it("lists only creator tools for a creator, with annotations and schemas", async () => {
    const t = await signup("Ada");
    const client = await connect(await signIn(t.apiKey), mode);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(CREATOR_TOOLS);
    const revoke = tools.find((tool) => tool.name === "paywall_revoke_access");
    expect(revoke?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((tool) => tool.name === "paywall_list_members")?.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(revoke?.inputSchema)).toContain("telegram_id");
    await client.close();
  });

  it("adds the owner tools for the platform owner", async () => {
    const client = await connect(await signIn(ADMIN_KEY), mode);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ADMIN_TOOLS, ...CREATOR_TOOLS].sort());
    await client.close();
  });

  it("runs a creator's day: bots, members, grant, revoke, payment link, revenue", async () => {
    const t = await signup("Ada");
    const bot = await createBot(t.headers, 1);
    const client = await connect(await signIn(t.apiKey), mode);

    const account = await client.callTool({ name: "paywall_get_account", arguments: { response_format: "json" } });
    expect(account.structuredContent).toMatchObject({ name: "Ada", plan: "free", platform_cut: 0.15, platform_owner: false, bots: 1 });

    const bots = await client.callTool({ name: "paywall_list_bots", arguments: {} });
    expect(textOf(bots)).toContain("@bot200000001");

    // "bot" may be left out when there is only one; or given as @username.
    const grant = await client.callTool({ name: "paywall_grant_access", arguments: { telegram_id: 777 } });
    expect(grant.isError).toBeFalsy();
    expect((await memberRow(bot.id, 777))?.has_access).toBe(1);
    await eventually(() => mock.tg("restrictChatMember").some((c) => c.tgToken === bot.token), "the unlock");
    const unlock = mock.tg("restrictChatMember").find((c) => c.tgToken === bot.token);
    expect(unlock?.body).toMatchObject({ chat_id: bot.groupId, user_id: 777 });

    await env.DB.prepare("UPDATE members SET username = 'jane_doe', first_name = 'Jane' WHERE telegram_id = 777").run();
    const found = await client.callTool({
      name: "paywall_list_members",
      arguments: { bot: "@bot200000001", search: "@jane", response_format: "json" },
    });
    expect(found.structuredContent).toMatchObject({ total: 1, count: 1, has_more: false });
    expect((found.structuredContent as { members: Array<{ telegram_id: number }> }).members[0]?.telegram_id).toBe(777);
    // "_" and "%" are matched literally, not as SQL wildcards.
    for (const search of ["j_ne", "%"]) {
      const none = await client.callTool({ name: "paywall_list_members", arguments: { search } });
      expect(textOf(none)).toContain("No paying member");
    }

    const revoke = await client.callTool({ name: "paywall_revoke_access", arguments: { telegram_id: 777 } });
    expect(revoke.isError).toBeFalsy();
    expect((await memberRow(bot.id, 777))?.has_access).toBe(0);

    const link = await client.callTool({
      name: "paywall_create_payment_link",
      arguments: { telegram_id: 888, access_type: "monthly" },
    });
    expect(textOf(link)).toContain("https://checkout.paystack.com/888-");
    const orderId = /Order: (\S+)\./.exec(textOf(link))?.[1];
    expect((await paymentRow(orderId!))).toMatchObject({ status: "pending", gross_amount: 5, bot_id: bot.id });

    const order = await client.callTool({ name: "paywall_get_payment", arguments: { order_id: orderId!, response_format: "json" } });
    expect(order.structuredContent).toMatchObject({ order_id: orderId, status: "pending", telegram_id: 888 });

    const revenue = await client.callTool({ name: "paywall_get_revenue", arguments: {} });
    expect(textOf(revenue)).toContain("| All time | 0 | $0.00 | $0.00 |");
    await client.close();
  });

  it("updates settings and pauses a bot, refusing changes that would break it", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1);
    const client = await connect(await signIn(t.apiKey), mode);

    const ok = await client.callTool({
      name: "paywall_update_bot",
      arguments: { monthly_price: 8, welcome_title: "Gold Club", status: "paused" },
    });
    expect(ok.isError).toBeFalsy();
    const detail = await call("GET", `/api/v1/bots/${bot.id}`, { headers: t.headers });
    expect(detail.body).toMatchObject({ status: "paused", welcome_title: "Gold Club" });
    expect(detail.body.prices.monthly).toBe(8);

    const empty = await client.callTool({ name: "paywall_update_bot", arguments: {} });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain("Nothing to change");

    const free = await client.callTool({ name: "paywall_update_bot", arguments: { one_time_price: 0, monthly_price: 0 } });
    expect(free.isError).toBe(true);

    const invalid = await client.callTool({ name: "paywall_update_bot", arguments: { status: "deleted" } });
    expect(invalid.isError).toBe(true);

    const keys = await client.callTool({ name: "paywall_update_bot", arguments: { paystack_secret_key: "sk_live_x" } });
    expect(keys.isError).toBe(true);
    await client.close();
  });

  it("asks which bot when there are several, and keeps creators apart", async () => {
    const a = await signup("A");
    const b = await signup("B");
    await call("POST", `/admin/tenants/${a.id}/tier`, { headers: asAdmin, json: { tier: "starter" } });
    const botA1 = await createBot(a.headers, 1);
    await createBot(a.headers, 2);
    const botB = await createBot(b.headers, 3);
    const client = await connect(await signIn(a.apiKey), mode);

    const ambiguous = await client.callTool({ name: "paywall_list_members", arguments: {} });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain("has 2 bots");
    expect(textOf(ambiguous)).toContain("@bot200000002");

    // Another creator's bot is invisible, by ID or by username.
    for (const ref of [botB.id, "@bot200000003"]) {
      const res = await client.callTool({ name: "paywall_grant_access", arguments: { bot: ref, telegram_id: 1 } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("No bot");
    }
    expect(await memberRow(botB.id, 1)).toBeNull();

    const own = await client.callTool({ name: "paywall_get_bot", arguments: { bot: botA1.id } });
    expect(textOf(own)).toContain(botA1.id);

    // Payments of another creator cannot be looked up either.
    const theirs = await call("POST", "/api/v1/payments/generate-link", {
      headers: b.headers,
      json: { bot_id: botB.id, telegram_id: 5, access_type: "one_time", provider: "paystack" },
    });
    const lookup = await client.callTool({ name: "paywall_get_payment", arguments: { order_id: theirs.body.order_id } });
    expect(lookup.isError).toBe(true);

    // Owner-only tools cannot be called by a creator even by name.
    await expect(
      client.callTool({ name: "paywall_admin_set_creator_plan", arguments: { creator_id: a.id, plan: "whitelabel" } }),
    ).rejects.toThrow(/not found/);
    expect((await call("GET", "/api/v1/tenants/me", { headers: a.headers })).body.tier).toBe("starter");
    await client.close();
  });

  it("lets the owner run the platform", async () => {
    const t = await signup("Creator One");
    const client = await connect(await signIn(ADMIN_KEY), mode);

    const overview = await client.callTool({ name: "paywall_admin_get_platform_overview", arguments: { response_format: "json" } });
    expect(overview.structuredContent).toMatchObject({ creators: 1, creators_on_free_trial: 1 });

    const list = await client.callTool({ name: "paywall_admin_list_creators", arguments: {} });
    expect(textOf(list)).toContain("Creator One");
    expect(textOf(list)).toContain(t.id);

    const plan = await client.callTool({
      name: "paywall_admin_set_creator_plan",
      arguments: { creator_id: t.id, plan: "starter", platform_cut_percent: 5 },
    });
    expect(textOf(plan)).toContain("'starter' with a 5% platform cut");
    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).body).toMatchObject({ tier: "starter", platform_cut: "5%" });

    await client.callTool({ name: "paywall_admin_set_creator_active", arguments: { creator_id: t.id, active: false } });
    expect((await call("GET", "/api/v1/tenants/me", { headers: t.headers })).status).toBe(401);

    const missing = await client.callTool({ name: "paywall_admin_set_creator_active", arguments: { creator_id: "nope", active: true } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("Tenant not found.");

    // The owner's own bot works through the same tools.
    const own = await client.callTool({ name: "paywall_grant_access", arguments: { telegram_id: 4242 } });
    expect(own.isError, textOf(own)).toBeFalsy();
    await eventually(() => mock.tg("restrictChatMember").length > 0, "the unlock");
    expect(mock.tg("restrictChatMember").at(-1)?.body).toMatchObject({ chat_id: OWNER_GROUP, user_id: 4242 });

    // Its prices come from Worker settings, so changing them here is refused with directions.
    const price = await client.callTool({ name: "paywall_update_bot", arguments: { monthly_price: 9 } });
    expect(price.isError).toBe(true);
    expect(textOf(price)).toContain("MONTHLY_PRICE_USD");
    await client.close();
  });

  it("queues a broadcast to paying members", async () => {
    const t = await signup();
    const bot = await createBot(t.headers, 1, { admin_user_ids: [99] });
    for (const id of [11, 12]) await call("POST", `/api/v1/bots/${bot.id}/members/${id}/grant`, { headers: t.headers });
    const client = await connect(await signIn(t.apiKey), mode);
    const res = await client.callTool({ name: "paywall_send_broadcast", arguments: { message: "Live at 9pm" } });
    expect(textOf(res)).toContain("Queued for 2 members");
    const job = await env.DB.prepare("SELECT * FROM broadcasts WHERE bot_id = ?1").bind(bot.id).first<Record<string, unknown>>();
    expect(job).toMatchObject({ text: "Live at 9pm", status: "pending", requested_by: 99 });
    await client.close();
  });

  it("checks connections without leaking keys", async () => {
    const t = await signup();
    await createBot(t.headers, 1);
    const client = await connect(await signIn(t.apiKey), mode);
    const res = await client.callTool({ name: "paywall_check_bot", arguments: {} });
    const out = textOf(res);
    expect(out).toContain("Connection check for @bot200000001");
    expect(out).toContain("✓ paystack");
    for (const secret of ["sk_test_tenant_1", "now-key-1", "now-ipn-1", "btc-key-1", "btc-whsec-1"]) {
      expect(out).not.toContain(secret);
    }
    await client.close();
  });

  it("hides internal errors from the model", async () => {
    const t = await signup();
    await createBot(t.headers, 1);
    // A database whose vault queries fail with an internal message.
    const failing = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("vault_images")) throw new Error("D1_ERROR: internal detail /var/db/secret");
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as AppEnv;
    const client = await connect(await signIn(t.apiKey), mode, failing);
    const res = await client.callTool({
      name: "paywall_create_payment_link",
      arguments: { telegram_id: 1, access_type: "image_unlock" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Something went wrong on the server. Try again shortly.");
    await client.close();
  });
});

// ── Grants end with the key ──────────────────────────────────────────────────

describe("MCP sessions end when the key changes", () => {
  async function toolsStatus(token: string, environment: AppEnv = env): Promise<number> {
    const res = await send(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      environment,
    );
    return res.status;
  }

  it("after a creator rotates their API key", async () => {
    const t = await signup();
    const token = await signIn(t.apiKey);
    expect(await toolsStatus(token)).toBe(200);
    await call("POST", "/api/v1/tenants/rotate-key", { headers: t.headers });
    const res = await toolsStatus(token);
    expect(res).toBe(401);
  });

  it("after a creator is suspended", async () => {
    const t = await signup();
    const token = await signIn(t.apiKey);
    await call("POST", `/admin/tenants/${t.id}/active`, { headers: asAdmin, json: { active: false } });
    expect(await toolsStatus(token)).toBe(401);
  });

  it("after ADMIN_API_KEY is changed", async () => {
    const token = await signIn(ADMIN_KEY);
    expect(await toolsStatus(token)).toBe(200);
    expect(await toolsStatus(token, envWith({ ADMIN_API_KEY: "a-brand-new-admin-key-0123456789" }))).toBe(401);
  });

  it("tells the client to sign in again", async () => {
    const t = await signup();
    const token = await signIn(t.apiKey);
    await call("POST", "/api/v1/tenants/rotate-key", { headers: t.headers });
    const res = await send(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
  });
});
