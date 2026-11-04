import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryDriver, sqliteDriver } from "@kingsleyweb/bun-cache";
import type {
  BunRequest,
  BunResponse,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { BunJobs, type JobsApi } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { BunCacheModule } from "@kingsleyweb/bun-nest/cache";
import { BunJobsApiModule, InjectJobsApi } from "@kingsleyweb/bun-nest/jobs";
import {
  Controller,
  Get,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleInit,
  Res,
} from "@nestjs/common";
import { Describe } from "@kingsleyweb/bun-nest";
import { HttpAdapterHost } from "@nestjs/core";
import { APP_CONFIG, type AppConfig } from "../config";
import { ConversationModule } from "../conversation/conversation.module";
import { clientIp } from "../security/client-ip";
import {
  BunCacheThrottlerStorage,
  rateLimitMiddleware,
} from "../security/throttler-storage";
import { ADMIN_CACHE, AdminAuthService } from "./admin-auth.service";
import { AdminController, AdminGuard } from "./admin.controller";
import { AdminsRepository } from "./admins.repository";

export const JOBS_API_PATH = "/admin/jobs-api";
export const JOBS_UI_PATH = "/admin/jobs";
/** Where `bun run ui:build` puts the admin UI; served under /admin/static. */
export const ADMIN_UI_DIR = join(import.meta.dir, "..", "..", "dist", "admin");

/** Sign-in: admin accounts and their sessions, in a bun-cache store of their own. */
@Module({
  imports: [
    BunCacheModule.forRootAsync({
      name: ADMIN_CACHE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.dataDir === ":memory:")
          return { driver: memoryDriver(), namespace: "investnow-admin" };
        mkdirSync(config.dataDir, { recursive: true });
        return {
          driver: sqliteDriver({ path: join(config.dataDir, "admin.db") }),
          namespace: "investnow-admin",
        };
      },
    }),
  ],
  providers: [AdminsRepository, AdminAuthService, AdminGuard],
  exports: [AdminsRepository, AdminAuthService, AdminGuard],
})
export class AdminAuthModule {}

/** The admin UI's page: a single-page app, so every /admin page is the same shell. */
@Controller("admin")
@Describe({ hidden: true })
class AdminPageController {
  @Get()
  page(@Res() res: BunResponse) {
    const file = join(ADMIN_UI_DIR, "admin.html");
    if (!existsSync(file)) {
      res
        .status(503)
        .type("text/plain")
        .send(
          "The admin UI isn't built yet: run `bun run ui:build`, or run the API in development (`bun run dev`), which serves it from source.",
        );
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.sendFile(file);
  }
}

/**
 * The admin area:
 *
 * - `/admin`: the admin UI (sign-in, conversations), and its API at `/admin/api`;
 * - `/admin/jobs`: bun-jobs-ui, the queues dashboard, over the bun-jobs
 *   management API at `/admin/jobs-api`. Both are refused without an admin session.
 */
@Module({
  imports: [
    AdminAuthModule,
    ConversationModule,
    BunJobsApiModule.forRootAsync({
      imports: [AdminAuthModule],
      inject: [BunJobs, AdminAuthService, BunCacheThrottlerStorage, APP_CONFIG],
      useFactory: (
        jobs: BunJobs,
        auth: AdminAuthService,
        storage: BunCacheThrottlerStorage,
        config: AppConfig,
      ) => ({
        jobs,
        basePath: JOBS_API_PATH,
        // Mounted below Nest, so the throttler guard doesn't reach it: the same limit as a middleware.
        middleware: [
          rateLimitMiddleware(storage, {
            name: "jobs-api",
            limit: 300,
            ttl: 60_000,
            tracker: (req) => clientIp(req, config.trustedProxies),
          }),
        ],
        authorize: async (req: BunRequest) =>
          (await auth.authenticate(req))
            ? true
            : {
                allow: false as const,
                status: 401 as const,
                reason: "Sign in at /admin",
              },
      }),
    }),
  ],
  controllers: [AdminController, AdminPageController],
})
export class AdminModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger("Admin");

  constructor(
    @InjectJobsApi() private readonly jobsApi: JobsApi,
    private readonly adapterHost: HttpAdapterHost,
    private readonly auth: AdminAuthService,
    private readonly admins: AdminsRepository,
    private readonly throttle: BunCacheThrottlerStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Mounts the jobs dashboard; BunJobsApiModule has mounted its API by now (imported modules initialise first). */
  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    if (!(adapter instanceof BunHttpAdapter))
      throw new TypeError("The admin area needs bun-nest's BunHttpAdapter");
    const ui = jobsUi({
      api: this.jobsApi,
      basePath: JOBS_UI_PATH,
      title: "InvestNow jobs",
      // Not signed in: to the sign-in page, which comes back here afterwards.
      middleware: [
        rateLimitMiddleware(this.throttle, {
          name: "jobs-ui",
          limit: 120,
          ttl: 60_000,
          tracker: (req) => clientIp(req, this.config.trustedProxies),
        }),
        this.redirectToSignIn,
      ],
      authorize: async (req) =>
        (await this.auth.authenticate(req))
          ? true
          : { allow: false, status: 401 },
    });
    adapter.getInstance().use(ui.basePath, ui.router);
  }

  private readonly redirectToSignIn: RouterHandler = async (req, res, next) => {
    if (await this.auth.authenticate(req)) return next();
    res.redirect(
      302,
      `/admin/?next=${encodeURIComponent(req.originalUrl || JOBS_UI_PATH)}`,
    );
  };

  async onApplicationBootstrap(): Promise<void> {
    const seed = this.config.admin.seed;
    if (seed) {
      const admin = await this.admins.upsert(seed);
      this.logger.log(
        `Admin "${admin.username}" <${admin.email}> is ready (from ADMIN_* settings)`,
      );
    } else if ((await this.admins.count()) === 0) {
      this.logger.warn(
        "No admin accounts yet: set ADMIN_EMAIL, ADMIN_USERNAME and ADMIN_PASSWORD, or run `bun run admin:create`",
      );
    }
  }
}
