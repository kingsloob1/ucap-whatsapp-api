import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "bun";
import type {
  MigrationRecord,
  MigrationState,
  MigrationStatus,
} from "./database.interface";

/** Where drizzle-kit writes the migrations (drizzle.config.ts `out`). */
export const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

/** The table drizzle's own migrator keeps, so drizzle-kit and this app agree on what is applied. */
const TABLE = "__drizzle_migrations";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** The migrations on disk, in journal order, with drizzle's hash (sha256 of the file). */
export function readMigrations(dir = MIGRATIONS_DIR): MigrationRecord[] {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries.map((entry) => {
    const text = readFileSync(join(dir, `${entry.tag}.sql`), "utf8");
    return {
      tag: entry.tag,
      createdAt: entry.when,
      hash: createHash("sha256").update(text).digest("hex"),
      statements: text
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  });
}

async function ensureTable(sql: SQL): Promise<void> {
  // The same definition drizzle's SQLite migrator creates.
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
}

async function appliedRows(
  sql: SQL,
): Promise<{ hash: string; createdAt: number }[]> {
  const rows: { hash: string; created_at: number | string }[] =
    await sql.unsafe(
      `SELECT hash, created_at FROM "${TABLE}" ORDER BY created_at`,
    );
  return rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
}

/**
 * Every migration's state, the way drizzle's migrator decides what to run:
 *
 * - `applied`: recorded, with the same hash as the file;
 * - `modified`: recorded, but the file changed since (history was edited: write a new migration instead);
 * - `pending`: newer than the last applied one, so the next `migrate` runs it;
 * - `skipped`: not recorded but older than the last applied one, so `migrate` will never run it
 *   (a branch merged out of order: regenerate it with a newer timestamp);
 * - `missing`: recorded in the database, but no file has its timestamp.
 */
export async function migrationStatus(
  sql: SQL,
  dir = MIGRATIONS_DIR,
): Promise<MigrationStatus[]> {
  await ensureTable(sql);
  const files = readMigrations(dir);
  const rows = await appliedRows(sql);
  const last = rows.at(-1)?.createdAt ?? Number.NEGATIVE_INFINITY;
  const byTime = new Map(rows.map((r) => [r.createdAt, r]));

  const out: MigrationStatus[] = files.map((file) => {
    const row = byTime.get(file.createdAt);
    let state: MigrationState;
    if (row) state = row.hash === file.hash ? "applied" : "modified";
    else state = file.createdAt > last ? "pending" : "skipped";
    return { tag: file.tag, createdAt: file.createdAt, state };
  });
  const known = new Set(files.map((f) => f.createdAt));
  for (const row of rows) {
    if (!known.has(row.createdAt))
      out.push({
        tag: `(no file for ${row.createdAt})`,
        createdAt: row.createdAt,
        state: "missing",
      });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Applies every pending migration, in one transaction (as drizzle's migrator
 * does), and answers the tags it applied. Refuses to run over `modified` or
 * `skipped` migrations: either means the files and the database disagree.
 */
export async function applyMigrations(
  sql: SQL,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const status = await migrationStatus(sql, dir);
  const broken = status.filter(
    (s) => s.state === "modified" || s.state === "skipped",
  );
  if (broken.length > 0) {
    throw new Error(
      `Migrations and database disagree: ${broken.map((s) => `${s.tag} is ${s.state}`).join(", ")}. See \`bun run db:status\`.`,
    );
  }
  const pending = new Set(
    status.filter((s) => s.state === "pending").map((s) => s.createdAt),
  );
  const toRun = readMigrations(dir).filter((m) => pending.has(m.createdAt));
  if (toRun.length === 0) return [];

  await sql.begin(async (tx) => {
    for (const migration of toRun) {
      for (const statement of migration.statements) await tx.unsafe(statement);
      await tx.unsafe(
        `INSERT INTO "${TABLE}" ("hash", "created_at") VALUES ($1, $2)`,
        [migration.hash, migration.createdAt],
      );
    }
  });
  return toRun.map((m) => m.tag);
}
