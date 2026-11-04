import type { SessionSource } from "../database/sessions.interface";
import type { OutboundMessage } from "../whatsapp/whatsapp.interface";

/** The replies to one inbound message, sent in order by one job. */
export interface OutboundJob {
  to: string;
  /** The inbound message these answer. */
  inReplyTo: string;
  messages: OutboundMessage[];
  /**
   * Where the replies go: WhatsApp (the default, also for jobs queued before
   * this field existed), or the chat simulator, which is never sent to WhatsApp.
   */
  source?: SessionSource;
}
