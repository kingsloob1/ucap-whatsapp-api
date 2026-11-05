import {
  ButtonMessageDto,
  FlowReplyMessageDto,
  InteractiveMessageDto,
  TextMessageDto,
} from "./webhook.dto";
import type {
  InboundInput,
  InboundMessage,
  WebhookMessage,
  WebhookPayload,
} from "./whatsapp.interface";

/** Reads what the state machine needs from one message; media and other types answer an empty input. */
export function toInput(message: WebhookMessage): InboundInput {
  const text = TextMessageDto.safeParse(message);
  if (text.success) return { text: text.data.text.body };
  const interactive = InteractiveMessageDto.safeParse(message);
  if (interactive.success) {
    const i = interactive.data.interactive;
    const reply = i.type === "button_reply" ? i.button_reply : i.list_reply;
    return { text: reply.title, choiceId: reply.id };
  }
  const button = ButtonMessageDto.safeParse(message);
  if (button.success) {
    return {
      text: button.data.button.text,
      ...(button.data.button.payload
        ? { choiceId: button.data.button.payload }
        : {}),
    };
  }
  return { text: "" };
}

/** Every user message in a payload, with its sender's profile name. Status updates are skipped. */
export function extractMessages(payload: WebhookPayload): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const names = new Map(
        (change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]),
      );
      for (const message of change.value.messages ?? []) {
        if (FlowReplyMessageDto.safeParse(message).success) continue;
        const name = names.get(message.from);
        out.push({
          messageId: message.id,
          phoneNumberId: change.value.metadata?.phone_number_id ?? null,
          waId: message.from,
          ...(name ? { name } : {}),
          timestamp: Number(message.timestamp) || Math.floor(Date.now() / 1000),
          input: toInput(message),
        });
      }
    }
  }
  return out;
}
