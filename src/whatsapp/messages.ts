/**
 * Outbound messages, independent of the WhatsApp wire format, and their
 * translation to Cloud API payloads. Interactive limits (Cloud API docs):
 * body 1024 chars, at most 3 reply buttons of 20 chars, list button 20 chars,
 * at most 10 rows in total, row titles 24 chars, row descriptions 72 chars.
 */
import type { AppConfig } from "../config";
import type {
  ListSection,
  OutboundMessage,
  ReplyButton,
} from "./whatsapp.interface";

/** What sending a Flow needs: each Flow's id on Meta, and whether drafts are sent. */
export type FlowSettings = Pick<AppConfig["whatsapp"]["flows"], "ids" | "mode">;

export const text = (body: string): OutboundMessage => ({ kind: "text", body });

export function buttons(
  body: string,
  items: ReplyButton[],
  footer?: string,
): OutboundMessage {
  if (items.length < 1 || items.length > 3)
    throw new RangeError("WhatsApp allows 1 to 3 reply buttons");
  return {
    kind: "buttons",
    body,
    buttons: items,
    ...(footer ? { footer } : {}),
  };
}

export function list(
  body: string,
  button: string,
  sections: ListSection[],
  extra: { header?: string; footer?: string } = {},
): OutboundMessage {
  const rows = sections.reduce((n, s) => n + s.rows.length, 0);
  if (rows < 1 || rows > 10)
    throw new RangeError("WhatsApp lists hold 1 to 10 rows");
  return { kind: "list", body, button, sections, ...extra };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The Cloud API `/messages` body for one message to `to` (a WhatsApp id, i.e. the phone number). */
export function toGraphPayload(
  to: string,
  message: OutboundMessage,
  flows?: FlowSettings,
): Record<string, unknown> {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
  };
  switch (message.kind) {
    case "text":
      return {
        ...base,
        type: "text",
        text: { preview_url: false, body: clip(message.body, 4096) },
      };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          ...(message.header
            ? { header: { type: "text", text: clip(message.header, 60) } }
            : {}),
          body: { text: clip(message.body, 1024) },
          ...(message.footer
            ? { footer: { text: clip(message.footer, 60) } }
            : {}),
          action: {
            buttons: message.buttons.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: clip(b.title, 20) },
            })),
          },
        },
      };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          ...(message.header
            ? { header: { type: "text", text: clip(message.header, 60) } }
            : {}),
          body: { text: clip(message.body, 1024) },
          ...(message.footer
            ? { footer: { text: clip(message.footer, 60) } }
            : {}),
          action: {
            button: clip(message.button, 20),
            sections: message.sections.map((s) => ({
              title: clip(s.title, 24),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: clip(r.title, 24),
                ...(r.description
                  ? { description: clip(r.description, 72) }
                  : {}),
              })),
            })),
          },
        },
      };
    case "flow": {
      const flowId = flows?.ids[message.flow];
      if (!flowId) throw new Error(`The ${message.flow} Flow has no id`);
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "flow",
          ...(message.header
            ? { header: { type: "text", text: clip(message.header, 60) } }
            : {}),
          body: { text: clip(message.body, 1024) },
          ...(message.footer
            ? { footer: { text: clip(message.footer, 60) } }
            : {}),
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token: message.token,
              flow_id: flowId,
              flow_cta: clip(message.cta, 20),
              // The endpoint answers INIT with the first screen.
              flow_action: "data_exchange",
              ...(flows.mode === "draft" ? { mode: "draft" } : {}),
            },
          },
        },
      };
    }
  }
}

/** A plain-text rendering, for dry-run logs and the dev simulator. */
export function toPlainText(message: OutboundMessage): string {
  switch (message.kind) {
    case "text":
      return message.body;
    case "buttons":
      return [
        message.body,
        ...message.buttons.map((b) => `  [${b.title}]  (${b.id})`),
        message.footer ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    case "flow":
      return [message.body, `  [${message.cta}]  (${message.flow} form)`]
        .filter(Boolean)
        .join("\n");
    case "list":
      return [
        message.body,
        `  ▸ ${message.button}`,
        ...message.sections.flatMap((s) => [
          `  — ${s.title}`,
          ...s.rows.map(
            (r) =>
              `    • ${r.title}${r.description ? ` — ${r.description}` : ""}  (${r.id})`,
          ),
        ]),
        message.footer ?? "",
      ]
        .filter(Boolean)
        .join("\n");
  }
}
