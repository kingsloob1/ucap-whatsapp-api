import { z } from "zod";

/**
 * The parts of the WhatsApp Cloud API webhook payload this service reads.
 * Objects are loose: Meta adds fields over time, and an unknown field must
 * never make a delivery fail.
 */
export const TextMessageDto = z.looseObject({
  type: z.literal("text"),
  text: z.looseObject({ body: z.string() }),
});

export const InteractiveMessageDto = z.looseObject({
  type: z.literal("interactive"),
  interactive: z.union([
    z.looseObject({
      type: z.literal("button_reply"),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }),
    }),
    z.looseObject({
      type: z.literal("list_reply"),
      list_reply: z.looseObject({
        id: z.string(),
        title: z.string(),
        description: z.string().optional(),
      }),
    }),
  ]),
});

/** A tap on a template's quick-reply button. */
export const ButtonMessageDto = z.looseObject({
  type: z.literal("button"),
  button: z.looseObject({ text: z.string(), payload: z.string().optional() }),
});

export const MessageBaseDto = z.looseObject({
  from: z.string().min(1),
  id: z.string().min(1),
  timestamp: z.string(),
  type: z.string(),
});

export const ContactDto = z.looseObject({
  wa_id: z.string(),
  profile: z.looseObject({ name: z.string().optional() }).optional(),
});

export const ValueDto = z.looseObject({
  messaging_product: z.literal("whatsapp").optional(),
  metadata: z
    .looseObject({
      phone_number_id: z.string(),
      display_phone_number: z.string().optional(),
    })
    .optional(),
  contacts: z.array(ContactDto).optional(),
  messages: z.array(MessageBaseDto).optional(),
  statuses: z
    .array(
      z.looseObject({
        id: z.string(),
        status: z.string(),
        recipient_id: z.string(),
      }),
    )
    .optional(),
});

/** The POST body Meta delivers to the webhook. */
export const WebhookPayloadDto = z.looseObject({
  object: z.string(),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(z.looseObject({ field: z.string(), value: ValueDto })),
    }),
  ),
});

export const HubDto = z.object({
  mode: z.string(),
  verify_token: z.string(),
  challenge: z.string(),
});

/**
 * The GET query Meta sends when the webhook is registered:
 * `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`. The query parser
 * nests dotted keys (`{ hub: { mode } }`); flat keys are accepted too.
 */
export const VerifyQueryDto = z.union([
  z.object({ hub: HubDto }).transform((q) => q.hub),
  z
    .object({
      "hub.mode": z.string(),
      "hub.verify_token": z.string(),
      "hub.challenge": z.string(),
    })
    .transform((q) => ({
      mode: q["hub.mode"],
      verify_token: q["hub.verify_token"],
      challenge: q["hub.challenge"],
    })),
]);
