import type { admins } from "../database/schema";
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { z } from "zod";
import type {
  AdminDto,
  LoginBodyDto,
  MeResponseDto,
  ProblemResponseDto,
  SessionDetailDto,
  SessionSummaryDto,
  SessionsQueryDto,
  SessionsResponseDto,
} from "./admin.dto";

export interface AdminSession {
  adminId: number;
  email: string;
  username: string;
  createdAt: string;
  expiresAt: string;
}

export type AdminCacheSchema = {
  [key: `admin-session:${string}`]: AdminSession;
  [key: `login-fail:${string}`]: number;
};

export type AdminRecord = Pick<
  typeof admins.$inferSelect,
  "id" | "email" | "username" | "passwordHash"
>;

export interface AdminRow {
  id: number;
  email: string;
  username: string;
  password_hash: string;
}

export type AdminRequest = BunRequest & { admin?: AdminSession };

export type LoginBody = z.infer<typeof LoginBodyDto>;
export type Admin = z.infer<typeof AdminDto>;
export type MeResponse = z.infer<typeof MeResponseDto>;
export type ProblemResponse = z.infer<typeof ProblemResponseDto>;
export type SessionsQuery = z.infer<typeof SessionsQueryDto>;
export type SessionSummary = z.infer<typeof SessionSummaryDto>;
export type SessionsResponse = z.infer<typeof SessionsResponseDto>;
export type SessionDetail = z.infer<typeof SessionDetailDto>;
