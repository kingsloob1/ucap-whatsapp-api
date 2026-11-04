import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit reads the model (src/database/schema.ts) and writes timestamped
 * SQL migrations into migrations/, with its snapshot of the model in
 * migrations/meta/. The app applies them itself (src/database/migrator.ts).
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/database/schema.ts",
  out: "./migrations",
  migrations: { prefix: "timestamp" },
  strict: true,
  verbose: true,
});
