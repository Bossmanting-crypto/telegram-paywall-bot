import os
from dotenv import load_dotenv

load_dotenv()

# ── Telegram ──────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN   = os.getenv("TELEGRAM_BOT_TOKEN")
GROUP_CHAT_ID        = int(os.getenv("GROUP_CHAT_ID", "0"))   # negative number e.g. -1001234567890
ADMIN_USER_IDS       = list(map(int, os.getenv("ADMIN_USER_IDS", "").split(",")))

# ── Pricing ───────────────────────────────────────────────────────────────────
ONE_TIME_PRICE_USD   = float(os.getenv("ONE_TIME_PRICE_USD", "10"))
MONTHLY_PRICE_USD    = float(os.getenv("MONTHLY_PRICE_USD", "5"))
CURRENCY             = os.getenv("CURRENCY", "USD")           # or KES for Paystack

# ── NOWPayments (crypto) ──────────────────────────────────────────────────────
NOWPAYMENTS_API_KEY      = os.getenv("NOWPAYMENTS_API_KEY")
NOWPAYMENTS_IPN_SECRET   = os.getenv("NOWPAYMENTS_IPN_SECRET")
NOWPAYMENTS_API_URL      = "https://api.nowpayments.io/v1"

# ── BTCPay Server (crypto) ────────────────────────────────────────────────────
BTCPAY_URL           = os.getenv("BTCPAY_URL")         # e.g. https://btcpay.yourdomain.com
BTCPAY_STORE_ID      = os.getenv("BTCPAY_STORE_ID")
BTCPAY_API_KEY       = os.getenv("BTCPAY_API_KEY")
BTCPAY_WEBHOOK_SECRET = os.getenv("BTCPAY_WEBHOOK_SECRET")

# ── Paystack (card / M-Pesa / bank) ──────────────────────────────────────────
PAYSTACK_SECRET_KEY  = os.getenv("PAYSTACK_SECRET_KEY")   # sk_live_...
PAYSTACK_PUBLIC_KEY  = os.getenv("PAYSTACK_PUBLIC_KEY")   # pk_live_...
PAYSTACK_API_URL     = "https://api.paystack.co"

# ── App / Webhook ─────────────────────────────────────────────────────────────
APP_URL              = os.getenv("APP_URL")               # https://your-bot.up.railway.app
WEBHOOK_PORT         = int(os.getenv("PORT", "8000"))
DATABASE_URL         = os.getenv("DATABASE_URL", "sqlite:///bot.db")
