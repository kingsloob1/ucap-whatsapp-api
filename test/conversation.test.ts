import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { ConversationService } from "../src/conversation/conversation.service";
import { UsersRepository } from "../src/database/users.repository";
import { testApp } from "./helpers";
import type {
  InboundInput,
  OutboundMessage,
} from "../src/whatsapp/whatsapp.interface";

let app: INestApplication;
let conversation: ConversationService;
let users: UsersRepository;

beforeAll(async () => {
  ({ app } = await testApp());
  await app.init();
  conversation = app.get(ConversationService);
  users = app.get(UsersRepository);
});

afterAll(async () => {
  await app.close();
});

/** Sends one message as `waId` and answers the replies and the step the session is left at. */
async function say(
  waId: string,
  input: string | InboundInput,
  name = "Ada Obi",
) {
  const replies = await conversation.handle(
    { waId, name },
    typeof input === "string" ? { text: input } : input,
    {
      source: "simulator",
    },
  );
  const session = await conversation.session(waId);
  return {
    replies,
    step: session?.step ?? null,
    body: replies.map(bodyOf).join("\n"),
  };
}

function bodyOf(message: OutboundMessage): string {
  return message.body;
}

const tap = (choiceId: string, text = choiceId): InboundInput => ({
  text,
  choiceId,
});

async function onboard(waId: string, bvn: string, pin = "4826") {
  await say(waId, "hi");
  await say(waId, tap("onboard:proceed", "Proceed"));
  await say(waId, bvn);
  await say(waId, "25/12/1990");
  await say(waId, "1,5");
  await say(waId, pin);
  return say(waId, pin);
}

describe("onboarding", () => {
  const waId = "2348000000001";

  test("a new user is welcomed and offered Proceed or Close", async () => {
    const r = await say(waId, "Hello");
    expect(r.step).toBe("onboarding_prompt");
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({
      kind: "buttons",
      buttons: [{ id: "onboard:proceed" }, { id: "close" }],
    });
    expect(r.body).toContain("Welcome to *InvestNow*, Ada!");
  });

  test("Close ends the session", async () => {
    const r = await say(waId, tap("close", "Close"));
    expect(r.step).toBeNull();
    expect(r.body).toContain("session has been closed");
  });

  test("BVN, date of birth, products and PIN, with the errors in between", async () => {
    await say(waId, "hi");
    expect((await say(waId, tap("onboard:proceed"))).step).toBe("ask_bvn");

    let r = await say(waId, "12345");
    expect(r.step).toBe("ask_bvn");
    expect(r.body).toContain("11 digits");

    expect((await say(waId, "22233344455")).step).toBe("ask_dob");

    r = await say(waId, "01/01/2015");
    expect(r.step).toBe("ask_dob");
    expect(r.body).toContain("at least 18");

    r = await say(waId, "25/12/1990");
    expect(r.step).toBe("select_products");
    expect(r.body).toContain("1.* Money Market Fund");

    r = await say(waId, "9");
    expect(r.step).toBe("select_products");

    r = await say(waId, "1, 5 and 6");
    expect(r.step).toBe("set_pin");
    expect(r.body).toContain("Money Market Fund, Stocks, Trustees");

    expect((await say(waId, "1111")).step).toBe("set_pin");
    expect((await say(waId, "4826")).step).toBe("confirm_pin");

    // The session never holds the PIN itself.
    const pending = await conversation.session(waId);
    expect(JSON.stringify(pending)).not.toContain("4826");

    r = await say(waId, "4827");
    expect(r.step).toBe("set_pin");
    expect(r.body).toContain("don't match");

    await say(waId, "4826");
    r = await say(waId, "4826");
    expect(r.step).toBe("menu");
    expect(r.replies.map((m) => m.kind)).toEqual(["text", "list"]);
    expect(r.body).toContain("*******4455");
  });

  test("the user is saved permanently, with a hashed PIN and their products", async () => {
    const user = await users.findByWaId(waId);
    expect(user).toMatchObject({
      waId,
      name: "Ada Obi",
      bvn: "22233344455",
      dateOfBirth: "1990-12-25",
    });
    expect(user!.pinHash).not.toContain("4826");
    expect(await Bun.password.verify("4826", user!.pinHash)).toBe(true);
    expect((await users.holdings(user!.id)).map((h) => h.productCode)).toEqual([
      "MMF",
      "STK",
      "TRS",
    ]);
  });

  test("a BVN already registered is refused", async () => {
    const other = "2348000000002";
    await say(other, "hi");
    await say(other, tap("onboard:proceed"));
    const r = await say(other, "22233344455");
    expect(r.step).toBe("ask_bvn");
    expect(r.body).toContain("already linked");
  });

  test("an onboarded user coming back gets the menu", async () => {
    await say(waId, "cancel");
    const r = await say(waId, "hi");
    expect(r.step).toBe("menu");
    expect(r.replies[0]).toMatchObject({ kind: "list" });
    expect(r.body).toContain("Welcome back");
  });
});

