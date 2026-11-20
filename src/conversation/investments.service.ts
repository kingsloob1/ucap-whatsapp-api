/**
 * What each product's buying steps show: the expected interest, the units or
 * shares an amount buys, and the summaries for the confirmation, the PIN
 * prompt and the transaction history. Pure functions over the demo figures in
 * investments.constants.ts.
 */
import {
  EXAMPLE_PRINCIPAL_KOBO,
  FIF_TENORS,
  FUND_TERMS,
  MMF_RATE_PCT,
  STOCKS,
} from "./investments.constants";
import { formatNaira } from "./parsers";
import { productTitle } from "./products";
import type { BuyDetails, Stock } from "./conversation.interface";

const DISCLAIMER = {
  rate: "_Rates are indicative and can change; returns aren't guaranteed._",
  units:
    "_Past returns don't guarantee future returns. Units are bought at the next unit price._",
  shares:
    "_Demo prices: a real order fills at the market price when it's executed._",
} as const;

/** Interest on `amountKobo` at a yearly rate, over `days` (simple interest, 365-day year), to the kobo. */
export function interestKobo(
  amountKobo: number,
  ratePct: number,
  days: number,
): number {
  return Math.round((amountKobo * ratePct * days) / (100 * 365));
}

export function formatRate(ratePct: number): string {
  return `${ratePct.toFixed(2)}% a year`;
}

/** Units an amount buys at a unit price, to 2 decimal places. */
export function unitsFor(amountKobo: number, unitPrice: number): number {
  return Math.floor((amountKobo / 100 / unitPrice) * 100) / 100;
}

