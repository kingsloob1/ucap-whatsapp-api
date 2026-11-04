import { Inject, Injectable } from "@nestjs/common";
import type { SQL } from "bun";
import { APP_DB } from "./database";
import type {
  Holding,
  NewUser,
  TransactionType,
  User,
  UserRow,
} from "./users.interface";

export class InsufficientFundsError extends Error {
  constructor(readonly availableKobo: number) {
    super("Insufficient wallet balance");
  }
}

export class DuplicateUserError extends Error {
  constructor(readonly field: "wa_id" | "bvn") {
    super(`A user with this ${field} already exists`);
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    waId: row.wa_id,
    name: row.name,
    bvn: row.bvn,
    dateOfBirth: row.date_of_birth,
    pinHash: row.pin_hash,
    walletBalanceKobo: Number(row.wallet_balance_kobo),
    createdAt: row.created_at,
  };
}

function reference(type: TransactionType): string {
  return `${type.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Users, their products and their (dummy) money, in the permanent SQLite file. */
@Injectable()
export class UsersRepository {
  constructor(@Inject(APP_DB) private readonly sql: SQL) {}

  async findByWaId(waId: string): Promise<User | null> {
    const rows: UserRow[] = await this
      .sql`SELECT * FROM users WHERE wa_id = ${waId}`;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async isBvnRegistered(bvn: string): Promise<boolean> {
    const rows: unknown[] = await this
      .sql`SELECT 1 FROM users WHERE bvn = ${bvn}`;
    return rows.length > 0;
  }

  /** Saves a finished onboarding: the user and the products they chose, in one transaction. */
  async create(input: NewUser): Promise<User> {
    try {
      return await this.sql.begin(async (tx) => {
        const rows: UserRow[] = await tx`
          INSERT INTO users (wa_id, name, bvn, date_of_birth, pin_hash)
          VALUES (${input.waId}, ${input.name}, ${input.bvn}, ${input.dateOfBirth}, ${input.pinHash})
          RETURNING *`;
        const user = toUser(rows[0]!);
        for (const code of input.productCodes) {
          await tx`INSERT INTO user_products (user_id, product_code) VALUES (${user.id}, ${code})`;
        }
        return user;
      });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (message.includes("UNIQUE") && message.includes("users.bvn"))
        throw new DuplicateUserError("bvn");
      if (message.includes("UNIQUE") && message.includes("users.wa_id"))
        throw new DuplicateUserError("wa_id");
      throw error;
    }
  }

  async holdings(userId: number): Promise<Holding[]> {
    const rows: { product_code: string; balance_kobo: number }[] = await this
      .sql`
      SELECT product_code, balance_kobo FROM user_products WHERE user_id = ${userId} ORDER BY subscribed_at, product_code`;
    return rows.map((r) => ({
      productCode: r.product_code,
      balanceKobo: Number(r.balance_kobo),
    }));
  }

  async walletBalance(userId: number): Promise<number> {
    const rows: { wallet_balance_kobo: number }[] = await this.sql`
      SELECT wallet_balance_kobo FROM users WHERE id = ${userId}`;
    return Number(rows[0]?.wallet_balance_kobo ?? 0);
  }

  /** Credits the wallet (a dummy payment that always succeeds). Answers the new balance and the reference. */
  async fundWallet(
    userId: number,
    amountKobo: number,
  ): Promise<{ balanceKobo: number; reference: string }> {
    const ref = reference("fund");
    const balanceKobo = await this.sql.begin(async (tx) => {
      const rows: { wallet_balance_kobo: number }[] = await tx`
        UPDATE users SET wallet_balance_kobo = wallet_balance_kobo + ${amountKobo},
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ${userId} RETURNING wallet_balance_kobo`;
      await tx`INSERT INTO transactions (reference, user_id, type, amount_kobo)
               VALUES (${ref}, ${userId}, 'fund', ${amountKobo})`;
      return Number(rows[0]!.wallet_balance_kobo);
    });
    return { balanceKobo, reference: ref };
  }

  /** Debits the wallet if it holds enough; throws `InsufficientFundsError` otherwise. */
  async withdrawFromWallet(
    userId: number,
    amountKobo: number,
  ): Promise<{ balanceKobo: number; reference: string }> {
    const ref = reference("withdraw");
    const balanceKobo = await this.sql.begin(async (tx) => {
      const rows: { wallet_balance_kobo: number }[] = await tx`
        UPDATE users SET wallet_balance_kobo = wallet_balance_kobo - ${amountKobo},
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ${userId} AND wallet_balance_kobo >= ${amountKobo}
        RETURNING wallet_balance_kobo`;
      if (rows.length === 0)
        throw new InsufficientFundsError(
          await this.walletBalanceIn(tx, userId),
        );
      await tx`INSERT INTO transactions (reference, user_id, type, amount_kobo)
               VALUES (${ref}, ${userId}, 'withdraw', ${amountKobo})`;
      return Number(rows[0]!.wallet_balance_kobo);
    });
    return { balanceKobo, reference: ref };
  }

  /** Moves money from the wallet into a product, subscribing the user to it if needed. */
  async buyProduct(
    userId: number,
    productCode: string,
    amountKobo: number,
  ): Promise<{
    walletBalanceKobo: number;
    productBalanceKobo: number;
    reference: string;
  }> {
    const ref = reference("buy");
    return this.sql.begin(async (tx) => {
      const wallet: { wallet_balance_kobo: number }[] = await tx`
        UPDATE users SET wallet_balance_kobo = wallet_balance_kobo - ${amountKobo},
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ${userId} AND wallet_balance_kobo >= ${amountKobo}
        RETURNING wallet_balance_kobo`;
      if (wallet.length === 0)
        throw new InsufficientFundsError(
          await this.walletBalanceIn(tx, userId),
        );
      const holding: { balance_kobo: number }[] = await tx`
        INSERT INTO user_products (user_id, product_code, balance_kobo) VALUES (${userId}, ${productCode}, ${amountKobo})
        ON CONFLICT (user_id, product_code) DO UPDATE SET balance_kobo = balance_kobo + excluded.balance_kobo
        RETURNING balance_kobo`;
      await tx`INSERT INTO transactions (reference, user_id, type, product_code, amount_kobo)
               VALUES (${ref}, ${userId}, 'buy', ${productCode}, ${amountKobo})`;
      return {
        walletBalanceKobo: Number(wallet[0]!.wallet_balance_kobo),
        productBalanceKobo: Number(holding[0]!.balance_kobo),
        reference: ref,
      };
    });
  }

  private async walletBalanceIn(tx: SQL, userId: number): Promise<number> {
    const rows: { wallet_balance_kobo: number }[] = await tx`
      SELECT wallet_balance_kobo FROM users WHERE id = ${userId}`;
    return Number(rows[0]?.wallet_balance_kobo ?? 0);
  }
}
