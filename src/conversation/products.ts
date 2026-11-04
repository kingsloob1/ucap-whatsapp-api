import type { Product } from "./conversation.interface";

export const PRODUCTS: readonly Product[] = [
  {
    code: "MMF",
    title: "Money Market Fund",
    description: "Low-risk fund investing in treasury bills and deposits",
  },
  {
    code: "FIF",
    title: "Fixed Income Fund",
    description: "Bonds and fixed income securities for steady returns",
  },
  {
    code: "BAL",
    title: "Balanced Fund",
    description: "A mix of equities and fixed income",
  },
  {
    code: "EQF",
    title: "Equity Fund",
    description: "Long-term growth from listed Nigerian equities",
  },
  {
    code: "STK",
    title: "Stocks",
    description: "Buy and sell shares on the Nigerian Exchange",
  },
  {
    code: "TRS",
    title: "Trustees",
    description: "Wills, private trusts and estate planning",
  },
];

const BY_CODE = new Map(PRODUCTS.map((p) => [p.code, p]));

export function productByCode(code: string): Product | undefined {
  return BY_CODE.get(code);
}

export function productTitle(code: string): string {
  return BY_CODE.get(code)?.title ?? code;
}
