import type { FlowName } from "./flows/flows.interface";

/** Everything the service reads from the environment, read once at startup. */
export interface AppConfig {
  port: number;
  host: string;
  production: boolean;
  /** Where the three SQLite files live; `:memory:` keeps everything in-process (tests). */
  dataDir: string;
  /** Idle time before an unfinished conversation resets, in ms. */
  sessionTtlMs: number;
  /** Apply pending database migrations at startup; without it, a pending migration refuses the start. */
  migrateOnStart: boolean;
  enableDevRoutes: boolean;
  /** Reverse proxies in front of the service whose X-Forwarded-For is trusted (0: use the socket peer). */
  trustedProxies: number;
  /**
   * A header that holds the client's address, set by a proxy that overwrites it
   * on every request (`x-real-ip` on Railway). Lower-cased; empty: not used.
   */
  clientIpHeader: string;
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
    flows: {
      /** The RSA private key (PEM) the Flow endpoint decrypts with; its public key is uploaded to Meta. */
      privateKey: string;
      privateKeyPassphrase: string;
      /** Each Flow's id on Meta; a Flow without one isn't offered on WhatsApp (the chat steps are used). */
      ids: Record<FlowName, string>;
      /** `draft` sends Flows that aren't published yet (testing); `published` otherwise. */
      mode: "published" | "draft";
    };
  };
  /** Offer the Flows in the chat simulator (rendered by the page, no Meta setup needed). */
  simulatorFlows: boolean;
}
