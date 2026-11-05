import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { ConversationService } from "../src/conversation/conversation.service";
import { QueueService } from "../src/queue/queue.service";
import { testApp, waitFor } from "./helpers";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let app: INestApplication;
const realFetch = globalThis.fetch;
/** The payloads sent to the Graph API, in order. */
const sent: { type: string; body: string }[] = [];

beforeAll(async () => {
  ({ app } = await testApp({
    WHATSAPP_ACCESS_TOKEN: "test-token",
    WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID",
    WHATSAPP_FLOW_PRIVATE_KEY: privateKey,
    WHATSAPP_FLOW_ID_ONBOARDING: "111",
    WHATSAPP_FLOW_ID_PIN: "222",
    WHATSAPP_FLOW_ID_TRANSACTION: "333",
  }));
  // Meta while the business isn't verified: forms are refused, text goes through.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("graph.facebook.com")) return realFetch(input, init);
    const payload = JSON.parse(String(init?.body)) as {
      type: string;
      text?: { body: string };
      interactive?: { type: string; body: { text: string } };
    };
    sent.push({
      type: payload.interactive?.type ?? payload.type,
      body: payload.text?.body ?? payload.interactive?.body.text ?? "",
    });
    if (payload.interactive?.type === "flow")
      return Response.json(
        { error: { message: "(#139000) Blocked by Integrity", code: 139000 } },
        { status: 400 },
      );
    return Response.json({ messages: [{ id: `wamid.${sent.length}` }] });
  }) as typeof fetch;
  await app.init();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

test("a form WhatsApp refuses is replaced by the chat steps", async () => {
  const queues = app.get(QueueService);
  const conversation = app.get(ConversationService);
  const waId = "2348061110001";
  const message = (id: string, text: string, choiceId?: string) => ({
    messageId: id,
    phoneNumberId: "PHONE_ID",
    waId,
    timestamp: Math.floor(Date.now() / 1000),
    input: { text, ...(choiceId ? { choiceId } : {}) },
  });

  await queues.enqueueInbound([message("wamid.in1", "hi")]);
  await waitFor(() => sent.length === 1);
  await queues.enqueueInbound([
    message("wamid.in2", "Proceed", "onboard:proceed"),
  ]);
  await waitFor(() => sent.length === 3);

  expect(sent.map((m) => m.type)).toEqual(["button", "flow", "text"]);
  expect(sent[2]!.body).toContain("Reply *TYPE* to answer a few questions");
  // The conversation is still waiting for the form, so TYPE works.
  expect((await conversation.session(waId))?.step).toBe("onboarding_flow");
  await queues.enqueueInbound([message("wamid.in3", "type")]);
  await waitFor(() => sent.length === 4);
  expect(sent[3]!.body).toContain("Step 1 of 4");
});
