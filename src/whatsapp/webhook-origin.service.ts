import type { Cache } from "@kingsleyweb/bun-cache";
import { InjectCache } from "@kingsleyweb/bun-nest/cache";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { SECURITY_CACHE } from "../security/throttler-storage";
import type {
  InboundMessage,
  OriginSchema,
  WebhookPayload,
} from "./whatsapp.interface";

/** Bad signatures from one address within the window before it is blocked. */
const MAX_BAD_SIGNATURES = 10;
const BAD_SIGNATURE_WINDOW_MS = 10 * 60_000;
const BLOCK_MS = 60 * 60_000;
/** Clock skew allowed for a message timestamp in the future. */
const MAX_FUTURE_SKEW_S = 5 * 60;

/**
 * Decides whether a webhook delivery really comes from our WhatsApp business
 * number, instead of throttling it:
 *
 * 1. the `X-Hub-Signature-256` HMAC over the raw body, keyed with the app
 *    secret (checked by the guard), with an address that keeps sending bad
 *    signatures blocked for an hour before its body is even hashed;
 * 2. the payload names our business account (`entry[].id`) and our phone
 *    number (`metadata.phone_number_id`), as `whatsapp_business_account` /
 *    `whatsapp`;
 * 3. each message is fresh (not older than the allowed age, not from the
 *    future) and from a plausible sender id; replays inside the window are
 *    already dropped by the inbound queue's job ids.
 */
@Injectable()
export class WebhookOriginService {
  private readonly logger = new Logger("WebhookOrigin");

  constructor(
    @InjectCache(SECURITY_CACHE) private readonly cache: Cache<OriginSchema>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async isBlocked(ip: string): Promise<boolean> {
    const until = await this.cache.get(`sigblock:${ip}`);
    return until !== undefined && until > Date.now();
  }

  /** Counts a failed proof of origin (a bad signature, a wrong verify token) against an address. */
  async recordFailure(ip: string, what: string): Promise<void> {
    const count = await this.cache.increment(`sigfail:${ip}`, 1, {
      ttl: BAD_SIGNATURE_WINDOW_MS,
    });
    this.logger.warn(
      `Webhook request with ${what} from ${ip || "unknown"} (${count} in 10 min)`,
    );
    if (count >= MAX_BAD_SIGNATURES) {
      await this.cache.set(`sigblock:${ip}`, Date.now() + BLOCK_MS, {
        ttl: BLOCK_MS,
      });
      await this.cache.delete(`sigfail:${ip}`);
      this.logger.warn(
        `Blocking webhook deliveries from ${ip} for an hour after ${count} failed checks`,
      );
    }
  }

  /**
   * Whether a signed payload is addressed to us. Answers the reason it isn't,
   * or null. A delivery for another account means a leaked app secret or a
   * misrouted webhook; either way it must not reach the state machine.
   */
  payloadProblem(payload: WebhookPayload): string | null {
    if (payload.object !== "whatsapp_business_account")
      return `object is "${payload.object}"`;
    const { businessAccountId, phoneNumberId } = this.config.whatsapp;
    for (const entry of payload.entry) {
      if (businessAccountId && entry.id !== businessAccountId)
        return `business account ${entry.id} is not ours`;
      for (const change of entry.changes) {
        if (
          change.value.messaging_product !== undefined &&
          change.value.messaging_product !== "whatsapp"
        ) {
          return "messaging_product is not whatsapp";
        }
        const to = change.value.metadata?.phone_number_id;
        if (phoneNumberId && to !== undefined && to !== phoneNumberId)
          return `phone number ${to} is not ours`;
        if (phoneNumberId && to === undefined && change.value.messages?.length)
          return "messages without a phone number id";
      }
    }
    return null;
  }

  /** The messages worth answering: fresh, from a plausible sender. The rest are logged and dropped. */
  filterMessages(
    messages: InboundMessage[],
    nowSeconds = Math.floor(Date.now() / 1000),
  ): InboundMessage[] {
    const maxAge = this.config.whatsapp.maxMessageAgeSeconds;
    return messages.filter((m) => {
      if (!/^\d{7,15}$/.test(m.waId)) {
        this.logger.warn(
          `Dropping message ${m.messageId}: sender "${m.waId}" is not a WhatsApp id`,
        );
        return false;
      }
      if (m.timestamp > nowSeconds + MAX_FUTURE_SKEW_S) {
        this.logger.warn(
          `Dropping message ${m.messageId}: timestamp is in the future`,
        );
        return false;
      }
      if (maxAge > 0 && nowSeconds - m.timestamp > maxAge) {
        this.logger.warn(
          `Dropping message ${m.messageId}: ${nowSeconds - m.timestamp}s old (max ${maxAge}s)`,
        );
        return false;
      }
      return true;
    });
  }
}
