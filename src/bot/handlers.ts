/**
 * Telegram bot engine. One function per kind of update, each given the bot's
 * resolved configuration, so the same code serves every creator's bot.
 *
 * Flow (mute mode): someone joins the group → they are restricted → the bot
 * sends them a payment menu → a provider webhook confirms payment →
 * restrictions lifted.
 *
 * Flow (approve mode): someone asks to join → the bot messages them a payment
 * menu → once paid, the bot approves the request (or sends a one-time link).
 *
 * Coins (optional, per bot): each person gets a free allowance and can buy
 * coin packs to unlock content items one at a time. Members with a paid plan
 * see every item free.
 */

import { MAX_VAULT_IMAGES, type AppEnv } from "../env";
import {
  botIsSelling,
  countVaultImages,
  getMember,
  hasValidAccess,
  memberGrantStatement,
  now,
  revokeMemberAccess,
  upsertMember,
  type AccessType,
  type BotConfig,
  type MemberRow,
  type Provider,
  ACCESS_TYPES,
  PROVIDERS,
} from "../db";
import {
  adjustCoins,
  balance,
  contentAt,
  contentIndex,
  countContent,
  countUnlocked,
  ensureFreeCoins,
  getContentItem,
  hasUnlocked,
  seesEverything,
  sendContent,
  unlockWithCoins,
  type ContentItem,
} from "../coins";
import { alertCreator } from "../alerts";
import { ensureJoinLink } from "../group";
import { newId } from "../lib/crypto";
import { queueBroadcast, rotateTenantKey } from "../services";
import { HttpError, logError, money } from "../lib/http";
import {
  ACCESS_LABEL,
  availableProviders,
  createCoinPayment,
  createPayment,
  deliverAccess,
  deliverVault,
  removeAccess,
} from "../payments";
import {
  escapeHtml,
  isInChat,
  restrictMember,
  sendMessage,
  tg,
  unrestrictMember,
  TelegramError,
  type InlineButton,
  type InlineKeyboard,
  type TgCallbackQuery,
  type TgChatJoinRequest,
  type TgChatMemberUpdated,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "../telegram";

const UNAVAILABLE = "⏸ This bot is not taking payments right now. Please try again later.";

export async function handleUpdate(
  env: AppEnv,
  bot: BotConfig,
  update: TgUpdate,
  baseUrl: string,
): Promise<void> {
  if (update.my_chat_member) return onBotMembership(env, bot, update.my_chat_member);
  if (update.chat_join_request) return onJoinRequest(env, bot, update.chat_join_request);
  if (update.chat_member) return onChatMember(env, bot, update.chat_member);
  if (update.callback_query) return onCallback(env, bot, update.callback_query, baseUrl);
  if (update.message) return onMessage(env, bot, update.message);
}

// ── Menus ────────────────────────────────────────────────────────────────────

const PLAN_BUTTON: Record<AccessType, (price: string) => string> = {
  one_time: (p) => `🔑 One-Time Access  $${p}`,
  monthly: (p) => `🔄 Monthly Access  $${p}/mo`,
  image_unlock: (p) => `🖼 Unlock Image Vault  $${p}`,
};

/** Plans this user can buy right now, as keyboard rows. */
async function planButtons(env: AppEnv, bot: BotConfig, member: MemberRow | null): Promise<InlineButton[][]> {
  const rows: InlineButton[][] = [];
  const lifetime = hasValidAccess(member) && member?.access_expires === null;
  if (!lifetime) {
    for (const type of ["one_time", "monthly"] as const) {
      if (bot.prices[type] > 0) {
        rows.push([{ text: PLAN_BUTTON[type](money(bot.prices[type])), callback_data: `access:${type}` }]);
      }
    }
  }
  const contentCount = await countVaultImages(env, bot.id);
  if (bot.prices.image_unlock > 0 && member?.images_unlocked !== 1 && contentCount > 0) {
    rows.push([
      { text: PLAN_BUTTON.image_unlock(money(bot.prices.image_unlock)), callback_data: "access:image_unlock" },
    ]);
  }
  if (bot.coins.enabled && contentCount > 0) {
    const coins = member?.coins ?? 0;
    rows.push([
      {
        text: seesEverything(member) ? "📸 Browse content" : `📸 Browse content · 🪙 ${coins}`,
        callback_data: "c:0",
      },
    ]);
  }
  return rows;
}

/** Plan buttons phrased as the "go unlimited" alternative to buying coins. */
function unlimitedButtons(bot: BotConfig, member: MemberRow | null): InlineButton[][] {
  if (hasValidAccess(member) && member?.access_expires === null) return [];
  const rows: InlineButton[][] = [];
  if (bot.prices.monthly > 0) {
    rows.push([{ text: `⭐ Go unlimited · $${money(bot.prices.monthly)}/mo`, callback_data: "access:monthly" }]);
  }
  if (bot.prices.one_time > 0) {
    rows.push([{ text: `⭐ Unlimited forever · $${money(bot.prices.one_time)}`, callback_data: "access:one_time" }]);
  }
  return rows;
}

function coinPackButtons(bot: BotConfig): InlineButton[][] {
  return bot.coins.packs.map((pack, i) => [
    {
      text: `🪙 ${pack.coins} coins · $${money(pack.price)}${bot.coins.packs.length === 3 && i === 1 ? "  ⭐ popular" : ""}`,
      callback_data: `cp:${i}`,
    },
  ]);
}

function planMenuText(bot: BotConfig, member: MemberRow | null = null): string {
  const lines = [`🔒 <b>${escapeHtml(bot.welcomeTitle)}</b>`, "", escapeHtml(bot.welcomeText)];
  if (bot.groupDescription) lines.push("", `<i>${escapeHtml(bot.groupDescription)}</i>`);
  if (bot.coins.enabled && member && member.coins > 0 && !seesEverything(member)) {
    lines.push("", `🎁 You have <b>${member.coins} coins</b> to unlock content. Tap <b>Browse content</b> to start.`);
  }
  lines.push("", "Choose your access plan:");
  return lines.join("\n");
}

const PROVIDER_BUTTON: Record<Provider, (bot: BotConfig) => string> = {
  paystack: (bot) => (bot.currency === "KES" ? "💳 Card / M-Pesa (Paystack)" : "💳 Card / Bank (Paystack)"),
  nowpayments: () => "₿ Crypto (NOWPayments)",
  btcpay: () => "⚡ Bitcoin (BTCPay)",
};

const PROVIDER_NOTE: Record<Provider, (bot: BotConfig) => string> = {
  paystack: (bot) =>
    bot.currency === "KES" ? "💳 Accepts <b>Visa, Mastercard, M-Pesa</b>" : "💳 Accepts <b>cards and bank payments</b>",
  nowpayments: () => "₿ Accepts <b>BTC, ETH, USDT, LTC + 100 more coins</b>",
  btcpay: () => "⚡ Accepts <b>BTC (on-chain + Lightning)</b>",
};

function providerKeyboard(bot: BotConfig, type: AccessType): InlineKeyboard {
  const rows: InlineButton[][] = availableProviders(bot).map((provider) => [
    { text: PROVIDER_BUTTON[provider](bot), callback_data: `pay:${type}:${provider}` },
  ]);
  rows.push([{ text: "🔙 Back", callback_data: "start_pay" }]);
  return { inline_keyboard: rows };
}

async function sendPlanMenu(
  env: AppEnv,
  bot: BotConfig,
  chatId: number,
  member: MemberRow | null,
  intro?: string,
): Promise<void> {
  const rows = await planButtons(env, bot, member);
  if (rows.length === 0 || availableProviders(bot).length === 0) {
    await sendMessage(bot.token, chatId, UNAVAILABLE);
    return;
  }
  await sendMessage(bot.token, chatId, intro ?? planMenuText(bot, member), {
    reply_markup: { inline_keyboard: rows },
  });
}

function mention(user: TgUser): string {
  return `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name || "there")}</a>`;
}

// ── The bot itself was added to / promoted in a chat ─────────────────────────

async function onBotMembership(env: AppEnv, bot: BotConfig, upd: TgChatMemberUpdated): Promise<void> {
  const { chat, new_chat_member: me } = upd;
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  if (me.status === "administrator") {
    if (bot.groupChatId === null) {
      // First group the bot is made admin of becomes its paywalled group.
      const result = await env.DB.prepare(
        "UPDATE bots SET group_chat_id = ?1, group_name = ?2 WHERE id = ?3 AND group_chat_id IS NULL",
      )
        .bind(chat.id, chat.title ?? null, bot.id)
        .run();
      if (result.meta.changes > 0) {
        await sendMessage(
          bot.token,
          chat.id,
          bot.joinMode === "approve"
            ? "✅ <b>Paywall is active.</b> New members will be let in once they've paid."
            : "✅ <b>Paywall is active.</b> New members will be asked to pay before they can post.",
        ).catch(() => undefined);
        if (bot.joinMode === "approve") {
          await ensureJoinLink(env, { ...bot, groupChatId: chat.id }).catch(() => undefined);
        }
      }
    } else if (bot.groupChatId === chat.id && chat.title && chat.title !== bot.groupName) {
      await env.DB.prepare("UPDATE bots SET group_name = ?1 WHERE id = ?2").bind(chat.title, bot.id).run();
    }
    return;
  }

  if (me.status === "member" && bot.groupChatId === null) {
    await sendMessage(
      bot.token,
      chat.id,
      "👋 Thanks for adding me! Promote me to <b>admin</b> with the <b>Ban users</b> permission so I can manage access.",
    ).catch(() => undefined);
  }
}

// ── Someone joined the paywalled group ───────────────────────────────────────

async function onChatMember(env: AppEnv, bot: BotConfig, upd: TgChatMemberUpdated): Promise<void> {
  if (bot.groupChatId === null || upd.chat.id !== bot.groupChatId) return;

  const joined = !isInChat(upd.old_chat_member) && isInChat(upd.new_chat_member);
  if (!joined) return; // promotions, our own restrict/unrestrict calls, people leaving

  const user = upd.new_chat_member.user;
  const status = upd.new_chat_member.status;
  if (user.is_bot || status === "creator" || status === "administrator") return;
  if (bot.adminIds.includes(user.id)) return;
  if (!botIsSelling(bot)) return; // paused or expired bots leave the group open

  const member = await upsertMember(env, bot.id, user);

  if (hasValidAccess(member)) {
    // A paying member came back: make sure an old restriction isn't still on.
    await unrestrictMember(bot.token, bot.groupChatId, user.id).catch((e) =>
      logError("could not unrestrict returning member", e, { bot_id: bot.id, telegram_id: user.id }),
    );
    return;
  }

  try {
    await restrictMember(bot.token, bot.groupChatId, user.id);
  } catch (error) {
    // Usually: the bot is not an admin, or lacks the "Ban users" permission.
    logError("could not restrict new member", error, { bot_id: bot.id, telegram_id: user.id });
    await alertCreator(env, bot, "restrict", "Someone joined the group but I couldn't mute them, so they can post without paying. Make sure I'm an admin with the Ban users permission.");
    return;
  }

  // Bots can only message people who have started them, so try a private
  // message first and fall back to a notice in the group.
  member.coins = await ensureFreeCoins(env, bot, member);
  try {
    await sendPlanMenu(
      env,
      bot,
      user.id,
      member,
      `👋 Hi <b>${escapeHtml(user.first_name || "there")}</b>!\n\n${planMenuText(bot, member)}`,
    );
    return;
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error;
  }

  const link = bot.username ? `https://t.me/${bot.username}?start=pay` : null;
  try {
    const notice = await sendMessage(
      bot.token,
      bot.groupChatId,
      `👋 Welcome ${mention(user)}!\n\nThis group is for paying members. ` +
        (link
          ? "Tap the button below and press <b>Start</b> to unlock access."
          : "Open a private chat with me and press <b>Start</b> to unlock access."),
      link ? { reply_markup: { inline_keyboard: [[{ text: "🔓 Unlock access", url: link }]] } } : {},
    );
    // Keep the group tidy: only the most recent welcome notice stays.
    if (bot.lastNoticeMessageId) {
      await tg(bot.token, "deleteMessage", {
        chat_id: bot.groupChatId,
        message_id: bot.lastNoticeMessageId,
      }).catch(() => undefined);
    }
    await env.DB.prepare("UPDATE bots SET last_notice_message_id = ?1 WHERE id = ?2")
      .bind(notice.message_id, bot.id)
      .run();
  } catch (error) {
    logError("could not post welcome notice", error, { bot_id: bot.id });
  }
}

// ── Someone asked to join the group (approve mode) ───────────────────────────

async function onJoinRequest(env: AppEnv, bot: BotConfig, req: TgChatJoinRequest): Promise<void> {
  if (bot.groupChatId === null || req.chat.id !== bot.groupChatId) return;
  const user = req.from;
  if (user.is_bot) return;

  const member = await upsertMember(env, bot.id, user);
  if (bot.adminIds.includes(user.id) || hasValidAccess(member)) {
    await tg(bot.token, "approveChatJoinRequest", { chat_id: bot.groupChatId, user_id: user.id }).catch((e) =>
      logError("could not approve join request", e, { bot_id: bot.id, telegram_id: user.id }),
    );
    return;
  }
  // In mute mode the group's own admins decide on join requests.
  if (bot.joinMode !== "approve") return;

  // The bot may message the requester for a few minutes through user_chat_id.
  const chatId = req.user_chat_id || user.id;
  if (!botIsSelling(bot)) {
    await sendMessage(bot.token, chatId, UNAVAILABLE).catch(() => undefined);
    return;
  }
  member.coins = await ensureFreeCoins(env, bot, member);
  const group = bot.groupName ? `<b>${escapeHtml(bot.groupName)}</b>` : "the group";
  await sendPlanMenu(
    env,
    bot,
    chatId,
    member,
    `👋 Hi <b>${escapeHtml(user.first_name || "there")}</b>! Thanks for asking to join ${group}.\n\n` +
      `${planMenuText(bot, member)}\n\n<i>You'll be let in automatically as soon as your payment is confirmed.</i>`,
  ).catch((e) => logError("could not message join requester", e, { bot_id: bot.id, telegram_id: user.id }));
}

// ── Content and coins ────────────────────────────────────────────────────────

function navRow(index: number, total: number): InlineButton[] {
  const row: InlineButton[] = [];
  if (index > 0) row.push({ text: "◀ Previous", callback_data: `c:${index - 1}` });
  if (index < total - 1) row.push({ text: "Next ▶", callback_data: `c:${index + 1}` });
  return row;
}

function itemCaption(item: ContentItem, index: number, total: number, footer?: string): string {
  const parts = [];
  if (item.caption) parts.push(escapeHtml(item.caption));
  parts.push(`<i>${index + 1} of ${total}</i>${footer ? ` · ${footer}` : ""}`);
  return parts.join("\n\n");
}

/** Show content item number `index`: the item itself if unlocked, otherwise an unlock card. */
async function showContent(env: AppEnv, bot: BotConfig, chatId: number, user: TgUser, index: number): Promise<void> {
  const { item, total } = await contentAt(env, bot.id, index);
  if (total === 0) {
    await sendMessage(bot.token, chatId, "📭 Nothing here yet. Check back soon!");
    return;
  }
  if (!item) {
    await showContent(env, bot, chatId, user, total - 1);
    return;
  }
  const member = await upsertMember(env, bot.id, user);
  const nav = navRow(index, total);
  const keyboard = (rows: InlineButton[][]): InlineKeyboard => ({ inline_keyboard: rows.filter((r) => r.length) });

  if (seesEverything(member)) {
    await sendContent(bot, chatId, item, itemCaption(item, index, total), keyboard([nav]));
    return;
  }
  if (await hasUnlocked(env, bot.id, user.id, item.id)) {
    // Coin users see their balance with every item they open.
    const footer = bot.coins.enabled ? `🪙 ${member.coins}` : undefined;
    await sendContent(bot, chatId, item, itemCaption(item, index, total, footer), keyboard([nav]));
    return;
  }
  if (!bot.coins.enabled) {
    await sendPlanMenu(env, bot, chatId, member, "🔒 This content is for members.\n\nChoose a plan to unlock it:");
    return;
  }

  const coins = await ensureFreeCoins(env, bot, member);
  const cost = bot.coins.unlockCost;
  const teaser = item.caption ? `\n\n${escapeHtml(item.caption.slice(0, 200))}` : "";
  const kind = { photo: "📷 Photo", video: "🎬 Video", animation: "🎞 Clip", document: "📄 File" }[item.kind] ?? "📷 Photo";
  await sendMessage(
    bot.token,
    chatId,
    `🔒 <b>${kind} ${index + 1} of ${total}</b>${teaser}\n\nUnlock for <b>${cost} coin${cost === 1 ? "" : "s"}</b>. You have <b>${coins}</b>.`,
    {
      reply_markup: keyboard([
        [{ text: `🔓 Unlock · 🪙 ${cost}`, callback_data: `u:${item.id}` }],
        nav,
        [{ text: "🪙 Buy coins", callback_data: "coins" }],
      ]),
    },
  );
}

async function unlockItem(env: AppEnv, bot: BotConfig, chatId: number, user: TgUser, itemId: string): Promise<void> {
  const item = await getContentItem(env, bot.id, itemId);
  if (!item) {
    await sendMessage(bot.token, chatId, "That item isn't available any more.");
    return;
  }
  const member = await upsertMember(env, bot.id, user);
  const [index, total] = await Promise.all([contentIndex(env, bot.id, item.id), countContent(env, bot.id)]);
  const nav = navRow(index, total);
  if (seesEverything(member)) {
    await sendContent(bot, chatId, item, itemCaption(item, index, total), { inline_keyboard: nav.length ? [nav] : [] });
    return;
  }
  if (!bot.coins.enabled) {
    await sendPlanMenu(env, bot, chatId, member);
    return;
  }
  await ensureFreeCoins(env, bot, member);
  const result = await unlockWithCoins(env, bot, user.id, item.id);
  if (result.status === "insufficient") {
    await outOfCoins(env, bot, chatId, member, result.balance);
    return;
  }
  const footer = `🪙 ${result.balance}`;
  await sendContent(bot, chatId, item, itemCaption(item, index, total, footer), {
    inline_keyboard: nav.length ? [nav] : [],
  });
}

/** The friendly "want more?" prompt: coin packs, or a membership. */
async function outOfCoins(env: AppEnv, bot: BotConfig, chatId: number, member: MemberRow, coins: number): Promise<void> {
  const cost = bot.coins.unlockCost;
  const bought = await env.DB.prepare(
    "SELECT 1 AS x FROM coin_ledger WHERE bot_id = ?1 AND telegram_id = ?2 AND reason = 'purchase' LIMIT 1",
  )
    .bind(bot.id, member.telegram_id)
    .first();
  const head =
    member.free_coins_granted === 1 && !bought
      ? "🎉 <b>You've used your free coins!</b>"
      : `🪙 <b>You need ${cost} coins</b> to unlock this. You have ${coins}.`;
  const canPay = availableProviders(bot).length > 0;
  const rows = canPay ? [...coinPackButtons(bot), ...unlimitedButtons(bot, member)] : [];
  await sendMessage(
    bot.token,
    chatId,
    canPay
      ? `${head}\n\nWant to see more? Grab a coin pack, or go unlimited and see everything:`
      : `${head}\n\nCoin packs aren't on sale right now. Please check back later.`,
    rows.length ? { reply_markup: { inline_keyboard: rows } } : {},
  );
}

async function balanceText(env: AppEnv, bot: BotConfig, member: MemberRow): Promise<string> {
  const [coins, unlocked, total] = await Promise.all([
    balance(env, bot.id, member.telegram_id),
    countUnlocked(env, bot.id, member.telegram_id),
    countContent(env, bot.id),
  ]);
  if (seesEverything(member)) {
    return `🪙 <b>Your coins: ${coins}</b>\n\n⭐ Your membership includes all ${total} item${total === 1 ? "" : "s"} for free.`;
  }
  return (
    `🪙 <b>Your coins: ${coins}</b>\n\n` +
    `Each item costs ${bot.coins.unlockCost} coin${bot.coins.unlockCost === 1 ? "" : "s"}. ` +
    `You've unlocked ${unlocked} of ${total}.`
  );
}

function balanceKeyboard(bot: BotConfig, member: MemberRow): InlineKeyboard {
  const rows: InlineButton[][] = [[{ text: "📸 Browse content", callback_data: "c:0" }]];
  if (availableProviders(bot).length > 0 && !seesEverything(member)) {
    rows.push([{ text: "🪙 Buy coins", callback_data: "coins" }], ...unlimitedButtons(bot, member));
  }
  return { inline_keyboard: rows };
}

// ── Messages and commands ────────────────────────────────────────────────────

function parseCommand(text: string, botUsername: string | null): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || !match[1]) return null;
  const target = match[2];
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: match[1].toLowerCase(), args: (match[3] ?? "").trim() };
}

