"""
payments/btcpay.py – BTCPay Server integration (self-hosted or BTCPay Server hosted).
Docs: https://docs.btcpayserver.org/API/Greenfield/v1/
"""

import hashlib
import hmac
import requests
from config import BTCPAY_URL, BTCPAY_STORE_ID, BTCPAY_API_KEY, BTCPAY_WEBHOOK_SECRET, APP_URL


HEADERS = {
    "Authorization": f"token {BTCPAY_API_KEY}",
    "Content-Type":  "application/json",
}


def create_invoice(amount_usd: float, order_id: str, description: str) -> dict:
    """
    Create a BTCPay invoice.
    Returns dict with 'invoice_id' and 'payment_url'.
    """
    payload = {
        "amount":      str(amount_usd),
        "currency":    "USD",
        "metadata": {
            "orderId":     order_id,
            "itemDesc":    description,
        },
        "checkout": {
            "redirectURL":        f"{APP_URL}/payment/success",
            "redirectAutomatically": True,
        },
    }
    url  = f"{BTCPAY_URL}/api/v1/stores/{BTCPAY_STORE_ID}/invoices"
    resp = requests.post(url, headers=HEADERS, json=payload, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return {
        "invoice_id":  data["id"],
        "payment_url": data["checkoutLink"],
        "raw":         data,
    }


def verify_webhook_signature(request_body: bytes, received_sig: str) -> bool:
    """
    BTCPay sends HMAC-SHA256 in header 'BTCPay-Sig' as 'sha256=<hex>'.
    """
    try:
        sig_value = received_sig.replace("sha256=", "")
        expected  = hmac.new(
            BTCPAY_WEBHOOK_SECRET.encode(), request_body, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, sig_value)
    except Exception:
        return False


def get_invoice_status(invoice_id: str) -> str:
    url  = f"{BTCPAY_URL}/api/v1/stores/{BTCPAY_STORE_ID}/invoices/{invoice_id}"
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    return resp.json().get("status", "unknown")


# Invoice statuses that mean "paid"
CONFIRMED_STATUSES = {"Settled", "Processing"}
