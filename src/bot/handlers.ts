/**
 * Telegram bot engine. One function per kind of update, each given the bot's
 * resolved configuration, so the same code serves every creator's bot.
 *
 * Flow: someone joins the group → they are restricted → the bot sends them a
 * payment menu → a provider webhook confirms payment → restrictions lifted.
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
import { newId } from "../lib/crypto";
import { HttpError, logError, money } from "../lib/http";
import {
  ACCESS_LABEL,
  availableProviders,
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
  if (bot.prices.image_unlock > 0 && member?.images_unlocked !== 1 && (await countVaultImages(env, bot.id)) > 0) {
    rows.push([
      { text: PLAN_BUTTON.image_unlock(money(bot.prices.image_unlock)), callback_data: "access:image_unlock" },
    ]);
  }
  return rows;
}

function planMenuText(bot: BotConfig): string {
  const lines = [`🔒 <b>${escapeHtml(bot.welcomeTitle)}</b>`, "", escapeHtml(bot.welcomeText)];
  if (bot.groupDescription) lines.push("", `<i>${escapeHtml(bot.groupDescription)}</i>`);
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
  await sendMessage(bot.token, chatId, intro ?? planMenuText(bot), {
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
          "✅ <b>Paywall is active.</b> New members will be asked to pay before they can post.",
        ).catch(() => undefined);
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
    return;
  }

  // Bots can only message people who have started them, so try a private
  // message first and fall back to a notice in the group.
  try {
    await sendPlanMenu(
      env,
      bot,
      user.id,
      member,
      `👋 Hi <b>${escapeHtml(user.first_name || "there")}</b>!\n\n${planMenuText(bot)}`,
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

  if (isAdmin && command && (await adminCommand(env, bot, command, reply, from))) return;

  if (msg.chat.type !== "private") return; // ordinary group chatter is ignored

  if (isAdmin && msg.photo?.length) {
    await addToVault(env, bot, msg, reply);
    return;
  }

  const member = await upsertMember(env, bot.id, from);

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

async function addToVault(
  env: AppEnv,
  bot: BotConfig,
  msg: TgMessage,
  reply: (html: string) => Promise<unknown>,
): Promise<void> {
  const photo = msg.photo?.[msg.photo.length - 1]; // largest size is last
  if (!photo) return;
  const count = await countVaultImages(env, bot.id);
  if (count >= MAX_VAULT_IMAGES) {
    await reply(`🖼 The vault is full (${MAX_VAULT_IMAGES} images). Send /clearvault to start over.`);
    return;
  }
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO vault_images (id, bot_id, file_id, file_unique_id, added_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(newId(), bot.id, photo.file_id, photo.file_unique_id, msg.from?.id ?? null, now())
    .run();
  const added = result.meta.changes > 0;
  await reply(
    added
      ? `🖼 Added to the vault (${count + 1} image${count + 1 === 1 ? "" : "s"}).`
      : "🖼 That image is already in the vault.",
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
      const recipients = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM members WHERE bot_id = ?1 AND has_access = 1",
      )
        .bind(bot.id)
        .first<{ n: number }>();
      await env.DB.prepare(
        `INSERT INTO broadcasts (id, bot_id, text, requested_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
        .bind(newId(), bot.id, command.args.slice(0, 4000), from.id, now())
        .run();
      await reply(
        `📢 Broadcast queued for <b>${recipients?.n ?? 0}</b> member(s). Delivery starts within a minute; I'll confirm when it's done.`,
      );
      return true;
    }

    case "vault": {
      const count = await countVaultImages(env, bot.id);
      await reply(
        `🖼 The vault holds <b>${count}</b> image(s) (max ${MAX_VAULT_IMAGES}).\n\n` +
          `Send me photos in this chat to add them. /clearvault empties it.\n` +
          (bot.prices.image_unlock > 0
            ? `Price: <b>$${money(bot.prices.image_unlock)}</b>`
            : "The vault has no price set, so it is not on sale."),
      );
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
          "/vault — image vault status (send photos to add)\n" +
          "/clearvault — empty the vault\n" +
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

  if (!botIsSelling(bot)) {
    await show(UNAVAILABLE);
    return;
  }

  const member = await upsertMember(env, bot.id, user);
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
      await showPlans("❌ Failed to generate a payment link. Please try again.");
    }
    return;
  }
}
