import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

/** The DI token for the app's permanent SQLite database (Bun SQL). */
export const APP_DB = Symbol("APP_DB");

/** Opens `<dataDir>/investnow.db`, or an in-memory database for `:memory:`. */
export async function openAppDatabase(dataDir: string): Promise<SQL> {
  let url = "sqlite://:memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    url = `sqlite://${join(dataDir, "investnow.db")}`;
  }
  const sql = new SQL(url);
  await sql`PRAGMA journal_mode = WAL`;
  await sql`PRAGMA foreign_keys = ON`;
  await sql`PRAGMA busy_timeout = 5000`;
  await migrate(sql);
  return sql;
}

/**
 * Creates the schema. Every statement is idempotent; money is stored in kobo
 * as integers so nothing is lost to floating point.
 */
async function migrate(sql: SQL): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id               TEXT    NOT NULL UNIQUE,
      name                TEXT,
      bvn                 TEXT    NOT NULL UNIQUE,
      date_of_birth       TEXT    NOT NULL,
      pin_hash            TEXT    NOT NULL,
      wallet_balance_kobo INTEGER NOT NULL DEFAULT 0 CHECK (wallet_balance_kobo >= 0),
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS user_products (
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_code  TEXT    NOT NULL,
      balance_kobo  INTEGER NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
      subscribed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (user_id, product_code)
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      reference    TEXT    NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type         TEXT    NOT NULL CHECK (type IN ('fund', 'withdraw', 'buy')),
      product_code TEXT,
      amount_kobo  INTEGER NOT NULL CHECK (amount_kobo > 0),
      status       TEXT    NOT NULL DEFAULT 'successful',
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`;
  await sql`CREATE INDEX IF NOT EXISTS ix_transactions_user ON transactions (user_id, created_at)`;

  // Admin accounts. Passwords are Bun.password (argon2id) hashes.
  await sql`
    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_login_at TEXT
    )`;

  // What admins see of conversations. The state itself lives in the bun-cache
  // session store; this is one row per WhatsApp id describing its latest session.
  await sql`
    CREATE TABLE IF NOT EXISTS conversation_sessions (
      wa_id            TEXT    PRIMARY KEY,
      source           TEXT    NOT NULL CHECK (source IN ('whatsapp', 'simulator')),
      profile_name     TEXT,
      phone_number_id  TEXT,
      step             TEXT,
      started_at       TEXT    NOT NULL,
      last_activity_at TEXT    NOT NULL,
      expires_at       TEXT,
      message_count    INTEGER NOT NULL DEFAULT 0,
      ended_at         TEXT,
      end_reason       TEXT
    )`;
  await sql`CREATE INDEX IF NOT EXISTS ix_conversation_sessions_activity ON conversation_sessions (last_activity_at)`;

  // Every message in and out, for the admin's view of a session. Inputs typed
  // at a PIN step are stored redacted.
  await sql`
    CREATE TABLE IF NOT EXISTS conversation_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id       TEXT    NOT NULL,
      source      TEXT    NOT NULL,
      direction   TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
      step_before TEXT,
      step_after  TEXT,
      text        TEXT,
      choice_id   TEXT,
      kind        TEXT,
      at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`;
  await sql`CREATE INDEX IF NOT EXISTS ix_conversation_events_wa ON conversation_events (wa_id, id)`;
}
