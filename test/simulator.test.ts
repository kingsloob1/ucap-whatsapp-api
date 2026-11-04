import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { testApp } from "./helpers";

let app: INestApplication;
let base: string;
const realFetch = globalThis.fetch;
/** Calls the service made to the Graph API: a simulated conversation must make none. */
const graphCalls: string[] = [];

beforeAll(async () => {
  // Real-looking credentials, so the WhatsApp client is NOT in dry-run: anything
  // routed to WhatsApp would reach fetch.
  ({ app } = await testApp({
    WHATSAPP_ACCESS_TOKEN: "test-token",
    WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID",
  }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("graph.facebook.com")) {
      graphCalls.push(url);
      return Response.json({ messages: [{ id: "wamid.fake" }] });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

type Entry =
  | {
      id: number;
      direction: "in";
      text: string;
      choiceId: string | null;
      messageId: string | null;
      at: string;
    }
  | {
      id: number;
      direction: "out";
      messageId: string | null;
      replyIndex: number;
      deliveredAt: string;
      message: { kind: string; body: string; buttons?: { id: string }[] };
    };

async function send(
  from: string,
  text: string,
  choiceId?: string,
): Promise<string> {
  const res = await realFetch(`${base}/dev/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, text, ...(choiceId ? { choiceId } : {}) }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { messageId: string }).messageId;
}

async function conversation(waId: string, after = 0, wait = 0) {
  const res = await realFetch(
    `${base}/dev/conversations/${waId}?after=${after}&wait=${wait}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { step: string | null; entries: Entry[] };
}

/** Waits until the replies to `messageId` have been delivered. */
async function repliesTo(waId: string, messageId: string): Promise<Entry[]> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const { entries } = await conversation(waId, 0, 1);
    const out = entries.filter(
      (e) => e.direction === "out" && e.messageId === messageId,
    );
    if (out.length > 0) return out;
  }
  throw new Error(`no reply to ${messageId}`);
}

describe("the simulator, through the queues", () => {
  const waId = "2348039990001";

  test("a message is queued like a webhook delivery, and its replies are delivered to the simulator", async () => {
    const id = await send(waId, "hi");
    expect(id).toMatch(/^sim\./);
    const out = await repliesTo(waId, id);
    expect(out[0]).toMatchObject({
      direction: "out",
      replyIndex: 0,
      message: { kind: "buttons" },
    });
    if (out[0]!.direction === "out") {
      expect(out[0]!.message.buttons?.map((b) => b.id)).toEqual([
        "onboard:proceed",
        "close",
      ]);
      expect(out[0]!.deliveredAt).toBeTruthy();
    }

    const { step, entries } = await conversation(waId);
    expect(step).toBe("onboarding_prompt");
    expect(entries[0]).toMatchObject({
      direction: "in",
      text: "hi",
      messageId: id,
    });
  });

  test("replies to simulated messages are never sent to WhatsApp", () => {
    expect(graphCalls).toEqual([]);
  });

  test("another device sees the same conversation, and newer entries with `after`", async () => {
    const first = await conversation(waId);
    const id = await send(waId, "Proceed", "onboard:proceed");
    await repliesTo(waId, id);
    const newer = await conversation(waId, first.entries.at(-1)!.id);
    expect(newer.entries.map((e) => e.direction)).toEqual(["in", "out"]);
    expect(newer.entries[0]).toMatchObject({ choiceId: "onboard:proceed" });
    expect(newer.step).toBe("ask_bvn");
  });

  test("a waiting read returns as soon as something new arrives", async () => {
    const { entries } = await conversation(waId);
    const lastId = entries.at(-1)!.id;
    const started = Date.now();
    const waiting = conversation(waId, lastId, 8);
    await Bun.sleep(300);
    await send(waId, "22233344455");
    const answered = await waiting;
    expect(answered.entries.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the stored conversation keeps the BVN masked", async () => {
    const { entries } = await conversation(waId);
    const bvn = entries.find(
      (e) => e.direction === "in" && e.text.endsWith("4455"),
    );
    expect(bvn).toMatchObject({ text: "•••••••4455" });
    expect(JSON.stringify(entries)).not.toContain("22233344455");
  });

  test("resetting the number forgets the conversation", async () => {
    const res = await realFetch(`${base}/dev/users/${waId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await conversation(waId)).toEqual({ step: null, entries: [] });
  });

  test("an invalid number is refused", async () => {
    const res = await realFetch(`${base}/dev/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "123", text: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});
