import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the real Workers runtime (workerd) with a local D1
// database. Every outbound call to Telegram and the payment providers is
// intercepted by test/helpers.ts, so nothing leaves the machine.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_API_KEY: "test-admin-key-0123456789abcdef",
          ENCRYPTION_KEY: "test-encryption-passphrase-0123456789abcdef",
          CORS_ORIGINS: "https://dashboard.example.com",
          // Owner bot: fake credentials with the same names as production.
          TELEGRAM_BOT_TOKEN: "111111111:AAownerTokenAbcdefghijklmnopqrstuvwxyz",
          GROUP_CHAT_ID: "-1001111111111",
          ADMIN_USER_IDS: "42",
          ONE_TIME_PRICE_USD: "10",
          MONTHLY_PRICE_USD: "5",
          PAYSTACK_SECRET_KEY: "sk_test_owner_paystack_secret",
          PAYSTACK_PUBLIC_KEY: "pk_test_owner_paystack_public",
          NOWPAYMENTS_API_KEY: "owner-nowpayments-api-key",
          NOWPAYMENTS_IPN_SECRET: "owner-nowpayments-ipn-secret",
          BTCPAY_URL: "https://btcpay.example.com/",
          BTCPAY_STORE_ID: "ownerStore",
          BTCPAY_API_KEY: "owner-btcpay-api-key",
          BTCPAY_WEBHOOK_SECRET: "owner-btcpay-webhook-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
