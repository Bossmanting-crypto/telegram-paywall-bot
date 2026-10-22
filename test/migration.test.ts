import { describe, expect, it } from "vitest";
import { MIGRATIONS, ensureReady, forgetSchemaCheck } from "../src/schema";
import { call, env, mockFetch, asAdmin } from "./helpers";

describe("upgrading a live database", () => {
  it("adds coins and join settings to an existing version-1 database without losing data", async () => {
    mockFetch();
    // Rebuild the database exactly as version 1 left it, with some data in it.
    const tables = ["coin_ledger", "content_unlocks", "broadcasts", "vault_images", "payments", "members", "bots", "tenants", "schema_meta"];
    await env.DB.batch(tables.map((t) => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
    await env.DB.batch([
      ...MIGRATIONS[0]!.map((sql) => env.DB.prepare(sql)),
      env.DB.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', '1')"),
      env.DB.prepare(
        `INSERT INTO tenants (id, email, name, api_key_hash, api_key_prefix, tier, platform_cut, created_at)
         VALUES ('owner', 'owner@platform.local', 'Platform owner', 'h', 'admin-key', 'whitelabel', 0, 1)`,
      ),
      env.DB.prepare("INSERT INTO bots (id, tenant_id, webhook_secret, status, created_at) VALUES ('owner', 'owner', 's', 'active', 1)"),
      env.DB.prepare(
        `INSERT INTO members (id, bot_id, telegram_id, has_access, access_type, joined_at)
         VALUES ('m1', 'owner', 555, 1, 'one_time', 1)`,
      ),
      env.DB.prepare(
        "INSERT INTO vault_images (id, bot_id, file_id, file_unique_id, created_at) VALUES ('v1', 'owner', 'f', 'u', 1)",
      ),
    ]);

    forgetSchemaCheck();
    await ensureReady(env);

    expect(await env.DB.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first()).toEqual({ value: String(MIGRATIONS.length) });
    expect(await env.DB.prepare("SELECT join_mode, coins_enabled, free_coins, unlock_cost FROM bots WHERE id = 'owner'").first()).toEqual({
      join_mode: "mute",
      coins_enabled: 0,
      free_coins: 15,
      unlock_cost: 5,
    });
    expect(await env.DB.prepare("SELECT has_access, coins, free_coins_granted FROM members WHERE id = 'm1'").first()).toEqual({
      has_access: 1,
      coins: 0,
      free_coins_granted: 0,
    });
    expect(await env.DB.prepare("SELECT kind, caption FROM vault_images WHERE id = 'v1'").first()).toEqual({ kind: "photo", caption: null });

    // Running it again is a no-op.
    forgetSchemaCheck();
    await ensureReady(env);
    const bot = await call("GET", "/api/v1/bots/owner", { headers: asAdmin });
    expect(bot.status).toBe(200);
    expect(bot.body.content_items).toBe(1);
  });
});