async function onMessage(env: AppEnv, bot: BotConfig, msg: TgMessage): Promise<void> {
  const from = msg.from;
  if (!from || from.is_bot) return;

  const isAdmin = bot.adminIds.includes(from.id);
  const command = parseCommand(msg.text?.trim() ?? "", bot.username);
  const reply = (html: string, extra: Record<string, unknown> = {}) =>
    sendMessage(bot.token, msg.chat.id, html, extra);

  if (command?.name === "id" && (msg.chat.type === "private" || isAdmin || bot.groupChatId === null)) {
    await reply(`Chat ID: <code>${msg.chat.id}</code>\nYour user ID: <code>${from.id}</code>`);
    return;
  }

  if (command?.name === "accountkey" && msg.chat.type === "private") {
    await recoverAccountKey(env, bot, from, reply);
    return;
  }

  if (isAdmin && command && (await adminCommand(env, bot, command, reply, from))) return;

  if (msg.chat.type !== "private") return; // ordinary group chatter is ignored

  if (isAdmin && !command && (msg.photo?.length || msg.video || msg.animation || msg.document)) {
    await addToVault(env, bot, msg, reply);
    return;
  }

  const member = await upsertMember(env, bot.id, from);
  if (bot.coins.enabled) member.coins = await ensureFreeCoins(env, bot, member);

  if (bot.coins.enabled && (command?.name === "balance" || command?.name === "coins")) {
    await reply(await balanceText(env, bot, member), { reply_markup: balanceKeyboard(bot, member) });
    return;
  }
  if (command?.name === "content" || command?.name === "browse" || (command?.name === "start" && command.args === "content")) {
    if (bot.coins.enabled || seesEverything(member)) {
      await showContent(env, bot, msg.chat.id, from, 0);
      return;
    }
  }

  if (command?.name === "vault" && member.images_unlocked === 1) {
    await deliverVault(env, bot, from.id);
    return;
  }

  if (!botIsSelling(bot)) {
    await reply(UNAVAILABLE);
    return;
  }

  if (hasValidAccess(member)) {
    // Also repairs the rare case where payment was recorded but the unlock
    // call to Telegram failed.
    if (bot.groupChatId) {
      await unrestrictMember(bot.token, bot.groupChatId, from.id).catch(() => undefined);
    }
    const expiry = member.access_expires
      ? `\nYour subscription runs until <b>${new Date(member.access_expires * 1000).toUTCString().slice(5, 16)}</b>.`
      : "";
    const extras = await planButtons(env, bot, member);
    await reply(
      `✅ You have active access to the group!${expiry}`,
      extras.length ? { reply_markup: { inline_keyboard: extras } } : {},
    );
    return;
  }

  await sendPlanMenu(env, bot, msg.chat.id, member);
}

