/**
 * Prices are written in the bot's price currency: US dollars, or the currency
 * Paystack charges in (e.g. Kenyan shillings). Platform fees and crypto are
 * always worked out in USD, using the bot's exchange rate.
 */

import type { BotConfig } from "./db";
import { round2 } from "./lib/http";

const SYMBOLS: Record<string, string> = { USD: "$", KES: "KSh ", NGN: "₦", GHS: "GH₵", ZAR: "R " };

/** "$5", "$5.50", "KSh 1,500", "₦2,000". */
export function formatAmount(currency: string, amount: number): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const whole = Math.abs(amount % 1) < 0.005;
  const text = amount.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `${symbol}${text}`;
}

export function formatPrice(bot: BotConfig, amount: number): string {
  return formatAmount(bot.priceCurrency, amount);
}

/** The same amount in USD (for platform fees, crypto and the ledger). */
export function toUsd(bot: BotConfig, amount: number): number {
  if (bot.priceCurrency === "USD") return round2(amount);
  return round2(amount / (bot.fxRate > 0 ? bot.fxRate : 1));
}

/**
 * What Paystack charges, in minor units (cents). A price written in the
 * Paystack currency is charged exactly; a USD price is converted at the rate.
 */
export function paystackMinor(bot: BotConfig, amount: number): number {
  if (bot.priceCurrency === bot.currency) return Math.round(amount * 100);
  return Math.round(toUsd(bot, amount) * (bot.fxRate > 0 ? bot.fxRate : 1) * 100);
}
