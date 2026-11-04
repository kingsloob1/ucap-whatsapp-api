/**
 * The API's OpenAPI document, built in process with no server listening, for
 * `bun-client generate --module` (`bun run ui:types:generate`, and
 * `bun run ui:types:check` in CI). The dev server's `/__bun/types` endpoint,
 * which `bun run ui:types` follows, serves the same document (src/dev/ui-document.ts).
 */
import "reflect-metadata";
import type { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { loadConfig } from "../src/config";
import { UI_ASYNCAPI, uiDocument } from "../src/dev/ui-document";
import { createApp } from "../src/main";

export default async function openapi() {
  const config = loadConfig({
    NODE_ENV: "development",
    DATA_DIR: ":memory:",
    ENABLE_DEV_ROUTES: "true",
  });
  const app = await createApp(config, { quiet: true, uiSource: false });
  await app.init();
  try {
    const adapter = app.getHttpAdapter() as unknown as BunHttpAdapter;
    return {
      openapi: uiDocument(adapter),
      asyncapi: structuredClone(UI_ASYNCAPI),
    };
  } finally {
    await app.close();
  }
}
