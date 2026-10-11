/** Minimal Telegram Bot API client (plain fetch — no SDK needed on Workers). */

export class TelegramError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly description: string,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = "TelegramError";
  }
}

export async function tg<T = unknown>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  // The URL contains the bot token: never log it.
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: T; description?: string; error_code?: number }
    | null;
  if (!data || !data.ok) {
    throw new TelegramError(method, data?.error_code ?? res.status, data?.description ?? `HTTP ${res.status}`);
  }
  return data.result as T;
}

// ── Types (only the fields this bot uses) ────────────────────────────────────

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  photo?: TgPhotoSize[];
}

export interface TgChatMember {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  user: TgUser;
  is_member?: boolean;
  can_restrict_members?: boolean;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  chat_member?: TgChatMemberUpdated;
  my_chat_member?: TgChatMemberUpdated;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export const ALLOWED_UPDATES = ["message", "callback_query", "chat_member", "my_chat_member"];

// ── Permissions ──────────────────────────────────────────────────────────────

/** Unpaid members: can read, cannot post anything. */
export const RESTRICTED = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

/** Paid members: everything an ordinary member can do. */
export const FULL_ACCESS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
  can_manage_topics: false,
};

export function restrictMember(token: string, chatId: number, userId: number): Promise<unknown> {
  return tg(token, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: RESTRICTED,
    use_independent_chat_permissions: true,
  });
}

export function unrestrictMember(token: string, chatId: number, userId: number): Promise<unknown> {
  return tg(token, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: FULL_ACCESS,
    use_independent_chat_permissions: true,
  });
}

export function sendMessage(
  token: string,
  chatId: number,
  html: string,
  extra: Record<string, unknown> = {},
): Promise<TgMessage> {
  return tg<TgMessage>(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export function escapeHtml(value: string | null | undefined): string {
  return (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** True when `member` is currently inside the chat. */
export function isInChat(member: TgChatMember): boolean {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    case "restricted":
      return member.is_member === true;
    default:
      return false;
  }
}

/** Bot tokens look like `1234567890:AA…` (numeric bot ID, colon, 35-ish chars). */
export function looksLikeBotToken(token: string): boolean {
  return /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token);
}
