import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { toGraphPayload, toPlainText } from "./messages";
import type { OutboundMessage, SentMessage } from "./whatsapp.interface";

/** A send the Cloud API refused for a reason retrying won't fix (bad token, invalid recipient, bad payload). */
export class PermanentSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Sends messages through the WhatsApp Cloud API (`POST /{phone-number-id}/messages`).
 * Without an access token or phone number id it runs dry: it logs each message
 * and keeps the last 200 in {@link sent}.
 */
@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);
  readonly sent: SentMessage[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.whatsapp.dryRun) {
      this.logger.warn(
        "WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set: replies are logged, not sent",
      );
    }
  }

  get dryRun(): boolean {
    return this.config.whatsapp.dryRun;
  }

  /** Sends one message; answers the WhatsApp message id (`dry-run` in dry-run mode). */
  async send(
    to: string,
    message: OutboundMessage,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.dryRun) {
      this.sent.push({ to, message, at: new Date() });
      if (this.sent.length > 200) this.sent.shift();
      this.logger.log(`[dry-run] → ${to}\n${toPlainText(message)}`);
      return "dry-run";
    }

    const { graphApiVersion, phoneNumberId, accessToken } =
      this.config.whatsapp;
    const response = await fetch(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          toGraphPayload(to, message, this.config.whatsapp.flows),
        ),
        signal: signal ?? AbortSignal.timeout(15_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number };
    };
    if (response.ok) return body.messages?.[0]?.id ?? "unknown";

    const reason = `WhatsApp API ${response.status}: ${body.error?.message ?? response.statusText} (code ${body.error?.code ?? "?"})`;
    // 429 and 5xx are worth retrying; any other 4xx will fail the same way again.
    if (response.status === 429 || response.status >= 500)
      throw new Error(reason);
    throw new PermanentSendError(reason, response.status);
  }
}
