/**
 * The dev API's schemas, shared by the server (`@Validate`) and the chat UI
 * (bun-client checks requests and responses with them). Keep this module
 * browser-safe: zod and ./phone only, no server code.
 */
import { z } from "zod";
import { isValidWaId } from "../shared/phone";

export const WaIdDto = z
  .string()
  .regex(
    /^\d{7,15}$/,
    "the phone number in international format, digits only, without +",
  )
  .refine(isValidWaId, "not a valid mobile number");

export const SimulateBodyDto = z.object({
  /** The sender's WhatsApp id: their mobile number in E.164 without the `+`. */
  from: WaIdDto,
  name: z.string().trim().min(1).max(100).optional(),
  /** What the user typed, or the title of what they tapped. */
  text: z.string().max(4096).default(""),
  /** The id of a tapped button or list row (e.g. "onboard:proceed", "menu:fund", "product:MMF"). */
  choiceId: z.string().max(256).optional(),
});

export const OutboundMessageDto = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), body: z.string() }),
  z.object({
    kind: z.literal("buttons"),
    body: z.string(),
    header: z.string().optional(),
    footer: z.string().optional(),
    buttons: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  z.object({
    kind: z.literal("list"),
    body: z.string(),
    header: z.string().optional(),
    footer: z.string().optional(),
    button: z.string(),
    sections: z.array(
      z.object({
        title: z.string(),
        rows: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string().optional(),
          }),
        ),
      }),
    ),
  }),
]);

export const SimulateResponseDto = z.object({
  /** The step the session is left at; null when the session ended. */
  step: z.string().nullable(),
  replies: z.array(OutboundMessageDto),
  transcript: z.string(),
});

/** Accepted: the message is on the inbound queue, like a webhook delivery. */
export const SendMessageResponseDto = z.object({
  /** The simulated message's id (`sim.…`), which its replies and ticks refer to. */
  messageId: z.string(),
  /** When the server accepted it (ISO 8601, milliseconds). */
  at: z.iso.datetime(),
});

export const ConversationParamsDto = z.object({ waId: WaIdDto });

export const ConversationQueryDto = z.object({
  /** Only entries newer than this id. */
  after: z.coerce.number().int().min(0).default(0),
  /** Seconds to wait for something new before answering (long polling); 0 answers at once. */
  wait: z.coerce.number().int().min(0).max(8).default(0),
});

export const ConversationEntryDto = z.discriminatedUnion("direction", [
  z.object({
    id: z.number(),
    direction: z.literal("in"),
    at: z.string(),
    messageId: z.string().nullable(),
    /** As stored: PINs and BVNs redacted. */
    text: z.string(),
    choiceId: z.string().nullable(),
  }),
  z.object({
    id: z.number(),
    direction: z.literal("out"),
    at: z.string(),
    messageId: z.string().nullable(),
    replyIndex: z.number(),
    deliveredAt: z.string(),
    message: OutboundMessageDto,
  }),
]);

export const ConversationResponseDto = z.object({
  /** The step the conversation is at; null when there is no live session. */
  step: z.string().nullable(),
  entries: z.array(ConversationEntryDto),
});

export const ResetParamsDto = z.object({ waId: WaIdDto });

export const ResetResponseDto = z.object({ deletedUser: z.boolean() });

export const OutboxResponseDto = z.object({
  dryRun: z.boolean(),
  messages: z.array(
    z.object({
      to: z.string(),
      message: OutboundMessageDto,
      at: z.iso.datetime(),
    }),
  ),
});

export const HealthResponseDto = z.object({
  status: z.literal("ok"),
  /** The server's current date and time, ISO 8601 in UTC with milliseconds. */
  serverTime: z.iso.datetime({ precision: 3 }),
  /** The same instant as milliseconds since the Unix epoch. */
  epochMs: z.number().int(),
});

/** Nest's answer to a request that failed validation, or any other HTTP error. */
export const ErrorResponseDto = z.object({
  statusCode: z.number(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
});
