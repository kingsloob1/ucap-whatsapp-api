import type {
  MessageBaseDto,
  VerifyQueryDto,
  WebhookPayloadDto,
} from "./webhook.dto";
import type { z } from "zod";

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export type OutboundMessage =
  | { kind: "text"; body: string }
  | {
      kind: "buttons";
      body: string;
      header?: string;
      footer?: string;
      buttons: ReplyButton[];
    }
  | {
      kind: "list";
      body: string;
      header?: string;
      footer?: string;
      button: string;
      sections: ListSection[];
    };

/** What the state machine reads from an inbound message. */
export interface InboundInput {
  /** The typed text, or the title of the button or row tapped. Empty for media. */
  text: string;
  /** The id of the tapped button or list row, when the message was a tap. */
  choiceId?: string;
}

/** A message that dry-run mode recorded instead of sending. */
export interface SentMessage {
  to: string;
  message: OutboundMessage;
  at: Date;
}

export type OriginSchema = {
  [key: `sigfail:${string}`]: number;
  [key: `sigblock:${string}`]: number;
};

export type WebhookMessage = z.infer<typeof MessageBaseDto>;

export type WebhookPayload = z.infer<typeof WebhookPayloadDto>;

export type VerifyQuery = z.output<typeof VerifyQueryDto>;

/** One inbound user message, flattened out of a webhook payload: what goes on the queue. */
export interface InboundMessage {
  /** The WhatsApp message id (`wamid.…`): the job id, so Meta's redeliveries are dropped. */
  messageId: string;
  /** The business phone number id the message was sent to. */
  phoneNumberId: string | null;
  waId: string;
  name?: string;
  /** Unix seconds, as Meta sends it. */
  timestamp: number;
  input: InboundInput;
}
