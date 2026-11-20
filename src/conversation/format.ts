/** How answers and requests are shown back to users, in chat messages, Flow screens and the history. */
import { formatNaira } from "./parsers";
import { productTitle } from "./products";
import type { PendingAction } from "./conversation.interface";

/**
 * Digits with all but the last 4 as dots: a BVN in a message or the history.
 * Dots, not asterisks, so nothing pairs up as WhatsApp bold.
 */
export function hideBvn(bvn: string): string {
  const digits = bvn.replace(/\D/g, "");
  return `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** An ISO date as DD/MM/YYYY; anything else as given. */
export function formatDob(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function productsText(codes: string[]): string {
  return codes.map(productTitle).join(", ");
}

/** What a pending request does, e.g. "Fund your wallet with ₦50,000.00". */
export function actionSummary(action: PendingAction): string {
  switch (action.type) {
    case "fund":
      return `Fund your wallet with ${formatNaira(action.amountKobo)}`;
    case "withdraw":
      return `Withdraw ${formatNaira(action.amountKobo)} to your bank account`;
    case "buy":
      return `Buy ${formatNaira(action.amountKobo)} of ${productTitle(action.productCode)} from your wallet`;
    case "balance":
      return "View your wallet and investment balances";
    case "products":
      return "View your products and what you hold in each";
    case "history":
      return "View your transaction history";
  }
}

const WHEN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A stored ISO timestamp in Nigerian time, e.g. "20 Nov 2026, 11:29". */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : WHEN.format(date);
}
