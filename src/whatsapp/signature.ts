import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks Meta's `X-Hub-Signature-256` header: `sha256=` and the hex HMAC-SHA256
 * of the raw request body, keyed with the app secret.
 */
export function isValidSignature(
  rawBody: Uint8Array,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

/** The header value for a body, as Meta would send it. For tests and the dev simulator. */
export function sign(rawBody: string | Uint8Array, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** Compares two secrets in constant time (for their length). */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
