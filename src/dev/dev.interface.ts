import type { z } from "zod";
import type {
  ConversationEntryDto,
  ConversationQueryDto,
  ConversationResponseDto,
  ErrorResponseDto,
  FlowDefinitionDto,
  FlowExchangeBodyDto,
  FlowExchangeResponseDto,
  FlowNameParamsDto,
  HealthResponseDto,
  OutboxResponseDto,
  ResetParamsDto,
  ResetResponseDto,
  SendMessageResponseDto,
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
export type SendMessageResponse = z.infer<typeof SendMessageResponseDto>;
export type ConversationQuery = z.infer<typeof ConversationQueryDto>;
export type ConversationEntry = z.infer<typeof ConversationEntryDto>;
export type ConversationResponse = z.infer<typeof ConversationResponseDto>;
export type FlowNameParams = z.infer<typeof FlowNameParamsDto>;
export type FlowDefinitionResponse = z.infer<typeof FlowDefinitionDto>;
export type FlowExchangeBody = z.infer<typeof FlowExchangeBodyDto>;
export type FlowExchangeResponse = z.infer<typeof FlowExchangeResponseDto>;
