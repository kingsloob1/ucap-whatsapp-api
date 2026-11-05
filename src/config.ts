import type { AppConfig } from "./config.interface";
import { resolve } from "node:path";

export type { AppConfig } from "./config.interface";

/** The DI token the config is provided under. */
export const APP_CONFIG = Symbol("APP_CONFIG");

const DAY_MS = 86_400_000;

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`Expected a non-negative integer, got "${value}"`);
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const production = env.NODE_ENV === "production";
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const dataDir = env.DATA_DIR?.trim() || "./data";

  const config: AppConfig = {
    port: int(env.PORT, 3000),
    host: env.HOST?.trim() || "0.0.0.0",
    production,
    dataDir: dataDir === ":memory:" ? dataDir : resolve(dataDir),
    sessionTtlMs: int(env.SESSION_TTL_MS, DAY_MS),
    migrateOnStart: bool(env.MIGRATE_ON_START, !production),
    enableDevRoutes: bool(env.ENABLE_DEV_ROUTES, !production),
    trustedProxies: int(env.TRUSTED_PROXIES, 0),
    clientIpHeader: env.CLIENT_IP_HEADER?.trim().toLowerCase() ?? "",
    admin: {
      sessionTtlMs: int(env.ADMIN_SESSION_TTL_MS, 8 * 3_600_000),
      seed:
        env.ADMIN_EMAIL?.trim() &&
        env.ADMIN_USERNAME?.trim() &&
        env.ADMIN_PASSWORD
          ? {
              email: env.ADMIN_EMAIL.trim(),
              username: env.ADMIN_USERNAME.trim(),
              password: env.ADMIN_PASSWORD,
            }
          : null,
    },
    whatsapp: {
      verifyToken: env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "",
      appSecret: env.WHATSAPP_APP_SECRET?.trim() ?? "",
      accessToken,
      phoneNumberId,
      businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() ?? "",
      maxMessageAgeSeconds: int(
        env.WEBHOOK_MAX_MESSAGE_AGE_SECONDS,
        DAY_MS / 1000,
      ),
      graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v26.0",
      dryRun: accessToken === "" || phoneNumberId === "",
      flows: {
        privateKey: env.WHATSAPP_FLOW_PRIVATE_KEY?.trim() ?? "",
        privateKeyPassphrase: env.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE ?? "",
        ids: {
          onboarding: env.WHATSAPP_FLOW_ID_ONBOARDING?.trim() ?? "",
          pin: env.WHATSAPP_FLOW_ID_PIN?.trim() ?? "",
          transaction: env.WHATSAPP_FLOW_ID_TRANSACTION?.trim() ?? "",
        },
        mode:
          env.WHATSAPP_FLOW_MODE?.trim().toLowerCase() === "draft"
            ? "draft"
            : "published",
      },
    },
    simulatorFlows: bool(env.SIMULATOR_FLOWS, true),
  };

  const { flows } = config.whatsapp;
  if (Object.values(flows.ids).some(Boolean) && flows.privateKey === "")
    throw new Error(
      "WHATSAPP_FLOW_PRIVATE_KEY is required when a WHATSAPP_FLOW_ID_* is set",
    );

  if (production) {
    const missing = (
      ["verifyToken", "appSecret", "accessToken", "phoneNumberId"] as const
    ).filter((key) => config.whatsapp[key] === "");
    if (missing.length > 0)
      throw new Error(
        `Missing WhatsApp settings in production: ${missing.join(", ")}`,
      );
    if (config.enableDevRoutes)
      throw new Error("ENABLE_DEV_ROUTES must be off in production");
  }
  return config;
}
