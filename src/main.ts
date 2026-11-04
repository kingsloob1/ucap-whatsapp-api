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

const UI_DIR = join(import.meta.dir, "..", "ui");

/**
 * In development, the API serves the chat and admin UIs from source: Bun
 * bundles ui/index.html and ui/admin.html on request, with hot reload, as
 * native routes ahead of Nest. One port, same origin as the API, no proxy.
 * In production (and wherever the source isn't there) the built dist/ is
 * served instead; the UI source and React are never loaded.
 */
async function uiSourceRoutes(
  config: AppConfig,
): Promise<Record<string, unknown> | undefined> {
  if (config.production || !config.enableDevRoutes) return undefined;
  if (
    !existsSync(join(UI_DIR, "index.html")) ||
    !existsSync(join(UI_DIR, "admin.html"))
  )
    return undefined;
  const [{ default: chat }, { default: admin }] = await Promise.all([
    import("../ui/index.html"),
    import("../ui/admin.html"),
  ]);
  return {
    "/": Response.redirect("/chat", 302),
    "/chat": chat,
    "/chat/": chat,
    "/admin": admin,
    "/admin/": admin,
  };
}

/** Builds the application without listening: shared by `main`, the tests and the scripts. */
export async function createApp(
  config: AppConfig,
  /** `uiSource: false` skips serving the UIs from source (the tests and the OpenAPI export). */
  options: { quiet?: boolean; uiSource?: boolean } = {},
): Promise<INestApplication> {
  const routes =
    options.uiSource === false ? undefined : await uiSourceRoutes(config);
  // rawBody keeps the exact bytes Meta signed, for the X-Hub-Signature-256 check.
  const adapter = new BunHttpAdapter(30_000, {
    // bun-nest has no default body cap: WhatsApp deliveries are small, 1 MB is generous.
    request: { parseBody: { maxContentLength: "1mb" }, parseCookies: true },
    server: {
      maxRequestBodySize: 2 * 1024 * 1024,
      ...(routes ? { routes: routes as never } : {}),
    },
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

  // The built chat UI (`bun run ui:build`), beside the dev routes it calls,
  // when it isn't being served from source.
  const chatUi = join(import.meta.dir, "..", "dist", "ui");
  if (
    !routes &&
    config.enableDevRoutes &&
    existsSync(join(chatUi, "index.html"))
  ) {
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
  const url = await app.getUrl();
  logger.log(
    `Webhook: ${url}/webhook · Admin: ${url}/admin/ · Jobs: ${url}/admin/jobs/`,
  );
  if (config.enableDevRoutes)
    logger.log(`Chat simulator: ${url}/chat (hot reload in development)`);
}
