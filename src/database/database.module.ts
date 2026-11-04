import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { SQL } from "bun";
import { APP_CONFIG, type AppConfig } from "../config";
import { APP_DB, openAppDatabase } from "./database";
import { SessionsRepository } from "./sessions.repository";
import { UsersRepository } from "./users.repository";

@Global()
@Module({
  providers: [
    {
      provide: APP_DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => openAppDatabase(config.dataDir),
    },
    UsersRepository,
    SessionsRepository,
  ],
  exports: [APP_DB, UsersRepository, SessionsRepository],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(APP_DB) private readonly sql: SQL) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sql.close();
  }
}
