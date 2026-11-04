/**
 * The model of investnow.db: the source of truth for its schema. Change a
 * table here, then run `bun run db:generate` to write the timestamped SQL
 * migration for it (into migrations/); `bun run db:check` fails while the two
 * disagree. Queries stay hand-written on Bun.SQL; the row types come from here.
 *
 * The bun-cache and bun-jobs stores (sessions.db, jobs.db, admin.db,
 * security.db) manage their own schemas and are not part of this model.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** ISO 8601 UTC with milliseconds: what every timestamp column defaults to. */
const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    waId: text("wa_id").notNull().unique(),
    name: text("name"),
    bvn: text("bvn").notNull().unique(),
    /** `YYYY-MM-DD`. */
    dateOfBirth: text("date_of_birth").notNull(),
    pinHash: text("pin_hash").notNull(),
    walletBalanceKobo: integer("wallet_balance_kobo").notNull().default(0),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [check("users_wallet_non_negative", sql`${t.walletBalanceKobo} >= 0`)],
);

/** The products a user subscribed to, and what they hold in each. */
export const userProducts = sqliteTable(
  "user_products",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productCode: text("product_code").notNull(),
    balanceKobo: integer("balance_kobo").notNull().default(0),
    subscribedAt: text("subscribed_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productCode] }),
    check("user_products_balance_non_negative", sql`${t.balanceKobo} >= 0`),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reference: text("reference").notNull().unique(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["fund", "withdraw", "buy"] }).notNull(),
    productCode: text("product_code"),
    amountKobo: integer("amount_kobo").notNull(),
    status: text("status").notNull().default("successful"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("ix_transactions_user").on(t.userId, t.createdAt),
    check(
      "transactions_type_known",
      sql`${t.type} IN ('fund', 'withdraw', 'buy')`,
    ),
    check("transactions_amount_positive", sql`${t.amountKobo} > 0`),
  ],
);

/** Admin accounts. Passwords are Bun.password (argon2id) hashes; emails are stored lower-cased. */
export const admins = sqliteTable(
  "admins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: text("created_at").notNull().default(now),
    lastLoginAt: text("last_login_at"),
  },
  // Usernames are unique whatever their case.
  (t) => [
    uniqueIndex("ux_admins_username_lower").on(sql`lower(${t.username})`),
  ],
);

/**
 * What admins see of conversations: one row per WhatsApp id describing its
 * latest session. The state itself lives in the bun-cache session store.
 */
export const conversationSessions = sqliteTable(
  "conversation_sessions",
  {
    waId: text("wa_id").primaryKey(),
    source: text("source", { enum: ["whatsapp", "simulator"] }).notNull(),
    profileName: text("profile_name"),
    phoneNumberId: text("phone_number_id"),
    step: text("step"),
    startedAt: text("started_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    expiresAt: text("expires_at"),
    messageCount: integer("message_count").notNull().default(0),
    endedAt: text("ended_at"),
    endReason: text("end_reason"),
  },
  (t) => [
    index("ix_conversation_sessions_activity").on(t.lastActivityAt),
    check(
      "conversation_sessions_source_known",
      sql`${t.source} IN ('whatsapp', 'simulator')`,
    ),
  ],
);

/** Every message in and out. Inputs typed at a PIN step are stored redacted, BVNs masked. */
export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    waId: text("wa_id").notNull(),
    source: text("source").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    stepBefore: text("step_before"),
    stepAfter: text("step_after"),
    text: text("text"),
    choiceId: text("choice_id"),
    kind: text("kind"),
    /** The inbound message this event belongs to (a WhatsApp `wamid.…` or a simulator `sim.…` id). */
    messageId: text("message_id"),
    /** For a reply: its position among the replies to that message. */
    replyIndex: integer("reply_index"),
    /** The whole message as JSON: a reply's buttons and list rows, or a user's (redacted) input. */
    payload: text("payload"),
    /** When the outbound job delivered a reply (to WhatsApp, or to the simulator). */
    deliveredAt: text("delivered_at"),
    at: text("at").notNull().default(now),
  },
  (t) => [
    index("ix_conversation_events_wa").on(t.waId, t.id),
    index("ix_conversation_events_message").on(
      t.messageId,
      t.direction,
      t.replyIndex,
    ),
    check(
      "conversation_events_direction_known",
      sql`${t.direction} IN ('in', 'out')`,
    ),
  ],
);
