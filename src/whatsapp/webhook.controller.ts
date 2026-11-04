import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { Describe, Validate, ValidQuery } from "@kingsleyweb/bun-nest";
import {
  type CanActivate,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  type ExecutionContext,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { APP_CONFIG, type AppConfig } from "../config";
import { QueueService } from "../queue/queue.service";
import { clientIp } from "../security/client-ip";
import { WebhookOriginService } from "./webhook-origin.service";
import { isValidSignature, sameSecret } from "./signature";
import { extractMessages } from "./webhook.mapper";
import type { VerifyQuery } from "./whatsapp.interface";
import { VerifyQueryDto, WebhookPayloadDto } from "./webhook.dto";

/**
 * Rejects a delivery whose `X-Hub-Signature-256` doesn't match the raw body,
 * and any delivery from an address blocked for sending bad signatures.
 * Without an app secret (dev only; production refuses to start) nothing is checked.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  private warned = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly origin: WebhookOriginService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = this.config.whatsapp.appSecret;
    if (secret === "") {
      if (!this.warned) {
        this.logger.warn(
          "WHATSAPP_APP_SECRET is not set: webhook signatures are NOT being checked",
        );
        this.warned = true;
      }
      return true;
    }
    const req = context.switchToHttp().getRequest<RawBodyRequest<BunRequest>>();
    const ip = clientIp(req, this.config.trustedProxies);
    if (await this.origin.isBlocked(ip))
      throw new ForbiddenException("Blocked");

    const header = req.headers["x-hub-signature-256"];
    const rawBody = req.rawBody;
    if (
      !rawBody ||
      !isValidSignature(
        rawBody,
        typeof header === "string" ? header : undefined,
        secret,
      )
    ) {
      await this.origin.recordFailure(ip, "an invalid signature");
      throw new UnauthorizedException("Invalid webhook signature");
    }
    return true;
  }
}

/** Meta's endpoint: left out of the typed client, which only the chat UI uses. */
@Controller("webhook")
@Describe({ hidden: true })
@SkipThrottle()
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: QueueService,
    private readonly origin: WebhookOriginService,
  ) {}

  /** Meta's verification handshake when the webhook URL is registered. */
  @Get()
  @Validate({ query: VerifyQueryDto })
  async verify(
    @ValidQuery() query: VerifyQuery,
    @Req() req: BunRequest,
    @Res({ passthrough: true }) res: BunResponse,
  ): Promise<string> {
    const ip = clientIp(req, this.config.trustedProxies);
    if (await this.origin.isBlocked(ip))
      throw new ForbiddenException("Blocked");
    const expected = this.config.whatsapp.verifyToken;
    if (
      query.mode !== "subscribe" ||
      expected === "" ||
      !sameSecret(query.verify_token, expected)
    ) {
      await this.origin.recordFailure(ip, "a wrong verify token");
      throw new ForbiddenException("Verification failed");
    }
    res.type("text/plain");
    return query.challenge;
  }

  /**
   * A delivery: messages are queued and answered by the worker, so this
   * returns at once (Meta redelivers anything not acknowledged quickly).
   * A body this service can't read is still acknowledged, or Meta would
   * redeliver it for days.
   */
  @Post()
  @HttpCode(200)
  @UseGuards(WebhookSignatureGuard)
  async receive(
    @Req() req: RawBodyRequest<BunRequest>,
  ): Promise<{ received: number; queued: number }> {
    const payload = WebhookPayloadDto.safeParse(req.body);
    if (!payload.success) {
      this.logger.warn(
        `Ignoring an unreadable webhook body: ${payload.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`,
      );
      return { received: 0, queued: 0 };
    }
    const problem = this.origin.payloadProblem(payload.data);
    if (problem) {
      // Signed, but not for us: acknowledged so it isn't redelivered, never processed.
      this.logger.warn(`Ignoring a webhook delivery: ${problem}`);
      return { received: 0, queued: 0 };
    }
    const messages = this.origin.filterMessages(extractMessages(payload.data));
    const queued =
      messages.length > 0 ? await this.queues.enqueueInbound(messages) : 0;
    return { received: messages.length, queued };
  }
}
