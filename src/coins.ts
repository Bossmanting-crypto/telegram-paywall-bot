/**
 * Coins: a per-bot wallet for each Telegram user, a one-time free allowance,
 * and pay-per-item content unlocked with coins.
 *
 * Every balance change is a single D1 batch (one transaction) guarded so that
 * a retried or concurrent request can never charge twice or credit twice:
 *  - the free allowance is keyed by a fixed ledger ID per member;
 *  - an unlock inserts its row first, and the charge only applies if that
 *    exact row (matched by a random ref) was inserted by this request;
 *  - a coin-pack credit only applies while its payment is still pending,
 *    in the same batch that marks the payment confirmed.
 */

import {
  hasValidAccess,
  now,
  type BotConfig,
  type ContentKind,
  type MemberRow,
  type PaymentRow,
} from "./db";
import type { AppEnv } from "./env";
import { newId, randomHex } from "./lib/crypto";
import { tg, type InlineKeyboard } from "./telegram";

export type LedgerReason = "free" | "purchase" | "unlock" | "grant";

export interface ContentItem {
  id: string;
  kind: ContentKind;
  file_id: string;
  caption: string | null;
}

/** Subscribers and vault buyers see every item without spending coins. */
export function seesEverything(member: MemberRow | null): boolean {
  return hasValidAccess(member) || member?.images_unlocked === 1;
}

/**
 * Give the one-time free allowance if this member hasn't had it yet.
 * Returns the member's coin balance afterwards.
 */
export async function ensureFreeCoins(env: AppEnv, bot: BotConfig, member: MemberRow): Promise<number> {
  if (!bot.coins.enabled || bot.coins.free <= 0 || member.free_coins_granted === 1) return member.coins;
  const ledgerId = `free:${bot.id}:${member.telegram_id}`;
  const ref = randomHex(8);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO coin_ledger (id, bot_id, telegram_id, delta, reason, ref, created_at)
       VALUES (?1, ?2, ?3, ?4, 'free', ?5, ?6)`,
    ).bind(ledgerId, bot.id, member.telegram_id, bot.coins.free, ref, now()),
    env.DB.prepare(
      `UPDATE members SET coins = coins + ?1, free_coins_granted = 1
       WHERE bot_id = ?2 AND telegram_id = ?3 AND free_coins_granted = 0
         AND EXISTS (SELECT 1 FROM coin_ledger WHERE id = ?4 AND ref = ?5)`,
    ).bind(bot.coins.free, bot.id, member.telegram_id, ledgerId, ref),
  ]);
  return balance(env, bot.id, member.telegram_id);
}

export async function balance(env: AppEnv, botId: string, telegramId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT coins FROM members WHERE bot_id = ?1 AND telegram_id = ?2")
    .bind(botId, telegramId)
    .first<{ coins: number }>();
  return row?.coins ?? 0;
}

/** Add (or with a negative amount, remove) coins by hand. Never goes below zero. */
export async function adjustCoins(
  env: AppEnv,
  botId: string,
  telegramId: number,
  delta: number,
  reason: LedgerReason,
  ref: string | null = null,
): Promise<number> {
  const at = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO members (id, bot_id, telegram_id, coins, joined_at) VALUES (?1, ?2, ?3, MAX(?4, 0), ?5)
       ON CONFLICT(bot_id, telegram_id) DO UPDATE SET coins = MAX(members.coins + ?4, 0)`,
    ).bind(newId(), botId, telegramId, delta, at),
    env.DB.prepare(
      `INSERT INTO coin_ledger (id, bot_id, telegram_id, delta, reason, ref, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(newId(), botId, telegramId, delta, reason, ref, at),
  ]);
  return balance(env, botId, telegramId);
}

/**
 * Statements that credit a coin-pack purchase. They only take effect while
 * the payment is pending, so run them in the same batch that confirms it.
 */
export function coinPurchaseStatements(env: AppEnv, payment: PaymentRow): D1PreparedStatement[] {
  const coins = payment.coins ?? 0;
  const at = now();
  const pending = "EXISTS (SELECT 1 FROM payments WHERE id = ?5 AND status = 'pending')";
  return [
    env.DB.prepare(
      `INSERT INTO members (id, bot_id, telegram_id, coins, joined_at)
       SELECT ?1, ?2, ?3, ?4, ?6 WHERE ${pending}
       ON CONFLICT(bot_id, telegram_id) DO UPDATE SET coins = members.coins + excluded.coins`,
    ).bind(newId(), payment.bot_id, payment.telegram_id, coins, payment.id, at),
    env.DB.prepare(
      `INSERT INTO coin_ledger (id, bot_id, telegram_id, delta, reason, ref, created_at)
       SELECT ?1, ?2, ?3, ?4, 'purchase', ?5, ?6 WHERE ${pending}`,
    ).bind(newId(), payment.bot_id, payment.telegram_id, coins, payment.id, at),
  ];
}

// ── Content ──────────────────────────────────────────────────────────────────

export async function countContent(env: AppEnv, botId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_images WHERE bot_id = ?1")
    .bind(botId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The item at `index` in the order items were added (rowid), plus the total. */
export async function contentAt(
  env: AppEnv,
  botId: string,
  index: number,
): Promise<{ item: ContentItem | null; total: number }> {
  const [itemRes, countRes] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, kind, file_id, caption FROM vault_images WHERE bot_id = ?1 ORDER BY rowid LIMIT 1 OFFSET ?2",
    ).bind(botId, Math.max(0, index)),
    env.DB.prepare("SELECT COUNT(*) AS n FROM vault_images WHERE bot_id = ?1").bind(botId),
  ]);
  const item = ((itemRes?.results ?? [])[0] as ContentItem | undefined) ?? null;
  const total = ((countRes?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  return { item, total };
}

export async function getContentItem(env: AppEnv, botId: string, itemId: string): Promise<ContentItem | null> {
  return env.DB.prepare("SELECT id, kind, file_id, caption FROM vault_images WHERE bot_id = ?1 AND id = ?2")
    .bind(botId, itemId)
    .first<ContentItem>();
}

/** Position of an item in the list (0-based), for "Next" buttons. */
export async function contentIndex(env: AppEnv, botId: string, itemId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM vault_images
     WHERE bot_id = ?1 AND rowid < (SELECT rowid FROM vault_images WHERE id = ?2)`,
  )
    .bind(botId, itemId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function hasUnlocked(env: AppEnv, botId: string, telegramId: number, itemId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM content_unlocks WHERE bot_id = ?1 AND telegram_id = ?2 AND item_id = ?3",
  )
    .bind(botId, telegramId, itemId)
    .first();
  return row !== null;
}

