/** Parsing and validation of what users type. Each answers a value or an error message to show them. */
import type { Parsed } from "./conversation.interface";

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

/** A BVN is 11 digits; spaces and dashes are ignored. */
export function parseBvn(input: string): Parsed<string> {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{11}$/.test(digits))
    return fail("A BVN is 11 digits. Please check it and send it again.");
  return ok(digits);
}

export const MIN_AGE = 18;

/**
 * A date of birth as DD/MM/YYYY (also with `-` or `.`), or YYYY-MM-DD.
 * Answers an ISO date. The user must be at least {@link MIN_AGE}.
 */
export function parseDateOfBirth(
  input: string,
  now = new Date(),
): Parsed<string> {
  const value = input.trim();
  let day: number;
  let month: number;
  let year: number;
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (m) {
    day = Number(m[1]);
    month = Number(m[2]);
    year = Number(m[3]);
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value))) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    return fail(
      "Please send your date of birth as DD/MM/YYYY, for example 25/12/1990.",
    );
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return fail(
      "That date doesn't exist. Please send your date of birth as DD/MM/YYYY.",
    );
  }
  if (date.getTime() > now.getTime())
    return fail("Your date of birth can't be in the future.");

  let age = now.getUTCFullYear() - year;
  const birthdayPassed =
    now.getUTCMonth() > month - 1 ||
    (now.getUTCMonth() === month - 1 && now.getUTCDate() >= day);
  if (!birthdayPassed) age -= 1;
  if (age < MIN_AGE)
    return fail(
      `You must be at least ${MIN_AGE} years old to open an InvestNow account.`,
    );
  if (age > 120)
    return fail(
      "Please check your date of birth and send it again as DD/MM/YYYY.",
    );

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return ok(iso);
}

/**
 * A selection from a numbered list of `count` items: "1,3,4", "1 3 4", "1, 3 and 4" or "all".
 * Answers the zero-based indexes, deduplicated, in list order.
 */
export function parseSelection(input: string, count: number): Parsed<number[]> {
  const value = input.trim().toLowerCase();
  if (value === "all") return ok([...Array(count).keys()]);
  const tokens = value
    .split(/(?:\s*,\s*|\s+and\s+|\s*&\s*|\s+)/)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.some((t) => !/^\d+$/.test(t))) {
    return fail(
      `Please reply with the numbers of the products you want, separated by commas (e.g. 1,3), or "all".`,
    );
  }
  const numbers = tokens.map(Number);
  const outOfRange = numbers.filter((n) => n < 1 || n > count);
  if (outOfRange.length > 0)
    return fail(`Please choose numbers between 1 and ${count}.`);
  return ok([...new Set(numbers.map((n) => n - 1))].sort((a, b) => a - b));
}

/** A 4-digit PIN, refusing ones that are easy to guess. */
export function parseNewPin(input: string): Parsed<string> {
  const pin = input.trim();
  if (!/^\d{4}$/.test(pin)) return fail("Your PIN must be exactly 4 digits.");
  if (/^(\d)\1{3}$/.test(pin))
    return fail(
      "That PIN is too easy to guess (all the same digit). Please choose another.",
    );
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) {
    return fail(
      "That PIN is too easy to guess (a sequence). Please choose another.",
    );
  }
  return ok(pin);
}

export const MIN_AMOUNT_KOBO = 100_00;
export const MAX_AMOUNT_KOBO = 10_000_000_00;

/** An amount in naira: "5000", "5,000", "₦5,000.50", "N5000", "5k". Answers kobo. */
export function parseAmount(input: string): Parsed<number> {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^(₦|ngn|n)\s*/, "")
    .replace(/,/g, "");
  const m = /^(\d+(?:\.\d{1,2})?)\s*(k|m)?$/.exec(value);
  if (!m) return fail("Please send the amount in naira, for example 5000.");
  const multiplier = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
  const kobo = Math.round(Number(m[1]) * multiplier * 100);
  if (kobo < MIN_AMOUNT_KOBO)
    return fail(`The minimum amount is ${formatNaira(MIN_AMOUNT_KOBO)}.`);
  if (kobo > MAX_AMOUNT_KOBO)
    return fail(`The maximum amount is ${formatNaira(MAX_AMOUNT_KOBO)}.`);
  return ok(kobo);
}

const NAIRA = new Intl.NumberFormat("en-NG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatNaira(kobo: number): string {
  return `₦${NAIRA.format(kobo / 100)}`;
}

/** The BVN with all but the last 4 digits hidden. */
export function maskBvn(bvn: string): string {
  return `${"*".repeat(Math.max(0, bvn.length - 4))}${bvn.slice(-4)}`;
}
