import { createClient, type SchemaSource } from "@kingsleyweb/bun-client";
import {
  LoginBodyDto,
  MeResponseDto,
  OkResponseDto,
  ProblemResponseDto,
  ResetSessionResponseDto,
  SessionDetailDto,
  SessionsQueryDto,
  SessionsResponseDto,
  WaIdParamsDto,
} from "../../../src/admin/admin.dto";
import { manifest, type Routes } from "../api.gen";

/** The server's own schemas for the admin routes: the client checks requests and responses with them. */
const schemas = {
  "POST /admin/api/login": {
    body: LoginBodyDto,
    responses: {
      200: MeResponseDto,
      400: ProblemResponseDto,
      401: ProblemResponseDto,
      429: ProblemResponseDto,
    },
  },
  "POST /admin/api/logout": { responses: { 200: OkResponseDto } },
  "GET /admin/api/me": {
    responses: { 200: MeResponseDto, 401: ProblemResponseDto },
  },
  "GET /admin/api/sessions": {
    query: SessionsQueryDto,
    responses: {
      200: SessionsResponseDto,
      400: ProblemResponseDto,
      401: ProblemResponseDto,
      429: ProblemResponseDto,
    },
  },
  "GET /admin/api/sessions/:waId": {
    params: WaIdParamsDto,
    responses: {
      200: SessionDetailDto,
      401: ProblemResponseDto,
      404: ProblemResponseDto,
    },
  },
  "POST /admin/api/sessions/:waId/reset": {
    params: WaIdParamsDto,
    responses: {
      200: ResetSessionResponseDto,
      401: ProblemResponseDto,
      404: ProblemResponseDto,
    },
  },
} satisfies SchemaSource<Routes>["schemas"];

/** Same-origin, so the HttpOnly session cookie goes with every call. Statuses outside the manifest come back as results. */
export const adminApi = createClient<Routes, { undeclaredStatus: "result" }>({
  baseUrl: window.location.origin,
  manifest,
  schemas: () => Promise.resolve({ schemas }),
  undeclaredStatus: "result",
  timeout: 15_000,
  retry: false,
});

/** The message of an error body, whatever its shape. */
export function problemText(
  error: unknown,
  fallback = "Something went wrong.",
): string {
  if (error && typeof error === "object" && "message" in error) {
    const m = (error as { message: unknown }).message;
    if (Array.isArray(m)) return m.join("; ");
    if (typeof m === "string") return m;
  }
  return fallback;
}
