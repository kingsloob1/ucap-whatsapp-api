import {
  generateOpenApi,
  type OpenApiDocument,
} from "@kingsleyweb/bun-common/lib/docs";
import type { BunHttpAdapter } from "@kingsleyweb/bun-nest";

/** The routes the chat and admin UIs call: what their typed client is generated from. */
const UI_PATH = /^\/(dev|admin\/api)\/|^\/health$/;

/**
 * The AsyncAPI document beside it: the app has no WebSocket gateways. Both the
 * dev endpoint and scripts/openapi.ts serve this one, since it joins the
 * generated file's typesHash.
 */
export const UI_ASYNCAPI = {
  asyncapi: "3.0.0",
  info: { title: "InvestNow WhatsApp API", version: "dev" },
  defaultContentType: "application/json",
} as const;

/** Set by `createApp`, so the dev type sync can document the running app. */
export const adapterRef: { current: BunHttpAdapter | null } = { current: null };

/**
 * The OpenAPI document of the UI-facing routes only. The jobs management API,
 * the static UIs and the webhook stay out: the UIs never call them, and the
 * generated client stays small and the same whether or not the UIs are built.
 * Served by the dev type sync (`bun run ui:types` follows it) and by
 * scripts/openapi.ts (`bun run ui:types:generate` / `ui:types:check`).
 */
export function uiDocument(adapter: BunHttpAdapter): OpenApiDocument {
  const { document } = generateOpenApi(adapter.getInstance(), {
    title: "InvestNow WhatsApp API",
    version: "dev",
  });
  const doc = document as OpenApiDocument & {
    paths?: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
  };
  doc.paths = Object.fromEntries(
    Object.entries(doc.paths ?? {}).filter(([path]) => UI_PATH.test(path)),
  );

  // Keep only the component schemas the remaining paths reach.
  const schemas = doc.components?.schemas;
  if (schemas) {
    const reached = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref" && typeof inner === "string") {
          const name = inner.replace("#/components/schemas/", "");
          if (!reached.has(name)) {
            reached.add(name);
            visit(schemas[name]);
          }
        } else visit(inner);
      }
    };
    visit(doc.paths);
    doc.components!.schemas = Object.fromEntries(
      Object.entries(schemas).filter(([name]) => reached.has(name)),
    );
  }
  return doc;
}
