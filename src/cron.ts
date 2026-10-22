/**
 * Scheduled work, run every minute by the Cron Trigger:
 *   • revoke plans that have run out (even minutes),
 *   • free passes: a heads-up, the end, and one follow-up a day later (odd minutes),
 *   • end self-serve Starter plans that have run out (every 15 minutes),
 *   • deliver queued /broadcast messages a batch at a time.
 *
 * Batches are small on purpose: the Workers free plan allows 50 outbound
 * requests and 50 database queries per run, and anything left over is simply
 * picked up on the next run a minute later.
 */

import { alertCreator } from "./alerts";
import { expireStarterPlans } from "./billing";
import { keepYourSpot, passKeyboard } from "./bot/handlers";
import { hasValidAccess, loadBot, now, type BotConfig, type MemberRow } from "./db";
import type { AppEnv } from "./env";
import { log, logError } from "./lib/http";
import { removeAccess } from "./payments";
import { sendMessage, tg } from "./telegram";

const EXPIRY_BATCH = 8;
const PASS_BATCH = 4;
const FOLLOWUP_DELAY = 86400;
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

  // Alternate minutes keep each run inside the free plan's request budget.
  if (new Date(scheduledTime).getUTCMinutes() % 2 === 0) await expireSubscriptions(env, bot);
  else await runFreePasses(env, bot);
  if (new Date(scheduledTime).getUTCMinutes() % 15 === 0) await endStarterPlans(env, bot);
  await deliverBroadcast(env, bot);
}

async function expireSubscriptions(env: AppEnv, bot: BotLoader): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT m.*
     FROM members m JOIN bots b ON b.id = m.bot_id
     WHERE m.has_access = 1 AND m.access_expires IS NOT NULL AND m.access_expires <= ?1
       AND b.status = 'active'
     ORDER BY m.access_expires LIMIT ?2`,
  )
    .bind(now(), EXPIRY_BATCH)
    .all<MemberRow>();
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
      "⏳ <b>Your access has ended.</b> Renew to keep your spot:",
      renewKeyboard(config, m),
    ).catch(() => undefined);
    log("subscription expired", { bot_id: m.bot_id, telegram_id: m.telegram_id });
  }
}

function renewKeyboard(config: BotConfig, member: MemberRow): Record<string, unknown> {
  const offer = passKeyboard(config, member);
  return "reply_markup" in offer
    ? offer
    : { reply_markup: { inline_keyboard: [[{ text: "🔄 Renew access", callback_data: "start_pay" }]] } };
}

type BotLoader = (id: string) => Promise<BotConfig | null>;

/** Free passes: warn before the end, end them, and follow up once a day later. */
async function runFreePasses(env: AppEnv, bot: BotLoader): Promise<void> {
  const at = now();

  // 1. Heads-up: three hours before the end, or halfway through a short pass.
  const warn = await env.DB.prepare(
    `SELECT m.* FROM members m JOIN bots b ON b.id = m.bot_id
     WHERE m.pass_expires IS NOT NULL AND m.pass_expires > ?1 AND m.pass_warned = 0
       AND m.pass_expires - ?1 <= MIN(10800, b.free_pass_hours * 1800)
       AND b.status = 'active'
     ORDER BY m.pass_expires LIMIT ?2`,
  )
    .bind(at, PASS_BATCH)
    .all<MemberRow>();
  for (const m of warn.results) {
    const claimed = await env.DB.prepare("UPDATE members SET pass_warned = 1 WHERE id = ?1 AND pass_warned = 0").bind(m.id).run();
    if (claimed.meta.changes === 0 || hasValidAccess(m, at)) continue;
    const config = await bot(m.bot_id);
    if (!config?.token) continue;
    const { text, extra } = keepYourSpot(config, m, "warning");
    await sendMessage(config.token, m.telegram_id, text, extra).catch(() => undefined);
  }

  // 2. The end: take the spot back unless they've paid, and offer the plans.
  const ended = await env.DB.prepare(
    `SELECT m.* FROM members m JOIN bots b ON b.id = m.bot_id
     WHERE m.pass_expires IS NOT NULL AND m.pass_expires <= ?1 AND b.status = 'active'
     ORDER BY m.pass_expires LIMIT ?2`,
  )
    .bind(at, PASS_BATCH)
    .all<MemberRow>();
  for (const m of ended.results) {
    const claimed = await env.DB.prepare(
      "UPDATE members SET pass_expires = NULL, pass_ended_at = ?2 WHERE id = ?1 AND pass_expires IS NOT NULL AND pass_expires <= ?2",
    )
      .bind(m.id, at)
      .run();
    if (claimed.meta.changes === 0) continue;
    const member = { ...m, pass_expires: null };
    if (hasValidAccess(member, at)) continue; // paid during the pass
    const config = await bot(m.bot_id);
    if (!config?.token) continue;
    await removeAccess(config, m.telegram_id);
    const { text, extra } = keepYourSpot(config, member, "ended");
    await sendMessage(config.token, m.telegram_id, text, extra).catch(() => undefined);
    log("free pass ended", { bot_id: m.bot_id, telegram_id: m.telegram_id });
  }

  // 3. One gentle follow-up a day later, only if they still haven't paid.
  const later = await env.DB.prepare(
    `SELECT m.* FROM members m JOIN bots b ON b.id = m.bot_id
     WHERE m.pass_ended_at IS NOT NULL AND m.followup_sent = 0 AND m.pass_ended_at <= ?1
       AND b.status = 'active'
     ORDER BY m.pass_ended_at LIMIT ?2`,
  )
    .bind(at - FOLLOWUP_DELAY, PASS_BATCH)
    .all<MemberRow>();
  for (const m of later.results) {
    const claimed = await env.DB.prepare("UPDATE members SET followup_sent = 1 WHERE id = ?1 AND followup_sent = 0").bind(m.id).run();
    if (claimed.meta.changes === 0 || hasValidAccess(m, at)) continue;
    const config = await bot(m.bot_id);
    if (!config?.token) continue;
    const { text, extra } = keepYourSpot(config, m, "followup");
    if (!("reply_markup" in extra)) continue; // nothing to offer right now
    await sendMessage(config.token, m.telegram_id, text, extra).catch(() => undefined);
  }
}

/** Self-serve Starter plans that ran out: back to an ended trial, and tell the creator. */
async function endStarterPlans(env: AppEnv, bot: (id: string) => Promise<BotConfig | null>): Promise<void> {
  const ended = await expireStarterPlans(env, now());
  for (const tenantId of ended) {
    log("starter plan ended", { tenant_id: tenantId });
    const { results } = await env.DB.prepare("SELECT id FROM bots WHERE tenant_id = ?1 AND status = 'active'")
      .bind(tenantId)
      .all<{ id: string }>();
    for (const row of results) {
      const config = await bot(row.id);
      if (config) {
        await alertCreator(env, config, "plan-ended", "Your Starter plan has ended, so your fee per sale is back to the standard rate. Your bot keeps selling as normal. Renew Starter in the dashboard (Account) any time.");
      }
    }
  }
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
