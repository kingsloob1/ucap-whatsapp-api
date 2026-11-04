import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryDriver, sqliteDriver } from "@kingsleyweb/bun-cache";
import { BunCacheModule } from "@kingsleyweb/bun-nest/cache";
import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { ConversationService } from "./conversation.service";
import { SESSION_CACHE } from "./conversation.constants";

@Module({
  imports: [
    // Conversation state: one entry per WhatsApp id in <dataDir>/sessions.db,
    // expiring after SESSION_TTL_MS of inactivity (each message rewrites it).
    BunCacheModule.forRootAsync({
      name: SESSION_CACHE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.dataDir === ":memory:") {
          return {
            driver: memoryDriver(),
            namespace: "investnow",
            ttl: config.sessionTtlMs,
          };
        }
        mkdirSync(config.dataDir, { recursive: true });
        return {
          driver: sqliteDriver({ path: join(config.dataDir, "sessions.db") }),
          namespace: "investnow",
          ttl: config.sessionTtlMs,
        };
      },
    }),
  ],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
