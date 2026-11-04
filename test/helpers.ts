import type { INestApplication } from "@nestjs/common";
import { type AppConfig, loadConfig } from "../src/config";
import { createApp } from "../src/main";

export const APP_SECRET = "test-app-secret";
export const VERIFY_TOKEN = "test-verify-token";

/** The app on in-memory stores, in dry-run mode, with the dev routes. */
export async function testApp(
  overrides: Record<string, string> = {},
): Promise<{ app: INestApplication; config: AppConfig }> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: ":memory:",
    ENABLE_DEV_ROUTES: "true",
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    ...overrides,
  });
  const app = await createApp(config, { quiet: true });
  return { app, config };
}

/** Polls until `check` answers true, or fails after `timeout` ms. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeout = 5_000,
): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Condition not met within ${timeout} ms`);
}
