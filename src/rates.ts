/**
 * The platform's rate on a creator's sales. Standard-plan creators pay less
 * as they sell more (VOLUME_LADDER, over the last 30 days); Starter, white
 * label and custom rates are flat. The rate is fixed on each payment when it
 * is created, so the fee on a sale never changes afterwards.
 */

import type { Tier } from "./db";
import { TIER_CUT, VOLUME_LADDER, VOLUME_WINDOW_DAYS, type AppEnv } from "./env";
import { round2 } from "./lib/http";

/** Sales that count towards volume: buyers' payments, not fees paid to the owner. */
const SALES = "status = 'confirmed' AND access_type NOT IN ('platform_fee', 'starter_plan')";

export function ladderCut(volumeUsd: number): number {
  for (const step of VOLUME_LADDER) if (volumeUsd >= step.fromUsd) return step.cut;
  return VOLUME_LADDER[VOLUME_LADDER.length - 1]?.cut ?? TIER_CUT.free ?? 0.12;
}

/** Whether a creator's rate follows the ladder: standard plan, no custom rate. */
export function onLadder(tier: Tier | string, platformCut: number): boolean {
  return tier === "free" && Math.abs(platformCut - (TIER_CUT.free ?? 0.12)) < 1e-9;
}

export async function salesVolume(env: AppEnv, tenantId: string, at: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(gross_amount), 0) AS v FROM payments
     WHERE tenant_id = ?1 AND ${SALES} AND confirmed_at >= ?2`,
  )
    .bind(tenantId, at - VOLUME_WINDOW_DAYS * 86400)
    .first<{ v: number }>();
  return round2(row?.v ?? 0);
}

export interface SaleRate {
  cut: number;
  volumeUsd: number;
  ladder: boolean;
  /** The next step down, if there is one. */
  next: { fromUsd: number; cut: number } | null;
}

export async function saleRate(
  env: AppEnv,
  tenant: { id: string; tier: Tier | string; platformCut: number },
  at: number = Math.floor(Date.now() / 1000),
): Promise<SaleRate> {
  if (!onLadder(tenant.tier, tenant.platformCut)) {
    return { cut: tenant.platformCut, volumeUsd: 0, ladder: false, next: null };
  }
  const volumeUsd = await salesVolume(env, tenant.id, at);
  const cut = Math.min(tenant.platformCut, ladderCut(volumeUsd));
  const next = [...VOLUME_LADDER].reverse().find((s) => s.fromUsd > volumeUsd && s.cut < cut) ?? null;
  return { cut, volumeUsd, ladder: true, next };
}
