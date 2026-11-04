/** The name of the bun-cache cache that holds sessions. */
export const SESSION_CACHE = "sessions";

export const sessionKey = (waId: string) => `session:${waId}` as const;
