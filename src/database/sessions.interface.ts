import type { conversationEvents, conversationSessions } from "./schema";
import type {
  InboundInput,
  OutboundMessage,
} from "../whatsapp/whatsapp.interface";

/** Where a conversation came from: a real WhatsApp webhook, or the chat UI's simulator. */
export type SessionSource =
  (typeof conversationSessions.$inferSelect)["source"];

/** A `conversation_sessions` row (schema.ts), with whether the number has onboarded. */
export type SessionRecord = typeof conversationSessions.$inferSelect & {
  /** Whether this WhatsApp id has finished onboarding. */
  onboarded: boolean;
};

/** One logged message, as the admin's session view shows it. */
export type SessionEvent = Pick<
  typeof conversationEvents.$inferSelect,
  | "id"
  | "direction"
  | "stepBefore"
  | "stepAfter"
  | "text"
  | "choiceId"
  | "kind"
  | "at"
>;

export type SessionStatus = "active" | "ended" | "expired";

export interface ListSessionsQuery {
  source?: SessionSource;
  status?: SessionStatus;
  /** Matches the WhatsApp id or the profile name. */
  search?: string;
  limit: number;
  offset: number;
}

/** What one handled message did, for the log. */
export interface Exchange {
  waId: string;
  source: SessionSource;
  profileName?: string;
  phoneNumberId?: string | null;
  stepBefore: string | null;
  stepAfter: string | null;
  input: InboundInput;
  replies: OutboundMessage[];
  ttlMs: number;
  /** The inbound message's id; without one, the replies are recorded as delivered at once. */
  messageId?: string;
  /** The input text is already masked (a Flow answer): stored as given. */
  masked?: boolean;
  /** The event's kind: `text` for a chat message, `flow` for an answer given in a Flow. */
  inKind?: "text" | "flow";
}

/** One message of a conversation, as the simulator shows it. */
export type ConversationEntry =
  | {
      id: number;
      direction: "in";
      at: string;
      messageId: string | null;
      text: string;
      choiceId: string | null;
      /** Given in a WhatsApp Flow (a form), not typed in the chat. */
      form: boolean;
    }
  | {
      id: number;
      direction: "out";
      at: string;
      messageId: string | null;
      replyIndex: number;
      deliveredAt: string;
      message: OutboundMessage;
    };

export interface SessionRow {
  wa_id: string;
  source: SessionSource;
  profile_name: string | null;
  phone_number_id: string | null;
  step: string | null;
  started_at: string;
  last_activity_at: string;
  expires_at: string | null;
  message_count: number;
  ended_at: string | null;
  end_reason: string | null;
  onboarded: number;
}
