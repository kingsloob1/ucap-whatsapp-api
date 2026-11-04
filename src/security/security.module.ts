import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryDriver, sqliteDriver } from "@kingsleyweb/bun-cache";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { BunCacheModule } from "@kingsleyweb/bun-nest/cache";
import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_CONFIG, type AppConfig } from "../config";
import { WebhookOriginService } from "../whatsapp/webhook-origin.service";
import { clientIp } from "./client-ip";
import { BunCacheThrottlerStorage, SECURITY_CACHE } from "./throttler-storage";

/** Counters for rate limits and blocks, in `<dataDir>/security.db`. */
@Global()
@Module({
  imports: [
    BunCacheModule.forRootAsync({
      name: SECURITY_CACHE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.dataDir === ":memory:")
          return { driver: memoryDriver(), namespace: "investnow-security" };
        mkdirSync(config.dataDir, { recursive: true });
        return {
          driver: sqliteDriver({ path: join(config.dataDir, "security.db") }),
          namespace: "investnow-security",
        };
      },
    }),
  ],
  providers: [BunCacheThrottlerStorage, WebhookOriginService],
  exports: [BunCacheThrottlerStorage, WebhookOriginService],
})
class SecurityStoreModule {}

/**
 * Rate limits on every Nest route (`@nestjs/throttler`, a global guard), keyed
 * by client address, with tighter limits on the routes worth abusing (sign-in,
 * the simulator). The webhook skips them: it is protected by proof of origin
 * instead (see WebhookOriginService).
 */
@Module({
  imports: [
    SecurityStoreModule,
    ThrottlerModule.forRootAsync({
      imports: [SecurityStoreModule],
      inject: [APP_CONFIG, BunCacheThrottlerStorage],
      useFactory: (config: AppConfig, storage: BunCacheThrottlerStorage) => ({
        throttlers: [{ name: "default", ttl: 60_000, limit: 120 }],
        storage,
        getTracker: (req: Record<string, unknown>) =>
          clientIp(req as unknown as BunRequest, config.trustedProxies),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  exports: [SecurityStoreModule],
})
export class SecurityModule {}
