import type { Cache } from "@kingsleyweb/bun-cache";
import { InjectCache } from "@kingsleyweb/bun-nest/cache";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import {
  DuplicateUserError,
  InsufficientFundsError,
  UsersRepository,
} from "../database/users.repository";
import { SessionsRepository } from "../database/sessions.repository";
import { buttons, list, text } from "../whatsapp/messages";
import { KeyedMutex } from "./keyed-mutex";
import {
  formatNaira,
  maskBvn,
  parseAmount,
  parseBvn,
  parseDateOfBirth,
  parseNewPin,
  parseSelection,
} from "./parsers";
import { PRODUCTS, productByCode, productTitle } from "./products";
import {
  BVN_USSD,
  INVESTNOW_USSD,
  SESSION_CACHE,
  sessionKey,
  ussd,
} from "./conversation.constants";
import type { User } from "../database/users.interface";
import type {
  InboundInput,
  OutboundMessage,
} from "../whatsapp/whatsapp.interface";
import type {
  Contact,
  Context,
  MessageMeta,
  PendingAction,
  Session,
  SessionCacheSchema,
  Transition,
} from "./conversation.interface";

const CLOSE_WORDS = new Set([
  "cancel",
  "exit",
  "close",
  "quit",
  "stop",
  "bye",
  "end",
]);
const GREETINGS = new Set([
  "hi",
  "hello",
  "hey",
  "start",
  "restart",
  "good morning",
  "good afternoon",
  "good evening",
]);
const MAX_PIN_ATTEMPTS = 3;

const CHOICE = {
  proceed: "onboard:proceed",
  close: "close",
  fund: "menu:fund",
  balance: "menu:balance",
  withdraw: "menu:withdraw",
  buy: "menu:buy",
} as const;