describe("menu actions", () => {
  const waId = "2348000000003";

  beforeAll(async () => {
    expect((await onboard(waId, "11122233344")).step).toBe("menu");
  });

  test("withdraw and buy with an empty wallet send the user back to the menu", async () => {
    let r = await say(waId, tap("menu:withdraw"));
    expect(r.step).toBe("menu");
    expect(r.body).toContain("wallet is empty");

    await say(waId, tap("menu:buy"));
    r = await say(waId, tap("product:EQF"));
    expect(r.step).toBe("menu");
    expect(r.body).toContain("fund your wallet first");
  });

  test("fund: amount, then PIN, with wrong PINs counted", async () => {
    expect((await say(waId, "1")).step).toBe("fund_amount");
    expect((await say(waId, "50")).step).toBe("fund_amount"); // under the minimum
    expect((await say(waId, "50k")).step).toBe("authorize");

    let r = await say(waId, "9999");
    expect(r.step).toBe("authorize");
    expect(r.body).toContain("2 attempts left");

    r = await say(waId, "4826");
    expect(r.step).toBe("menu");
    expect(r.body).toContain("₦50,000.00");
    const user = (await users.findByWaId(waId))!;
    expect(await users.walletBalance(user.id)).toBe(5_000_000);
  });

  test("three wrong PINs cancel the request", async () => {
    await say(waId, "fund");
    await say(waId, "1000");
    await say(waId, "1111");
    await say(waId, "2222");
    const r = await say(waId, "3333");
    expect(r.step).toBe("menu");
    expect(r.body).toContain("Too many incorrect PIN attempts");
    const user = (await users.findByWaId(waId))!;
    expect(await users.walletBalance(user.id)).toBe(5_000_000);
  });

  test("buy moves money from the wallet into the product", async () => {
    await say(waId, tap("menu:buy"));
    expect((await say(waId, tap("product:EQF"))).step).toBe("buy_amount");
    expect((await say(waId, "60000")).step).toBe("buy_amount"); // more than the wallet holds
    await say(waId, "20,000");
    const r = await say(waId, "4826");
    expect(r.body).toContain("You bought ₦20,000.00 of Equity Fund");
    const user = (await users.findByWaId(waId))!;
    expect(await users.walletBalance(user.id)).toBe(3_000_000);
    expect(
      (await users.holdings(user.id)).find((h) => h.productCode === "EQF")
        ?.balanceKobo,
    ).toBe(2_000_000);
  });

  test("withdraw refuses more than the wallet holds, then debits it", async () => {
    await say(waId, "withdraw");
    expect((await say(waId, "40000")).body).toContain("up to ₦30,000.00");
    await say(waId, "5000");
    const r = await say(waId, "4826");
    expect(r.body).toContain("Wallet balance: ₦25,000.00");
  });

  test("balance needs the PIN and lists every holding", async () => {
    expect((await say(waId, tap("menu:balance"))).step).toBe("authorize");
    const r = await say(waId, "4826");
    expect(r.body).toContain("Wallet: ₦25,000.00");
    expect(r.body).toContain("Equity Fund: ₦20,000.00");
    expect(r.body).toContain("Total: ₦45,000.00");
  });

  test("MENU leaves a pending action, CANCEL ends the session", async () => {
    await say(waId, "fund");
    expect((await say(waId, "menu")).step).toBe("menu");
    expect((await say(waId, "cancel")).step).toBeNull();
  });
});

test("one user's messages are handled in order, even when they arrive together", async () => {
  const waId = "2348000000004";
  const results = await Promise.all([
    say(waId, "hi"),
    say(waId, tap("onboard:proceed")),
    say(waId, "33344455566"),
  ]);
  expect(results.map((r) => r.replies[0]?.body.slice(0, 20))).toEqual([
    expect.stringContaining("Welcome"),
    expect.stringContaining("Great"),
    expect.stringContaining("Step 2 of 4"),
  ]);
  expect((await conversation.session(waId))?.step).toBe("ask_dob");
});

test("a media message is answered without moving the session", async () => {
  const waId = "2348000000005";
  await say(waId, "hi");
  const r = await say(waId, { text: "" });
  expect(r.step).toBe("onboarding_prompt");
  expect(r.body).toContain("only read text");
});
