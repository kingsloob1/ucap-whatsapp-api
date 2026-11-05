import type { SessionSource } from "../database/sessions.interface";
import type { FlowRef } from "../flows/flows.interface";
import type { User } from "../database/users.interface";
import type {
  InboundInput,
  OutboundMessage,
} from "../whatsapp/whatsapp.interface";

/** Who sent a message. */
export interface Contact {
  /** The WhatsApp id: the sender's phone number in international format, without `+`. */
  waId: string;
  /** The WhatsApp profile name, when the webhook carried one. */
  name?: string;
}

/** Where a message came from, for the admin's session log. */
export interface MessageMeta {
  source: SessionSource;
  /** The business phone number id a WhatsApp message was sent to. */
  phoneNumberId?: string | null;
  /**
   * The inbound message's id, when it came through the queue (`wamid.…` or
   * `sim.…`): its replies are then delivered by the outbound job. Without one
   * (the direct /dev/simulate path) they count as delivered at once.
   */
  messageId?: string;
}

/** What one step answers: the session to store (`null` ends it) and the replies to send. */
export interface Transition {
  next: Session | null;
  replies: OutboundMessage[];
}

export interface Context {
  contact: Contact;
  user: User | null;
  input: InboundInput;
  /** The tapped id, or the typed text, lower-cased and trimmed: what commands and choices are matched on. */
  answer: string;
  source: SessionSource;
}

/** A money action started from the menu, before its amount is known. */
export type TransactionType = "fund" | "withdraw" | "buy";

/** A money action waiting for the user's PIN. */
export type PendingAction =
  | { type: "fund"; amountKobo: number }
  | { type: "withdraw"; amountKobo: number }
  | { type: "buy"; productCode: string; amountKobo: number }
  | { type: "balance" };

/** Everything onboarding collects, held while the user reviews it before the account is created. */
export interface OnboardingDraft {
  bvn: string;
  /** ISO date (YYYY-MM-DD). */
  dateOfBirth: string;
  productCodes: string[];
  /** The PIN's argon2id hash: the PIN itself is never stored. */
  pinHash: string;
}

/**
 * The conversation state machine's states. A session is stored per WhatsApp id
 * in the bun-cache SQLite store, expires after the configured idle TTL, and
 * holds nothing secret: a PIN being set is kept only as its hash.
 */
export type Session =
  // Onboarding
  | { step: "onboarding_prompt" }
  // Onboarding in a WhatsApp Flow: each screen the endpoint accepts fills the
  // draft; `submitted` is set when the user confirms on the review screen.
  | {
      step: "onboarding_flow";
      flowToken: string;
      draft: Partial<OnboardingDraft>;
      submitted?: boolean;
    }
  | { step: "ask_bvn" }
  | { step: "ask_dob"; bvn: string }
  | { step: "select_products"; bvn: string; dateOfBirth: string }
  | {
      step: "set_pin";
      bvn: string;
      dateOfBirth: string;
      productCodes: string[];
    }
  | {
      step: "confirm_pin";
      bvn: string;
      dateOfBirth: string;
      productCodes: string[];
      pinHash: string;
    }
  // Onboarding review: every answer is shown, and any one of them can be changed
  // before the account is created. Each edit step returns to the review.
  | { step: "review"; draft: OnboardingDraft }
  | { step: "edit_bvn"; draft: OnboardingDraft }
  | { step: "edit_dob"; draft: OnboardingDraft }
  | { step: "edit_products"; draft: OnboardingDraft }
  | { step: "edit_pin"; draft: OnboardingDraft }
  | { step: "edit_pin_confirm"; draft: OnboardingDraft; newPinHash: string }
  // Onboarded
  | { step: "menu" }
  | { step: "fund_amount" }
  | { step: "withdraw_amount" }
  | { step: "buy_product" }
  | { step: "buy_amount"; productCode: string }
  // Fund, withdraw or buy in a WhatsApp Flow: the amount (and product) screen
  // sets `action`, the PIN screen `approved`.
  | {
      step: "transaction";
      type: TransactionType;
      flowToken: string;
      action?: PendingAction;
      attempts: number;
      approved?: boolean;
    }
  // A PIN to approve `action`: typed in the chat, or, with `flowToken`, in the PIN Flow.
  | {
      step: "authorize";
      action: PendingAction;
      attempts: number;
      flowToken?: string;
      approved?: boolean;
    };

export type Step = Session["step"];

/** The cache's typed schema. */
export type SessionCacheSchema = {
  [key: `session:${string}`]: Session;
  [key: `flow:${string}`]: FlowRef;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The dummy product catalogue. Codes are what the database stores; titles must
 * fit a WhatsApp list row (24 characters) and descriptions its 72.
 */
export interface Product {
  code: string;
  title: string;
  description: string;
}
