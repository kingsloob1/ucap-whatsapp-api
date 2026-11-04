import type { z } from "zod";
import type {
  ErrorResponseDto,
  HealthResponseDto,
  OutboxResponseDto,
  ResetParamsDto,
  ResetResponseDto,
  SimulateBodyDto,
  SimulateResponseDto,
} from "./dev.dto";

export type SimulateBody = z.infer<typeof SimulateBodyDto>;
export type SimulateResponse = z.infer<typeof SimulateResponseDto>;
export type ResetParams = z.infer<typeof ResetParamsDto>;
export type ResetResponse = z.infer<typeof ResetResponseDto>;
export type OutboxResponse = z.infer<typeof OutboxResponseDto>;
export type ErrorResponse = z.infer<typeof ErrorResponseDto>;
export type HealthResponse = z.infer<typeof HealthResponseDto>;
