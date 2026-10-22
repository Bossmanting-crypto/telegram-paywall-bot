/** The HTTP application: routing, CORS and error handling. */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { handleUpdate } from "./bot/handlers";
import { loadBot } from "./db";
import { OWNER_ID, type AppEnv } from "./env";
import { safeEqual } from "./lib/crypto";
import { HttpError, ProviderError, baseUrl, logError, type AppContext } from "./lib/http";
import { admin } from "./routes/admin";
import { analytics } from "./routes/analytics";
import { bots } from "./routes/bots";
import { payments } from "./routes/payments";
import { tenants } from "./routes/tenants";
import { btcpayWebhook, nowpaymentsWebhook, paystackWebhook, webhooks } from "./routes/webhooks";
import { web } from "./routes/web";
import { ensureReady } from "./schema";
import type { TgUpdate } from "./telegram";

const VERSION = "2.0.0";

const app = new Hono<AppContext>();

// Liveness check that doesn't touch the database.
app.get("/health", (c) => c.json({ status: "healthy" }));

// Nothing this service accepts is large; refuse oversized bodies before reading them.
app.use(
  "*",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ detail: "Request body is too large." }, 413),
  }),
);

// Create / upgrade tables on the first request after a deploy.
app.use("*", async (c, next) => {
  await ensureReady(c.env);
  await next();
});

// Browser access to the API is limited to the origins listed in CORS_ORIGINS.
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const allowed = String((c.env as AppEnv).CORS_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ["content-type", "x-api-key", "x-admin-key"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

// Browsers get the landing page and dashboard; API clients get JSON on /.
app.route("/", web);

app.get("/", (c) =>
  c.json({
    service: "Paywall Bot SaaS",
    version: VERSION,
    status: "online",
    admin: "/admin",
    dashboard: "/dashboard",
    api: "/api/v1",
  }),
);

app.route("/api/v1/tenants", tenants);
app.route("/api/v1/bots", bots);
app.route("/api/v1/payments", payments);
app.route("/api/v1/analytics", analytics);
app.route("/webhooks", webhooks);
app.route("/admin", admin);

// Webhook paths used by the original single-bot deployment.
app.post("/webhook/paystack", (c) => paystackWebhook(c, OWNER_ID));
app.post("/webhook/nowpayments", (c) => nowpaymentsWebhook(c, OWNER_ID));
app.post("/webhook/btcpay", (c) => btcpayWebhook(c, OWNER_ID));

/** Telegram delivers each bot's updates here, signed with a per-bot secret. */
app.post("/telegram/:botId", async (c) => {
  const bot = await loadBot(c.env, c.req.param("botId"));
  if (!bot || !bot.token) throw new HttpError(404, "Bot not found");

  const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  if (!(await safeEqual(secret, bot.webhookSecret))) throw new HttpError(403, "Forbidden");

  let update: TgUpdate;
  try {
    update = await c.req.json<TgUpdate>();
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }

  // Always answer 200 once the update is authenticated: an error here should
  // be logged, not make Telegram re-deliver the same update over and over.
  try {
    await handleUpdate(c.env, bot, update, baseUrl(c));
  } catch (error) {
    logError("telegram update failed", error, { bot_id: bot.id, update_id: update.update_id });
  }
  return c.json({ ok: true });
});

const page = (title: string, text: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px">
<h1>${title}</h1><p>${text}</p></body></html>`;

app.get("/payment/success", (c) =>
  c.html(page("✅ Payment received", "Return to Telegram — your access will be unlocked as soon as the payment is confirmed.")),
);
app.get("/payment/cancel", (c) => c.html(page("❌ Payment cancelled", "Return to Telegram and try again.")));

app.notFound((c) => c.json({ detail: "Not found" }, 404));

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ detail: error.message }, error.status);
  }
  if (error instanceof ProviderError) {
    logError("provider error", error, { provider: error.provider, status: error.status, path: c.req.path });
    return c.json({ detail: `${error.provider} error: ${error.message}` }, 502);
  }
  logError("unhandled error", error, { path: c.req.path, method: c.req.method });
  return c.json({ detail: "Internal server error" }, 500);
});

export { app };
