import type { SessionSource } from "../database/sessions.interface";
import type { FlowName } from "../flows/flows.interface";
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
    }
  | {
      /**
       * A WhatsApp Flow: a form that opens over the chat. What the user enters
       * goes to the Flow endpoint, encrypted, and never appears as a chat message.
       */
      kind: "flow";
      body: string;
      header?: string;
      footer?: string;
      /** The button that opens the form (20 characters). */
      cta: string;
      flow: FlowName;
      /** Ties the form's requests to this conversation (`flow:<token>` in the session cache). */
      token: string;
    };

/** What the state machine reads from an inbound message. */
export interface InboundInput {
  /** The typed text, or the title of the button or row tapped. Empty for media. */
  text: string;
  /** The id of the tapped button or list row, when the message was a tap. */
  choiceId?: string;
  /**
   * Set on the message the Flow endpoint queues when a form is finished: the
   * form's token. Its `text` is the user's last answer, already masked.
   */
  flowToken?: string;
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
  /** Where it came from: a WhatsApp webhook (the default) or the chat simulator. */
  source?: SessionSource;
}
