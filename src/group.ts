/** Telegram group plumbing shared by the bot, the API and the admin routes. */

import { telegramWebhookUrl } from "./checks";
import type { BotConfig } from "./db";
import type { AppEnv } from "./env";
import { ALLOWED_UPDATES, tg } from "./telegram";

/** Point Telegram at this Worker for `bot`, asking for every update type the bot handles. */
export async function registerWebhook(bot: BotConfig, baseUrl: string): Promise<void> {
  await tg(bot.token, "setWebhook", {
    url: telegramWebhookUrl(baseUrl, bot.id),
    secret_token: bot.webhookSecret,
    allowed_updates: ALLOWED_UPDATES,
  });
}

/**
 * Approve mode needs a join-request link: people who use it are held for the
 * bot to approve. Creates one if the bot doesn't have it yet (or `force`) and
 * saves it. Throws if Telegram refuses (usually a missing admin permission).
 */
export async function ensureJoinLink(env: AppEnv, bot: BotConfig, force = false): Promise<string | null> {
  if (!bot.token || !bot.groupChatId) return null;
  if (bot.joinLink && !force) return bot.joinLink;
  const link = await tg<{ invite_link: string }>(bot.token, "createChatInviteLink", {
    chat_id: bot.groupChatId,
    name: "Paid members (approval)",
    creates_join_request: true,
  });
  await env.DB.prepare("UPDATE bots SET join_link = ?1 WHERE id = ?2").bind(link.invite_link, bot.id).run();
  return link.invite_link;
}
