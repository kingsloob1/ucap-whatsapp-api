import { Describe, DevTypesModule, Validate } from "@kingsleyweb/bun-nest";
import {
  Controller,
  type DynamicModule,
  Get,
  Global,
  Module,
} from "@nestjs/common";
import { AdminModule } from "./admin/admin.module";
import { APP_CONFIG, type AppConfig } from "./config";
import { ConversationModule } from "./conversation/conversation.module";
import { DatabaseModule } from "./database/database.module";
import { DevController } from "./dev/dev.controller";
import { adapterRef, UI_ASYNCAPI, uiDocument } from "./dev/ui-document";
import { HealthResponseDto } from "./dev/dev.dto";
import type { HealthResponse } from "./dev/dev.interface";
import { JOBS_PROVIDER, QueueService } from "./queue/queue.service";
import { SecurityModule } from "./security/security.module";
import {
  WebhookController,
  WebhookSignatureGuard,
} from "./whatsapp/webhook.controller";
import { WhatsAppClient } from "./whatsapp/whatsapp.client";

@Controller()
@Describe({ tags: ["health"] })
class HealthController {
  @Get("health")
  @Validate({ responses: { 200: HealthResponseDto } })
  @Describe({ operationId: "health" })
  health(): HealthResponse {
    const now = new Date();
    return {
      status: "ok",
      serverTime: now.toISOString(),
      epochMs: now.getTime(),
    };
  }
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

/** The app's bun-jobs context, injectable everywhere by its class. */
@Global()
@Module({ providers: [JOBS_PROVIDER], exports: [JOBS_PROVIDER.provide] })
class JobsModule {}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        SecurityModule,
        JobsModule,
        ConversationModule,
        AdminModule,
        // The API's OpenAPI document at /__bun/types, followed by `bun-client watch`
        // so the chat UI's typed client is regenerated whenever a route changes.
        DevTypesModule.forRoot({
          enabled: config.enableDevRoutes && !config.production,
          openapi: () => {
            if (!adapterRef.current)
              throw new Error("The HTTP adapter isn't ready");
            return uiDocument(adapterRef.current);
          },
          asyncapi: () => structuredClone(UI_ASYNCAPI) as never,
        }),
      ],
      controllers: [
        HealthController,
        WebhookController,
        ...(config.enableDevRoutes ? [DevController] : []),
      ],
      providers: [WhatsAppClient, QueueService, WebhookSignatureGuard],
    };
  }
}
