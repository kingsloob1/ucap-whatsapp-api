import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { ConversationService } from "../src/conversation/conversation.service";
import { SessionsRepository } from "../src/database/sessions.repository";
import { UsersRepository } from "../src/database/users.repository";
import {
  decryptFlowResponse,
  encryptFlowRequest,
} from "../src/flows/flow-crypto";
import { toGraphPayload } from "../src/whatsapp/messages";
import { sign } from "../src/whatsapp/signature";
import { extractMessages } from "../src/whatsapp/webhook.mapper";
import { APP_SECRET, testApp, waitFor } from "./helpers";
import type { SessionSource } from "../src/database/sessions.interface";
import type {
  InboundInput,
  OutboundMessage,
} from "../src/whatsapp/whatsapp.interface";

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let app: INestApplication;
let base: string;
let conversation: ConversationService;
let users: UsersRepository;
let log: SessionsRepository;

beforeAll(async () => {
  ({ app } = await testApp({
    SIMULATOR_FLOWS: "true",
    // As env vars usually hold a PEM: on one line, with literal \n.
    WHATSAPP_FLOW_PRIVATE_KEY: keys.privateKey.replace(/\n/g, "\\n"),
    WHATSAPP_FLOW_ID_ONBOARDING: "111",
    WHATSAPP_FLOW_ID_PIN: "222",
    WHATSAPP_FLOW_ID_TRANSACTION: "333",
  }));
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  conversation = app.get(ConversationService);
  users = app.get(UsersRepository);
  log = app.get(SessionsRepository);
});

afterAll(async () => {
  await app.close();
});

const tap = (choiceId: string, text = choiceId): InboundInput => ({
  text,
  choiceId,
});

async function say(
  waId: string,
  input: string | InboundInput,
  source: SessionSource = "simulator",
): Promise<OutboundMessage[]> {
  return conversation.handle(
    { waId, name: "Ada Obi" },
    typeof input === "string" ? { text: input } : input,
    { source },
  );
}

/** The token of the form in `replies`. */
function formIn(replies: OutboundMessage[], flow: string): string {
  const form = replies.find((m) => m.kind === "flow");
  expect(form).toMatchObject({ kind: "flow", flow });
  return form!.kind === "flow" ? form!.token : "";
}

