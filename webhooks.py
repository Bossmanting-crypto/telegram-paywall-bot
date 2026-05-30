"""
webhooks.py – Flask server handling payment webhooks from all providers.
Run alongside the Telegram bot.
"""

import json
import logging
from flask import Flask, request, jsonify

import database as db
from database import PaymentProvider, PaymentStatus, AccessType
from payments.nowpayments import verify_webhook_signature as now_verify, CONFIRMED_STATUSES as NOW_OK
from payments.btcpay import verify_webhook_signature as btc_verify, CONFIRMED_STATUSES as BTC_OK
from payments.paystack import verify_webhook_signature as ps_verify, verify_transaction as ps_verify_txn

log = logging.getLogger(__name__)
app = Flask(__name__)

# Bot instance is injected at startup (set in bot.py)
telegram_bot = None


def _unlock(telegram_id: int, access_type: AccessType):
    """Grant DB access + lift Telegram restrictions."""
    db.set_user_access(telegram_id, access_type)
    if telegram_bot:
        import asyncio
        from bot import grant_access
        asyncio.run(grant_access(telegram_id))


# ── NOWPayments ───────────────────────────────────────────────────────────────

@app.route("/webhook/nowpayments", methods=["POST"])
def nowpayments_webhook():
    sig  = request.headers.get("x-nowpayments-sig", "")
    body = request.get_data()

    if not now_verify(body, sig):
        log.warning("NOWPayments: invalid signature")
        return jsonify({"error": "invalid signature"}), 400

    data   = json.loads(body)
    status = data.get("payment_status", "")
    ref    = str(data.get("order_id", ""))

    if status in NOW_OK:
        payment = db.get_payment_by_ref(ref)
        if payment and payment.status != PaymentStatus.CONFIRMED:
            db.confirm_payment(ref)
            _unlock(payment.telegram_id, payment.access_type)
            log.info(f"NOWPayments: unlocked user {payment.telegram_id}")

    return jsonify({"ok": True}), 200


# ── BTCPay Server ─────────────────────────────────────────────────────────────

@app.route("/webhook/btcpay", methods=["POST"])
def btcpay_webhook():
    sig  = request.headers.get("BTCPay-Sig", "")
    body = request.get_data()

    if not btc_verify(body, sig):
        log.warning("BTCPay: invalid signature")
        return jsonify({"error": "invalid signature"}), 400

    data   = json.loads(body)
    event  = data.get("type", "")
    inv_id = data.get("invoiceId", "")

    if event in ("InvoiceSettled", "InvoiceProcessing"):
        # orderId stored in invoice metadata
        order_id = data.get("metadata", {}).get("orderId", inv_id)
        payment  = db.get_payment_by_ref(order_id)
        if payment and payment.status != PaymentStatus.CONFIRMED:
            db.confirm_payment(order_id)
            _unlock(payment.telegram_id, payment.access_type)
            log.info(f"BTCPay: unlocked user {payment.telegram_id}")

    return jsonify({"ok": True}), 200


# ── Paystack ──────────────────────────────────────────────────────────────────

@app.route("/webhook/paystack", methods=["POST"])
def paystack_webhook():
    sig  = request.headers.get("x-paystack-signature", "")
    body = request.get_data()

    if not ps_verify(body, sig):
        log.warning("Paystack: invalid signature")
        return jsonify({"error": "invalid signature"}), 400

    data  = json.loads(body)
    event = data.get("event", "")

    if event == "charge.success":
        ref     = data["data"]["reference"]
        payment = db.get_payment_by_ref(ref)

        if payment and payment.status != PaymentStatus.CONFIRMED:
            # Double-verify with Paystack API
            txn = ps_verify_txn(ref)
            if txn.get("status") == "success":
                db.confirm_payment(ref)
                _unlock(payment.telegram_id, payment.access_type)
                log.info(f"Paystack: unlocked user {payment.telegram_id}")

    elif event == "subscription.disable":
        # Subscription cancelled — revoke access
        customer_code = data["data"]["customer"]["customer_code"]
        log.info(f"Paystack subscription disabled for {customer_code}")
        # Find user by customer_code if stored

    return jsonify({"ok": True}), 200


# ── Success / Cancel pages ────────────────────────────────────────────────────

@app.route("/payment/success")
def payment_success():
    return """
    <html><body style='font-family:sans-serif;text-align:center;padding:60px'>
    <h1>✅ Payment Received!</h1>
    <p>Return to Telegram — your access will be unlocked within seconds.</p>
    </body></html>
    """

@app.route("/payment/cancel")
def payment_cancel():
    return """
    <html><body style='font-family:sans-serif;text-align:center;padding:60px'>
    <h1>❌ Payment Cancelled</h1>
    <p>Return to Telegram and try again.</p>
    </body></html>
    """