function formatUnits(units: number): string {
  return units.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUnitPrice(unitPrice: number): string {
  return `₦${unitPrice.toFixed(4)}`;
}

const DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** The day a term of `days` from `from` ends, e.g. "19 May 2027". */
export function maturityDate(days: number, from = new Date()): string {
  return DATE.format(new Date(from.getTime() + days * 86_400_000));
}

export function stockByTicker(ticker: string): Stock | undefined {
  return STOCKS.find((s) => s.ticker === ticker);
}

/** The details a product starts with when it has no questions before the amount. */
export function defaultDetails(productCode: string): BuyDetails | undefined {
  if (productCode === "MMF") return { kind: "rate", ratePct: MMF_RATE_PCT };
  if (productCode === "BAL" || productCode === "EQF")
    return { kind: "units", unitPrice: FUND_TERMS[productCode].unitPrice };
  return undefined;
}

/** The Fixed Income Fund's choice of terms. */
export function tenorPrompt(): string {
  const lines = FIF_TENORS.map(
    (t) => `• ${t.days} days: ${formatRate(t.ratePct)}`,
  );
  return (
    `*${productTitle("FIF")}*\n${lines.join("\n")}\n\n` +
    "How long would you like to invest for? The longer the term, the higher the rate, and your money is paid back with the interest when it ends."
  );
}

/** The question for the amount, with what the product's figures mean for an example principal. */
export function amountPrompt(
  productCode: string,
  details: BuyDetails | undefined,
  walletKobo: number,
): string {
  const ask =
    "How much would you like to invest? Send the amount in naira, e.g. 50000.";
  const wallet = `Wallet balance: ${formatNaira(walletKobo)}`;
  const example = formatNaira(EXAMPLE_PRINCIPAL_KOBO);
  switch (details?.kind) {
    case "rate": {
      const daily = interestKobo(EXAMPLE_PRINCIPAL_KOBO, details.ratePct, 1);
      const month = interestKobo(EXAMPLE_PRINCIPAL_KOBO, details.ratePct, 30);
      return (
        `*${productTitle(productCode)}*\nCurrent rate: *${formatRate(details.ratePct)}*\n\n` +
        `For example, ${example} earns about *${formatNaira(daily)} a day*, or ${formatNaira(month)} in 30 days.\n\n` +
        `${ask}\n\n${wallet}`
      );
    }
    case "tenor": {
      const total = interestKobo(
        EXAMPLE_PRINCIPAL_KOBO,
        details.ratePct,
        details.days,
      );
      return (
        `*${productTitle(productCode)} · ${details.days} days* at *${formatRate(details.ratePct)}*\n\n` +
        `For example, ${example} for ${details.days} days earns about *${formatNaira(total)}*, paid with your ${example} on ${maturityDate(details.days)}.\n\n` +
        `${ask}\n\n${wallet}`
      );
    }
    case "units": {
      const terms = FUND_TERMS[productCode as "BAL" | "EQF"];
      return (
        `*${productTitle(productCode)}*\n` +
        `Unit price: *${formatUnitPrice(details.unitPrice)}*\n` +
        `Past year's return: ${terms.oneYearPct.toFixed(2)}%\nRisk: ${terms.risk}\n\n` +
        `For example, ${example} buys about ${formatUnits(unitsFor(EXAMPLE_PRINCIPAL_KOBO, details.unitPrice))} units.\n\n` +
        `${ask}\n\n${wallet}`
      );
    }
    case "trust":
      return (
        `How much would you like to pay into your *${details.service.toLowerCase()}* for ${details.beneficiary}? ` +
        `Send the amount in naira, e.g. 50000.\n\n${wallet}`
      );
    default:
      return `How much of *${productTitle(productCode)}* would you like to buy? Send the amount in naira.\n\n${wallet}`;
  }
}

/** The question for the number of shares of a stock. */
export function sharesPrompt(stock: Stock, walletKobo: number): string {
  const most = Math.floor(walletKobo / stock.priceKobo);
  return (
    `*${stock.name} (${stock.ticker})*\nPrice: *${formatNaira(stock.priceKobo)} a share*\n\n` +
    `Your wallet balance of ${formatNaira(walletKobo)} can buy up to ${most.toLocaleString("en-NG")} share${most === 1 ? "" : "s"}.\n\n` +
    "How many shares would you like to buy? e.g. 10"
  );
}

/** The confirmation's lines for a purchase: what it is and what the user should expect. */
export function buyQuote(
  productCode: string,
  amountKobo: number,
  details: BuyDetails | undefined,
): string {
  const head = [`Product: ${productTitle(productCode)}`];
  const amount = `Amount: *${formatNaira(amountKobo)}*`;
  switch (details?.kind) {
    case "rate": {
      const daily = interestKobo(amountKobo, details.ratePct, 1);
      const month = interestKobo(amountKobo, details.ratePct, 30);
      return [
        ...head,
        amount,
        `Rate: ${formatRate(details.ratePct)}`,
        `Expected interest: about *${formatNaira(daily)} a day* (${formatNaira(month)} in 30 days)`,
        "",
        DISCLAIMER.rate,
      ].join("\n");
    }
    case "tenor": {
      const interest = interestKobo(amountKobo, details.ratePct, details.days);
      return [
        ...head,
        amount,
        `Term: ${details.days} days, ending ${maturityDate(details.days)}`,
        `Rate: ${formatRate(details.ratePct)}`,
        `Expected interest: about *${formatNaira(interest)}*`,
        `Paid back at the end: about *${formatNaira(amountKobo + interest)}*`,
        "",
        DISCLAIMER.rate,
      ].join("\n");
    }
    case "units": {
      const terms = FUND_TERMS[productCode as "BAL" | "EQF"];
      return [
        ...head,
        amount,
        `Unit price: ${formatUnitPrice(details.unitPrice)}`,
        `Units: about *${formatUnits(unitsFor(amountKobo, details.unitPrice))}*`,
        `Risk: ${terms.risk}`,
        "",
        DISCLAIMER.units,
      ].join("\n");
    }
    case "shares": {
      const stock = stockByTicker(details.ticker);
      return [
        ...head,
        `Stock: ${stock?.name ?? details.ticker} (${details.ticker})`,
        `Shares: ${details.shares.toLocaleString("en-NG")} × ${formatNaira(details.priceKobo)}`,
        `Total: *${formatNaira(amountKobo)}*`,
        "",
        DISCLAIMER.shares,
      ].join("\n");
    }
    case "trust":
      return [
        ...head,
        `Service: ${details.service}`,
        `Beneficiary: ${details.beneficiary} (${details.relationship})`,
        amount,
      ].join("\n");
    default:
      return [...head, amount].join("\n");
  }
}

/** A short line for the PIN prompt and the history, e.g. "20 DANGCEM shares at ₦480.00"; null with no details. */
export function buyNote(
  amountKobo: number,
  details: BuyDetails | undefined,
): string | null {
  switch (details?.kind) {
    case "rate":
      return `${formatRate(details.ratePct)}, about ${formatNaira(interestKobo(amountKobo, details.ratePct, 1))} a day`;
    case "tenor":
      return `${details.days} days at ${formatRate(details.ratePct)}, about ${formatNaira(interestKobo(amountKobo, details.ratePct, details.days))} interest`;
    case "units":
      return `about ${formatUnits(unitsFor(amountKobo, details.unitPrice))} units at ${formatUnitPrice(details.unitPrice)}`;
    case "shares":
      return `${details.shares.toLocaleString("en-NG")} ${details.ticker} share${details.shares === 1 ? "" : "s"} at ${formatNaira(details.priceKobo)}`;
    case "trust":
      return `${details.service} for ${details.beneficiary} (${details.relationship})`;
    default:
      return null;
  }
}
