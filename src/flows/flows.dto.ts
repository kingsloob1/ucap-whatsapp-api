import { z } from "zod";

/** The encrypted body WhatsApp POSTs to the Flow endpoint (base64 strings). */
export const EncryptedFlowBodyDto = z.object({
  encrypted_flow_data: z.string().min(1),
  encrypted_aes_key: z.string().min(1),
  initial_vector: z.string().min(1),
});

/** A decrypted request. `ping` is WhatsApp's health check; `data.error` an error notification. */
export const FlowRequestDto = z.looseObject({
  version: z.string().optional(),
  action: z.enum(["ping", "INIT", "BACK", "data_exchange"]),
  screen: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  flow_token: z.string().optional(),
});
