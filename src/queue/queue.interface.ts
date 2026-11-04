import type { OutboundMessage } from "../whatsapp/whatsapp.interface";

/** The replies to one inbound message, sent in order by one job. */
export interface OutboundJob {
  to: string;
  /** The inbound message these answer. */
  inReplyTo: string;
  messages: OutboundMessage[];
}
