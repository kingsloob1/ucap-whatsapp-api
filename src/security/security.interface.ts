import type { AppConfig } from "../config.interface";
export type ThrottleSchema = {
  [key: `hits:${string}`]: number;
  [key: `window:${string}`]: number;
  [key: `block:${string}`]: number;
};

/** What `ThrottlerStorage.increment` answers (seconds, as the in-memory storage reports them). */
export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/** The settings that decide where a client's address is read from. */
export type ClientIpConfig = Pick<
  AppConfig,
  "trustedProxies" | "clientIpHeader"
>;