/** One request from a simulator form (POST /dev/flows/exchange). */
async function exchange(
  token: string,
  screen: string | undefined,
  data?: Record<string, unknown>,
): Promise<{
  status: number;
  screen?: string;
  data: Record<string, unknown>;
}> {
  const res = await fetch(`${base}/dev/flows/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flow_token: token,
      action: screen ? "data_exchange" : "INIT",
      ...(screen ? { screen } : {}),
      ...(data ? { data } : {}),
    }),
  });
  const body = (await res.json()) as {
    screen?: string;
    data: Record<string, unknown>;
  };
  return { status: res.status, ...body };
}

/** The history's entries for `waId`, as the simulator and the admin read them. */
const history = (waId: string) => log.conversation(waId);

describe("onboarding in a Flow", () => {
  const waId = "2348051110001";
  let token: string;

  test("Proceed opens the onboarding form instead of asking in the chat", async () => {
    await say(waId, "hi");
    const replies = await say(waId, tap("onboard:proceed", "Proceed"));
    token = formIn(replies, "onboarding");
    expect(replies[0]!.body).toContain("Reply *TYPE*");
    expect((await conversation.session(waId))?.step).toBe("onboarding_flow");
    expect(await exchange(token, undefined)).toMatchObject({
      screen: "BVN",
      data: { bvn_error: "" },
    });
  });

  test("the BVN is checked: 11 digits, starting with 22", async () => {
    let r = await exchange(token, "BVN", { bvn: "12345678901" });
    expect(r.screen).toBe("BVN");
    expect(r.data.bvn_error).toContain("starts with 22");
    r = await exchange(token, "BVN", { bvn: "2223334" });
    expect(r.data.bvn_error).toContain("11 digits");
    r = await exchange(token, "BVN", { bvn: "22233344455" });
    expect(r.screen).toBe("DOB");
    expect(r.data.max_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("the date of birth: a real date, at least 5 years ago", async () => {
    const fourYearsAgo = `${new Date().getUTCFullYear() - 4}-01-01`;
    let r = await exchange(token, "DOB", { dob: fourYearsAgo });
    expect(r.screen).toBe("DOB");
    expect(r.data.dob_error).toContain("at least 5");
    r = await exchange(token, "DOB", { dob: "1990-02-31" });
    expect(r.data.dob_error).toContain("doesn't exist");
    r = await exchange(token, "DOB", { dob: "1990-12-25" });
    expect(r.screen).toBe("PRODUCTS");
    expect(r.data.products).toContainEqual({
      id: "MMF",
      title: "Money Market Fund",
    });
  });

  test("products: at least one, from the catalogue", async () => {
    let r = await exchange(token, "PRODUCTS", { products: [] });
    expect(r.screen).toBe("PRODUCTS");
    expect(r.data.error_message).toContain("at least one");
    r = await exchange(token, "PRODUCTS", { products: ["XYZ"] });
    expect(r.screen).toBe("PRODUCTS");
    r = await exchange(token, "PRODUCTS", { products: ["STK", "MMF"] });
    expect(r.screen).toBe("PIN");
  });

  test("the new PIN is checked for strength and confirmed", async () => {
    let r = await exchange(token, "PIN", { pin: "1990", pin_confirm: "1990" });
    expect(r.data.pin_error).toContain("date of birth");
    r = await exchange(token, "PIN", { pin: "1212", pin_confirm: "1212" });
    expect(r.data.pin_error).toContain("repeated pair");
    r = await exchange(token, "PIN", { pin: "4826", pin_confirm: "4827" });
    expect(r.data.pin_confirm_error).toContain("don't match");
    r = await exchange(token, "PIN", { pin: "4826", pin_confirm: "4826" });
    expect(r).toMatchObject({
      screen: "REVIEW",
      data: {
        bvn_masked: "•••••••4455",
        dob_text: "25/12/1990",
        products_text: "Money Market Fund, Stocks",
      },
    });
    expect(JSON.stringify(await conversation.session(waId))).not.toContain(
      "4826",
    );
  });

  test("an answer changed from the review returns straight to it", async () => {
    const r = await exchange(token, "DOB", { dob: "1992-06-15" });
    expect(r).toMatchObject({
      screen: "REVIEW",
      data: { dob_text: "15/06/1992" },
    });
  });

  test("Create account closes the form and the bot opens the account", async () => {
    const r = await exchange(token, "REVIEW", { confirm: "yes" });
    expect(r.screen).toBe("SUCCESS");
    expect(r.data).toEqual({
      extension_message_response: { params: { flow_token: token } },
    });
    await waitFor(async () => (await users.findByWaId(waId)) !== null);
    const user = (await users.findByWaId(waId))!;
    expect(user).toMatchObject({
      bvn: "22233344455",
      dateOfBirth: "1992-06-15",
    });
    expect(await Bun.password.verify("4826", user.pinHash)).toBe(true);
    await waitFor(
      async () => (await conversation.session(waId))?.step === "menu",
    );
    // The form can't be used again.
    expect((await exchange(token, "REVIEW", { confirm: "yes" })).status).toBe(
      410,
    );
  });

  test("every answer is in the history as the user's message, masked", async () => {
    await waitFor(async () =>
      (await history(waId)).some(
        (e) => e.direction === "out" && e.message.body.includes("is ready"),
      ),
    );
    const entries = await history(waId);
    const answers = entries.filter((e) => e.direction === "in" && e.form);
    expect(answers.map((e) => (e.direction === "in" ? e.text : ""))).toEqual([
      "BVN: •••••••8901",
      "BVN: •••3334",
      "BVN: •••••••4455",
      `Date of birth: 01/01/${new Date().getUTCFullYear() - 4}`,
      "Date of birth: 31/02/1990",
      "Date of birth: 25/12/1990",
      "Products: none",
      "Products: none",
      "Products: Money Market Fund, Stocks",
      "PIN: •••• · Confirm PIN: ••••",
      "PIN: •••• · Confirm PIN: ••••",
      "PIN: •••• · Confirm PIN: ••••",
      "PIN: •••• (confirmed)",
      "Date of birth: 15/06/1992",
      "Confirm & create",
    ]);
    // A refused answer is followed by what the form said.
    const afterFirst = entries[entries.indexOf(answers[0]!) + 1]!;
    expect(afterFirst).toMatchObject({
      direction: "out",
      message: { body: expect.stringContaining("starts with 22") },
    });
    const all = JSON.stringify(entries);
    for (const secret of ["22233344455", "4826", "12345678901"])
      expect(all).not.toContain(secret);
  });

  test("TYPE answers in the chat instead", async () => {
    const other = "2348051110002";
    await say(other, "hi");
    formIn(await say(other, tap("onboard:proceed")), "onboarding");
    const replies = await say(other, "type");
    expect(replies[0]!.body).toContain("Step 1 of 4");
    expect((await conversation.session(other))?.step).toBe("ask_bvn");
  });
});

describe("fund, buy and balance in Flows", () => {
  const waId = "2348051110001"; // onboarded above, PIN 4826

  test("fund: the amount, then the PIN, in the transaction form", async () => {
    const token = formIn(await say(waId, tap("menu:fund")), "transaction");
    let r = await exchange(token, undefined);
    expect(r).toMatchObject({
      screen: "AMOUNT",
      data: { heading: "Fund your wallet", choose_product: false },
    });
    r = await exchange(token, "AMOUNT", { amount: "50" });
    expect(r.data.amount_error).toContain("₦100");
    r = await exchange(token, "AMOUNT", { amount: "50000" });
    expect(r).toMatchObject({
      screen: "PIN",
      data: { summary: "Fund your wallet with ₦50,000.00." },
    });

    r = await exchange(token, "PIN", { pin: "12" });
    expect(r.data.pin_error).toContain("4 digits");
    // Approving checks the PIN only: a weak-looking PIN is just a wrong one.
    r = await exchange(token, "PIN", { pin: "1111" });
    expect(r.data.pin_error).toBe("Incorrect PIN. You have 2 attempts left.");
    r = await exchange(token, "PIN", { pin: "4826" });
    expect(r.screen).toBe("SUCCESS");

    const user = (await users.findByWaId(waId))!;
    await waitFor(async () => (await users.walletBalance(user.id)) > 0);
    expect(await users.walletBalance(user.id)).toBe(5_000_000);
    await waitFor(
      async () => (await conversation.session(waId))?.step === "menu",
    );
    const texts = (await history(waId))
      .filter((e) => e.direction === "in" && e.form)
      .map((e) => (e.direction === "in" ? e.text : ""));
    expect(texts.slice(-5)).toEqual([
      "Amount: 50",
      "Amount: ₦50,000.00",
      "PIN: ••••",
      "PIN: ••••",
      "PIN: ••••",
    ]);
  });

  test("buy: the product and amount on one screen", async () => {
    const token = formIn(await say(waId, tap("menu:buy")), "transaction");
    let r = await exchange(token, undefined);
    expect(r.data.choose_product).toBe(true);
    r = await exchange(token, "AMOUNT", { amount: "20000" });
    expect(r.data.error_message).toContain("choose a product");
    r = await exchange(token, "AMOUNT", { product: "EQF", amount: "90000" });
    expect(r.data.amount_error).toContain("₦50,000.00");
    r = await exchange(token, "AMOUNT", { product: "EQF", amount: "20000" });
    expect(r.data.summary).toBe(
      "Buy ₦20,000.00 of Equity Fund from your wallet.",
    );
    expect((await exchange(token, "PIN", { pin: "4826" })).screen).toBe(
      "SUCCESS",
    );
    await waitFor(async () =>
      (await history(waId)).some(
        (e) =>
          e.direction === "out" &&
          e.message.body.includes("You bought ₦20,000.00 of Equity Fund"),
      ),
    );
  });

  test("balance: three wrong PINs close the form and cancel", async () => {
    const token = formIn(await say(waId, tap("menu:balance")), "pin");
    expect(await exchange(token, undefined)).toMatchObject({
      screen: "PIN",
      data: { summary: "View your wallet and investment balances." },
    });
    await exchange(token, "PIN", { pin: "1111" });
    await exchange(token, "PIN", { pin: "2222" });
    expect((await exchange(token, "PIN", { pin: "3333" })).screen).toBe(
      "SUCCESS",
    );
    await waitFor(async () =>
      (await history(waId)).some(
        (e) =>
          e.direction === "out" &&
          e.message.body.includes("Too many incorrect PIN attempts"),
      ),
    );
  });

  test("TYPE goes back to the chat steps; the PIN still comes as a form", async () => {
    formIn(await say(waId, tap("menu:fund")), "transaction");
    const replies = await say(waId, "type");
    expect(replies[0]!.body).toContain("How much would you like to add");
    formIn(await say(waId, "1000"), "pin");
    expect((await conversation.session(waId))?.step).toBe("authorize");
    // The chat still takes a typed PIN, for WhatsApp versions without Flows.
    const done = await say(waId, "4826");
    expect(done[0]!.body).toContain("Your wallet has been funded");
  });
});

describe("the WhatsApp Flow endpoint", () => {
  const waId = "2348051110003";

  async function post(
    request: unknown,
    { signed = true }: { signed?: boolean } = {},
  ) {
    const { body, aesKey, iv } = encryptFlowRequest(request, keys.publicKey);
    const raw = JSON.stringify(body);
    const res = await fetch(`${base}/flows`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signed ? { "x-hub-signature-256": sign(raw, APP_SECRET) } : {}),
      },
      body: raw,
    });
    const text = await res.text();
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      decrypted: () => decryptFlowResponse(text, aesKey, iv),
    };
  }

  test("answers the health check, encrypted", async () => {
    const r = await post({ version: "3.0", action: "ping" });
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/plain");
    expect(r.decrypted()).toEqual({ data: { status: "active" } });
  });

  test("refuses a request without Meta's signature (432)", async () => {
    const r = await post({ version: "3.0", action: "ping" }, { signed: false });
    expect(r.status).toBe(432);
  });

  test("answers 421 to a body it can't decrypt, so WhatsApp refetches the key", async () => {
    const raw = JSON.stringify({
      encrypted_flow_data: "AAAA",
      encrypted_aes_key: "AAAA",
      initial_vector: "AAAA",
    });
    const res = await fetch(`${base}/flows`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(raw, APP_SECRET),
      },
      body: raw,
    });
    expect(res.status).toBe(421);
  });

  test("answers 427 to a token that isn't an open form", async () => {
    const r = await post({
      version: "3.0",
      action: "INIT",
      flow_token: "nope",
    });
    expect(r.status).toBe(427);
  });

  test("serves a WhatsApp conversation's form, which the simulator route refuses", async () => {
    await say(waId, "hi", "whatsapp");
    const token = formIn(
      await say(waId, tap("onboard:proceed"), "whatsapp"),
      "onboarding",
    );
    const r = await post({ version: "3.0", action: "INIT", flow_token: token });
    expect(r.status).toBe(200);
    expect(r.decrypted()).toEqual({ screen: "BVN", data: { bvn_error: "" } });
    expect((await exchange(token, undefined)).status).toBe(410);
  });

  test("sends the form as an interactive Flow message", () => {
    const payload = toGraphPayload(
      waId,
      {
        kind: "flow",
        flow: "onboarding",
        token: "tok",
        body: "Tap",
        cta: "Open form",
        fallback: "Reply TYPE",
      },
      {
        ids: { onboarding: "111", pin: "222", transaction: "333" },
        mode: "draft",
      },
    );
    expect(payload).toMatchObject({
      type: "interactive",
      interactive: {
        type: "flow",
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: "tok",
            flow_id: "111",
            flow_cta: "Open form",
            flow_action: "data_exchange",
            mode: "draft",
          },
        },
      },
    });
  });

  test("drops the completion message WhatsApp sends when a form closes", () => {
    const messages = extractMessages({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    from: waId,
                    id: "wamid.x",
                    timestamp: "1",
                    type: "interactive",
                    interactive: {
                      type: "nfm_reply",
                      nfm_reply: { response_json: "{}", name: "flow" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages).toEqual([]);
  });
});
