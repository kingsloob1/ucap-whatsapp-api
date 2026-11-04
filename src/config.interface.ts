/** Everything the service reads from the environment, read once at startup. */
export interface AppConfig {
  port: number;
  host: string;
  production: boolean;
  /** Where the three SQLite files live; `:memory:` keeps everything in-process (tests). */
  dataDir: string;
  /** Idle time before an unfinished conversation resets, in ms. */
  sessionTtlMs: number;
  enableDevRoutes: boolean;
  /** Reverse proxies in front of the service whose X-Forwarded-For is trusted (0: use the socket peer). */
  trustedProxies: number;
  admin: {
    /** How long an admin stays signed in, in ms. */
    sessionTtlMs: number;
    /** An admin created (or whose password is reset) at startup, when all three are set. */
    seed: { email: string; username: string; password: string } | null;
  };
  whatsapp: {
    verifyToken: string;
    appSecret: string;
    accessToken: string;
    phoneNumberId: string;
    /** The WhatsApp Business Account id deliveries must name (entry[].id); empty accepts any. */
    businessAccountId: string;
    /** Messages older than this (seconds) are dropped as stale or replayed. */
    maxMessageAgeSeconds: number;
    graphApiVersion: string;
    /** True when there is no token or phone number id: replies are logged, not sent. */
    dryRun: boolean;
  };
}
