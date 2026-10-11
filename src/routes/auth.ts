/** Authentication: tenant API keys (`x-api-key`) and the platform admin key (`x-admin-key`). */

import type { MiddlewareHandler } from "hono";
import type { TenantRow } from "../db";
import { OWNER_ID, type AppEnv } from "../env";
import { safeEqual, sha256Hex } from "../lib/crypto";
import { HttpError, type AppContext } from "../lib/http";

export const MIN_ADMIN_KEY_LENGTH = 24;

export async function isAdminKey(env: AppEnv, provided: string | undefined): Promise<boolean> {
  const expected = env.ADMIN_API_KEY;
  if (!expected || expected.length < MIN_ADMIN_KEY_LENGTH) {
    throw new HttpError(
      503,
      `ADMIN_API_KEY is not configured. Add it as a Worker secret (at least ${MIN_ADMIN_KEY_LENGTH} characters).`,
    );
  }
  if (!provided) return false;
  return safeEqual(provided, expected);
}

function adminKeyFrom(headers: Headers): string | undefined {
  const direct = headers.get("x-admin-key");
  if (direct) return direct;
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "");
  return bearer?.[1];
}

/** Platform-owner routes. */
export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!(await isAdminKey(c.env, adminKeyFrom(c.req.raw.headers)))) {
    throw new HttpError(401, "Missing or wrong admin key. Send it in the x-admin-key header.");
  }
  await next();
};

/**
 * Creator routes. A valid admin key acts as the built-in owner tenant, so the
 * platform owner can use the same API for their own bot.
 */
export const requireTenant: MiddlewareHandler<AppContext> = async (c, next) => {
  let tenant: TenantRow | null;

  const adminKey = c.req.header("x-admin-key");
  if (adminKey) {
    if (!(await isAdminKey(c.env, adminKey))) throw new HttpError(401, "Wrong admin key.");
    tenant = await c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(OWNER_ID).first<TenantRow>();
  } else {
    const apiKey = c.req.header("x-api-key") ?? "";
    if (!apiKey.startsWith("pbk_")) {
      throw new HttpError(401, "Invalid API key format. Key must start with pbk_");
    }
    // Only a hash of each key is stored, so look the key up by its hash.
    tenant = await c.env.DB.prepare("SELECT * FROM tenants WHERE api_key_hash = ?1 AND is_active = 1")
      .bind(await sha256Hex(apiKey))
      .first<TenantRow>();
  }

  if (!tenant) throw new HttpError(401, "API key not found or account is inactive.");
  c.set("tenant", tenant);
  await next();
};
