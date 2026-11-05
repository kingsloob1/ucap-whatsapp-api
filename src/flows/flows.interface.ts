import type { z } from "zod";
import type { SessionSource } from "../database/sessions.interface";
import type { EncryptedFlowBodyDto, FlowRequestDto } from "./flows.dto";

/** The three Flows: onboarding, a PIN to approve a request, and fund/withdraw/buy. */
export type FlowName = "onboarding" | "pin" | "transaction";

/** What a Flow token points at, kept in the session cache as `flow:<token>`. */
export interface FlowRef {
  flow: FlowName;
  waId: string;
  source: SessionSource;
  /** The WhatsApp profile name, for the account the onboarding Flow creates. */
  profileName?: string;
}

/** The POST body WhatsApp sends to the Flow endpoint. */
export type EncryptedFlowBody = z.infer<typeof EncryptedFlowBodyDto>;

/** A decrypted Flow endpoint request (data API 3.0). */
export type FlowRequest = z.infer<typeof FlowRequestDto>;

/** What the endpoint answers: the next screen and its data, or an acknowledgement. */
export interface FlowResponse {
  screen?: string;
  data: Record<string, unknown>;
}

/** The Flow JSON of one Flow, as uploaded to Meta and rendered by the simulator. */
export interface FlowDefinition {
  version: string;
  data_api_version: string;
  routing_model: Record<string, string[]>;
  screens: Record<string, unknown>[];
}