export async function countUnlocked(env: AppEnv, botId: string, telegramId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM content_unlocks WHERE bot_id = ?1 AND telegram_id = ?2",
  )
    .bind(botId, telegramId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type UnlockResult =
  | { status: "unlocked"; balance: number }
  | { status: "already"; balance: number }
  | { status: "insufficient"; balance: number };

/** Spend coins on one item. Safe to call twice: the second call is "already". */
export async function unlockWithCoins(
  env: AppEnv,
  bot: BotConfig,
  telegramId: number,
  itemId: string,
): Promise<UnlockResult> {
  const cost = bot.coins.unlockCost;
  const ref = randomHex(8);
  const at = now();
  const inserted = "EXISTS (SELECT 1 FROM content_unlocks WHERE bot_id = ?1 AND telegram_id = ?2 AND item_id = ?3 AND ref = ?4)";
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO content_unlocks (bot_id, telegram_id, item_id, ref, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM members WHERE bot_id = ?1 AND telegram_id = ?2 AND coins >= ?6)
       ON CONFLICT DO NOTHING`,
    ).bind(bot.id, telegramId, itemId, ref, at, cost),
    env.DB.prepare(
      `UPDATE members SET coins = coins - ?5 WHERE bot_id = ?1 AND telegram_id = ?2 AND ${inserted}`,
    ).bind(bot.id, telegramId, itemId, ref, cost),
    env.DB.prepare(
      `INSERT INTO coin_ledger (id, bot_id, telegram_id, delta, reason, ref, created_at)
       SELECT ?5, ?1, ?2, ?6, 'unlock', ?3, ?7 WHERE ${inserted}`,
    ).bind(bot.id, telegramId, itemId, ref, newId(), -cost, at),
  ]);
  const left = await balance(env, bot.id, telegramId);
  if ((results[0]?.meta.changes ?? 0) === 1) return { status: "unlocked", balance: left };
  if (await hasUnlocked(env, bot.id, telegramId, itemId)) return { status: "already", balance: left };
  return { status: "insufficient", balance: left };
}

const SEND_METHOD: Record<ContentKind, [string, string]> = {
  photo: ["sendPhoto", "photo"],
  video: ["sendVideo", "video"],
  animation: ["sendAnimation", "animation"],
  document: ["sendDocument", "document"],
};

/** Send one item. Content is protected so it can't be forwarded or saved. */
export function sendContent(
  bot: BotConfig,
  chatId: number,
  item: ContentItem,
  caption: string | null,
  keyboard?: InlineKeyboard,
): Promise<unknown> {
  const [method, field] = SEND_METHOD[item.kind] ?? SEND_METHOD.photo;
  return tg(bot.token, method, {
    chat_id: chatId,
    [field]: item.file_id,
    ...(caption ? { caption, parse_mode: "HTML" } : {}),
    protect_content: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}
