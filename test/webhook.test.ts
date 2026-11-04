import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { sign } from "../src/whatsapp/signature";
import { WhatsAppClient } from "../src/whatsapp/whatsapp.client";
import { APP_SECRET, testApp, VERIFY_TOKEN, waitFor } from "./helpers";

let app: INestApplication;
let base: string;
let whatsapp: WhatsAppClient;

beforeAll(async () => {
  ({ app } = await testApp({
    WHATSAPP_BUSINESS_ACCOUNT_ID: "WABA_ID",
    WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID",
  }));
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  whatsapp = app.get(WhatsAppClient);
});

afterAll(async () => {
  await app.close();
});

const now = () => String(Math.floor(Date.now() / 1000));

function delivery(
  from: string,
  id: string,
  message: Record<string, unknown>,
  { waba = "WABA_ID", phoneId = "PHONE_ID", timestamp = now() } = {},
) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "2347000000000",
                phone_number_id: phoneId,
              },
              contacts: [{ wa_id: from, profile: { name: "Chidi Okeke" } }],
              messages: [{ from, id, timestamp, ...message }],
            },
          },
        ],
      },
    ],
  });
}

function post(body: string, signature: string | null = sign(body, APP_SECRET)) {
  return fetch(`${base}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
}

const sentTo = (to: string) => whatsapp.sent.filter((m) => m.to === to);

describe("GET /webhook (verification)", () => {
  test("echoes the challenge for the right token", async () => {
    const res = await fetch(
      `${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("1158201444");
  });

  test("refuses a wrong token", async () => {
    const res = await fetch(
      `${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`,
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /webhook (deliveries)", () => {
  test("refuses a missing or wrong signature", async () => {
    const body = delivery("2348111111111", "wamid.sig", {
      type: "text",
      text: { body: "hi" },
    });
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, sign(body, "other-secret"))).status).toBe(401);
  });

  test("queues a message, and the worker sends the reply", async () => {
    const from = "2348111111112";
    const res = await post(
      delivery(from, "wamid.one", { type: "text", text: { body: "Hi" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, queued: 1 });

    await waitFor(() => sentTo(from).length >= 1);
    expect(sentTo(from)[0]!.message).toMatchObject({ kind: "buttons" });
    expect(sentTo(from)[0]!.message.body).toContain(
      "Welcome to *InvestNow*, Chidi!",
    );
  });

  test("a redelivered message is not processed twice", async () => {
    const from = "2348111111113";
    const body = delivery(from, "wamid.dup", {
      type: "text",
      text: { body: "Hi" },
    });
    expect(await (await post(body)).json()).toEqual({ received: 1, queued: 1 });
    expect(await (await post(body)).json()).toEqual({ received: 1, queued: 0 });
    await waitFor(() => sentTo(from).length >= 1);
    await Bun.sleep(200);
    expect(sentTo(from)).toHaveLength(1);
  });

  test("a button tap is read by its id", async () => {
    const from = "2348111111114";
    await post(
      delivery(from, "wamid.t1", { type: "text", text: { body: "Hi" } }),
    );
    await waitFor(() => sentTo(from).length >= 1);
    await post(
      delivery(from, "wamid.t2", {
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "onboard:proceed", title: "Proceed" },
        },
      }),
    );
    await waitFor(() => sentTo(from).length >= 2);
    expect(sentTo(from)[1]!.message.body).toContain("Step 1 of 4");
  });

  test("status updates and unreadable bodies are acknowledged and ignored", async () => {
    const statuses = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "W",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.x", status: "read", recipient_id: "234" },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(await (await post(statuses)).json()).toEqual({
      received: 0,
      queued: 0,
    });
    const junk = JSON.stringify({ hello: "world" });
    const res = await post(junk);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 0, queued: 0 });
  });
});

describe("proof of origin", () => {
  test("a signed delivery for another business account or phone number is ignored", async () => {
    const from = "2348111111120";
    const other = delivery(
      from,
      "wamid.o1",
      { type: "text", text: { body: "Hi" } },
      { waba: "SOMEONE_ELSE" },
    );
    expect(await (await post(other)).json()).toEqual({
      received: 0,
      queued: 0,
    });
    const phone = delivery(
      from,
      "wamid.o2",
      { type: "text", text: { body: "Hi" } },
      { phoneId: "OTHER_PHONE" },
    );
    expect(await (await post(phone)).json()).toEqual({
      received: 0,
      queued: 0,
    });
    await Bun.sleep(150);
    expect(sentTo(from)).toHaveLength(0);
  });

  test("stale and future-dated messages are dropped", async () => {
    const from = "2348111111121";
    const old = String(Math.floor(Date.now() / 1000) - 2 * 86_400);
    const future = String(Math.floor(Date.now() / 1000) + 3_600);
    expect(
      await (
        await post(
          delivery(
            from,
            "wamid.s1",
            { type: "text", text: { body: "Hi" } },
            { timestamp: old },
          ),
        )
      ).json(),
    ).toEqual({
      received: 0,
      queued: 0,
    });
    expect(
      await (
        await post(
          delivery(
            from,
            "wamid.s2",
            { type: "text", text: { body: "Hi" } },
            { timestamp: future },
          ),
        )
      ).json(),
    ).toEqual({
      received: 0,
      queued: 0,
    });
  });

  test("the webhook is never throttled", async () => {
    const bodies = Array.from({ length: 150 }, (_, i) =>
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "WABA_ID", changes: [] }],
        i,
      }),
    );
    const statuses = await Promise.all(
      bodies.map(async (b) => (await post(b)).status),
    );
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  test("an address that keeps failing the signature is blocked, before its body is checked", async () => {
    // Its own app: the block is per address, and the test server is one address.
    const { app: other } = await testApp();
    await other.listen(0, "127.0.0.1");
    const url = `${await other.getUrl()}/webhook`;
    const body = delivery("2348111111122", "wamid.b1", {
      type: "text",
      text: { body: "Hi" },
    });
    const send = (signature: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
        },
        body,
      });
    for (let i = 0; i < 10; i++)
      expect((await send(sign(body, "wrong"))).status).toBe(401);
    expect((await send(sign(body, APP_SECRET))).status).toBe(403); // even a valid signature, while blocked
    await other.close();
  });
});

test("health answers the server's date and time, to the millisecond", async () => {
  const before = Date.now();
  const res = await fetch(`${base}/health`);
  const after = Date.now();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    status: string;
    serverTime: string;
    epochMs: number;
  };
  expect(body.status).toBe("ok");
  expect(body.serverTime).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  expect(Date.parse(body.serverTime)).toBe(body.epochMs);
  expect(body.epochMs).toBeGreaterThanOrEqual(before);
  expect(body.epochMs).toBeLessThanOrEqual(after);
});

test("the dev simulator answers the replies directly", async () => {
  const res = await fetch(`${base}/dev/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "2348111111115", name: "Ngozi", text: "hi" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { step: string; transcript: string };
  expect(body.step).toBe("onboarding_prompt");
  expect(body.transcript).toContain("Welcome to *InvestNow*, Ngozi!");

  const bad = await fetch(`${base}/dev/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "abc", text: "hi" }),
  });
  expect(bad.status).toBe(400);
});
