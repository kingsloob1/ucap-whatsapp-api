import type { transactions, userProducts, users } from "./schema";

/** A user, as the model (schema.ts) defines the `users` table. */
export type User = Omit<typeof users.$inferSelect, "updatedAt">;

export type Holding = Pick<
  typeof userProducts.$inferSelect,
  "productCode" | "balanceKobo"
>;

export interface NewUser {
  waId: string;
  name: string | null;
  bvn: string;
  /** ISO date, `YYYY-MM-DD`. */
  dateOfBirth: string;
  pinHash: string;
  productCodes: string[];
}

export type TransactionType = (typeof transactions.$inferSelect)["type"];

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
