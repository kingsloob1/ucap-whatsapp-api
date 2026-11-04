/**
 * Database migrations for investnow.db.
 *
 *   bun run db:generate -- --name add_kyc   writes a timestamped migration from the model (drizzle-kit)
 *   bun run db:status                       every migration: applied, pending, modified, skipped, missing
 *   bun run db:migrate                      applies the pending ones
 *   bun run db:check                        fails if the model has changes no migration covers
 *
 * `status` and `migrate` use DATA_DIR, like the app.
 */
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { connectAppDatabase } from "../src/database/database";
import {
  applyMigrations,
  MIGRATIONS_DIR,
  migrationStatus,
} from "../src/database/migrator";

const command = process.argv[2];

const MARK: Record<string, string> = {
  applied: "✓ applied ",
  pending: "• pending ",
  modified: "✗ modified",
  skipped: "✗ skipped ",
  missing: "✗ missing ",
};

async function status(): Promise<number> {
  const config = loadConfig();
  const sql = await connectAppDatabase(config.dataDir);
  try {
    const rows = await migrationStatus(sql);
    console.log(`investnow.db in ${config.dataDir}\n`);
    for (const row of rows) {
      console.log(
        `  ${MARK[row.state]}  ${row.tag}  (${new Date(row.createdAt).toISOString()})`,
      );
    }
    const counts = Object.groupBy(rows, (r) => r.state);
    console.log(
      `\n${counts.applied?.length ?? 0} applied, ${counts.pending?.length ?? 0} pending` +
        (rows.some((r) => !["applied", "pending"].includes(r.state))
          ? ", and problems above"
          : ""),
    );
    return rows.some((r) => !["applied", "pending"].includes(r.state)) ? 1 : 0;
  } finally {
    await sql.close();
  }
}

async function migrate(): Promise<number> {
  const config = loadConfig();
  const sql = await connectAppDatabase(config.dataDir);
  try {
    const applied = await applyMigrations(sql);
    console.log(
      applied.length
        ? `Applied: ${applied.join(", ")}`
        : "Nothing to apply: investnow.db is up to date.",
    );
    return 0;
  } finally {
    await sql.close();
  }
}

/**
 * Runs drizzle-kit generate against a copy of migrations/: any new file means
 * the model drifted. drizzle-kit is run inside the copy with relative paths
 * (it prefixes `./` to an absolute `out`), and only its explicit "No schema
 * changes" counts as a pass: it can fail and still exit 0.
 */
async function check(): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "investnow-db-check-"));
  try {
    cpSync(MIGRATIONS_DIR, join(work, "migrations"), { recursive: true });
    const before = new Set(readdirSync(join(work, "migrations")));
    writeFileSync(
      join(work, "drizzle.config.ts"),
      `export default ${JSON.stringify({
        dialect: "sqlite",
        schema: relative(work, resolve("src/database/schema.ts")),
        out: "./migrations",
        migrations: { prefix: "timestamp" },
      })};\n`,
    );
    const run = Bun.spawnSync(
      [process.execPath, "x", "drizzle-kit", "generate"],
      {
        cwd: work,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_PATH: resolve("node_modules") },
      },
    );
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    const added = readdirSync(join(work, "migrations")).filter(
      (f) => !before.has(f),
    );
    if (added.length > 0) {
      console.error(
        "The model (src/database/schema.ts) has changes no migration covers: run `bun run db:generate -- --name <what>`.\n" +
          `Would add: ${added.join(", ")}`,
      );
      return 1;
    }
    if (run.exitCode !== 0 || !/No schema changes/i.test(output)) {
      console.error(
        `drizzle-kit didn't confirm the model is covered:\n${output}`,
      );
      return 2;
    }
    console.log("Migrations cover the model.");
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const commands: Record<string, () => Promise<number>> = {
  status,
  migrate,
  check,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.error("Usage: bun scripts/db.ts <status|migrate|check>");
  process.exit(2);
}
process.exit(await run());