const KEY_RECOVERY_COOLDOWN = 600;

/**
 * A creator who has lost their API key sends /accountkey to one of their own
 * bots from the Telegram account linked to their platform account, and gets
 * a new key in this chat. The old key stops working.
 */
async function recoverAccountKey(
  env: AppEnv,
  bot: BotConfig,
  from: TgUser,
  reply: (html: string, extra?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  if (bot.isOwner) {
    await reply("This bot's account uses the platform admin key, which is set in Cloudflare.");
    return;
  }
  const tenant = await env.DB.prepare("SELECT recovery_telegram_id, is_active FROM tenants WHERE id = ?1")
    .bind(bot.tenantId)
    .first<{ recovery_telegram_id: number | null; is_active: number }>();
  if (!tenant || tenant.recovery_telegram_id !== from.id) {
    // Same answer whether or not an account exists, so nothing is revealed.
    await reply("This Telegram account isn't linked to this bot's platform account, so I can't issue a key here.");
    return;
  }
  if (tenant.is_active !== 1) {
    await reply("This account is suspended. Contact the platform owner.");
    return;
  }
  const at = now();
  const last = await env.DB.prepare("SELECT last_sent_at FROM alerts WHERE key = ?1")
    .bind(`accountkey:${bot.tenantId}`)
    .first<{ last_sent_at: number }>();
  if (last && last.last_sent_at > at - KEY_RECOVERY_COOLDOWN) {
    await reply("A new key was issued a few minutes ago. Please wait 10 minutes before asking again.");
    return;
  }
  await env.DB.prepare(
    `INSERT INTO alerts (key, last_sent_at, suppressed) VALUES (?1, ?2, 0)
     ON CONFLICT(key) DO UPDATE SET last_sent_at = ?2`,
  )
    .bind(`accountkey:${bot.tenantId}`, at)
    .run();
  const key = await rotateTenantKey(env, bot.tenantId);
  await reply(
    `🔑 <b>Your new account key</b>\n\n<code>${key}</code>\n\nYour old key has stopped working. Save this one somewhere safe, then delete this message. Sign in at the dashboard with it.`,
    { protect_content: true },
  );
}

async function addToVault(
  env: AppEnv,
  bot: BotConfig,
  msg: TgMessage,
  reply: (html: string) => Promise<unknown>,
): Promise<void> {
  const photo = msg.photo?.[msg.photo.length - 1]; // largest size is last
  const [kind, file] = photo
    ? (["photo", photo] as const)
    : msg.video
      ? (["video", msg.video] as const)
      : msg.animation
        ? (["animation", msg.animation] as const)
        : msg.document
          ? (["document", msg.document] as const)
          : [null, null];
  if (!kind || !file) return;
  const count = await countVaultImages(env, bot.id);
  if (count >= MAX_VAULT_IMAGES) {
    await reply(`🖼 The vault is full (${MAX_VAULT_IMAGES} items). Send /clearvault to start over.`);
    return;
  }
  const caption = msg.caption?.trim().slice(0, 1000) || null;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO vault_images (id, bot_id, file_id, file_unique_id, added_by, created_at, kind, caption)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(newId(), bot.id, file.file_id, file.file_unique_id, msg.from?.id ?? null, now(), kind, caption)
    .run();
  const added = result.meta.changes > 0;
  const hint = bot.coins.enabled
    ? ` People can unlock it for ${bot.coins.unlockCost} coin${bot.coins.unlockCost === 1 ? "" : "s"}.${caption ? "" : " Tip: add a caption to tease what's inside."}`
    : "";
  await reply(
    added
      ? `🖼 Added to the vault (${count + 1} item${count + 1 === 1 ? "" : "s"}).${hint}`
      : "🖼 That's already in the vault.",
  );
}

// ── Admin commands: /stats /grant /revoke /broadcast /vault /clearvault ──────

async function adminCommand(
  env: AppEnv,
  bot: BotConfig,
  command: { name: string; args: string },
  reply: (html: string) => Promise<unknown>,
  from: TgUser,
): Promise<boolean> {
  switch (command.name) {
    case "stats": {
      const at = now();
      const members = await env.DB.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN has_access = 1 AND (access_expires IS NULL OR access_expires > ?2) THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(CASE WHEN has_access = 1 AND access_expires > ?2 THEN 1 ELSE 0 END), 0) AS monthly,
                COALESCE(SUM(CASE WHEN has_access = 1 AND access_expires IS NULL THEN 1 ELSE 0 END), 0) AS lifetime
         FROM members WHERE bot_id = ?1`,
      )
        .bind(bot.id, at)
        .first<{ total: number; active: number; monthly: number; lifetime: number }>();
      const payments = await env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
                COALESCE(SUM(CASE WHEN status = 'confirmed' THEN gross_amount ELSE 0 END), 0) AS gross
         FROM payments WHERE bot_id = ?1`,
      )
        .bind(bot.id)
        .first<{ pending: number; confirmed: number; gross: number }>();
      await reply(
        `📊 <b>Bot Statistics</b>\n\n` +
          `👥 Total users: <b>${members?.total ?? 0}</b>\n` +
          `✅ Active access: <b>${members?.active ?? 0}</b>\n` +
          `  ├ One-time / granted: <b>${members?.lifetime ?? 0}</b>\n` +
          `  └ Monthly: <b>${members?.monthly ?? 0}</b>\n` +
          `💰 Paid orders: <b>${payments?.confirmed ?? 0}</b> ($${(payments?.gross ?? 0).toFixed(2)})\n` +
          `⏳ Pending payments: <b>${payments?.pending ?? 0}</b>`,
      );
      return true;
    }

    case "grant":
    case "revoke": {
      const uid = Number(command.args.split(/\s+/)[0]);
      if (!command.args || !Number.isSafeInteger(uid) || uid <= 0) {
        await reply(`Usage: /${command.name} &lt;user_id&gt;`);
        return true;
      }
      if (command.name === "grant") {
        await memberGrantStatement(env, bot.id, uid, "manual_grant").run();
        await deliverAccess(env, bot, uid, "manual_grant");
        await reply(`✅ Granted access to user <code>${uid}</code>`);
      } else {
        const found = await revokeMemberAccess(env, bot.id, uid);
        await removeAccess(bot, uid);
        await reply(
          found ? `🚫 Revoked access for user <code>${uid}</code>` : `No record of user <code>${uid}</code> — restricted them in the group anyway.`,
        );
      }
      return true;
    }

    case "broadcast": {
      if (!command.args) {
        await reply("Usage: /broadcast &lt;message&gt;");
        return true;
      }
      const recipients = await queueBroadcast(env, bot.id, command.args, from.id);
      await reply(
        `📢 Broadcast queued for <b>${recipients}</b> member(s). Delivery starts within a minute; I'll confirm when it's done.`,
      );
      return true;
    }

    case "vault": {
      const count = await countVaultImages(env, bot.id);
      await reply(
        `🖼 The vault holds <b>${count}</b> item(s) (max ${MAX_VAULT_IMAGES}).\n\n` +
          `Send me photos, videos, GIFs or files in this chat to add them. A caption becomes the teaser. /clearvault empties it.\n` +
          (bot.coins.enabled ? `Coins are on: each item costs <b>${bot.coins.unlockCost}</b>, new people get <b>${bot.coins.free}</b> free.\n` : "") +
          (bot.prices.image_unlock > 0
            ? `Price: <b>$${money(bot.prices.image_unlock)}</b>`
            : "The vault has no price set, so it is not on sale."),
      );
      return true;
    }

    case "givecoins": {
      const [rawId, rawAmount] = command.args.split(/\s+/);
      const uid = Number(rawId);
      const amount = Number(rawAmount);
      if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 100000) {
        await reply("Usage: /givecoins &lt;user_id&gt; &lt;amount&gt;  (a negative amount takes coins away)");
        return true;
      }
      const left = await adjustCoins(env, bot.id, uid, amount, "grant", `admin:${from.id}`);
      await reply(`🪙 ${amount > 0 ? "Gave" : "Took"} ${Math.abs(amount)} coins ${amount > 0 ? "to" : "from"} <code>${uid}</code>. Their balance: <b>${left}</b>.`);
      if (amount > 0 && bot.token) {
        await sendMessage(bot.token, uid, `🎁 You've been given <b>${amount} coins</b>! Your balance: <b>${left}</b>.`, {
          reply_markup: { inline_keyboard: [[{ text: "📸 Browse content", callback_data: "c:0" }]] },
        }).catch(() => undefined);
      }
      return true;
    }

    case "joinlink": {
      if (!bot.groupChatId) {
        await reply("Add me to your group as an admin first.");
        return true;
      }
      try {
        const link = await ensureJoinLink(env, bot, command.args === "new");
        await reply(
          `🔗 Share this link. People who use it ask to join, and I let them in once they've paid:\n${link}\n\n` +
            (bot.joinMode === "approve"
              ? "Send <code>/joinlink new</code> to replace it."
              : "⚠️ Approval mode is off, so I won't handle these requests. Turn it on in the dashboard."),
        );
      } catch (error) {
        await reply(`Couldn't create the link. Make sure I'm an admin with the <b>Invite users via link</b> permission.`);
        logError("could not create join link", error, { bot_id: bot.id });
      }
      return true;
    }

    case "clearvault": {
      await env.DB.prepare("DELETE FROM vault_images WHERE bot_id = ?1").bind(bot.id).run();
      await reply("🗑 Vault emptied.");
      return true;
    }

    case "help": {
      await reply(
        "<b>Admin commands</b>\n" +
          "/stats — members and payments\n" +
          "/grant &lt;user_id&gt; — give access for free\n" +
          "/revoke &lt;user_id&gt; — remove access\n" +
          "/broadcast &lt;message&gt; — message all paying members\n" +
          "/vault — content status (send photos, videos or files to add)\n" +
          "/clearvault — empty the vault\n" +
          "/givecoins &lt;user_id&gt; &lt;amount&gt; — give someone coins\n" +
          "/joinlink — link for people to ask to join (approval mode)\n" +
          "/id — show this chat's ID and your user ID",
      );
      return true;
    }

    default:
      return false;
  }
}

