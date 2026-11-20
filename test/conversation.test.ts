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
  await say(waId, pin);
  return say(waId, tap("review:confirm", "Confirm & create"));
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
    expect(r.body).toContain("dial ```*7277#```");
  });

  test("Close ends the session", async () => {
    const r = await say(waId, tap("close", "Close"));
    expect(r.step).toBeNull();
    expect(r.body).toContain("session has been closed");
    expect(r.body).toContain("```*7277#```");
  });

  test("BVN, date of birth, products and PIN, with the errors in between", async () => {
    await say(waId, "hi");
    const prompt = await say(waId, tap("onboard:proceed"));
    expect(prompt.step).toBe("ask_bvn");
    // Monospace: the USSD code's asterisks must never render as WhatsApp bold.
    expect(prompt.body).toContain("```*565*0#```");

    let r = await say(waId, "12345");
    expect(r.step).toBe("ask_bvn");
    expect(r.body).toContain("11 digits");

    expect((await say(waId, "22233344455")).step).toBe("ask_dob");

    r = await say(waId, "01/01/2023");
    expect(r.step).toBe("ask_dob");
    expect(r.body).toContain("at least 5");

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
    expect(r.step).toBe("review");
    expect(r.replies[0]).toMatchObject({ kind: "list" });
    expect(r.body).toContain("BVN: •••••••4455");
    expect(r.body).toContain("Date of birth: 25/12/1990");
    expect(r.body).toContain("Products: Money Market Fund, Stocks, Trustees");
    expect(await users.findByWaId(waId)).toBeNull(); // nothing saved before the confirm

    r = await say(waId, tap("review:confirm", "Confirm & create"));
    expect(r.step).toBe("menu");
    expect(r.replies.map((m) => m.kind)).toEqual(["text", "list"]);
    expect(r.body).toContain("BVN: •••••••4455");
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

describe("editing onboarding answers before the account is created", () => {
  const waId = "2348000000006";

  async function toReview() {
    await say(waId, "hi");
    await say(waId, tap("onboard:proceed"));
    await say(waId, "22244556677");
    await say(waId, "01/02/1985");
    await say(waId, "2");
    await say(waId, "4826");
    return say(waId, "4826");
  }

  test("the review lists every answer and an edit row for each", async () => {
    const r = await toReview();
    expect(r.step).toBe("review");
    const message = r.replies[0]!;
    expect(message.kind).toBe("list");
    if (message.kind === "list")
      expect(message.sections[0]!.rows.map((row) => row.id)).toEqual([
        "review:confirm",
        "review:bvn",
        "review:dob",
        "review:products",
        "review:pin",
      ]);
  });

  test("an edit validates like the original step, then returns to the review", async () => {
    let r = await say(waId, tap("review:bvn", "Edit BVN"));
    expect(r.step).toBe("edit_bvn");
    expect(r.body).toContain("Current: •••••••6677");

    r = await say(waId, "123");
    expect(r.step).toBe("edit_bvn");
    expect(r.body).toContain("11 digits");

    r = await say(waId, "22233344455"); // registered by the onboarding tests
    expect(r.step).toBe("edit_bvn");
    expect(r.body).toContain("already linked");

    r = await say(waId, "22255667788");
    expect(r.step).toBe("review");
    expect(r.body).toContain("BVN updated");
    expect(r.body).toContain("BVN: •••••••7788");
  });

  test("date of birth and products, typed with the numbers instead of tapping", async () => {
    expect((await say(waId, "3")).step).toBe("edit_dob");
    expect((await say(waId, "01/01/2023")).body).toContain("at least 5");
    let r = await say(waId, "15/06/1992");
    expect(r.step).toBe("review");
    expect(r.body).toContain("Date of birth: 15/06/1992");

    expect((await say(waId, "edit products")).step).toBe("edit_products");
    r = await say(waId, "1,4");
    expect(r.step).toBe("review");
    expect(r.body).toContain("Products: Money Market Fund, Equity Fund");
  });

  test("BACK leaves the value as it was", async () => {
    expect((await say(waId, tap("review:dob"))).step).toBe("edit_dob");
    const r = await say(waId, "back");
    expect(r.step).toBe("review");
    expect(r.body).toContain("No changes made");
    expect(r.body).toContain("Date of birth: 15/06/1992");
  });

  test("changing the PIN is confirmed too, and a mismatch asks again", async () => {
    expect((await say(waId, tap("review:pin"))).step).toBe("edit_pin");
    expect((await say(waId, "1234")).step).toBe("edit_pin"); // a sequence
    expect((await say(waId, "5917")).step).toBe("edit_pin_confirm");
    let r = await say(waId, "5918");
    expect(r.step).toBe("edit_pin");
    expect(r.body).toContain("don't match");
    await say(waId, "5917");
    r = await say(waId, "5917");
    expect(r.step).toBe("review");
    expect(r.body).toContain("PIN changed");
    expect(JSON.stringify(await conversation.session(waId))).not.toContain(
      "5917",
    );
  });

  test("an unknown reply shows the review again", async () => {
    const r = await say(waId, "maybe");
    expect(r.step).toBe("review");
    expect(r.body).toContain("didn't catch that");
  });

  test("confirming saves the edited answers", async () => {
    const r = await say(waId, "confirm");
    expect(r.step).toBe("menu");
    const user = (await users.findByWaId(waId))!;
    expect(user).toMatchObject({
      bvn: "22255667788",
      dateOfBirth: "1992-06-15",
    });
    expect(await Bun.password.verify("5917", user.pinHash)).toBe(true);
    expect(
      (await users.holdings(user.id)).map((h) => h.productCode).sort(),
    ).toEqual(["EQF", "MMF"]);
  });
});

describe("menu actions", () => {
  const waId = "2348000000003";

  beforeAll(async () => {
    expect((await onboard(waId, "22211122233")).step).toBe("menu");
  });

  test("withdraw and buy with an empty wallet send the user back to the menu", async () => {
    let r = await say(waId, tap("menu:withdraw"));
    expect(r.step).toBe("menu");
    expect(r.body).toContain("wallet is empty");

    r = await say(waId, tap("menu:buy"));
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
    expect((await say(waId, "20,000")).step).toBe("buy_confirm");
    expect((await say(waId, tap("buy:confirm", "Confirm"))).step).toBe(
      "authorize",
    );
    const r = await say(waId, "4826");
    expect(r.body).toContain("You bought ₦20,000.00 of Equity Fund");
    expect(r.body).toContain("About 10,675.77 units at ₦1.8734");
    expect(r.body).toContain("🔒 *Keep your investments private:*");
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

  test("MENU leaves a pending action, CLOSE ends the session", async () => {
    await say(waId, "fund");
    expect((await say(waId, "menu")).step).toBe("menu");
    expect((await say(waId, "close")).step).toBeNull();
  });
});

describe("buying, product by product", () => {
  const waId = "2348000000012";
  const PIN = "4826";
  const ids = (r: Awaited<ReturnType<typeof say>>) => {
    const m = r.replies[0]!;
    return m.kind === "buttons"
      ? m.buttons.map((b) => b.id)
      : m.kind === "list"
        ? m.sections.flatMap((sec) => sec.rows.map((row) => row.id))
        : [];
  };

  beforeAll(async () => {
    await onboard(waId, "22255566633");
    await say(waId, "fund");
    await say(waId, "1000000");
    await say(waId, PIN);
  });

  test("Money Market Fund: the rate and an example, then the daily interest to confirm", async () => {
    await say(waId, "buy");
    let r = await say(waId, tap("product:MMF"));
    expect(r.step).toBe("buy_amount");
    expect(r.body).toContain("Current rate: *18.50% a year*");
    expect(r.body).toContain(
      "₦100,000.00 earns about *₦50.68 a day*, or ₦1,520.55 in 30 days",
    );

    r = await say(waId, "50000");
    expect(r.step).toBe("buy_confirm");
    expect(r.body).toContain("Amount: *₦50,000.00*");
    expect(r.body).toContain(
      "Expected interest: about *₦25.34 a day* (₦760.27 in 30 days)",
    );
    expect(ids(r)).toEqual(["buy:confirm", "buy:change", "cancel"]);

    // Change amount asks again; the new amount gets its own quote.
    expect((await say(waId, tap("buy:change", "Change amount"))).step).toBe(
      "buy_amount",
    );
    r = await say(waId, "10000");
    expect(r.body).toContain("about *₦5.07 a day*");

    r = await say(waId, tap("buy:confirm", "Confirm"));
    expect(r.step).toBe("authorize");
    expect(r.body).toContain(
      "Buy ₦10,000.00 of Money Market Fund from your wallet (18.50% a year, about ₦5.07 a day)",
    );
    r = await say(waId, PIN);
    expect(r.body).toContain("You bought ₦10,000.00 of Money Market Fund");
  });

  test("Fixed Income Fund: the term sets the rate; interest at maturity", async () => {
    await say(waId, "buy");
    let r = await say(waId, tap("product:FIF"));
    expect(r.step).toBe("buy_tenor");
    expect(ids(r)).toEqual(["tenor:90", "tenor:180", "tenor:365"]);
    expect(r.body).toContain("• 180 days: 16.25% a year");
    expect((await say(waId, "45 days")).step).toBe("buy_tenor");

    r = await say(waId, tap("tenor:180", "180 days"));
    expect(r.step).toBe("buy_amount");
    expect(r.body).toContain(
      "₦100,000.00 for 180 days earns about *₦8,013.70*",
    );

    r = await say(waId, "20000");
    expect(r.body).toMatch(/Term: 180 days, ending \d{1,2} \w{3} \d{4}/);
    expect(r.body).toContain("Expected interest: about *₦1,602.74*");
    expect(r.body).toContain("Paid back at the end: about *₦21,602.74*");
    await say(waId, "cancel");
  });

  test("Balanced Fund: unit price, past return and risk; the units an amount buys", async () => {
    await say(waId, "buy");
    let r = await say(waId, tap("product:BAL"));
    expect(r.body).toContain("Unit price: *₦2.4512*");
    expect(r.body).toContain("Past year's return: 21.40%");
    expect(r.body).toContain("Risk: Medium");
    expect(r.body).toContain("₦100,000.00 buys about 40,796.34 units");
    r = await say(waId, "10000");
    expect(r.body).toContain("Units: about *4,079.63*");
    await say(waId, "cancel");
  });

  test("Stocks: the stock, then a whole number of shares the wallet can pay for", async () => {
    await say(waId, "buy");
    let r = await say(waId, tap("product:STK"));
    expect(r.step).toBe("buy_stock");
    expect(ids(r)).toContain("stock:MTNN");

    r = await say(waId, tap("stock:MTNN", "MTN Nigeria"));
    expect(r.step).toBe("buy_shares");
    expect(r.body).toContain("Price: *₦230.00 a share*");
    expect(r.body).toContain("can buy up to");

    for (const bad of ["ten", "0", "2.5"])
      expect((await say(waId, bad)).body).toContain("whole number of shares");
    r = await say(waId, "99999");
    expect(r.step).toBe("buy_shares");
    expect(r.body).toContain("more than your wallet balance");

    r = await say(waId, "40");
    expect(r.step).toBe("buy_confirm");
    expect(r.body).toContain("Stock: MTN Nigeria (MTNN)");
    expect(r.body).toContain("Shares: 40 × ₦230.00");
    expect(r.body).toContain("Total: *₦9,200.00*");
    const m = r.replies[0]!;
    expect(m.kind === "buttons" && m.buttons[1]!.title).toBe("Change shares");

    expect((await say(waId, "change")).step).toBe("buy_shares");
    await say(waId, "40");
    await say(waId, "confirm");
    r = await say(waId, PIN);
    expect(r.body).toContain("You bought ₦9,200.00 of Stocks");
    expect(r.body).toContain("40 MTNN shares at ₦230.00");
  });

  test("Trustees: the service, the beneficiary's full name and relationship, then the amount", async () => {
    await say(waId, "buy");
    let r = await say(waId, tap("product:TRS"));
    expect(r.step).toBe("buy_trust");
    expect(ids(r)).toEqual(["trust:0", "trust:1", "trust:2", "trust:3"]);

    r = await say(waId, tap("trust:0", "Simple will"));
    expect(r.step).toBe("buy_beneficiary");
    expect(r.body).toContain("main beneficiary of your will");
    expect((await say(waId, "Chidi")).body).toContain("first name and surname");
    expect((await say(waId, "12345")).body).toContain("in letters");

    r = await say(waId, "  Chidi   Okafor ");
    expect(r.step).toBe("buy_relationship");
    expect(r.body).toContain("What is Chidi Okafor to you?");
    expect((await say(waId, "cousin")).step).toBe("buy_relationship");

    r = await say(waId, tap("rel:spouse", "Spouse"));
    expect(r.step).toBe("buy_amount");
    expect(r.body).toContain("your *simple will* for Chidi Okafor");

    r = await say(waId, "25000");
    expect(r.body).toContain("Service: Simple will");
    expect(r.body).toContain("Beneficiary: Chidi Okafor (Spouse)");

    // Cancel on the confirmation buys nothing.
    const user = (await users.findByWaId(waId))!;
    const before = await users.walletBalance(user.id);
    r = await say(waId, tap("cancel", "Cancel"));
    expect(r.replies[0]!.body).toBe(
      "❌ Your purchase was cancelled. No money was moved.",
    );
    expect(await users.walletBalance(user.id)).toBe(before);
  });
});

describe("liquidating", () => {
  const waId = "2348000000014";
  const PIN = "4826";

  beforeAll(async () => {
    await onboard(waId, "22255566655"); // Money Market Fund and Stocks, ₦0 in each
    await say(waId, "fund");
    await say(waId, "100000");
    await say(waId, PIN);
  });

  test("with nothing invested, there is nothing to liquidate", async () => {
    const r = await say(waId, tap("menu:liquidate", "Liquidate"));
    expect(r.step).toBe("menu");
    expect(r.replies[0]!.body).toContain(
      "You don't have any investments to liquidate yet",
    );
  });

  test("a product, an amount, the confirmation, then the PIN moves money back to the wallet", async () => {
    for (const [product, amount] of [
      ["product:EQF", "30000"],
      ["product:FIF", "20000"],
    ] as const) {
      await say(waId, "buy");
      await say(waId, tap(product));
      if (product === "product:FIF") await say(waId, tap("tenor:90"));
      await say(waId, amount);
      await say(waId, "confirm");
      await say(waId, PIN);
    }
    const user = (await users.findByWaId(waId))!;
    expect(await users.walletBalance(user.id)).toBe(5_000_000);

    // Only products with money in them are offered (not the ₦0 ones from onboarding).
    let r = await say(waId, "5");
    expect(r.step).toBe("liquidate_product");
    const m = r.replies[0]!;
    expect(
      m.kind === "list" && m.sections[0]!.rows.map((row) => row.id),
    ).toEqual(["liquidate:EQF", "liquidate:FIF"]);

    r = await say(waId, tap("liquidate:FIF", "Fixed Income Fund"));
    expect(r.step).toBe("liquidate_amount");
    expect(r.body).toContain("You hold *₦20,000.00*");
    expect(r.body).toContain("can cost some of the interest earned");

    r = await say(waId, "25000");
    expect(r.step).toBe("liquidate_amount");
    expect(r.body).toContain("You hold ₦20,000.00 in Fixed Income Fund");

    r = await say(waId, "5000");
    expect(r.step).toBe("liquidate_confirm");
    expect(r.body).toContain("Amount: *₦5,000.00*");
    expect(r.body).toContain("Left in Fixed Income Fund: ₦15,000.00");
    expect(r.body).toContain("Wallet after: ₦55,000.00");

    expect((await say(waId, tap("liquidate:change"))).step).toBe(
      "liquidate_amount",
    );
    await say(waId, "ALL");
    r = await say(waId, tap("liquidate:confirm", "Confirm"));
    expect(r.step).toBe("authorize");
    expect(r.body).toContain(
      "Liquidate ₦20,000.00 of Fixed Income Fund into your wallet",
    );
    r = await say(waId, PIN);
    expect(r.body).toContain(
      "✅ ₦20,000.00 of Fixed Income Fund was liquidated into your wallet",
    );
    expect(r.body).toContain("Fixed Income Fund: ₦0.00");
    expect(r.body).toContain("Wallet balance: ₦70,000.00");
    expect(r.body).toContain("🔒 *Keep your investments private:*");
    expect(await users.walletBalance(user.id)).toBe(7_000_000);
  });

  test("the history shows it, and an emptied product is no longer offered", async () => {
    await say(waId, "history");
    let r = await say(waId, PIN);
    expect(r.body).toContain(
      "1. *Liquidated Fixed Income Fund* · +₦20,000.00 to wallet",
    );
    r = await say(waId, tap("menu:liquidate"));
    const m = r.replies[0]!;
    expect(
      m.kind === "list" && m.sections[0]!.rows.map((row) => row.id),
    ).toEqual(["liquidate:EQF"]);
    expect(m.kind === "list" && m.sections[0]!.rows[0]!.description).toBe(
      "₦30,000.00 invested",
    );
  });

  test("CANCEL on the confirmation moves nothing", async () => {
    await say(waId, tap("liquidate:EQF"));
    await say(waId, "all");
    const r = await say(waId, tap("cancel", "Cancel"));
    expect(r.replies[0]!.body).toBe(
      "❌ Your liquidation was cancelled. No money was moved.",
    );
    const user = (await users.findByWaId(waId))!;
    expect(
      (await users.holdings(user.id)).find((h) => h.productCode === "EQF")
        ?.balanceKobo,
    ).toBe(3_000_000);
  });

  test("the repository refuses more than the product holds", async () => {
    const user = (await users.findByWaId(waId))!;
    await expect(
      users.liquidateProduct(user.id, "EQF", 3_000_001),
    ).rejects.toMatchObject({ availableKobo: 3_000_000 });
  });
});

describe("privacy reminders", () => {
  test("when onboarding starts, when the account is ready, and after a transaction", async () => {
    const waId = "2348000000013";
    await say(waId, "hi");
    let r = await say(waId, tap("onboard:proceed"));
    expect(r.body).toContain("🔒 You'll share your BVN and create a PIN here");
    expect(r.body).toContain("*Chat lock*");

    r = await onboard(waId, "22255566644");
    expect(r.replies[0]!.body).toContain("Your InvestNow account is ready");
    expect(r.replies[0]!.body).toContain("🔒 *Keep your investments private:*");

    await say(waId, "fund");
    await say(waId, "5000");
    r = await say(waId, "4826");
    expect(r.body).toContain("*Clear chat*");
  });
});

describe("my products and transaction history", () => {
  const waId = "2348000000010";
  const PIN = "4826";

  /** The page message's buttons, as their ids. */
  const nav = (r: Awaited<ReturnType<typeof say>>) => {
    const m = r.replies[0]!;
    return m.kind === "buttons" ? m.buttons.map((b) => b.id) : [];
  };
  const footer = (r: Awaited<ReturnType<typeof say>>) => {
    const m = r.replies[0]!;
    return m.kind === "buttons" ? m.footer : undefined;
  };

  beforeAll(async () => {
    await onboard(waId, "22255566611"); // Money Market Fund and Stocks
    await say(waId, "fund");
    await say(waId, "60000");
    await say(waId, PIN);
    // A purchase in each of the six products: 7 transactions, 6 holdings.
    const steps: Record<string, string[]> = {
      "1": ["1000"], // Money Market Fund
      "2": ["90", "2000"], // Fixed Income Fund: the term, then the amount
      "3": ["3000"], // Balanced Fund
      "4": ["4000"], // Equity Fund
      "5": ["1", "10"], // Stocks: Dangote Cement, 10 shares (₦4,800.00)
      "6": ["3", "Ada Obi", "2", "6000"], // Trustees: education trust for a child
    };
    for (const [n, answers] of Object.entries(steps)) {
      await say(waId, "buy");
      await say(waId, n);
      for (const a of answers) await say(waId, a);
      await say(waId, "confirm");
      await say(waId, PIN);
    }
  });

  test("the menu lists both, after Buy products and Liquidate", async () => {
    const r = await say(waId, "menu");
    const menu = r.replies[0]!;
    expect(menu.kind).toBe("list");
    const rows =
      menu.kind === "list" ? menu.sections.flatMap((s) => s.rows) : [];
    expect(rows.map((row) => row.id)).toEqual([
      "menu:fund",
      "menu:balance",
      "menu:withdraw",
      "menu:buy",
      "menu:liquidate",
      "menu:products",
      "menu:history",
      "close",
    ]);
  });

  test("My products asks for the PIN, then pages through the holdings", async () => {
    let r = await say(waId, tap("menu:products", "My products"));
    expect(r.step).toBe("authorize");
    expect(r.body).toContain("PIN to view your products");

    r = await say(waId, PIN);
    expect(r.step).toBe("browse");
    expect(r.body).toContain("📊 *Your products*");
    expect(r.body).toContain("1. *Money Market Fund*\n₦1,000.00");
    expect(r.body).toContain("*Total invested: ₦20,800.00*");
    expect(r.body).not.toContain("6.");
    expect(footer(r)).toBe("Page 1 of 2");
    expect(nav(r)).toEqual(["page:next", "menu"]);

    // The next page needs no PIN.
    r = await say(waId, tap("page:next", "Next ▶"));
    expect(r.step).toBe("browse");
    expect(r.body).toContain("6. *");
    expect(footer(r)).toBe("Page 2 of 2");
    expect(nav(r)).toEqual(["page:previous", "menu"]);
  });

  test("Transaction history pages newest first, and stays in range", async () => {
    await say(waId, "history");
    let r = await say(waId, PIN);
    expect(r.step).toBe("browse");
    expect(r.body).toContain("🧾 *Transaction history*");
    expect(r.body).toContain(
      "1. *Bought Trustees* · ₦6,000.00\nEducation trust for Ada Obi (Child)\n",
    );
    expect(r.body).toContain("10 DANGCEM shares at ₦480.00");
    expect(r.body).toMatch(/\d{1,2} \w{3} \d{4}, \d{2}:\d{2} · Ref BUY-/);
    expect(r.body).not.toContain("Wallet funded");
    expect(footer(r)).toBe("Page 1 of 2");

    r = await say(waId, "next");
    expect(r.body).toContain("6. *Bought Money Market Fund* · ₦1,000.00");
    expect(r.body).toContain("7. *Wallet funded* · +₦60,000.00");
    expect(footer(r)).toBe("Page 2 of 2");

    // A Next tapped on an old message, past the end: the last page again.
    r = await say(waId, tap("page:next", "Next ▶"));
    expect(footer(r)).toBe("Page 2 of 2");

    r = await say(waId, "Previous");
    expect(footer(r)).toBe("Page 1 of 2");
    expect((await say(waId, tap("menu", "Menu"))).step).toBe("menu");
  });

  test("from a page, a menu choice or CANCEL goes on as from the menu", async () => {
    await say(waId, "history");
    await say(waId, PIN);
    expect((await say(waId, "2")).step).toBe("authorize"); // Check balance
    await say(waId, "cancel");

    await say(waId, "history");
    await say(waId, PIN);
    const r = await say(waId, "cancel");
    expect(r.step).toBe("menu");
    expect(r.replies).toHaveLength(1);
    expect(r.body).not.toContain("nothing to cancel");
  });

  test("cancelling at the PIN says what was dropped, without money words", async () => {
    await say(waId, "history");
    const r = await say(waId, "cancel");
    expect(r.replies[0]!.body).toBe(
      "❌ Viewing your transaction history was cancelled.",
    );
  });

  test("a user with no transactions is told so, with the menu", async () => {
    const other = "2348000000011";
    await onboard(other, "22255566622");
    await say(other, "history");
    const r = await say(other, PIN);
    expect(r.step).toBe("menu");
    expect(r.replies[0]!.body).toContain(
      "You haven't made any transactions yet",
    );
    expect(r.replies[1]).toMatchObject({ kind: "list" });
  });
});

describe("cancelling", () => {
  const waId = "2348000000007";

  beforeAll(async () => {
    await onboard(waId, "22233344477");
    await say(waId, "fund");
    await say(waId, "50000");
    await say(waId, "4826");
  });

  /** Expects the confirmation, then the menu. */
  function cancelled(r: Awaited<ReturnType<typeof say>>, what: string) {
    expect(r.step).toBe("menu");
    expect(r.replies).toHaveLength(2);
    expect(r.replies[0]).toMatchObject({ kind: "text" });
    expect(r.replies[0]!.body).toBe(what);
    expect(r.replies[1]).toMatchObject({ kind: "list" });
  }

  test("CANCEL while asked for an amount", async () => {
    await say(waId, "fund");
    cancelled(
      await say(waId, "cancel"),
      "❌ Your wallet funding was cancelled. No money was moved.",
    );
  });

  test("other ways to say it, at the PIN: go back, never mind, forget it", async () => {
    await say(waId, "withdraw");
    await say(waId, "1000");
    cancelled(
      await say(waId, "Go back!"),
      "❌ Your withdrawal was cancelled. No money was moved.",
    );
    await say(waId, "buy");
    cancelled(
      await say(waId, "Never mind"),
      "❌ Your purchase was cancelled. No money was moved.",
    );
    await say(waId, "balance");
    cancelled(
      await say(waId, "forget it."),
      "❌ Your balance check was cancelled.",
    );
  });

  test("a cancelled request is gone: the PIN no longer approves it", async () => {
    await say(waId, "withdraw");
    await say(waId, "1000");
    await say(waId, "cancel");
    const r = await say(waId, "4826");
    expect(r.step).toBe("menu");
    expect(r.body).not.toContain("withdrawn");
  });

  test("at the menu there is nothing to cancel", async () => {
    const r = await say(waId, "cancel");
    expect(r.step).toBe("menu");
    expect(r.replies).toHaveLength(1);
    expect(r.body).toContain("There's nothing to cancel");
  });

  test("onboarding goes back to the Proceed/Close prompt, and can start again", async () => {
    const other = "2348000000008";
    await say(other, "hi");
    await say(other, tap("onboard:proceed"));
    await say(other, "22233344488");
    const r = await say(other, "cancel");
    expect(r.step).toBe("onboarding_prompt");
    expect(r.replies[0]!.body).toBe(
      "❌ Your account setup was cancelled. Nothing was saved.",
    );
    expect(r.replies[1]).toMatchObject({
      kind: "buttons",
      buttons: [{ id: "onboard:proceed" }, { id: "close" }],
    });
    expect((await say(other, tap("onboard:proceed"))).body).toContain(
      "Step 1 of 4",
    );
    expect((await say(other, "cancel")).step).toBe("onboarding_prompt");
    // At the prompt itself, cancelling ends the conversation.
    expect((await say(other, "cancel")).step).toBeNull();
  });

  test("in an edit, BACK returns to the review but CANCEL cancels the setup", async () => {
    const other = "2348000000009";
    await say(other, "hi");
    await say(other, tap("onboard:proceed"));
    await say(other, "22233344499");
    await say(other, "25/12/1990");
    await say(other, "1");
    await say(other, "4826");
    await say(other, "4826");
    await say(other, tap("review:bvn"));
    expect((await say(other, "go back")).step).toBe("review");
    await say(other, tap("review:bvn"));
    expect((await say(other, "cancel")).step).toBe("onboarding_prompt");
  });
});

test("one user's messages are handled in order, even when they arrive together", async () => {
  const waId = "2348000000004";
  const results = await Promise.all([
    say(waId, "hi"),
    say(waId, tap("onboard:proceed")),
    say(waId, "22234455566"),
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
