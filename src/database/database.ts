import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { SQL } from "bun";
import { applyMigrations, migrationStatus } from "./migrator";

const logger = new Logger("Database");

/** The DI token for the app's permanent SQLite database (Bun SQL). */
export const APP_DB = Symbol("APP_DB");

/**
 * Opens `<dataDir>/investnow.db` (or an in-memory database for `:memory:`) and
 * brings its schema up to date: pending migrations are applied when
 * `migrateOnStart` is set, and otherwise refuse the start, naming them.
 */
export async function openAppDatabase(
  dataDir: string,
  options: { migrateOnStart: boolean },
): Promise<SQL> {
  const sql = await connectAppDatabase(dataDir);

  if (options.migrateOnStart) {
    const applied = await applyMigrations(sql);
    if (applied.length > 0)
      logger.log(`Applied migrations: ${applied.join(", ")}`);
  } else {
    const pending = (await migrationStatus(sql)).filter(
      (m) => m.state !== "applied",
    );
    if (pending.length > 0) {
      await sql.close();
      throw new Error(
        `investnow.db is not up to date (${pending.map((m) => `${m.tag}: ${m.state}`).join(", ")}). ` +
          "Run `bun run db:migrate`, or set MIGRATE_ON_START=true.",
      );
    }
  }
  return sql;
}

/** Opens investnow.db with its pragmas, leaving its schema as it is (the migration scripts start here). */
export async function connectAppDatabase(dataDir: string): Promise<SQL> {
  let url = "sqlite://:memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    url = `sqlite://${join(dataDir, "investnow.db")}`;
  }
  const sql = new SQL(url);
  await sql`PRAGMA journal_mode = WAL`;
  await sql`PRAGMA foreign_keys = ON`;
  await sql`PRAGMA busy_timeout = 5000`;
  return sql;
}
