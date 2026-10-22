/**
 * Paywall Bot — multi-tenant Telegram paywall platform on Cloudflare Workers.
 *
 *   /api/v1/*            creator API (x-api-key)
 *   /admin, /admin/*     platform owner (x-admin-key)
 *   /mcp                 MCP server for Claude and other AI clients (OAuth)
 *   /authorize, /oauth/*, /.well-known/oauth-*   MCP sign-in
 *   /telegram/{bot_id}   Telegram sends bot updates here
 *   /webhooks/{provider}/{bot_id}   payment confirmations
 *   scheduled()          every minute: subscription expiry, broadcasts
 */

import { app } from "./app";
import { runCron } from "./cron";
import type { AppEnv } from "./env";
import { alertOwner } from "./alerts";
import { logError } from "./lib/http";
import { isOAuthRoute, oauthProvider } from "./mcp/oauth";
import { ensureReady } from "./schema";

export default {
  fetch(request, env, ctx) {
    // Only MCP and its sign-in go through the OAuth layer; the bot, the API
    // and the payment webhooks are served exactly as before.
    if (isOAuthRoute(new URL(request.url).pathname)) {
      return oauthProvider(env, request).fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, _ctx) {
    try {
      await ensureReady(env);
      await runCron(env, controller.scheduledTime);
    } catch (error) {
      logError("cron failed", error);
      await alertOwner(env, "cron", `The every-minute job failed: ${error instanceof Error ? error.message : String(error)}. Subscriptions may not expire and broadcasts may stall until it recovers.`);
      throw error; // so the run shows as failed in the dashboard
    }
  },
} satisfies ExportedHandler<AppEnv>;
