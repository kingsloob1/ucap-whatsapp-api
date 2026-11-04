import { Inject, Injectable } from "@nestjs/common";
import type { SQL } from "bun";
import { APP_DB } from "../database/database";
import { USERNAME } from "../admin/admin.dto";
import type { AdminRecord, AdminRow } from "./admin.interface";

/** Why a password is refused, or null when it is acceptable. */
export function passwordProblem(
  password: string,
  identity: { email: string; username: string },
): string | null {
  if (password.length < 12) return "must be at least 12 characters";
  if (password.length > 200) return "must be at most 200 characters";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((r) =>
    r.test(password),
  ).length;
  if (classes < 3)
    return "must mix at least three of: lower case, upper case, digits, symbols";
  const lower = password.toLowerCase();
  if (
    lower.includes(identity.username.toLowerCase()) ||
    lower.includes(identity.email.split("@")[0]!.toLowerCase())
  ) {
    return "must not contain the username or email";
  }
  return null;
}

@Injectable()
export class AdminsRepository {
  constructor(@Inject(APP_DB) private readonly sql: SQL) {}

  /** By email (case-insensitive) when the identifier has an `@`, otherwise by username. */
  async findByIdentifier(identifier: string): Promise<AdminRecord | null> {
    const value = identifier.trim();
    const rows: AdminRow[] = value.includes("@")
      ? await this
          .sql`SELECT id, email, username, password_hash FROM admins WHERE email = ${value.toLowerCase()}`
      : await this
          .sql`SELECT id, email, username, password_hash FROM admins WHERE lower(username) = lower(${value})`;
    const row = rows[0];
    return row
      ? {
          id: Number(row.id),
          email: row.email,
          username: row.username,
          passwordHash: row.password_hash,
        }
      : null;
  }

  async count(): Promise<number> {
    const [row]: { n: number }[] = await this
      .sql`SELECT count(*) AS n FROM admins`;
    return Number(row?.n ?? 0);
  }

  /** Creates an admin, or resets the password of the one with that email. Validates everything. */
  async upsert(input: {
    email: string;
    username: string;
    password: string;
  }): Promise<AdminRecord> {
    const email = input.email.trim().toLowerCase();
    const username = input.username.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error("Admin email is not a valid email address");
    if (!USERNAME.test(username)) {
      throw new Error(
        "Admin username must be 3–32 letters, digits, '.', '_' or '-', starting and ending with a letter or digit",
      );
    }
    const problem = passwordProblem(input.password, { email, username });
    if (problem) throw new Error(`Admin password ${problem}`);

    const hash = await Bun.password.hash(input.password);
    const rows: AdminRow[] = await this.sql`
      INSERT INTO admins (email, username, password_hash) VALUES (${email}, ${username}, ${hash})
      ON CONFLICT (email) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash
      RETURNING id, email, username, password_hash`;
    const row = rows[0]!;
    return {
      id: Number(row.id),
      email: row.email,
      username: row.username,
      passwordHash: row.password_hash,
    };
  }

  async touchLogin(id: number): Promise<void> {
    await this
      .sql`UPDATE admins SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${id}`;
  }
}
