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

test("a refused form is replaced by the chat steps, without asking for TYPE", async () => {
  const queues = app.get(QueueService);
  const conversation = app.get(ConversationService);
  const waId = "2348061110001";
  let n = 0;
  const stepOf = async () => (await conversation.session(waId))?.step;
  /** Sends a message and waits for the conversation to reach `step`. */
  async function say(text: string, step: string, choiceId?: string) {
    await queues.enqueueInbound([
      {
        messageId: `wamid.in${++n}`,
        phoneNumberId: "PHONE_ID",
        waId,
        timestamp: Math.floor(Date.now() / 1000),
        input: { text, ...(choiceId ? { choiceId } : {}) },
      },
    ]);
    await waitFor(async () => (await stepOf()) === step);
  }
  const sentText = (part: string) =>
    waitFor(() => sent.some((m) => m.type === "text" && m.body.includes(part)));

  await say("hi", "onboarding_prompt");
  // The onboarding form is refused: the chat asks for the BVN straight away.
  await say("Proceed", "ask_bvn", "onboard:proceed");
  await sentText("Step 1 of 4");
  const form = sent.findIndex((m) => m.type === "flow");
  expect(sent[form]!.body).not.toContain("TYPE");
  expect(sent[form + 1]).toMatchObject({ type: "text" });
  expect(sent[form + 1]!.body).toContain("Great, let's get you set up!");
  expect(sent.some((m) => m.body.includes("Reply *TYPE*"))).toBe(false);

  await say("22233344455", "ask_dob");
  await say("25/12/1990", "select_products");
  await say("1,5", "set_pin");
  await say("4826", "confirm_pin");
  await say("4826", "review");
  await say("Confirm & create", "menu", "review:confirm");

  // The fund form is refused: the chat asks for the amount.
  await say("Fund wallet", "fund_amount", "menu:fund");
  await sentText("How much would you like to add to your wallet?");
  expect(sent.at(-2)).toMatchObject({ type: "flow" });

  // The PIN form is refused: the chat asks for the PIN, and a typed PIN approves.
  await say("1000", "authorize");
  await sentText("Please enter your 4-digit PIN to approve");
  const session = await conversation.session(waId);
  expect(session && "flowToken" in session).toBe(false);
  await say("4826", "menu");
  await sentText("Your wallet has been funded");
  expect(sent.some((m) => m.body.includes("Reply *TYPE*"))).toBe(false);
});
