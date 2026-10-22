/**
 * Failure alerts sent to Telegram, so problems that cost sales are noticed
 * the same hour rather than when a buyer complains.
 *
 *  - alertOwner: platform problems, to the owner (ALERT_CHAT_ID, or every ID
 *    in ADMIN_USER_IDS) through the owner bot.
 *  - alertCreator: one bot's problems, to that bot's admins through the bot
 *    itself, so each creator hears about their own setup.
 *
 * Each alert has a key; the same key sends at most one message an hour, and
 * the next message says how many were held back. Never throws.
 */

import { now, parseIdList, type BotConfig } from "./db";
import type { AppEnv } from "./env";
import { logError } from "./lib/http";
import { escapeHtml, sendMessage } from "./telegram";

const WINDOW_SECONDS = 3600;

/** Returns how many alerts were held back since the last one, or null to stay quiet. */
async function claim(env: AppEnv, key: string): Promise<number | null> {
  const at = now();
  const row = await env.DB.prepare("SELECT last_sent_at, suppressed FROM alerts WHERE key = ?1")
    .bind(key)
    .first<{ last_sent_at: number; suppressed: number }>();
  if (row && row.last_sent_at > at - WINDOW_SECONDS) {
    await env.DB.prepare("UPDATE alerts SET suppressed = suppressed + 1 WHERE key = ?1").bind(key).run();
    return null;
  }
  await env.DB.prepare(
    `INSERT INTO alerts (key, last_sent_at, suppressed) VALUES (?1, ?2, 0)
     ON CONFLICT(key) DO UPDATE SET last_sent_at = ?2, suppressed = 0`,
  )
    .bind(key, at)
    .run();
  return row?.suppressed ?? 0;
}

async function deliver(token: string, chatIds: number[], key: string, env: AppEnv, html: string): Promise<void> {
  if (!token || chatIds.length === 0) return;
  try {
    const held = await claim(env, key);
    if (held === null) return;
    const text = `⚠️ ${html}${held > 0 ? `\n\n<i>${held} more like this in the last hour.</i>` : ""}`;
    await Promise.all(chatIds.map((id) => sendMessage(token, id, text).catch(() => undefined)));
  } catch (error) {
    logError("could not send alert", error, { key });
  }
}

export function ownerAlertChats(env: AppEnv): number[] {
  const explicit = parseIdList(env.ALERT_CHAT_ID);
  return explicit.length ? explicit : parseIdList(env.ADMIN_USER_IDS);
}

/** A platform problem, for the owner. `text` is plain text. */
export function alertOwner(env: AppEnv, key: string, text: string): Promise<void> {
  if (env.ALERTS === "off") return Promise.resolve();
  return deliver(env.TELEGRAM_BOT_TOKEN ?? "", ownerAlertChats(env), `owner:${key}`, env, `<b>Paywall alert</b>\n${escapeHtml(text)}`);
}

/** A problem with one bot, for that bot's admins (the owner, for the owner's bot). `text` is plain text. */
export function alertCreator(env: AppEnv, bot: BotConfig, key: string, text: string): Promise<void> {
  if (env.ALERTS === "off") return Promise.resolve();
  const chats = bot.isOwner ? [...new Set([...ownerAlertChats(env), ...bot.adminIds])] : bot.adminIds;
  const label = bot.username ? `@${bot.username}` : "your bot";
  return deliver(bot.token, chats, `bot:${bot.id}:${key}`, env, `<b>${escapeHtml(label)} needs attention</b>\n${escapeHtml(text)}`);
}
