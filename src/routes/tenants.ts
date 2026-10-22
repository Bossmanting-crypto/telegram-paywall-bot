/** /api/v1/tenants — signup, profile, API key rotation. */

import { Hono } from "hono";
import { iso, now } from "../db";
import { FREE_TRIAL_DAYS, OWNER_ID, TIER_CUT } from "../env";
import { newApiKey, newId, sha256Hex } from "../lib/crypto";
import { HttpError, readJson, reqString, type AppContext } from "../lib/http";
import { accountSummary } from "../services";
import { requireTenant } from "./auth";

export const tenants = new Hono<AppContext>();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function percent(cut: number): string {
  return `${Math.round(cut * 100)}%`;
}

tenants.post("/signup", async (c) => {
  if (c.env.ALLOW_SIGNUPS === "false") {
    throw new HttpError(403, "Signups are closed right now.");
  }
  const body = await readJson(c);
  const email = reqString(body, "email", 256).toLowerCase();
  const name = reqString(body, "name", 128);
  if (!EMAIL.test(email)) throw new HttpError(422, "'email' is not a valid email address.");

  const existing = await c.env.DB.prepare("SELECT id FROM tenants WHERE email = ?1").bind(email).first();
  if (existing) throw new HttpError(400, "Email already registered.");

  const apiKey = newApiKey();
  const id = newId();
  const created = now();
  const trialEnds = created + FREE_TRIAL_DAYS * 86400;
  const cut = TIER_CUT.free ?? 0.15;

  await c.env.DB.prepare(
    `INSERT INTO tenants (id, email, name, api_key_hash, api_key_prefix, tier, platform_cut, trial_ends_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'free', ?6, ?7, ?8)`,
  )
    .bind(id, email, name, await sha256Hex(apiKey), apiKey.slice(0, 12), cut, trialEnds, created)
    .run();

  return c.json({
    message: "Account created! Save your API key — it won't be shown again.",
    id,
    email,
    name,
    tier: "free",
    api_key: apiKey,
    platform_cut: percent(cut),
    trial_ends: iso(trialEnds),
  });
});

tenants.get("/me", requireTenant, async (c) => {
  const a = await accountSummary(c.env, c.get("tenant"));
  return c.json({
    id: a.id,
    email: a.email,
    name: a.name,
    tier: a.tier,
    platform_cut: percent(a.platformCut),
    api_key_hint: a.apiKeyHint,
    bots: a.bots,
    trial_ends: a.trialEndsAt,
    total_gross: `$${a.grossUsd.toFixed(2)}`,
    platform_fees: `$${a.feesUsd.toFixed(2)}`,
    net_earned: `$${a.netUsd.toFixed(2)}`,
  });
});

tenants.post("/rotate-key", requireTenant, async (c) => {
  const t = c.get("tenant");
  if (t.id === OWNER_ID) {
    throw new HttpError(400, "The owner account uses the admin key. Change the ADMIN_API_KEY secret instead.");
  }
  const apiKey = newApiKey();
  await c.env.DB.prepare("UPDATE tenants SET api_key_hash = ?1, api_key_prefix = ?2 WHERE id = ?3")
    .bind(await sha256Hex(apiKey), apiKey.slice(0, 12), t.id)
    .run();
  return c.json({
    message: "New API key generated. Update your integrations immediately.",
    api_key: apiKey,
  });
});

/**
 * Plan changes are applied by the platform owner once payment is received
 * (POST /admin/tenants/{id}/tier). Creators cannot change their own cut.
 */
tenants.post("/upgrade", requireTenant, async (c) => {
  const t = c.get("tenant");
  return c.json(
    {
      detail:
        "Upgrades are applied by the platform once payment is received. Contact the platform owner and quote your account ID.",
      account_id: t.id,
      current_tier: t.tier,
      available: {
        starter: `${percent(TIER_CUT.starter ?? 0.08)} platform cut, unlimited bots and members`,
        whitelabel: "one-time purchase, no platform cut",
      },
    },
    402,
  );
});
