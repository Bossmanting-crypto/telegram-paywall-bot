/**
 * Paywall Bot — multi-tenant Telegram paywall platform on Cloudflare Workers.
 *
 *   /api/v1/*            creator API (x-api-key)
 *   /admin, /admin/*     platform owner (x-admin-key)
 *   /telegram/{bot_id}   Telegram sends bot updates here
 *   /webhooks/{provider}/{bot_id}   payment confirmations
 *   scheduled()          every minute: subscription expiry, broadcasts
 */

import { app } from "./app";
import { runCron } from "./cron";
import type { AppEnv } from "./env";
import { logError } from "./lib/http";
import { ensureReady } from "./schema";

export default {
  fetch: app.fetch,

  async scheduled(controller, env, _ctx) {
    try {
      await ensureReady(env);
      await runCron(env, controller.scheduledTime);
    } catch (error) {
      logError("cron failed", error);
      throw error; // so the run shows as failed in the dashboard
    }
  },
} satisfies ExportedHandler<AppEnv>;