// ── Inline button presses ────────────────────────────────────────────────────

function normaliseAccessType(value: string | undefined): AccessType | null {
  const mapped = value === "onetime" ? "one_time" : value; // buttons sent by the old bot
  return ACCESS_TYPES.includes(mapped as AccessType) ? (mapped as AccessType) : null;
}

async function onCallback(env: AppEnv, bot: BotConfig, query: TgCallbackQuery, baseUrl: string): Promise<void> {
  const data = query.data ?? "";
  const user = query.from;
  const chatId = query.message?.chat.id ?? user.id;
  const messageId = query.message?.message_id;

  await tg(bot.token, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => undefined);

  /** Replace the menu message in place; fall back to a new message. */
  const show = async (html: string, keyboard?: InlineKeyboard): Promise<void> => {
    const extra = keyboard ? { reply_markup: keyboard } : {};
    if (messageId) {
      try {
        await tg(bot.token, "editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...extra,
        });
        return;
      } catch (error) {
        if (error instanceof TelegramError && error.description.includes("not modified")) return;
      }
    }
    await sendMessage(bot.token, chatId, html, extra);
  };

  // Viewing content and spending coins already owned works even while sales are paused.
  if (data.startsWith("c:")) {
    const index = Number(data.slice(2));
    await showContent(env, bot, chatId, user, Number.isSafeInteger(index) ? index : 0);
    return;
  }
  if (data.startsWith("u:")) {
    await unlockItem(env, bot, chatId, user, data.slice(2));
    return;
  }
  if (data === "bal" && bot.coins.enabled) {
    const m = await upsertMember(env, bot.id, user);
    m.coins = await ensureFreeCoins(env, bot, m);
    await show(await balanceText(env, bot, m), balanceKeyboard(bot, m));
    return;
  }

  if (!botIsSelling(bot)) {
    await show(UNAVAILABLE);
    return;
  }

  const member = await upsertMember(env, bot.id, user);

  if (data === "coins" || data.startsWith("cp:") || data.startsWith("cpay:")) {
    if (!bot.coins.enabled || bot.coins.packs.length === 0 || availableProviders(bot).length === 0) {
      await show("🪙 Coin packs aren't on sale right now.");
      return;
    }
    if (data === "coins") {
      const coins = await ensureFreeCoins(env, bot, member);
      await show(
        `🪙 <b>Buy coins</b>\n\nEach item costs <b>${bot.coins.unlockCost}</b> coin${bot.coins.unlockCost === 1 ? "" : "s"}. You have <b>${coins}</b>.\n\nCoins never expire.`,
        { inline_keyboard: [...coinPackButtons(bot), ...unlimitedButtons(bot, member), [{ text: "🔙 Back", callback_data: "bal" }]] },
      );
      return;
    }
    const [kind, rawIndex, rawProvider] = data.split(":");
    const index = Number(rawIndex);
    const pack = Number.isSafeInteger(index) ? bot.coins.packs[index] : undefined;
    if (!pack) {
      await show("That coin pack has changed. Tap below to see the current ones.", {
        inline_keyboard: [[{ text: "🪙 Coin packs", callback_data: "coins" }]],
      });
      return;
    }
    if (kind === "cp") {
      const rows: InlineButton[][] = availableProviders(bot).map((provider) => [
        { text: PROVIDER_BUTTON[provider](bot), callback_data: `cpay:${index}:${provider}` },
      ]);
      rows.push([{ text: "🔙 Back", callback_data: "coins" }]);
      await show(`🪙 <b>${pack.coins} coins — $${money(pack.price)}</b>\n\nChoose your payment method:`, { inline_keyboard: rows });
      return;
    }
    const provider = PROVIDERS.includes(rawProvider as Provider) ? (rawProvider as Provider) : null;
    if (!provider) {
      await show("Choose a payment method:", { inline_keyboard: [[{ text: "🔙 Back", callback_data: `cp:${index}` }]] });
      return;
    }
    await show("⏳ Generating your payment link…");
    try {
      const payment = await createCoinPayment(env, bot, { telegramId: user.id, packIndex: index, provider, baseUrl });
      await show(
        `✅ <b>Payment Link Ready!</b>\n\n${PROVIDER_NOTE[provider](bot)}\n\n` +
          `You get: <b>${payment.coins} coins</b>\nAmount: <b>$${payment.amount.toFixed(2)}</b>\n` +
          `Reference: <code>${payment.orderId}</code>\n\nCoins are added automatically once the payment is confirmed.`,
        {
          inline_keyboard: [
            [{ text: "💳 Pay Now", url: payment.paymentUrl }],
            [{ text: "🔙 Change Method", callback_data: `cp:${index}` }],
          ],
        },
      );
    } catch (error) {
      logError("coin payment link error", error, { bot_id: bot.id, provider });
      await alertCreator(env, bot, `paylink-${provider}`, `A buyer couldn't get a ${provider} payment link for coins: ${error instanceof Error ? error.message : String(error)}. Check your ${provider} keys in the dashboard.`);
      await show("❌ Failed to generate a payment link. Please try again.", {
        inline_keyboard: [[{ text: "🪙 Coin packs", callback_data: "coins" }]],
      });
    }
    return;
  }
  const showPlans = async (intro?: string): Promise<void> => {
    const rows = await planButtons(env, bot, await getMember(env, bot.id, user.id));
    if (rows.length === 0) {
      await show(intro ?? "✅ You already have everything this bot offers.");
      return;
    }
    await show(intro ? `${intro}\n\n${planMenuText(bot)}` : planMenuText(bot), { inline_keyboard: rows });
  };

  if (data === "start_pay") {
    await showPlans();
    return;
  }

  if (data.startsWith("access:")) {
    const type = normaliseAccessType(data.split(":")[1]);
    if (!type || !(bot.prices[type] > 0)) {
      await showPlans();
      return;
    }
    if (availableProviders(bot).length === 0) {
      await show(UNAVAILABLE);
      return;
    }
    const suffix = type === "monthly" ? " / month" : "";
    await show(
      `💰 <b>${ACCESS_LABEL[type]} — $${bot.prices[type].toFixed(2)}${suffix}</b>\n\nChoose your payment method:`,
      providerKeyboard(bot, type),
    );
    return;
  }

  if (data.startsWith("pay:")) {
    const [, rawType, rawProvider] = data.split(":");
    const type = normaliseAccessType(rawType);
    const provider = PROVIDERS.includes(rawProvider as Provider) ? (rawProvider as Provider) : null;
    if (!type || !provider) {
      await showPlans();
      return;
    }
    if (type !== "image_unlock" && hasValidAccess(member) && member.access_expires === null) {
      await show("✅ You already have lifetime access to the group.");
      return;
    }

    await show("⏳ Generating your payment link…");
    try {
      const payment = await createPayment(env, bot, {
        telegramId: user.id,
        accessType: type,
        provider,
        baseUrl,
      });
      await show(
        `✅ <b>Payment Link Ready!</b>\n\n` +
          `${PROVIDER_NOTE[provider](bot)}\n\n` +
          `Amount: <b>$${payment.amount.toFixed(2)}</b>\n` +
          `Reference: <code>${payment.orderId}</code>\n\n` +
          `Tap the button below to pay. Access is granted automatically once the payment is confirmed.`,
        {
          inline_keyboard: [
            [{ text: "💳 Pay Now", url: payment.paymentUrl }],
            [{ text: "🔙 Change Method", callback_data: `access:${type}` }],
          ],
        },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) {
        // Free-tier member cap: nothing the buyer can do about it.
        await show("😔 This group is full right now. Please check back later.");
        return;
      }
      logError("payment link error", error, { bot_id: bot.id, provider });
      await alertCreator(env, bot, `paylink-${provider}`, `A buyer couldn't get a ${provider} payment link: ${error instanceof Error ? error.message : String(error)}. Check your ${provider} keys in the dashboard, then run the connection check.`);
      await showPlans("❌ Failed to generate a payment link. Please try again.");
    }
    return;
  }
}
