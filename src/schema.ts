/**
 * Database schema. The Worker creates and upgrades its own tables the first
 * time it runs after a deploy, so there is no separate migration step.
 *
 * To change the schema, append a new entry to MIGRATIONS — never edit an
 * existing one, because deployed databases have already applied it.
 *
 * Times are stored as Unix seconds. Money columns are in USD unless noted.
 */

import { OWNER_ID, type AppEnv } from "./env";
import { randomHex } from "./lib/crypto";

export const MIGRATIONS: string[][] = [
  // ── 1: initial schema ──────────────────────────────────────────────────────
  [
    `CREATE TABLE IF NOT EXISTS schema_meta (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,

    // A creator / business using the platform.
    `CREATE TABLE IF NOT EXISTS tenants (
       id                        TEXT PRIMARY KEY,
       email                     TEXT NOT NULL UNIQUE,
       name                      TEXT NOT NULL,
       api_key_hash              TEXT NOT NULL UNIQUE,
       api_key_prefix            TEXT NOT NULL,
       tier                      TEXT NOT NULL DEFAULT 'free',
       platform_cut              REAL NOT NULL DEFAULT 0.15,
       is_active                 INTEGER NOT NULL DEFAULT 1,
       trial_ends_at             INTEGER,
       paystack_subaccount_code  TEXT,
       created_at                INTEGER NOT NULL
     )`,

    // One bot per Telegram group. Columns ending in _enc are AES-GCM encrypted.
    `CREATE TABLE IF NOT EXISTS bots (
       id                         TEXT PRIMARY KEY,
       tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
       bot_token_enc              TEXT,
       telegram_bot_id            INTEGER,
       bot_username               TEXT,
       webhook_secret             TEXT NOT NULL,
       group_chat_id              INTEGER,
       group_name                 TEXT,
       status                     TEXT NOT NULL DEFAULT 'active',
       one_time_price             REAL,
       monthly_price              REAL,
       image_unlock_price         REAL,
       currency                   TEXT,
       fx_rate                    REAL,
       welcome_title              TEXT,
       welcome_text               TEXT,
       group_description          TEXT,
       admin_user_ids             TEXT,
       paystack_secret_key_enc    TEXT,
       paystack_public_key        TEXT,
       nowpayments_api_key_enc    TEXT,
       nowpayments_ipn_secret_enc TEXT,
       btcpay_url                 TEXT,
       btcpay_store_id            TEXT,
       btcpay_api_key_enc         TEXT,
       btcpay_webhook_secret_enc  TEXT,
       last_notice_message_id     INTEGER,
       created_at                 INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_bots_tenant ON bots(tenant_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_telegram_id
       ON bots(telegram_bot_id) WHERE telegram_bot_id IS NOT NULL`,

    // A Telegram user known to one bot.
    `CREATE TABLE IF NOT EXISTS members (
       id              TEXT PRIMARY KEY,
       bot_id          TEXT NOT NULL REFERENCES bots(id),
       telegram_id     INTEGER NOT NULL,
       username        TEXT,
       first_name      TEXT,
       has_access      INTEGER NOT NULL DEFAULT 0,
       access_type     TEXT,
       access_expires  INTEGER,
       images_unlocked INTEGER NOT NULL DEFAULT 0,
       joined_at       INTEGER NOT NULL,
       UNIQUE (bot_id, telegram_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_members_expiry
       ON members(access_expires) WHERE has_access = 1 AND access_expires IS NOT NULL`,

    // Every payment link created, and whether it was paid.
    `CREATE TABLE IF NOT EXISTS payments (
       id                  TEXT PRIMARY KEY,
       tenant_id           TEXT NOT NULL REFERENCES tenants(id),
       bot_id              TEXT NOT NULL REFERENCES bots(id),
       telegram_id         INTEGER NOT NULL,
       provider            TEXT NOT NULL,
       provider_ref        TEXT NOT NULL UNIQUE,
       provider_invoice_id TEXT,
       access_type         TEXT NOT NULL,
       gross_amount        REAL NOT NULL,
       platform_fee        REAL NOT NULL,
       net_amount          REAL NOT NULL,
       currency            TEXT NOT NULL DEFAULT 'USD',
       charge_amount_minor INTEGER,
       charge_currency     TEXT,
       status              TEXT NOT NULL DEFAULT 'pending',
       payment_url         TEXT,
       created_at          INTEGER NOT NULL,
       confirmed_at        INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id, status, confirmed_at)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_bot ON payments(bot_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(provider_invoice_id)`,

    // Image vault: Telegram file IDs, re-sent to buyers by the same bot.
    `CREATE TABLE IF NOT EXISTS vault_images (
       id             TEXT PRIMARY KEY,
       bot_id         TEXT NOT NULL REFERENCES bots(id),
       file_id        TEXT NOT NULL,
       file_unique_id TEXT NOT NULL,
       added_by       INTEGER,
       created_at     INTEGER NOT NULL,
       UNIQUE (bot_id, file_unique_id)
     )`,

    // /broadcast messages waiting to be delivered by the cron job.
    `CREATE TABLE IF NOT EXISTS broadcasts (
       id           TEXT PRIMARY KEY,
       bot_id       TEXT NOT NULL REFERENCES bots(id),
       text         TEXT NOT NULL,
       cursor       INTEGER NOT NULL DEFAULT 0,
       sent         INTEGER NOT NULL DEFAULT 0,
       failed       INTEGER NOT NULL DEFAULT 0,
       status       TEXT NOT NULL DEFAULT 'pending',
       requested_by INTEGER,
       created_at   INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, created_at)`,
  ],

  // ── 2: coins, pay-per-item content, join approval ──────────────────────────
  [
    // 'mute': people join, stay muted until they pay. 'approve': the bot only
    // approves join requests from people who have paid.
    `ALTER TABLE bots ADD COLUMN join_mode TEXT NOT NULL DEFAULT 'mute'`,
    `ALTER TABLE bots ADD COLUMN join_link TEXT`,
    `ALTER TABLE bots ADD COLUMN coins_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bots ADD COLUMN free_coins INTEGER NOT NULL DEFAULT 15`,
    `ALTER TABLE bots ADD COLUMN unlock_cost INTEGER NOT NULL DEFAULT 5`,
    `ALTER TABLE bots ADD COLUMN coin_packs TEXT`, // JSON [{coins, price}]; NULL = defaults

    `ALTER TABLE members ADD COLUMN coins INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE members ADD COLUMN free_coins_granted INTEGER NOT NULL DEFAULT 0`,

    // Coins bought by a coin-pack payment (access_type = 'coin_pack').
    `ALTER TABLE payments ADD COLUMN coins INTEGER`,

    // Content items: the vault now holds videos, GIFs and files too.
    `ALTER TABLE vault_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo'`,
    `ALTER TABLE vault_images ADD COLUMN caption TEXT`,

    // Every change to a coin balance, for support questions and audits.
    `CREATE TABLE IF NOT EXISTS coin_ledger (
       id          TEXT PRIMARY KEY,
       bot_id      TEXT NOT NULL REFERENCES bots(id),
       telegram_id INTEGER NOT NULL,
       delta       INTEGER NOT NULL,
       reason      TEXT NOT NULL,
       ref         TEXT,
       created_at  INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_coin_ledger_member ON coin_ledger(bot_id, telegram_id, created_at)`,

    // Items each person has unlocked with coins.
    `CREATE TABLE IF NOT EXISTS content_unlocks (
       bot_id      TEXT NOT NULL REFERENCES bots(id),
       telegram_id INTEGER NOT NULL,
       item_id     TEXT NOT NULL,
       ref         TEXT NOT NULL,
       created_at  INTEGER NOT NULL,
       PRIMARY KEY (bot_id, telegram_id, item_id)
     )`,
  ],
];

// Per-isolate flag so the version check runs once per cold start, not per request.
let ready = false;

/** Test hook: forget that the schema was checked (after storage is wiped). */
export function forgetSchemaCheck(): void {
  ready = false;
}

export async function ensureReady(env: AppEnv): Promise<void> {
  if (ready) return;

  let version = 0;
  try {
    const row = await env.DB.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first<{
      value: string;
    }>();
    version = row ? Number(row.value) : 0;
  } catch {
    version = 0; // schema_meta doesn't exist yet: brand-new database
  }

  for (let v = version; v < MIGRATIONS.length; v++) {
    const statements = MIGRATIONS[v] ?? [];
    await env.DB.batch([
      ...statements.map((sql) => env.DB.prepare(sql)),
      env.DB.prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(String(v + 1)),
    ]);
  }

  await ensureOwner(env);
  ready = true;
}

/**
 * The platform owner's own bot is configured through Worker secrets rather
 * than the API. It still needs a tenant row and a bot row so payments,
 * members and stats have something to attach to.
 */
async function ensureOwner(env: AppEnv): Promise<void> {
  const existing = await env.DB.prepare("SELECT id FROM bots WHERE id = ?1").bind(OWNER_ID).first();
  if (existing) return;

  const created = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenants
         (id, email, name, api_key_hash, api_key_prefix, tier, platform_cut, is_active, created_at)
       VALUES (?1, 'owner@platform.local', 'Platform owner', ?2, 'admin-key', 'whitelabel', 0, 1, ?3)`,
    ).bind(OWNER_ID, `owner-no-api-key-${randomHex(16)}`, created),
    env.DB.prepare(
      `INSERT OR IGNORE INTO bots (id, tenant_id, webhook_secret, status, created_at)
       VALUES (?1, ?1, ?2, 'active', ?3)`,
    ).bind(OWNER_ID, randomHex(24), created),
  ]);
}
