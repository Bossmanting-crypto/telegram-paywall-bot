/** Errors, request parsing and small formatting helpers shared by the routes. */

import type { Context } from "hono";
import type { AppEnv } from "../env";
import type { TenantRow } from "../db";

export type AppContext = { Bindings: AppEnv; Variables: { tenant: TenantRow } };
export type Ctx = Context<AppContext>;

/** An error that should reach the caller as `{ "detail": message }`. */
export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 500 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** A payment provider or Telegram answered with an error. */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function baseUrl(c: Ctx): string {
  return (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/+$/, "");
}

export async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Optional string field. `undefined` = not sent, `null` = sent empty (clear it). */
export function optString(
  body: Record<string, unknown>,
  key: string,
  max = 512,
): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(422, `'${key}' must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(422, `'${key}' is too long (max ${max}).`);
  return trimmed === "" ? null : trimmed;
}

export function reqString(body: Record<string, unknown>, key: string, max = 512): string {
  const value = optString(body, key, max);
  if (value === undefined || value === null) throw new HttpError(422, `'${key}' is required.`);
  return value;
}

export function optNumber(
  body: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(422, `'${key}' must be a number.`);
  }
  if (opts.integer && !Number.isSafeInteger(value)) {
    throw new HttpError(422, `'${key}' must be a whole number.`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new HttpError(422, `'${key}' must be at least ${opts.min}.`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new HttpError(422, `'${key}' must be at most ${opts.max}.`);
  }
  return value;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** `10` → "10", `9.5` → "9.50". */
export function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ message, ...fields }));
}

export function logError(message: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({
      message,
      error: error instanceof Error ? error.message : String(error),
      ...fields,
    }),
  );
}
