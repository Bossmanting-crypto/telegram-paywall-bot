"""
payments/paystack.py – Paystack integration for Kenya.
Supports: Visa/Mastercard, M-Pesa, Equity Bank, MPESA STK Push.
Docs: https://paystack.com/docs/api/
Settlement goes to your Kenyan Equity Bank account.
"""

import hashlib
import hmac
import requests
from config import PAYSTACK_SECRET_KEY, PAYSTACK_API_URL, APP_URL, ONE_TIME_PRICE_USD, MONTHLY_PRICE_USD


HEADERS = {
    "Authorization": f"Bearer {PAYSTACK_SECRET_KEY}",
    "Content-Type":  "application/json",
}

# Paystack uses Kenyan Shillings (KES) or USD
# 1 USD ≈ 129 KES (update periodically or fetch live rate)
USD_TO_KES = 129


def usd_to_kobo_kes(amount_usd: float) -> int:
    """Convert USD to KES kobo (Paystack uses smallest currency unit × 100)."""
    kes = amount_usd * USD_TO_KES
    return int(kes * 100)   # kobo equivalent in KES


def create_payment_link(
    email: str,
    amount_usd: float,
    order_id: str,
    description: str,
    currency: str = "KES",
) -> dict:
    """
    Initialize a Paystack transaction.
    Returns payment authorization URL.
    """
    amount_minor = usd_to_kobo_kes(amount_usd) if currency == "KES" else int(amount_usd * 100)

    payload = {
        "email":        email,
        "amount":       amount_minor,
        "currency":     currency,
        "reference":    order_id,
        "callback_url": f"{APP_URL}/webhook/paystack",
        "metadata": {
            "order_id":    order_id,
            "description": description,
            "cancel_action": f"{APP_URL}/payment/cancel",
        },
        "channels": ["card", "mobile_money", "bank"],  # card = Visa/MC, mobile_money = M-Pesa
    }
    resp = requests.post(f"{PAYSTACK_API_URL}/transaction/initialize", headers=HEADERS, json=payload, timeout=15)
    resp.raise_for_status()
    data = resp.json()["data"]
    return {
        "reference":   data["reference"],
        "payment_url": data["authorization_url"],
        "access_code": data["access_code"],
        "raw":         data,
    }


def verify_transaction(reference: str) -> dict:
    """
    Verify a Paystack transaction by reference.
    Returns full transaction data.
    """
    resp = requests.get(f"{PAYSTACK_API_URL}/transaction/verify/{reference}", headers=HEADERS, timeout=15)
    resp.raise_for_status()
    return resp.json()["data"]


def verify_webhook_signature(request_body: bytes, received_sig: str) -> bool:
    """
    Paystack signs webhooks with HMAC-SHA512.
    Header: x-paystack-signature
    """
    try:
        expected = hmac.new(
            PAYSTACK_SECRET_KEY.encode(), request_body, hashlib.sha512
        ).hexdigest()
        return hmac.compare_digest(expected, received_sig)
    except Exception:
        return False


def create_subscription_plan(name: str, amount_usd: float, interval: str = "monthly") -> dict:
    """
    Create a Paystack recurring plan for subscriptions.
    interval: monthly | weekly | annually
    """
    amount_kes = usd_to_kobo_kes(amount_usd)
    payload = {
        "name":     name,
        "interval": interval,
        "amount":   amount_kes,
        "currency": "KES",
    }
    resp = requests.post(f"{PAYSTACK_API_URL}/plan", headers=HEADERS, json=payload, timeout=15)
    resp.raise_for_status()
    return resp.json()["data"]
