"""
payments/nowpayments.py – NOWPayments crypto payment integration.
Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt
"""

import hashlib
import hmac
import json
import requests
from config import NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, NOWPAYMENTS_API_URL, APP_URL


HEADERS = {
    "x-api-key": NOWPAYMENTS_API_KEY,
    "Content-Type": "application/json",
}


def create_invoice(amount_usd: float, order_id: str, description: str) -> dict:
    """
    Create a hosted NOWPayments invoice.
    Returns dict with 'invoice_url' and 'id'.
    """
    payload = {
        "price_amount":    amount_usd,
        "price_currency":  "usd",
        "order_id":        order_id,
        "order_description": description,
        "ipn_callback_url": f"{APP_URL}/webhook/nowpayments",
        "success_url":     f"{APP_URL}/payment/success",
        "cancel_url":      f"{APP_URL}/payment/cancel",
        "is_fixed_rate":   True,
        "is_fee_paid_by_user": False,
    }
    resp = requests.post(f"{NOWPAYMENTS_API_URL}/invoice", headers=HEADERS, json=payload, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return {
        "invoice_id":  data["id"],
        "payment_url": data["invoice_url"],
        "raw":         data,
    }


def verify_webhook_signature(request_body: bytes, received_sig: str) -> bool:
    """
    Verify NOWPayments IPN signature.
    The signature is HMAC-SHA512 of the sorted JSON payload.
    """
    try:
        body_dict   = json.loads(request_body)
        sorted_body = json.dumps(body_dict, sort_keys=True).encode()
        expected    = hmac.new(
            NOWPAYMENTS_IPN_SECRET.encode(), sorted_body, hashlib.sha512
        ).hexdigest()
        return hmac.compare_digest(expected, received_sig)
    except Exception:
        return False


def get_payment_status(payment_id: str) -> str:
    """Poll a single payment status."""
    resp = requests.get(f"{NOWPAYMENTS_API_URL}/payment/{payment_id}", headers=HEADERS, timeout=15)
    resp.raise_for_status()
    return resp.json().get("payment_status", "unknown")


# Payment statuses that mean "paid"
CONFIRMED_STATUSES = {"finished", "confirmed", "sending", "partially_paid"}
