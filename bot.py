"""
bot.py – Main Telegram bot.
Handles: new members → restrict → send payment menu → unlock on confirmation.
Admin commands: /stats /grant /revoke /broadcast
"""

import asyncio
import logging
import uuid
from datetime import datetime
from threading import Thread

from telegram import (
    Update, ChatPermissions, InlineKeyboardButton, InlineKeyboardMarkup, Bot
)
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    ChatMemberHandler, ContextTypes, MessageHandler, filters
)
from telegram.error import TelegramError

import database as db
from database import AccessType, PaymentProvider
from payments.nowpayments import create_invoice as now_invoice
from payments.btcpay import create_invoice as btc_invoice
from payments.paystack import create_payment_link as ps_link
from config import (
    TELEGRAM_BOT_TOKEN, GROUP_CHAT_ID, ADMIN_USER_IDS,
    ONE_TIME_PRICE_USD, MONTHLY_PRICE_USD, APP_URL
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Permissions ───────────────────────────────────────────────────────────────

RESTRICTED = ChatPermissions(
    can_send_messages=False,
    can_send_media_messages=False,
    can_send_polls=False,
    can_send_other_messages=False,
    can_add_web_page_previews=False,
    can_change_info=False,
    can_invite_users=False,
    can_pin_messages=False,
)

FULL_ACCESS = ChatPermissions(
    can_send_messages=True,
    can_send_media_messages=True,
    can_send_polls=True,
    can_send_other_messages=True,
    can_add_web_page_previews=True,
    can_change_info=False,
    can_invite_users=True,
    can_pin_messages=False,
)


# ── Keyboards ─────────────────────────────────────────────────────────────────

def payment_menu_keyboard(access_type: str) -> InlineKeyboardMarkup:
    """Choose provider after selecting access type."""
    prefix = access_type  # "onetime" or "monthly"
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("💳 Card / M-Pesa (Paystack)", callback_data=f"pay:{prefix}:paystack")],
        [InlineKeyboardButton("₿ Crypto (NOWPayments)",      callback_data=f"pay:{prefix}:nowpayments")],
        [InlineKeyboardButton("⚡ Crypto (BTCPay)",           callback_data=f"pay:{prefix}:btcpay")],
        [InlineKeyboardButton("🔙 Back",                     callback_data="start_pay")],
    ])

def access_type_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(f"🔑 One-Time Access  ${ONE_TIME_PRICE_USD:.0f}", callback_data="access:onetime")],
        [InlineKeyboardButton(f"🔄 Monthly Access   ${MONTHLY_PRICE_USD:.0f}/mo", callback_data="access:monthly")],
    ])


# ── Core: restrict & unlock ───────────────────────────────────────────────────

async def restrict_user(bot: Bot, user_id: int):
    try:
        await bot.restrict_chat_member(GROUP_CHAT_ID, user_id, RESTRICTED)
        log.info(f"Restricted user {user_id}")
    except TelegramError as e:
        log.warning(f"Could not restrict {user_id}: {e}")


async def grant_access(user_id: int):
    """Called from webhook thread – creates a new bot instance call."""
    app_bot = Bot(token=TELEGRAM_BOT_TOKEN)
    try:
        await app_bot.restrict_chat_member(GROUP_CHAT_ID, user_id, FULL_ACCESS)
        await app_bot.send_message(
            user_id,
            "✅ *Payment confirmed!* You now have full access to the group.\n\n"
            "Welcome aboard! 🎉",
            parse_mode="Markdown"
        )
        log.info(f"Granted access to user {user_id}")
    except TelegramError as e:
        log.warning(f"Could not unlock {user_id}: {e}")
    finally:
        await app_bot.close()


# ── Handlers ──────────────────────────────────────────────────────────────────

