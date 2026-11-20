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

export const flowKey = (token: string) => `flow:${token}` as const;

/** Wrong PINs before a pending request is cancelled. */
export const MAX_PIN_ATTEMPTS = 3;

/**
 * The reminder after onboarding and every completed transaction: WhatsApp keeps
 * the chat on the phone, so anyone who can open it sees the user's investments.
 */
export const PRIVACY_TIP =
  "🔒 *Keep your investments private:* lock this chat (tap the chat's name at the top, then *Chat lock*) " +
  "and clear it when you're done (chat menu, then *Clear chat*), so no one else using your phone can see your details.";

/** The shorter reminder when onboarding starts: the BVN and PIN are about to be shared. */
export const ONBOARDING_PRIVACY_TIP =
  "🔒 You'll share your BVN and create a PIN here. When you're done, lock this chat (tap its name, then *Chat lock*) " +
  "and clear it (chat menu, then *Clear chat*) to keep your details private.";