/**
 * The InvestNow conversation: a state machine over the session stored in
 * bun-cache, with users and money in the permanent SQLite database. One
 * message is handled at a time per user.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly mutex = new KeyedMutex();

  constructor(
    @InjectCache(SESSION_CACHE)
    private readonly sessions: Cache<SessionCacheSchema>,
    private readonly users: UsersRepository,
    private readonly log: SessionsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Handles one inbound message and answers the replies to send, in order. */
  handle(
    contact: Contact,
    input: InboundInput,
    meta: MessageMeta,
  ): Promise<OutboundMessage[]> {
    return this.mutex.run(contact.waId, () =>
      this.process(contact, input, meta),
    );
  }

  /** The stored session, for tests and debugging. */
  session(waId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionKey(waId));
  }

  /** Ends a user's session, waiting for any message of theirs still being handled. Answers whether one was live. */
  endSession(waId: string, reason: string): Promise<boolean> {
    return this.mutex.run(waId, async () => {
      const key = sessionKey(waId);
      const live = (await this.sessions.get(key)) !== undefined;
      await this.sessions.delete(key);
      await this.log.markEnded(waId, reason);
      return live;
    });
  }

  private async process(
    contact: Contact,
    input: InboundInput,
    meta: MessageMeta,
  ): Promise<OutboundMessage[]> {
    const key = sessionKey(contact.waId);
    const [session, user] = await Promise.all([
      this.sessions.get(key),
      this.users.findByWaId(contact.waId),
    ]);
    const answer = (input.choiceId ?? input.text).trim().toLowerCase();
    const ctx: Context = { contact, user, input, answer };

    const { next, replies } = await this.transition(session, ctx);
    if (next)
      await this.sessions.set(key, next, { ttl: this.config.sessionTtlMs });
    else await this.sessions.delete(key);
    this.logger.debug(
      `${contact.waId}: ${session?.step ?? "(none)"} -> ${next?.step ?? "(closed)"}`,
    );
    await this.log.record({
      waId: contact.waId,
      source: meta.source,
      ...(contact.name ? { profileName: contact.name } : {}),
      phoneNumberId: meta.phoneNumberId ?? null,
      stepBefore: session?.step ?? null,
      stepAfter: next?.step ?? null,
      input,
      replies,
      ttlMs: this.config.sessionTtlMs,
    });
    return replies;
  }

  private async transition(
    session: Session | undefined,
    ctx: Context,
  ): Promise<Transition> {
    const { answer, user } = ctx;

    if (CLOSE_WORDS.has(answer) || answer === CHOICE.close) return this.close();
    if (!session || GREETINGS.has(answer)) return this.welcome(ctx);
    if (answer === "menu")
      return user ? this.menu("What would you like to do?") : this.welcome(ctx);
    if (answer === "" && !ctx.input.choiceId) {
      return {
        next: session,
        replies: [
          text("Sorry, I can only read text messages and button taps for now."),
        ],
      };
    }

    // A session that no longer fits the user (e.g. onboarding finished elsewhere) starts over.
    const onboarded = isOnboardedStep(session);
    if (onboarded !== (user !== null)) return this.welcome(ctx);

    switch (session.step) {
      case "onboarding_prompt":
        return this.onboardingPrompt(ctx);
      case "ask_bvn":
        return this.askBvn(ctx);
      case "ask_dob":
        return this.askDob(session, ctx);
      case "select_products":
        return this.selectProducts(session, ctx);
      case "set_pin":
        return this.setPin(session, ctx);
      case "confirm_pin":
        return this.confirmPin(session, ctx);
      case "menu":
        return this.menuChoice(user!, ctx);
      case "fund_amount":
        return this.fundAmount(ctx);
      case "withdraw_amount":
        return this.withdrawAmount(user!, ctx);
      case "buy_product":
        return this.buyProduct(user!, ctx);
      case "buy_amount":
        return this.buyAmount(session, user!, ctx);
      case "authorize":
        return this.authorize(session, user!, ctx);
    }
  }

  /* ------------------------------------------------------------ welcome */

  private welcome({ contact, user }: Context): Transition {
    const name = firstName(user?.name ?? contact.name);
    if (user) {
      return this.menu(
        `Welcome back to *InvestNow*, ${name}! 👋\n\nWhat would you like to do today?`,
      );
    }
    return {
      next: { step: "onboarding_prompt" },
      replies: [
        buttons(
          `Welcome to *InvestNow*, ${name}! 👋\n\n` +
            "Invest in money market funds, stocks, trusts and more, right here on WhatsApp.\n\n" +
            "You don't have an InvestNow account yet. Would you like to set one up now? It takes about 2 minutes.\n\n" +
            `You can also use InvestNow by USSD: dial ${ussd(INVESTNOW_USSD)}.`,
          [
            { id: CHOICE.proceed, title: "Proceed" },
            { id: CHOICE.close, title: "Close" },
          ],
        ),
      ],
    };
  }

  private close(): Transition {
    return {
      next: null,
      replies: [
        text(
          "Your session has been closed. Send any message whenever you'd like to continue, " +
            `or dial ${ussd(INVESTNOW_USSD)} to use InvestNow by USSD. 👋`,
        ),
      ],
    };
  }

  /* --------------------------------------------------------- onboarding */

  private onboardingPrompt({ answer }: Context): Transition {
    if (
      answer === CHOICE.proceed ||
      ["proceed", "yes", "y", "ok", "okay", "1"].includes(answer)
    ) {
      return {
        next: { step: "ask_bvn" },
        replies: [
          text(
            "Great, let's get you set up! 🚀\n\n*Step 1 of 4*\nPlease enter your 11-digit Bank Verification Number (BVN).\n\n" +
              `Don't know it? Dial ${ussd(BVN_USSD)} from the phone number linked to your bank account.`,
          ),
        ],
      };
    }
    if (["no", "n", "2"].includes(answer)) return this.close();
    return {
      next: { step: "onboarding_prompt" },
      replies: [
        buttons(
          "Please tap *Proceed* to open your InvestNow account, or *Close* to end this session.",
          [
            { id: CHOICE.proceed, title: "Proceed" },
            { id: CHOICE.close, title: "Close" },
          ],
        ),
      ],
    };
  }

  private async askBvn({ input }: Context): Promise<Transition> {
    const bvn = parseBvn(input.text);
    if (!bvn.ok)
      return { next: { step: "ask_bvn" }, replies: [text(bvn.error)] };
    if (await this.users.isBvnRegistered(bvn.value)) {
      return {
        next: { step: "ask_bvn" },
        replies: [
          text(
            "This BVN is already linked to another InvestNow account. Please check the number and try again, " +
              "or reply CANCEL to stop.",
          ),
        ],
      };
    }
    return {
      next: { step: "ask_dob", bvn: bvn.value },
      replies: [
        text(
          "*Step 2 of 4*\nPlease enter your date of birth as DD/MM/YYYY, for example 25/12/1990.",
        ),
      ],
    };
  }

  private askDob(
    session: Extract<Session, { step: "ask_dob" }>,
    { input }: Context,
  ): Transition {
    const dob = parseDateOfBirth(input.text);
    if (!dob.ok) return { next: session, replies: [text(dob.error)] };
    return {
      next: {
        step: "select_products",
        bvn: session.bvn,
        dateOfBirth: dob.value,
      },
      replies: [productSelectionPrompt()],
    };
  }

  private selectProducts(
    session: Extract<Session, { step: "select_products" }>,
    { input }: Context,
  ): Transition {
    const selection = parseSelection(input.text, PRODUCTS.length);
    if (!selection.ok)
      return { next: session, replies: [text(selection.error)] };
    const productCodes = selection.value.map((i) => PRODUCTS[i]!.code);
    return {
      next: {
        step: "set_pin",
        bvn: session.bvn,
        dateOfBirth: session.dateOfBirth,
        productCodes,
      },
      replies: [
        text(
          `You selected: ${productCodes.map(productTitle).join(", ")}.\n\n` +
            "*Step 4 of 4*\nCreate a 4-digit transaction PIN. You'll use it to approve transactions and view balances.\n\n" +
            "🔒 _You can delete your PIN messages from this chat after sending them._",
        ),
      ],
    };
  }

  private async setPin(
    session: Extract<Session, { step: "set_pin" }>,
    { input }: Context,
  ): Promise<Transition> {
    const pin = parseNewPin(input.text);
    if (!pin.ok) return { next: session, replies: [text(pin.error)] };
    const pinHash = await Bun.password.hash(pin.value);
    return {
      next: { ...session, step: "confirm_pin", pinHash },
      replies: [text("Please enter your PIN again to confirm it.")],
    };
  }

  private async confirmPin(
    session: Extract<Session, { step: "confirm_pin" }>,
    { input, contact }: Context,
  ): Promise<Transition> {
    const pin = input.text.trim();
    if (!/^\d{4}$/.test(pin))
      return {
        next: session,
        replies: [text("Please enter your 4-digit PIN again to confirm it.")],
      };

    const { pinHash, ...rest } = session;
    if (!(await Bun.password.verify(pin, pinHash))) {
      return {
        next: { ...rest, step: "set_pin" },
        replies: [
          text("Those PINs don't match. Please create your 4-digit PIN again."),
        ],
      };
    }

    let user: User;
    try {
      user = await this.users.create({
        waId: contact.waId,
        name: contact.name ?? null,
        bvn: session.bvn,
        dateOfBirth: session.dateOfBirth,
        pinHash,
        productCodes: session.productCodes,
      });
    } catch (error) {
      if (error instanceof DuplicateUserError && error.field === "bvn") {
        return {
          next: { step: "ask_bvn" },
          replies: [
            text(
              "This BVN was just linked to another InvestNow account. Please enter a different BVN.",
            ),
          ],
        };
      }
      throw error;
    }

    const menu = this.menu("What would you like to do first?");
    return {
      next: menu.next,
      replies: [
        text(
          `🎉 Your InvestNow account is ready, ${firstName(user.name ?? undefined)}!\n\n` +
            `BVN: ${maskBvn(user.bvn)}\n` +
            `Products: ${session.productCodes.map(productTitle).join(", ")}\n\n` +
            "Fund your wallet to start investing.",
        ),
        ...menu.replies,
      ],
    };
  }

  /* --------------------------------------------------------------- menu */

  private menu(body: string, before: OutboundMessage[] = []): Transition {
    return {
      next: { step: "menu" },
      replies: [
        ...before,
        list(
          body,
          "Menu",
          [
            {
              title: "Actions",
              rows: [
                {
                  id: CHOICE.fund,
                  title: "Fund wallet",
                  description: "Add money to your InvestNow wallet",
                },
                {
                  id: CHOICE.balance,
                  title: "Check balance",
                  description: "See your wallet and investments",
                },
                {
                  id: CHOICE.withdraw,
                  title: "Withdraw",
                  description: "Send money from your wallet to your bank",
                },
                {
                  id: CHOICE.buy,
                  title: "Buy products",
                  description: "Invest from your wallet in a product",
                },
                {
                  id: CHOICE.close,
                  title: "Close session",
                  description: "End this conversation",
                },
              ],
            },
          ],
          { footer: "Reply MENU anytime, or CANCEL to stop" },
        ),
      ],
    };
  }

  private async menuChoice(
    user: User,
    { answer }: Context,
  ): Promise<Transition> {
    const choice = matchChoice(answer, [
      [CHOICE.fund, ["1", "fund", "fund wallet"]],
      [CHOICE.balance, ["2", "balance", "check balance"]],
      [CHOICE.withdraw, ["3", "withdraw"]],
      [CHOICE.buy, ["4", "buy", "buy products"]],
      [CHOICE.close, ["5", "close session"]],
    ]);

    switch (choice) {
      case CHOICE.fund: {
        const wallet = await this.users.walletBalance(user.id);
        return {
          next: { step: "fund_amount" },
          replies: [
            text(
              `How much would you like to add to your wallet? Send the amount in naira, e.g. 5000.\n\nWallet balance: ${formatNaira(wallet)}`,
            ),
          ],
        };
      }
      case CHOICE.balance:
        return this.askPin(
          { type: "balance" },
          "Please enter your 4-digit PIN to view your balances.",
        );
      case CHOICE.withdraw: {
        const wallet = await this.users.walletBalance(user.id);
        if (wallet === 0)
          return this.menu(
            "Your wallet is empty, so there's nothing to withdraw yet.",
          );
        return {
          next: { step: "withdraw_amount" },
          replies: [
            text(
              `How much would you like to withdraw? Available: ${formatNaira(wallet)}`,
            ),
          ],
        };
      }
      case CHOICE.buy:
        return {
          next: { step: "buy_product" },
          replies: [productPicker(await this.ownedProducts(user.id))],
        };
      case CHOICE.close:
        return this.close();
      default:
        return this.menu(
          "Sorry, I didn't catch that. Please choose an option from the menu.",
        );
    }
  }

  /* ------------------------------------------------------------ actions */

  private fundAmount({ input }: Context): Transition {
    const amount = parseAmount(input.text);
    if (!amount.ok)
      return { next: { step: "fund_amount" }, replies: [text(amount.error)] };
    return this.askPin(
      { type: "fund", amountKobo: amount.value },
      `Fund your wallet with *${formatNaira(amount.value)}*.\n\nEnter your 4-digit PIN to approve, or reply CANCEL.`,
    );
  }

  private async withdrawAmount(
    user: User,
    { input }: Context,
  ): Promise<Transition> {
    const amount = parseAmount(input.text);
    if (!amount.ok)
      return {
        next: { step: "withdraw_amount" },
        replies: [text(amount.error)],
      };
    const wallet = await this.users.walletBalance(user.id);
    if (amount.value > wallet) {
      return {
        next: { step: "withdraw_amount" },
        replies: [
          text(
            `You can withdraw up to ${formatNaira(wallet)}. Please send a smaller amount.`,
          ),
        ],
      };
    }
    return this.askPin(
      { type: "withdraw", amountKobo: amount.value },
      `Withdraw *${formatNaira(amount.value)}* to your bank account.\n\nEnter your 4-digit PIN to approve, or reply CANCEL.`,
    );
  }

  private async buyProduct(
    user: User,
    { answer }: Context,
  ): Promise<Transition> {
    const product = matchProduct(answer);
    if (!product) {
      return {
        next: { step: "buy_product" },
        replies: [
          productPicker(
            await this.ownedProducts(user.id),
            "Please choose a product from the list.",
          ),
        ],
      };
    }
    const wallet = await this.users.walletBalance(user.id);
    if (wallet === 0) {
      return this.menu(
        "Your wallet balance is ₦0.00. Please fund your wallet first, then buy the product.",
      );
    }
    return {
      next: { step: "buy_amount", productCode: product.code },
      replies: [
        text(
          `How much of *${product.title}* would you like to buy? Send the amount in naira.\n\nWallet balance: ${formatNaira(wallet)}`,
        ),
      ],
    };
  }

  private async buyAmount(
    session: Extract<Session, { step: "buy_amount" }>,
    user: User,
    { input }: Context,
  ): Promise<Transition> {
    const amount = parseAmount(input.text);
    if (!amount.ok) return { next: session, replies: [text(amount.error)] };
    const wallet = await this.users.walletBalance(user.id);
    if (amount.value > wallet) {
      return {
        next: session,
        replies: [
          text(
            `Your wallet balance is ${formatNaira(wallet)}. Please send a smaller amount, or reply MENU to fund your wallet.`,
          ),
        ],
      };
    }
    return this.askPin(
      {
        type: "buy",
        productCode: session.productCode,
        amountKobo: amount.value,
      },
      `Buy *${formatNaira(amount.value)}* of *${productTitle(session.productCode)}* from your wallet.\n\n` +
        "Enter your 4-digit PIN to approve, or reply CANCEL.",
    );
  }

  private askPin(action: PendingAction, prompt: string): Transition {
    return {
      next: { step: "authorize", action, attempts: 0 },
      replies: [text(prompt)],
    };
  }

  private async authorize(
    session: Extract<Session, { step: "authorize" }>,
    user: User,
    { input }: Context,
  ): Promise<Transition> {
    const pin = input.text.trim();
    if (!/^\d{4}$/.test(pin)) {
      return {
        next: session,
        replies: [text("Please enter your 4-digit PIN, or reply CANCEL.")],
      };
    }
    if (!(await Bun.password.verify(pin, user.pinHash))) {
      const attempts = session.attempts + 1;
      if (attempts >= MAX_PIN_ATTEMPTS) {
        return this.menu("What would you like to do?", [
          text(
            "❌ Too many incorrect PIN attempts, so this request was cancelled.",
          ),
        ]);
      }
      const left = MAX_PIN_ATTEMPTS - attempts;
      return {
        next: { ...session, attempts },
        replies: [
          text(
            `Incorrect PIN. You have ${left} attempt${left === 1 ? "" : "s"} left.`,
          ),
        ],
      };
    }
    return this.menu("Anything else?", [
      await this.execute(session.action, user),
    ]);
  }

  private async execute(
    action: PendingAction,
    user: User,
  ): Promise<OutboundMessage> {
    try {
      switch (action.type) {
        case "fund": {
          const result = await this.users.fundWallet(
            user.id,
            action.amountKobo,
          );
          return text(
            `✅ Your wallet has been funded with ${formatNaira(action.amountKobo)}.\n\n` +
              `Wallet balance: ${formatNaira(result.balanceKobo)}\nRef: ${result.reference}\n\n_Demo: no real payment was taken._`,
          );
        }
        case "withdraw": {
          const result = await this.users.withdrawFromWallet(
            user.id,
            action.amountKobo,
          );
          return text(
            `✅ Your withdrawal of ${formatNaira(action.amountKobo)} is on its way to your bank account.\n\n` +
              `Wallet balance: ${formatNaira(result.balanceKobo)}\nRef: ${result.reference}\n\n_Demo: no real transfer was made._`,
          );
        }
        case "buy": {
          const result = await this.users.buyProduct(
            user.id,
            action.productCode,
            action.amountKobo,
          );
          const title = productTitle(action.productCode);
          return text(
            `✅ You bought ${formatNaira(action.amountKobo)} of ${title}.\n\n` +
              `${title}: ${formatNaira(result.productBalanceKobo)}\n` +
              `Wallet balance: ${formatNaira(result.walletBalanceKobo)}\nRef: ${result.reference}`,
          );
        }
        case "balance":
          return this.balances(user);
      }
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return text(
          `❌ Your wallet balance is ${formatNaira(error.availableKobo)}, which isn't enough for this request. Nothing was charged.`,
        );
      }
      throw error;
    }
  }

  private async balances(user: User): Promise<OutboundMessage> {
    const [wallet, holdings] = await Promise.all([
      this.users.walletBalance(user.id),
      this.users.holdings(user.id),
    ]);
    const total = wallet + holdings.reduce((sum, h) => sum + h.balanceKobo, 0);
    const lines = holdings.length
      ? holdings.map(
          (h) =>
            `• ${productTitle(h.productCode)}: ${formatNaira(h.balanceKobo)}`,
        )
      : ["• No products yet"];
    return text(
      `💼 *Your InvestNow balances*\n\nWallet: ${formatNaira(wallet)}\n\n*Investments*\n${lines.join("\n")}\n\n` +
        `*Total: ${formatNaira(total)}*`,
    );
  }

  private async ownedProducts(userId: number): Promise<Set<string>> {
    return new Set(
      (await this.users.holdings(userId)).map((h) => h.productCode),
    );
  }
}

