/** A migration file, as the migrator reads it. */
export interface MigrationRecord {
  /** The file name without `.sql`: `<timestamp>_<name>`. */
  tag: string;
  /** The journal's `when` (ms): what drizzle orders and records migrations by. */
  createdAt: number;
  /** sha256 of the file, as drizzle records it. */
  hash: string;
  statements: string[];
}

export type MigrationState =
  "applied" | "pending" | "modified" | "skipped" | "missing";

export interface MigrationStatus {
  tag: string;
  createdAt: number;
  state: MigrationState;
}
