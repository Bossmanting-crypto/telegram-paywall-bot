/**
 * Scheduled work, run every minute by the Cron Trigger:
 *   • revoke monthly subscriptions that have run out,
 *   • stop bots whose creator's free trial has ended,
 *   • deliver queued /broadcast messages a batch at a time.
 *
 * Batches are small on purpose: the Workers free plan allows 50 outbound
 * requests and 50 database queries per run, and anything left over is simply
 * picked up on the next run a minute later.
 */

import { loadBot, now, type BotConfig } from "./db";
import type { AppEnv } from "./env";
import { log, logError } from "./lib/http";
import { removeAccess } from "./payments";
import { sendMessage, tg } from "./telegram";

const EXPIRY_BATCH = 8;
const BROADCAST_BATCH = 20;

export async function runCron(env: AppEnv, scheduledTime: number): Promise<void> {
  const cache = new Map<string, BotConfig | null>();
  const bot = async (id: string): Promise<BotConfig | null> => {
    if (!cache.has(id)) {
      cache.set(id, await loadBot(env, id).catch((error) => {
        logError("cron could not load bot", error, { bot_id: id });
        return null;
      }));
    }
    return cache.get(id) ?? null;
  };

  await expireSubscriptions(env, bot);
  if (new Date(scheduledTime).getUTCMinutes() % 15 === 0) await expireTrials(env);
  await deliverBroadcast(env, bot);
}

async function expireSubscriptions(
  env: AppEnv,
  bot: (id: string) => Promise<BotConfig | null>,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.bot_id, m.telegram_id
     FROM members m JOIN bots b ON b.id = m.bot_id
     WHERE m.has_access = 1 AND m.access_expires IS NOT NULL AND m.access_expires <= ?1
       AND b.status = 'active'
     ORDER BY m.access_expires LIMIT ?2`,
  )
    .bind(now(), EXPIRY_BATCH)
    .all<{ id: string; bot_id: string; telegram_id: number }>();
  if (results.length === 0) return;

  // Mark them expired first, so a Telegram failure can't cause a member to be
  // processed again every minute. The expiry is re-checked in the UPDATE in
  // case someone renewed in the moment since the SELECT.
  const at = now();
  const updates = await env.DB.batch(
    results.map((m) =>
      env.DB.prepare(
        `UPDATE members SET has_access = 0, access_expires = NULL
         WHERE id = ?1 AND has_access = 1 AND access_expires IS NOT NULL AND access_expires <= ?2`,
      ).bind(m.id, at),
    ),
  );

  for (const [index, m] of results.entries()) {
    if ((updates[index]?.meta.changes ?? 0) === 0) continue; // renewed just in time
    const config = await bot(m.bot_id);
    if (!config?.token) continue;
    await removeAccess(config, m.telegram_id);
    await sendMessage(
      config.token,
      m.telegram_id,
      "⚠️ Your monthly subscription has expired. Renew to regain access:",
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Renew access", callback_data: "start_pay" }]] } },
    ).catch(() => undefined);
    log("subscription expired", { bot_id: m.bot_id, telegram_id: m.telegram_id });
  }
}

async function expireTrials(env: AppEnv): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE bots SET status = 'expired'
     WHERE status = 'active' AND tenant_id IN (
       SELECT id FROM tenants WHERE tier = 'free' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ?1
     )`,
  )
    .bind(now())
    .run();
  if (result.meta.changes > 0) log("free trials ended", { bots_stopped: result.meta.changes });
}

async function deliverBroadcast(
  env: AppEnv,
  bot: (id: string) => Promise<BotConfig | null>,
): Promise<void> {
  const job = await env.DB.prepare(
    "SELECT * FROM broadcasts WHERE status = 'pending' ORDER BY created_at LIMIT 1",
  ).first<{
    id: string;
    bot_id: string;
    text: string;
    cursor: number;
    sent: number;
    failed: number;
    requested_by: number | null;
  }>();
  if (!job) return;

  const config = await bot(job.bot_id);
  if (!config?.token) {
    await env.DB.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE id = ?1").bind(job.id).run();
    return;
  }

  // Walk members in telegram_id order, remembering where we got to.
  const { results } = await env.DB.prepare(
    `SELECT telegram_id FROM members
     WHERE bot_id = ?1 AND has_access = 1 AND telegram_id > ?2
     ORDER BY telegram_id LIMIT ?3`,
  )
    .bind(job.bot_id, job.cursor, BROADCAST_BATCH)
    .all<{ telegram_id: number }>();

  let sent = job.sent;
  let failed = job.failed;
  let cursor = job.cursor;
  for (const m of results) {
    try {
      // Plain text: an admin's message is not interpreted as HTML.
      await tg(config.token, "sendMessage", { chat_id: m.telegram_id, text: job.text });
      sent++;
    } catch {
      failed++; // usually: the member blocked the bot
    }
    cursor = m.telegram_id;
  }

  const finished = results.length < BROADCAST_BATCH;
  await env.DB.prepare("UPDATE broadcasts SET cursor = ?1, sent = ?2, failed = ?3, status = ?4 WHERE id = ?5")
    .bind(cursor, sent, failed, finished ? "done" : "pending", job.id)
    .run();

  if (finished && job.requested_by) {
    await sendMessage(
      config.token,
      job.requested_by,
      `📢 Broadcast sent to <b>${sent}</b> of ${sent + failed} member(s).`,
    ).catch(() => undefined);
  }
}
