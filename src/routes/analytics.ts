/** /api/v1/analytics — revenue and membership numbers for one creator. */

import { Hono } from "hono";
import type { AppContext } from "../lib/http";
import { listConfirmedPayments, revenueOverview } from "../services";
import { requireTenant } from "./auth";

export const analytics = new Hono<AppContext>();
analytics.use("*", requireTenant);

analytics.get("/overview", async (c) => {
  const o = await revenueOverview(c.env, c.get("tenant"));
  return c.json({
    all_time: {
      gross: o.allTime.grossUsd,
      platform_fee: o.allTime.platformFeeUsd,
      net: o.allTime.netUsd,
      transactions: o.allTime.transactions,
    },
    last_30_days: {
      gross: o.last30Days.grossUsd,
      net: o.last30Days.netUsd,
      transactions: o.last30Days.transactions,
    },
    active_members: o.activeMembers,
    total_bots: o.totalBots,
    platform_cut: `${Math.round(o.platformCut * 100)}%`,
  });
});

analytics.get("/payments", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const page = await listConfirmedPayments(c.env, c.get("tenant").id, {
    limit,
    offset,
    botId: c.req.query("bot_id") ?? null,
  });
  return c.json({ count: page.payments.length, total: page.total, payments: page.payments });
});
