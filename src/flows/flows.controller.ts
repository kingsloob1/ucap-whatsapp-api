import type { KeyObject } from "node:crypto";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { Describe } from "@kingsleyweb/bun-nest";
import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { APP_CONFIG, type AppConfig } from "../config";
import { clientIp } from "../security/client-ip";
import { isValidSignature } from "../whatsapp/signature";
import { WebhookOriginService } from "../whatsapp/webhook-origin.service";
import {
  decryptFlowRequest,
  encryptFlowResponse,
  FlowDecryptError,
  loadPrivateKey,
} from "./flow-crypto";
import { FlowExchangeService, FlowTokenError } from "./flow-exchange.service";
import { EncryptedFlowBodyDto, FlowRequestDto } from "./flows.dto";

/** WhatsApp's status codes for the Flow endpoint. */
const DECRYPT_FAILED = 421; // WhatsApp refetches the public key and retries
const TOKEN_INVALID = 427; // the form is closed with an error
const SIGNATURE_FAILED = 432;

/**
 * The WhatsApp Flow endpoint (data API 3.0), set as the endpoint URI of each
 * Flow: `https://<host>/flows`. Like the webhook it isn't throttled; it is
 * protected by Meta's `X-Hub-Signature-256` (app secret) and by encryption to
 * our public key. Left out of the typed client.
 */
@Controller("flows")
@Describe({ hidden: true })
@SkipThrottle()
export class FlowsController {
  private readonly logger = new Logger(FlowsController.name);
  private readonly privateKey: KeyObject | null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly exchange: FlowExchangeService,
    private readonly origin: WebhookOriginService,
  ) {
    const { privateKey, privateKeyPassphrase } = config.whatsapp.flows;
    this.privateKey = privateKey
      ? loadPrivateKey(privateKey, privateKeyPassphrase)
      : null;
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<BunRequest>,
    @Res({ passthrough: true }) res: BunResponse,
  ): Promise<string> {
    if (!this.privateKey)
      throw new ServiceUnavailableException("Flows are not configured");

    const ip = clientIp(req, this.config);
    if (await this.origin.isBlocked(ip))
      throw new ForbiddenException("Blocked");
    const secret = this.config.whatsapp.appSecret;
    if (secret) {
      const header = req.headers["x-hub-signature-256"];
      if (
        !req.rawBody ||
        !isValidSignature(
          req.rawBody,
          typeof header === "string" ? header : undefined,
          secret,
        )
      ) {
        await this.origin.recordFailure(ip, "an invalid Flow signature");
        throw new HttpException("Invalid signature", SIGNATURE_FAILED);
      }
    }

    const body = EncryptedFlowBodyDto.safeParse(req.body);
    if (!body.success)
      throw new HttpException("Unreadable Flow request", DECRYPT_FAILED);
    let decrypted: ReturnType<typeof decryptFlowRequest>;
    try {
      decrypted = decryptFlowRequest(body.data, this.privateKey);
    } catch (error) {
      if (!(error instanceof FlowDecryptError)) throw error;
      this.logger.warn(
        `A Flow request couldn't be decrypted: ${error.message}`,
      );
      throw new HttpException("Decryption failed", DECRYPT_FAILED);
    }
    const request = FlowRequestDto.safeParse(decrypted.body);
    if (!request.success)
      throw new HttpException("Unreadable Flow request", DECRYPT_FAILED);

    try {
      const response = await this.exchange.exchange(request.data);
      res.type("text/plain");
      return encryptFlowResponse(response, decrypted.aesKey, decrypted.iv);
    } catch (error) {
      if (error instanceof FlowTokenError)
        throw new HttpException(error.message, TOKEN_INVALID);
      throw error;
    }
  }
}
