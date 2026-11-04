/**
 * Creates an admin, or resets the password of the admin with that email.
 *
 *   bun run admin:create --email ops@example.com --username ops
 *
 * The password is read from ADMIN_PASSWORD, or asked for (twice). It needs 12+
 * characters mixing three of: lower case, upper case, digits, symbols.
 */
import "reflect-metadata";
import { parseArgs } from "node:util";
import {
  AdminsRepository,
  passwordProblem,
} from "../src/admin/admins.repository";
import { loadConfig } from "../src/config";
import { openAppDatabase } from "../src/database/database";

const { values } = parseArgs({
  options: { email: { type: "string" }, username: { type: "string" } },
  strict: true,
});
const email = values.email?.trim().toLowerCase();
const username = values.username?.trim();
if (!email || !username) {
  console.error(
    "Usage: bun run admin:create --email <email> --username <username>",
  );
  process.exit(2);
}

let password = process.env.ADMIN_PASSWORD ?? "";
if (!password) {
  password = prompt("Password:") ?? "";
  if ((prompt("Repeat the password:") ?? "") !== password) {
    console.error("The passwords don't match.");
    process.exit(1);
  }
}
const problem = passwordProblem(password, { email, username });
if (problem) {
  console.error(`The password ${problem}.`);
  process.exit(1);
}

const config = loadConfig();
const sql = await openAppDatabase(config.dataDir);
try {
  const admin = await new AdminsRepository(sql).upsert({
    email,
    username,
    password,
  });
  console.log(
    `Admin #${admin.id} "${admin.username}" <${admin.email}> is ready. Sign in at /admin.`,
  );
} finally {
  await sql.close();
}
