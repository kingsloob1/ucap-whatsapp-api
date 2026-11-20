/**
 * The figures each product's buying steps show. They are demo values for the
 * dummy InvestNow backend, not live rates or prices: change them here.
 */
import type { FundTerms, Stock, Tenor } from "./conversation.interface";

/** Money Market Fund: the yearly rate interest is quoted at. */
export const MMF_RATE_PCT = 18.5;

/** The principal the Money Market Fund's example uses. */
export const EXAMPLE_PRINCIPAL_KOBO = 100_000_00;

/** Fixed Income Fund: the terms on offer, each at its own yearly rate. */
export const FIF_TENORS: readonly Tenor[] = [
  { days: 90, ratePct: 15.5 },
  { days: 180, ratePct: 16.25 },
  { days: 365, ratePct: 17 },
];

/** Unit-priced mutual funds: today's price per unit, the past year's return and the risk level. */
export const FUND_TERMS: Readonly<Record<"BAL" | "EQF", FundTerms>> = {
  BAL: { unitPrice: 2.4512, oneYearPct: 21.4, risk: "Medium" },
  EQF: { unitPrice: 1.8734, oneYearPct: 34.8, risk: "High" },
};

/** Stocks on the Nigerian Exchange that can be bought, at a demo price per share. */
export const STOCKS: readonly Stock[] = [
  { ticker: "DANGCEM", name: "Dangote Cement", priceKobo: 480_00 },
  { ticker: "MTNN", name: "MTN Nigeria", priceKobo: 230_00 },
  { ticker: "AIRTELAFRI", name: "Airtel Africa", priceKobo: 2_150_00 },
  { ticker: "GTCO", name: "Guaranty Trust Holding", priceKobo: 52_50 },
  { ticker: "ZENITHBANK", name: "Zenith Bank", priceKobo: 38_40 },
];

/** The most shares one order can buy. */
export const MAX_SHARES = 1_000_000;

/** Trustees: the services, and who the beneficiary can be to the user. */
export const TRUST_SERVICES: readonly { title: string; description: string }[] =
  [
    { title: "Simple will", description: "Say who receives your assets" },
    {
      title: "Private trust",
      description: "Assets managed for your loved ones",
    },
    {
      title: "Education trust",
      description: "Pay for a child's school fees over time",
    },
    {
      title: "Estate planning",
      description: "A plan for your whole estate",
    },
  ];

export const RELATIONSHIPS: readonly string[] = [
  "Spouse",
  "Child",
  "Parent",
  "Sibling",
  "Other",
];

/** What a liquidation of each product should warn about, shown before it is confirmed. */
export const LIQUIDATION_NOTES: Readonly<Record<string, string>> = {
  MMF: "Money Market Fund liquidations usually reach your wallet within 24 hours. _Demo: paid at once._",
  FIF: "Liquidating before your term ends can cost some of the interest earned. _Demo: no penalty is charged._",
  BAL: "Units are sold at the next unit price. _Demo: sold at the value shown._",
  EQF: "Units are sold at the next unit price. _Demo: sold at the value shown._",
  STK: "Your shares are sold at the market price when the order is executed. _Demo: sold at the value shown._",
  TRS: "Taking money out of a trust can need the trustee's approval. _Demo: paid at once._",
};
