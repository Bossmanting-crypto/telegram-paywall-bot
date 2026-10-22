/**
 * Sign-in for the MCP server.
 *
 * Claude (and other MCP clients) connect with OAuth: the client is sent to
 * /authorize, the person pastes their existing account key (a creator's
 * `pbk_…` API key, or the platform's ADMIN_API_KEY), approves, and the client
 * gets its own short-lived token. The key itself never reaches the client.
 *
 * Someone without an account can create one on the same page (name and
 * email); they're shown their new key once and then connected with it.
 *
 * Grants are tied to the key they were approved with: rotating a creator key,
 * changing ADMIN_API_KEY or suspending a creator ends every MCP session
 * started with the old key.
 */

import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { OWNER_ID, type AppEnv } from "../env";
import type { TenantRow } from "../db";
import { safeEqual, sha256Hex } from "../lib/crypto";
import { HttpError, logError } from "../lib/http";
import { createTenant } from "../services";
import { MIN_ADMIN_KEY_LENGTH } from "../routes/auth";
import { ensureReady } from "../schema";
import { buildServer } from "./tools";

export const MCP_PATH = "/mcp";
const AUTHORIZE_PATH = "/authorize";
const SCOPE = "paywall";

/** Requests the OAuth provider owns; everything else goes straight to the app. */
export function isOAuthRoute(pathname: string): boolean {
  return (
    pathname === MCP_PATH ||
    pathname.startsWith(`${MCP_PATH}/`) ||
    pathname === AUTHORIZE_PATH ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/oauth-")
  );
}

/** What a grant carries into each MCP request. Encrypted at rest by the provider. */
interface McpProps {
  tenantId: string;
  admin: boolean;
  /** First 16 hex characters of the SHA-256 of the key the grant was approved with. */
  keyCheck: string;
}

type AuthorizeEnv = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };

// ── Matching a pasted key to an account ──────────────────────────────────────

async function keyCheckFor(key: string): Promise<string> {
  return (await sha256Hex(key)).slice(0, 16);
}

/** The account a pasted key belongs to, or null. */
async function accountForKey(env: AppEnv, key: string): Promise<McpProps | null> {
  if (key.startsWith("pbk_")) {
    const hash = await sha256Hex(key);
    const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE api_key_hash = ?1 AND is_active = 1")
      .bind(hash)
      .first<{ id: string }>();
    return tenant ? { tenantId: tenant.id, admin: false, keyCheck: hash.slice(0, 16) } : null;
  }
  const adminKey = env.ADMIN_API_KEY;
  if (adminKey && adminKey.length >= MIN_ADMIN_KEY_LENGTH && (await safeEqual(key, adminKey))) {
    return { tenantId: OWNER_ID, admin: true, keyCheck: await keyCheckFor(adminKey) };
  }
  return null;
}

/** The account behind a grant, if the grant is still valid for it. */
async function accountForGrant(env: AppEnv, props: McpProps): Promise<TenantRow | null> {
  const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1 AND is_active = 1")
    .bind(props.tenantId)
    .first<TenantRow>();
  if (!tenant) return null;
  if (props.admin) {
    const adminKey = env.ADMIN_API_KEY;
    if (!adminKey || adminKey.length < MIN_ADMIN_KEY_LENGTH) return null;
    return (await safeEqual(props.keyCheck, await keyCheckFor(adminKey))) ? tenant : null;
  }
  return (await safeEqual(props.keyCheck, tenant.api_key_hash.slice(0, 16))) ? tenant : null;
}

// ── The MCP endpoint ─────────────────────────────────────────────────────────

function isMcpProps(value: unknown): value is McpProps {
  const p = value as Partial<McpProps> | null;
  return !!p && typeof p.tenantId === "string" && typeof p.admin === "boolean" && typeof p.keyCheck === "string";
}

const mcpApiHandler = {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    await ensureReady(env);
    const origin = new URL(request.url).origin;
    const props = (ctx as ExecutionContext & { props?: unknown }).props;
    const tenant = isMcpProps(props) ? await accountForGrant(env, props) : null;
    if (!tenant || !isMcpProps(props)) {
      // The key was rotated, the creator suspended, or ADMIN_API_KEY changed:
      // tell the client to sign in again.
      return new Response(JSON.stringify({ error: "invalid_token", error_description: "Please sign in again." }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer error="invalid_token", error_description="Please sign in again", resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}", scope="${SCOPE}"`,
        },
      });
    }

    const handler = createMcpHandler(
      () =>
        buildServer({
          env,
          tenant,
          admin: props.admin,
          baseUrl: (env.APP_URL || origin).replace(/\/+$/, ""),
          waitUntil: (promise) => ctx.waitUntil(promise),
        }),
      {
        maxRequestBodySize: 256 * 1024,
        onerror: (error) => logError("mcp request failed", error),
      },
    );
    return handler.fetch(request);
  },
};

// ── The sign-in page ─────────────────────────────────────────────────────────

const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // No form-action: browsers apply it to the redirect after Allow/Deny, which
  // goes to the connecting app's own address.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#15181d;--muted:#5b6472;--line:#dde1e7;--accent:#1f6feb;--bad:#cf222e;--warn:#9a6700}
