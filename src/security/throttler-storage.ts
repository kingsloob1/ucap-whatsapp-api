import type { Cache } from "@kingsleyweb/bun-cache";
import type {
  BunRequest,
  BunResponse,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { InjectCache } from "@kingsleyweb/bun-nest/cache";
import { Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type {
  ThrottleSchema,
  ThrottlerStorageRecord,
} from "./security.interface";

export const SECURITY_CACHE = "security";

/**
 * `@nestjs/throttler`'s storage on bun-cache (`<dataDir>/security.db`): fixed
 * windows from bun-cache counters, and blocks that outlive a restart and are
 * shared by every process on the host.
 */
@Injectable()
export class BunCacheThrottlerStorage implements ThrottlerStorage {
  constructor(
    @InjectCache(SECURITY_CACHE) private readonly cache: Cache<ThrottleSchema>,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const id = `${throttlerName}:${key}`;
    const now = Date.now();

    const blockedUntil = await this.cache.get(`block:${id}`);
    if (blockedUntil !== undefined && blockedUntil > now) {
      const left = Math.ceil((blockedUntil - now) / 1000);
      return {
        totalHits: limit + 1,
        timeToExpire: left,
        isBlocked: true,
        timeToBlockExpire: left,
      };
    }

    // The counter's TTL is set when it is created, so this is a fixed window.
    const totalHits = await this.cache.increment(`hits:${id}`, 1, { ttl });
    let windowEnds = await this.cache.get(`window:${id}`);
    if (totalHits === 1 || windowEnds === undefined) {
      windowEnds = now + ttl;
      await this.cache.set(`window:${id}`, windowEnds, { ttl });
    }
    const timeToExpire = Math.max(0, Math.ceil((windowEnds - now) / 1000));

    if (totalHits > limit) {
      const block = blockDuration > 0 ? blockDuration : ttl;
      await this.cache.set(`block:${id}`, now + block, { ttl: block });
      // The next window starts after the block.
      await this.cache.delete(`hits:${id}`);
      return {
        totalHits,
        timeToExpire,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(block / 1000),
      };
    }
    return { totalHits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
  }
}

/**
 * The same limits for routes mounted below Nest (the jobs dashboard and API),
 * where Nest guards do not run: a router middleware answering 429.
 */
export function rateLimitMiddleware(
  storage: ThrottlerStorage,
  options: {
    name: string;
    limit: number;
    ttl: number;
    blockDuration?: number;
    tracker: (req: BunRequest) => string;
  },
): RouterHandler {
  return async (req: BunRequest, res: BunResponse, next) => {
    const record = await storage.increment(
      options.tracker(req),
      options.ttl,
      options.limit,
      options.blockDuration ?? 0,
      options.name,
    );
    if (!record.isBlocked) return next();
    res
      .status(429)
      .setHeader("retry-after", String(record.timeToBlockExpire))
      .json({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Too many requests. Try again later.",
      });
  };
}
