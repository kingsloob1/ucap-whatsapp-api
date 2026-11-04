export interface User {
  id: number;
  waId: string;
  name: string | null;
  bvn: string;
  dateOfBirth: string;
  pinHash: string;
  walletBalanceKobo: number;
  createdAt: string;
}

export interface Holding {
  productCode: string;
  balanceKobo: number;
}

export interface NewUser {
  waId: string;
  name: string | null;
  bvn: string;
  /** ISO date, `YYYY-MM-DD`. */
  dateOfBirth: string;
  pinHash: string;
  productCodes: string[];
}

export type TransactionType = "fund" | "withdraw" | "buy";

export interface UserRow {
  id: number;
  wa_id: string;
  name: string | null;
  bvn: string;
  date_of_birth: string;
  pin_hash: string;
  wallet_balance_kobo: number;
  created_at: string;
}