@media (prefers-color-scheme: dark){:root{--bg:#0e1116;--card:#161b22;--text:#e6edf3;--muted:#9aa4b1;--line:#2b323c;--accent:#58a6ff;--bad:#ff7b72;--warn:#d29922}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.93rem}.warn{color:var(--warn)}.bad{color:var(--bad);font-weight:600}
ul{margin:0 0 16px;padding-left:20px}label{display:block;font-weight:600;margin:16px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}button{padding:10px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
strong{overflow-wrap:anywhere}
details{margin-top:20px;border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;font-weight:600}`;

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  const out = new Headers(headers);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) out.set(name, value);
  return new Response(html, { status, headers: out });
}

function keyForm(handle: string, error?: string): string {
  return `${error ? `<p class="bad" role="alert">${escape(error)}</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="key">Your account key</label>
  <input id="key" name="key" type="password" autocomplete="off" spellcheck="false" required placeholder="pbk_… or your admin key">
  <p class="muted">Creators: the <code>pbk_</code> API key from sign-up. Platform owner: your <code>ADMIN_API_KEY</code>. The key is only checked here; the app never receives it.</p>
  <div class="row"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
</form>`;
}

function signupForm(handle: string, error?: string, values: { name?: string; email?: string } = {}): string {
  return `<details${error ? " open" : ""}><summary>New here? Create a free account</summary>
${error ? `<p class="bad" role="alert">${escape(error)}</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="name">Name or brand</label>
  <input id="name" name="name" required maxlength="128" autocomplete="name" value="${escape(values.name ?? "")}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required maxlength="256" autocomplete="email" value="${escape(values.email ?? "")}">
  <p class="muted">Starts a free trial. You'll see your new account key once, then connect with it.</p>
  <div class="row"><button class="primary" name="decision" value="signup">Create account</button></div>
</form></details>`;
}

function newKeyPage(handle: string, apiKey: string, clientName: string): Response {
  return page(
    "Save your account key",
    `<h1>Account created</h1>
<p>Your account key is below. It's shown only this once, so copy it somewhere safe now. You'll use it to sign in to the dashboard and the API.</p>
<p><code style="font-size:1rem;overflow-wrap:anywhere">${escape(apiKey)}</code></p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <input type="hidden" name="key" value="${escape(apiKey)}">
  <div class="row"><button class="primary" name="decision" value="approve">I've saved it. Connect ${escape(clientName)}</button></div>
</form>`,
  );
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  return page(
    `Connect ${details.clientName}`,
    `<h1>Allow ${name} to manage your paywall bots?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>It will be able to:</p>
<ul>
  <li>see your bots, paying members, payments and revenue</li>
  <li>change prices and welcome texts, and pause or resume bots</li>
  <li>grant or remove members' access, create payment links and message members</li>
</ul>
<p class="muted">It cannot see or change your payment-provider keys. You can end access at any time by rotating your key.</p>
${keyForm(handle)}
${signupForm(handle)}`,
    200,
    headers,
  );
}

function errorPage(message: string, status = 400): Response {
  return page("Cannot connect", `<h1>Cannot connect</h1><p>${escape(message)}</p>`, status);
}

async function handleAuthorize(request: Request, env: AuthorizeEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return consentPage(details, consent.handle, consent.headers);
    }

    if (request.method !== "POST") return errorPage("Unsupported request.", 405);
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");

    if (form.get("decision") === "signup") {
      const name = String(form.get("name") ?? "");
      const email = String(form.get("email") ?? "");
      try {
        const created = await createTenant(env, {
          name,
          email,
          telegramId: null,
          ip: request.headers.get("cf-connecting-ip") ?? "",
        });
        return newKeyPage(handle, created.apiKey, "the app");
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return page("Create an account", `<h1>Create an account</h1>${signupForm(handle, error.message, { name, email })}`, error.status === 429 ? 429 : 400);
      }
    }

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Check the key before approving: approval uses up the page's handle, so
    // a typo must not.
    const key = String(form.get("key") ?? "").trim();
    const account = key ? await accountForKey(env, key) : null;
    if (!account) {
      return page("Key not recognised", `<h1>Key not recognised</h1>${keyForm(handle, "That key was not recognised. Check it and try again.")}`, 401);
    }

    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: account.tenantId,
      metadata: { admin: account.admin },
      scope: [SCOPE],
      props: account satisfies McpProps,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return errorPage(`${error.description} Start connecting again from your app.`);
    }
    if (error instanceof CimdFetchError) {
      return errorPage("The app asking for access could not be verified. Try again later.");
    }
    throw error;
  }
}

const defaultHandler = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    if (new URL(request.url).pathname === AUTHORIZE_PATH) {
      await ensureReady(env);
      return handleAuthorize(request, env as AuthorizeEnv);
    }
    return new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};

// ── The provider ─────────────────────────────────────────────────────────────

// The resource URL must be absolute, and this Worker's address is only known
// once a request arrives (or from APP_URL), so build one provider per origin.
const providers = new Map<string, OAuthProvider<AppEnv>>();

export function oauthProvider(env: AppEnv, request: Request): OAuthProvider<AppEnv> {
  const origin = (env.APP_URL ? new URL(env.APP_URL) : new URL(request.url)).origin.toLowerCase();
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<AppEnv>({
      apiRoute: MCP_PATH,
      apiHandler: mcpApiHandler,
      defaultHandler,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: {
        resource: `${origin}${MCP_PATH}`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "Paywall Bot",
      },
      onError: ({ code, status, internal }) => {
        console.warn(JSON.stringify({ message: "oauth error", code, status, category: internal.category, reason: internal.reason }));
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}
