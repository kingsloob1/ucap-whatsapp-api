/**
 * The admin API's schemas, shared by the server (`@Validate`) and the admin
 * UI (bun-client). Browser-safe: zod only.
 */
import { z } from "zod";

export const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/i;

/** An email address or a username. */
export const IdentifierDto = z
  .string()
  .trim()
  .min(3, "enter your email or username")
  .max(254)
  .refine(
    (v) =>
      v.includes("@") ? z.email().safeParse(v).success : USERNAME.test(v),
    "not a valid email or username",
  );

export const LoginBodyDto = z.object({
  identifier: IdentifierDto,
  password: z.string().min(1, "enter your password").max(200),
});

export const AdminDto = z.object({
  id: z.number(),
  email: z.string(),
  username: z.string(),
});

export const MeResponseDto = z.object({
  admin: AdminDto,
  expiresAt: z.iso.datetime(),
});

export const OkResponseDto = z.object({ ok: z.literal(true) });

export const ProblemResponseDto = z.object({
  statusCode: z.number(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
});

export const SessionSourceDto = z.enum(["whatsapp", "simulator"]);
export const SessionStatusDto = z.enum(["active", "ended", "expired"]);

export const SessionsQueryDto = z.object({
  source: SessionSourceDto.optional(),
  status: SessionStatusDto.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const SessionSummaryDto = z.object({
  waId: z.string(),
  source: SessionSourceDto,
  status: SessionStatusDto,
  profileName: z.string().nullable(),
  /** The step the state machine is at (the live one from the session store when active). */
  step: z.string().nullable(),
  onboarded: z.boolean(),
  phoneNumberId: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  expiresAt: z.string().nullable(),
  messageCount: z.number(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
});

export const SessionsResponseDto = z.object({
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  sessions: z.array(SessionSummaryDto),
  stats: z.object({
    active: z.number(),
    whatsapp: z.number(),
    simulator: z.number(),
    total: z.number(),
  }),
});

export const WaIdParamsDto = z.object({
  waId: z.string().regex(/^\d{7,15}$/, "a WhatsApp id: digits only"),
});

export const SessionEventDto = z.object({
  id: z.number(),
  direction: z.enum(["in", "out"]),
  stepBefore: z.string().nullable(),
  stepAfter: z.string().nullable(),
  text: z.string().nullable(),
  choiceId: z.string().nullable(),
  kind: z.string().nullable(),
  at: z.string(),
});

export const SessionDetailDto = z.object({
  session: SessionSummaryDto,
  /** The live state machine state, with secrets redacted; null when there is no live session. */
  state: z.record(z.string(), z.unknown()).nullable(),
  user: z
    .object({
      id: z.number(),
      name: z.string().nullable(),
      bvn: z.string(),
      dateOfBirth: z.string(),
      walletBalanceKobo: z.number(),
      createdAt: z.string(),
      holdings: z.array(
        z.object({ productCode: z.string(), balanceKobo: z.number() }),
      ),
    })
    .nullable(),
  events: z.array(SessionEventDto),
});

export const ResetSessionResponseDto = z.object({ wasLive: z.boolean() });