async def on_new_member(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Fires when someone joins the group."""
    result = update.chat_member
    if result.new_chat_member.status not in ("member", "restricted"):
        return

    user     = result.new_chat_member.user
    bot_user = await context.bot.get_me()

    if user.id == bot_user.id:
        return  # bot itself joined

    db.get_or_create_user(user.id, user.username, user.first_name)
    existing = db.get_user(user.id)

    if existing and existing.is_access_valid():
        log.info(f"User {user.id} already paid — skipping restriction")
        return

    await restrict_user(context.bot, user.id)

    try:
        await context.bot.send_message(
            chat_id=user.id,
            text=(
                f"👋 Hi *{user.first_name}*\\!\n\n"
                f"Access to this group requires a payment\\.\n\n"
                f"Choose your plan below:"
            ),
            parse_mode="MarkdownV2",
            reply_markup=access_type_keyboard(),
        )
    except TelegramError:
        # User hasn't started the bot in private — send a message in group
        try:
            msg = await context.bot.send_message(
                chat_id=GROUP_CHAT_ID,
                text=(
                    f"👋 Welcome {user.mention_html()}\\!\n\n"
                    "Please [start the bot](t.me/{bot_user.username}?start=pay) "
                    "in private to complete your payment and unlock access\\."
                ),
                parse_mode="MarkdownV2",
            )
            # Auto-delete notice after 60s
            await asyncio.sleep(60)
            await msg.delete()
        except TelegramError:
            pass


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    db.get_or_create_user(user.id, user.username, user.first_name)

    existing = db.get_user(user.id)
    if existing and existing.is_access_valid():
        expiry = ""
        if existing.access_expires:
            expiry = f"\nYour subscription renews on: *{existing.access_expires.strftime('%d %b %Y')}*"
        await update.message.reply_text(
            f"✅ You already have active access to the group!{expiry}",
            parse_mode="Markdown"
        )
        return

    await update.message.reply_text(
        "🔒 *Group Access Required*\n\n"
        "Choose your access plan:",
        parse_mode="Markdown",
        reply_markup=access_type_keyboard(),
    )


async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    data = query.data
    user = query.from_user

    # ── access type selection ─────────────────────────────────────────────────
    if data == "start_pay":
        await query.edit_message_text(
            "🔒 *Group Access Required*\n\nChoose your access plan:",
            parse_mode="Markdown",
            reply_markup=access_type_keyboard(),
        )
        return

    if data.startswith("access:"):
        access_type = data.split(":")[1]  # onetime or monthly
        price = ONE_TIME_PRICE_USD if access_type == "onetime" else MONTHLY_PRICE_USD
        label = "One-Time" if access_type == "onetime" else "Monthly"
        await query.edit_message_text(
            f"💰 *{label} Access — ${price:.2f}*\n\nChoose your payment method:",
            parse_mode="Markdown",
            reply_markup=payment_menu_keyboard(access_type),
        )
        return

    # ── provider selection ────────────────────────────────────────────────────
    if data.startswith("pay:"):
        _, access_str, provider_str = data.split(":")
        access_type = AccessType.ONE_TIME if access_str == "onetime" else AccessType.MONTHLY
        amount      = ONE_TIME_PRICE_USD if access_type == AccessType.ONE_TIME else MONTHLY_PRICE_USD
        order_id    = f"{user.id}_{uuid.uuid4().hex[:8]}"
        description = f"Telegram Group Access ({'One-Time' if access_type == AccessType.ONE_TIME else 'Monthly'})"

        await query.edit_message_text("⏳ Generating your payment link…")

        try:
            if provider_str == "paystack":
                email      = f"{user.id}@telegram.user"
                result     = ps_link(email, amount, order_id, description)
                pay_url    = result["payment_url"]
                prov_ref   = result["reference"]
                provider   = PaymentProvider.PAYSTACK
                note       = "💳 Accepts *Visa, Mastercard, M-Pesa*"

            elif provider_str == "nowpayments":
                result     = now_invoice(amount, order_id, description)
                pay_url    = result["payment_url"]
                prov_ref   = order_id
                provider   = PaymentProvider.NOWPAYMENTS
                note       = "₿ Accepts *BTC, ETH, USDT, LTC + 100 more coins*"

            else:  # btcpay
                result     = btc_invoice(amount, order_id, description)
                pay_url    = result["payment_url"]
                prov_ref   = order_id
                provider   = PaymentProvider.BTCPAY
                note       = "⚡ Accepts *BTC (on-chain + Lightning)*"

            db.create_payment(
                telegram_id=user.id,
                provider=provider,
                provider_ref=prov_ref,
                access_type=access_type,
                amount_usd=amount,
                amount_local=amount,
                currency="USD",
                payment_url=pay_url,
            )

            keyboard = InlineKeyboardMarkup([
                [InlineKeyboardButton("💳 Pay Now", url=pay_url)],
                [InlineKeyboardButton("🔙 Change Method", callback_data=f"access:{access_str}")],
            ])

            await query.edit_message_text(
                f"✅ *Payment Link Ready!*\n\n"
                f"{note}\n\n"
                f"Amount: *${amount:.2f}*\n"
                f"Reference: `{prov_ref}`\n\n"
                f"Click the button below to pay. "
                f"Access is granted automatically within seconds of payment.",
                parse_mode="Markdown",
                reply_markup=keyboard,
            )

        except Exception as e:
            log.error(f"Payment link error: {e}")
            await query.edit_message_text(
                "❌ Failed to generate payment link. Please try again.",
                reply_markup=access_type_keyboard(),
            )


# ── Admin Commands ────────────────────────────────────────────────────────────

def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_USER_IDS


async def admin_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        return
    with db.Session() as s:
        total   = s.query(db.User).count()
        paid    = s.query(db.User).filter_by(has_access=True).count()
        monthly = s.query(db.User).filter_by(access_type=AccessType.MONTHLY, has_access=True).count()
        onetime = s.query(db.User).filter_by(access_type=AccessType.ONE_TIME, has_access=True).count()
        pending = s.query(db.Payment).filter_by(status=db.PaymentStatus.PENDING).count()

    await update.message.reply_text(
        f"📊 *Bot Statistics*\n\n"
        f"👥 Total users: *{total}*\n"
        f"✅ Active access: *{paid}*\n"
        f"  ├ One-time: *{onetime}*\n"
        f"  └ Monthly: *{monthly}*\n"
        f"⏳ Pending payments: *{pending}*",
        parse_mode="Markdown"
    )


async def admin_grant(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Usage: /grant <user_id>"""
    if not is_admin(update.effective_user.id):
        return
    if not context.args:
        await update.message.reply_text("Usage: /grant <user_id>")
        return
    uid = int(context.args[0])
    db.set_user_access(uid, AccessType.ONE_TIME)
    await grant_access(uid)
    await update.message.reply_text(f"✅ Granted access to user {uid}")


async def admin_revoke(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Usage: /revoke <user_id>"""
    if not is_admin(update.effective_user.id):
        return
    if not context.args:
        await update.message.reply_text("Usage: /revoke <user_id>")
        return
    uid = int(context.args[0])
    db.revoke_user_access(uid)
    await restrict_user(context.bot, uid)
    await update.message.reply_text(f"🚫 Revoked access for user {uid}")


async def admin_broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Usage: /broadcast <message>"""
    if not is_admin(update.effective_user.id):
        return
    if not context.args:
        await update.message.reply_text("Usage: /broadcast <message>")
        return
    msg = " ".join(context.args)
    with db.Session() as s:
        users = s.query(db.User).filter_by(has_access=True).all()
        ids   = [u.telegram_id for u in users]
    sent = 0
    for uid in ids:
        try:
            await context.bot.send_message(uid, msg)
            sent += 1
        except TelegramError:
            pass
    await update.message.reply_text(f"📢 Broadcast sent to {sent}/{len(ids)} users.")


# ── Subscription expiry job ───────────────────────────────────────────────────

async def check_expired_subscriptions(context: ContextTypes.DEFAULT_TYPE):
    expired = db.get_expired_subscriptions()
    for user in expired:
        db.revoke_user_access(user.telegram_id)
        await restrict_user(context.bot, user.telegram_id)
        try:
            await context.bot.send_message(
                user.telegram_id,
                "⚠️ Your monthly subscription has expired. "
                "Renew to regain access:",
                reply_markup=access_type_keyboard(),
            )
        except TelegramError:
            pass
        log.info(f"Expired subscription revoked for {user.telegram_id}")


# ── App factory ───────────────────────────────────────────────────────────────

def build_app() -> Application:
    db.init_db()
    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    application.add_handler(CommandHandler("start",     start_command))
    application.add_handler(CommandHandler("stats",     admin_stats))
    application.add_handler(CommandHandler("grant",     admin_grant))
    application.add_handler(CommandHandler("revoke",    admin_revoke))
    application.add_handler(CommandHandler("broadcast", admin_broadcast))
    application.add_handler(CallbackQueryHandler(button_handler))
    application.add_handler(ChatMemberHandler(on_new_member, ChatMemberHandler.CHAT_MEMBER))

    # Run expired subscription check every hour
    application.job_queue.run_repeating(check_expired_subscriptions, interval=3600, first=60)

    return application


# ── Run Flask + Bot together ──────────────────────────────────────────────────

def run_webhook_server():
    from webhooks import app as flask_app
    from config import WEBHOOK_PORT
    flask_app.run(host="0.0.0.0", port=WEBHOOK_PORT, debug=False)


if __name__ == "__main__":
    # Start Flask webhook server in background thread
    webhook_thread = Thread(target=run_webhook_server, daemon=True)
    webhook_thread.start()

    # Start Telegram bot (polling)
    log.info("Starting Telegram bot...")
    app = build_app()
    app.run_polling(allowed_updates=["message", "callback_query", "chat_member"])
