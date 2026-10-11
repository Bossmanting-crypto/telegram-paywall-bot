/** /api/v1/analytics — revenue and membership numbers for one creator. */

import { Hono } from "hono";
import { iso, now, type PaymentRow } from "../db";
import type { AppContext } from "../lib/http";
import { round2 } from "../lib/http";
import { requireTenant } from "./auth";

export const analytics = new Hono<AppContext>();
analytics.use("*", requireTenant);

analytics.get("/overview", async (c) => {
  const tenant = c.get("tenant");
  const at = now();
  const since = at - 30 * 86400;

  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(gross_amount), 0) AS gross,
            COALESCE(SUM(platform_fee), 0) AS fee,
            COALESCE(SUM(net_amount), 0) AS net,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?2 THEN 1 ELSE 0 END), 0) AS n30,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?2 THEN gross_amount ELSE 0 END), 0) AS gross30,
            COALESCE(SUM(CASE WHEN confirmed_at >= ?2 THEN net_amount ELSE 0 END), 0) AS net30
     FROM payments WHERE tenant_id = ?1 AND status = 'confirmed'`,
  )
    .bind(tenant.id, since)
    .first<{ n: number; gross: number; fee: number; net: number; n30: number; gross30: number; net30: number }>();

  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM bots WHERE tenant_id = ?1 AND status != 'deleted') AS bots,
       (SELECT COUNT(*) FROM members m JOIN bots b ON b.id = m.bot_id
         WHERE b.tenant_id = ?1 AND b.status != 'deleted' AND m.has_access = 1
           AND (m.access_expires IS NULL OR m.access_expires > ?2)) AS members`,
  )
    .bind(tenant.id, at)
    .first<{ bots: number; members: number }>();

  return c.json({
    all_time: {
      gross: round2(totals?.gross ?? 0),
      platform_fee: round2(totals?.fee ?? 0),
      net: round2(totals?.net ?? 0),
      transactions: totals?.n ?? 0,
    },
    last_30_days: {
      gross: round2(totals?.gross30 ?? 0),
      net: round2(totals?.net30 ?? 0),
      transactions: totals?.n30 ?? 0,
    },
    active_members: counts?.members ?? 0,
    total_bots: counts?.bots ?? 0,
    platform_cut: `${Math.round(tenant.platform_cut * 100)}%`,
  });
});

analytics.get("/payments", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM payments WHERE tenant_id = ?1 AND status = 'confirmed'
     ORDER BY confirmed_at DESC, id LIMIT ?2`,
  )
    .bind(c.get("tenant").id, limit)
    .all<PaymentRow>();
  return c.json({
    count: results.length,
    payments: results.map((p) => ({
      id: p.id,
      order_id: p.provider_ref,
      bot_id: p.bot_id,
      telegram_id: p.telegram_id,
      provider: p.provider,
      access_type: p.access_type,
      gross: p.gross_amount,
      platform_fee: p.platform_fee,
      net: p.net_amount,
      currency: p.currency,
      confirmed_at: iso(p.confirmed_at),
    })),
  });
});
