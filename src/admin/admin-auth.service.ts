import { createHash, randomBytes } from "node:crypto";
import type { Cache } from "@kingsleyweb/bun-cache";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { InjectCache } from "@kingsleyweb/bun-nest/cache";
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { AdminsRepository } from "./admins.repository";
import type { AdminCacheSchema, AdminSession } from "./admin.interface";

export const ADMIN_CACHE = "admin";
export const ADMIN_COOKIE = "investnow_admin";
/** Where the cookie is sent: the admin UI, its API and the jobs dashboard, nothing else. */
export const ADMIN_PATH = "/admin";

const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_ACCOUNT = 5;
const MAX_FAILS_PER_IP = 20;

/** The session key is a hash of the token: the store never holds a usable token. */
const sessionKey = (token: string) =>
  `admin-session:${createHash("sha256").update(token).digest("hex")}` as const;

/**
 * Admin sign-in: email or username plus password, a random session token in
 * an HttpOnly, SameSite=Strict cookie scoped to /admin, and the session in the
 * bun-cache store (so it expires on its own). Failed attempts are counted per
 * account and per IP and locked out for 15 minutes past the limit.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  /** Verified against when the account doesn't exist, so a miss takes as long as a wrong password. */
  private readonly decoyHash = Bun.password.hash(
    randomBytes(16).toString("hex"),
  );

  constructor(
    @InjectCache(ADMIN_CACHE) private readonly cache: Cache<AdminCacheSchema>,
    private readonly admins: AdminsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(
    identifier: string,
    password: string,
    ip: string,
  ): Promise<{ token: string; session: AdminSession }> {
    const account =
      `login-fail:account:${identifier.trim().toLowerCase()}` as const;
    const peer = `login-fail:ip:${ip || "unknown"}` as const;
    // Read with get(): increment(key, 0) would create the counter without its expiry.
    const [accountFails = 0, ipFails = 0] = await Promise.all([
      this.cache.get(account),
      this.cache.get(peer),
    ]);
    if (accountFails >= MAX_FAILS_PER_ACCOUNT || ipFails >= MAX_FAILS_PER_IP) {
      throw new HttpException(
        "Too many failed sign-in attempts. Try again in 15 minutes.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const admin = await this.admins.findByIdentifier(identifier);
    const valid = await Bun.password.verify(
      password,
      admin?.passwordHash ?? (await this.decoyHash),
    );
    if (!admin || !valid) {
      await Promise.all([
        this.cache.increment(account, 1, { ttl: FAIL_WINDOW_MS }),
        this.cache.increment(peer, 1, { ttl: FAIL_WINDOW_MS }),
      ]);
      this.logger.warn(
        `Failed admin sign-in for "${identifier}" from ${ip || "unknown"}`,
      );
      throw new UnauthorizedException(
        "The email/username or password is incorrect.",
      );
    }

    await this.cache.delete(account);
    await this.admins.touchLogin(admin.id);
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const session: AdminSession = {
      adminId: admin.id,
      email: admin.email,
      username: admin.username,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.admin.sessionTtlMs).toISOString(),
    };
    await this.cache.set(sessionKey(token), session, {
      ttl: this.config.admin.sessionTtlMs,
    });
    this.logger.log(
      `Admin ${admin.username} signed in from ${ip || "unknown"}`,
    );
    return { token, session };
  }

  /** The signed-in admin for a request, or null. */
  async authenticate(req: BunRequest): Promise<AdminSession | null> {
    const token = req.cookies?.[ADMIN_COOKIE];
    if (typeof token !== "string" || !/^[\w-]{43}$/.test(token)) return null;
    return (await this.cache.get(sessionKey(token))) ?? null;
  }

  async logout(req: BunRequest): Promise<void> {
    const token = req.cookies?.[ADMIN_COOKIE];
    if (typeof token === "string" && token !== "")
      await this.cache.delete(sessionKey(token));
  }

  setCookie(res: BunResponse, token: string): void {
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.production,
      path: ADMIN_PATH,
      maxAge: this.config.admin.sessionTtlMs,
    });
  }

  clearCookie(res: BunResponse): void {
    res.clearCookie(ADMIN_COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.production,
      path: ADMIN_PATH,
    });
  }
}
