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

export type SessionEvent = Omit<
  typeof conversationEvents.$inferSelect,
  "waId" | "source"
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
}

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
