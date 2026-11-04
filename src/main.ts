import "reflect-metadata";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { type INestApplication, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ADMIN_UI_DIR } from "./admin/admin.module";
import { AppModule } from "./app.module";
import { adapterRef } from "./dev/ui-document";
import { type AppConfig, loadConfig } from "./config";

/** Builds the application without listening: shared by `main` and the tests. */
export async function createApp(
  config: AppConfig,
  options: { quiet?: boolean } = {},
): Promise<INestApplication> {
  // rawBody keeps the exact bytes Meta signed, for the X-Hub-Signature-256 check.
  const adapter = new BunHttpAdapter(30_000, {
    // bun-nest has no default body cap: WhatsApp deliveries are small, 1 MB is generous.
    request: { parseBody: { maxContentLength: "1mb" }, parseCookies: true },
    server: { maxRequestBodySize: 2 * 1024 * 1024 },
  });
  adapterRef.current = adapter;
  const app = await NestFactory.create(AppModule.forRoot(config), adapter, {
    rawBody: true,
    logger: options.quiet
      ? false
      : config.production
        ? ["log", "warn", "error"]
        : ["log", "warn", "error", "debug"],
  });
  app.enableShutdownHooks();

  // The built admin UI's assets (its page is served by the admin module).
  if (existsSync(ADMIN_UI_DIR)) {
    adapter.useStaticAssets(ADMIN_UI_DIR, {
      prefix: "/admin/static",
      dotfiles: "deny",
      index: false,
    });
  }

  // The built chat UI (`bun run ui:build`), beside the dev routes it calls.
  const chatUi = join(import.meta.dir, "..", "dist", "ui");
  if (config.enableDevRoutes && existsSync(join(chatUi, "index.html"))) {
    adapter.useStaticAssets(chatUi, { prefix: "/chat", dotfiles: "deny" });
  }
  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
  const logger = new Logger("Bootstrap");
  logger.log(`InvestNow WhatsApp service listening on ${await app.getUrl()}`);
  logger.log(
    `Webhook: ${await app.getUrl()}/webhook${config.enableDevRoutes ? " · Dev simulator: POST /dev/simulate" : ""}`,
  );
}