/* -------------------------------------------------------------- helpers */

function isOnboardedStep(session: Session): boolean {
  switch (session.step) {
    case "onboarding_prompt":
    case "ask_bvn":
    case "ask_dob":
    case "select_products":
    case "set_pin":
    case "confirm_pin":
      return false;
    default:
      return true;
  }
}

function firstName(name: string | undefined): string {
  return name?.trim().split(/\s+/)[0] || "there";
}

/** Finds which choice an answer names: its id, or one of its typed aliases. */
function matchChoice<T extends string>(
  answer: string,
  choices: [T, string[]][],
): T | undefined {
  return choices.find(
    ([id, aliases]) => answer === id || aliases.includes(answer),
  )?.[0];
}

function matchProduct(answer: string) {
  if (answer.startsWith("product:"))
    return productByCode(answer.slice("product:".length).toUpperCase());
  if (/^\d+$/.test(answer)) return PRODUCTS[Number(answer) - 1];
  return PRODUCTS.find(
    (p) => p.title.toLowerCase() === answer || p.code.toLowerCase() === answer,
  );
}

function productSelectionPrompt(): OutboundMessage {
  const lines = PRODUCTS.map(
    (p, i) => `*${i + 1}.* ${p.title} — ${p.description}`,
  );
  return text(
    "*Step 3 of 4*\nWhich products are you interested in? You can choose more than one.\n\n" +
      `${lines.join("\n")}\n\n` +
      "Reply with the numbers separated by commas (e.g. *1,3,5*), or *all*.",
  );
}

function productPicker(
  owned: Set<string>,
  body = "Which product would you like to buy?",
): OutboundMessage {
  return list(body, "Products", [
    {
      title: "Products",
      rows: PRODUCTS.map((p) => ({
        id: `product:${p.code}`,
        title: p.title,
        description: owned.has(p.code)
          ? `✓ Subscribed · ${p.description}`
          : p.description,
      })),
    },
  ]);
}
