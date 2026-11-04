/** The name of the bun-cache cache that holds sessions. */
export const SESSION_CACHE = "sessions";

/** USSD code a user dials to see their BVN. */
export const BVN_USSD = "*565*0#";

/** InvestNow's own USSD code: the service without WhatsApp. */
export const INVESTNOW_USSD = "*7277#";

/**
 * A USSD code as WhatsApp monospace: its asterisks must never pair up with
 * another asterisk in the message as bold.
 */
export const ussd = (code: string) => "```" + code + "```";

export const sessionKey = (waId: string) => `session:${waId}` as const;
