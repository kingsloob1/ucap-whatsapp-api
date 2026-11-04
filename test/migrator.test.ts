import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import {
  applyMigrations,
  MIGRATIONS_DIR,
  migrationStatus,
  readMigrations,
} from "../src/database/migrator";

let dir: string;
let sql: SQL;

/** Writes a migrations folder the way drizzle-kit lays it out. */
function folder(migrations: { tag: string; when: number; sql: string }[]) {
  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const m of migrations) writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: migrations.map((m, idx) => ({
        idx,
        version: "6",
        when: m.when,
        tag: m.tag,
        breakpoints: true,
      })),
    }),
  );
}

const ONE = {
  tag: "20260101000000_one",
  when: 1_000,
  sql: "CREATE TABLE a (x integer);",
};
const TWO = {
  tag: "20260102000000_two",
  when: 2_000,
  sql: "CREATE TABLE b (y integer);\n--> statement-breakpoint\nINSERT INTO b VALUES (7);",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrator-"));
  sql = new SQL("sqlite://:memory:");
});

afterEach(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

const states = async () =>
  (await migrationStatus(sql, dir)).map((s) => `${s.tag}:${s.state}`);

describe("migrator", () => {
  test("pending migrations are applied in order, statement by statement, then recorded", async () => {
    folder([ONE, TWO]);
    expect(await states()).toEqual([
      "20260101000000_one:pending",
      "20260102000000_two:pending",
    ]);
    expect(await applyMigrations(sql, dir)).toEqual([ONE.tag, TWO.tag]);
    expect(await states()).toEqual([
      "20260101000000_one:applied",
      "20260102000000_two:applied",
    ]);
    expect(await sql`SELECT y FROM b`).toEqual([{ y: 7 }] as never);
    expect(await applyMigrations(sql, dir)).toEqual([]);
  });

  test("records what drizzle's own migrator records, so drizzle-kit agrees", async () => {
    folder([ONE]);
    await applyMigrations(sql, dir);
    const rows: { hash: string; created_at: number }[] =
      await sql`SELECT hash, created_at FROM __drizzle_migrations`;
    expect(rows).toEqual([
      { hash: readMigrations(dir)[0]!.hash, created_at: 1_000 },
    ]);
  });

  test("a new migration after the last applied one is pending", async () => {
    folder([ONE]);
    await applyMigrations(sql, dir);
    folder([ONE, TWO]);
    expect(await states()).toEqual([
      "20260101000000_one:applied",
      "20260102000000_two:pending",
    ]);
  });

  test("an applied file that changed is modified, and migrate refuses to run", async () => {
    folder([ONE]);
    await applyMigrations(sql, dir);
    folder([{ ...ONE, sql: "CREATE TABLE a (x integer, z text);" }, TWO]);
    expect(await states()).toEqual([
      "20260101000000_one:modified",
      "20260102000000_two:pending",
    ]);
    await expect(applyMigrations(sql, dir)).rejects.toThrow("is modified");
    expect(
      await sql`SELECT name FROM sqlite_master WHERE name = 'b'`,
    ).toHaveLength(0);
  });

  test("a migration older than the last applied one, never applied, is skipped", async () => {
    folder([TWO]);
    await applyMigrations(sql, dir);
    folder([ONE, TWO]);
    expect(await states()).toEqual([
      "20260101000000_one:skipped",
      "20260102000000_two:applied",
    ]);
    await expect(applyMigrations(sql, dir)).rejects.toThrow("is skipped");
  });

  test("a recorded migration with no file is missing", async () => {
    folder([ONE, TWO]);
    await applyMigrations(sql, dir);
    folder([ONE]);
    expect(await states()).toEqual([
      "20260101000000_one:applied",
      "(no file for 2000):missing",
    ]);
  });

  test("a failing migration rolls back everything in the run", async () => {
    folder([
      ONE,
      {
        ...TWO,
        sql: "CREATE TABLE b (y integer);\n--> statement-breakpoint\nINSERT INTO nope VALUES (1);",
      },
    ]);
    await expect(applyMigrations(sql, dir)).rejects.toThrow();
    expect(
      await sql`SELECT name FROM sqlite_master WHERE name IN ('a', 'b')`,
    ).toHaveLength(0);
    expect(await states()).toEqual([
      "20260101000000_one:pending",
      "20260102000000_two:pending",
    ]);
  });

  test("the project's own migrations apply cleanly to an empty database", async () => {
    expect((await applyMigrations(sql, MIGRATIONS_DIR)).length).toBeGreaterThan(
      0,
    );
    const tables: { name: string }[] =
      await sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
    expect(tables.map((t) => t.name)).toEqual([
      "__drizzle_migrations",
      "admins",
      "conversation_events",
      "conversation_sessions",
      "transactions",
      "user_products",
      "users",
    ]);
    expect(
      (await migrationStatus(sql, MIGRATIONS_DIR)).every(
        (s) => s.state === "applied",
      ),
    ).toBe(true);
  });
});
