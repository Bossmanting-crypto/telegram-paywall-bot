/** Web Crypto helpers: hashing, HMAC, constant-time compare, random IDs, AES-GCM. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toHex(buf: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hmacHex(
  hash: "SHA-256" | "SHA-512",
  key: string,
  data: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

/**
 * Constant-time string comparison. Both values are hashed to a fixed size
 * first so the comparison leaks neither content nor length.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf.buffer);
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Tenant API key: `pbk_` + 64 hex characters (256 bits of randomness). */
export function newApiKey(): string {
  return `pbk_${randomHex(32)}`;
}

// ── Encryption at rest for creators' credentials ─────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const MIN_ENCRYPTION_KEY_LENGTH = 32;

export function encryptionConfigured(passphrase: string | undefined): passphrase is string {
  return typeof passphrase === "string" && passphrase.length >= MIN_ENCRYPTION_KEY_LENGTH;
}

/** Derive the AES key from the passphrase. Derive once and reuse it for a batch of fields. */
export async function deriveKey(passphrase: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("telegram-paywall-bot"),
      info: encoder.encode("credentials-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Returns `v1.<iv>.<ciphertext>` (base64). */
export async function encryptSecret(passphrase: string, plaintext: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await deriveKey(passphrase);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export async function decryptWithKey(key: CryptoKey, blob: string): Promise<string> {
  const [version, ivPart, ctPart] = blob.split(".");
  if (version !== "v1" || !ivPart || !ctPart) throw new Error("Unrecognised ciphertext format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivPart) },
    key,
    fromBase64(ctPart),
  );
  return decoder.decode(plain);
}

export async function decryptSecret(passphrase: string, blob: string): Promise<string> {
  return decryptWithKey(await deriveKey(passphrase), blob);
}

/** `sk_live_abcd…wxyz` → `sk_live_…wxyz`, for showing which key is in use. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "…";
  const prefix = /^(sk|pk)_(live|test)_/.exec(value)?.[0] ?? "";
  return `${prefix}…${value.slice(-4)}`;
}
