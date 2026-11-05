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
  parseAmount,
  parseBvn,
  parseDateOfBirth,
  parseNewPin,
  parseSelection,
} from "./parsers";
import { PRODUCTS, productByCode, productTitle } from "./products";
import {
  BVN_USSD,
  flowKey,
  INVESTNOW_USSD,
  MAX_PIN_ATTEMPTS,
  SESSION_CACHE,
  sessionKey,
  ussd,
} from "./conversation.constants";
import { actionSummary, formatDob, hideBvn, productsText } from "./format";
import type { SessionSource } from "../database/sessions.interface";
import type { FlowName, FlowRef } from "../flows/flows.interface";
import type { User } from "../database/users.interface";
import type {
  InboundInput,
  OutboundMessage,
} from "../whatsapp/whatsapp.interface";
import type {
  Contact,
  Context,
  MessageMeta,
  OnboardingDraft,
  Parsed,
  PendingAction,
  Session,
  SessionCacheSchema,
  TransactionType,
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
/** What a user replies to answer a Flow's questions in the chat instead. */
const TYPE_WORDS = new Set(["type", "chat", "type it", "text"]);

const CHOICE = {
  proceed: "onboard:proceed",
  close: "close",
  fund: "menu:fund",
  balance: "menu:balance",
  withdraw: "menu:withdraw",
  buy: "menu:buy",
} as const;

/** The review's list rows. */
const REVIEW = {
  confirm: "review:confirm",
  bvn: "review:bvn",
  dob: "review:dob",
  products: "review:products",
  pin: "review:pin",
} as const;

/** What an edit step accepts to leave the current value as it is. */
const KEEP_WORDS = new Set(["back", "keep", "review"]);

const BVN_TAKEN =
  "This BVN is already linked to another InvestNow account. Please check the number and try again, " +
  "or reply CANCEL to stop.";

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

  /** What a Flow token points at, while its form may still be used. */
  flowRef(token: string): Promise<FlowRef | undefined> {
    return this.sessions.get(flowKey(token));
  }

  /** Stores a session changed by the Flow endpoint; call it inside {@link exclusive}. */
  async saveSession(waId: string, session: Session): Promise<void> {
    await this.sessions.set(sessionKey(waId), session, {
      ttl: this.config.sessionTtlMs,
    });
  }

  /** Runs `task` while no message of `waId`'s is being handled (the Flow endpoint updates sessions under it too). */
  exclusive<T>(waId: string, task: () => Promise<T>): Promise<T> {
    return this.mutex.run(waId, task);
  }

  /**
   * Whether a Flow is offered instead of the chat steps: on WhatsApp once Meta
   * has its id and the endpoint its key, in the simulator unless turned off.
   */
  flowsOn(flow: FlowName, source: SessionSource): boolean {
    if (source === "simulator") return this.config.simulatorFlows;
    const { flows } = this.config.whatsapp;
    return flows.privateKey !== "" && flows.ids[flow] !== "";
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
    const ctx: Context = {
      contact,
      user,
      input,
      answer,
      source: meta.source,
    };

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
      ...(meta.messageId ? { messageId: meta.messageId } : {}),
      // A finished Flow's last answer, already masked by the endpoint.
      ...(input.flowToken ? { masked: true, inKind: "flow" as const } : {}),
    });
    return replies;
  }

  private async transition(
    session: Session | undefined,
    ctx: Context,
  ): Promise<Transition> {
    const { answer, user } = ctx;

    if (ctx.input.flowToken) return this.flowFinished(session, ctx);
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
      case "onboarding_flow":
        return this.onboardingFlow(session, ctx);
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
      case "review":
        return this.review(session, ctx);
      case "edit_bvn":
      case "edit_dob":
      case "edit_products":
      case "edit_pin":
      case "edit_pin_confirm":
        return this.edit(session, ctx);
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
      case "transaction":
        return this.transaction(session, user!, ctx);
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

  private async onboardingPrompt(ctx: Context): Promise<Transition> {
    const { answer } = ctx;
    if (
      answer === CHOICE.proceed ||
      ["proceed", "yes", "y", "ok", "okay", "1"].includes(answer)
    ) {
      if (this.flowsOn("onboarding", ctx.source)) {
        const token = await this.newFlowToken("onboarding", ctx);
        return {
          next: { step: "onboarding_flow", flowToken: token, draft: {} },
          replies: [
            onboardingFlowMessage(token, "Great, let's get you set up! 🚀"),
          ],
        };
      }
      return {
        next: { step: "ask_bvn" },
        replies: [
          text(
            "Great, let's get you set up! 🚀\n\n" +
              bvnPrompt("*Step 1 of 4*\nPlease enter"),
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

  /** A message while the onboarding form is open: TYPE switches to the chat steps; anything else shows the form again. */
  private onboardingFlow(
    session: Extract<Session, { step: "onboarding_flow" }>,
    { answer }: Context,
  ): Transition {
    if (TYPE_WORDS.has(answer)) {
      void this.sessions.delete(flowKey(session.flowToken));
      return {
        next: { step: "ask_bvn" },
        replies: [
          text(
            "No problem, let's do it here in the chat.\n\n" +
              bvnPrompt("*Step 1 of 4*\nPlease enter"),
          ),
        ],
      };
    }
    return {
      next: session,
      replies: [
        onboardingFlowMessage(
          session.flowToken,
          "Your account form is still waiting for you.",
        ),
      ],
    };
  }

  /**
   * The message the Flow endpoint queues when a form is finished, its token in
   * the input: creates the account, or carries out the approved request. A
   * token that isn't the session's (an old form) is ignored.
   */
  private async flowFinished(
    session: Session | undefined,
    ctx: Context,
  ): Promise<Transition> {
    const token = ctx.input.flowToken!;
    if (!session || !("flowToken" in session) || session.flowToken !== token)
      return { next: session ?? null, replies: [] };

    if (session.step === "onboarding_flow") {
      if (!session.submitted || !isCompleteDraft(session.draft))
        return { next: session, replies: [] };
      await this.sessions.delete(flowKey(token));
      return this.createAccount(session.draft, ctx.contact);
    }
    if (!ctx.user) return this.welcome(ctx);
    if (session.approved && session.action) {
      await this.sessions.delete(flowKey(token));
      return this.menu("Anything else?", [
        await this.execute(session.action, ctx.user),
      ]);
    }
    if (session.attempts >= MAX_PIN_ATTEMPTS) {
      await this.sessions.delete(flowKey(token));
      return this.menu("What would you like to do?", [
        text(
          "❌ Too many incorrect PIN attempts, so this request was cancelled.",
        ),
      ]);
    }
    return { next: session, replies: [] };
  }

  /** A new Flow token, pointing at this conversation, valid as long as a session. */
  private async newFlowToken(flow: FlowName, ctx: Context): Promise<string> {
    const token = crypto.randomUUID().replaceAll("-", "");
    await this.sessions.set(
      flowKey(token),
      {
        flow,
        waId: ctx.contact.waId,
        source: ctx.source,
        ...(ctx.contact.name ? { profileName: ctx.contact.name } : {}),
      },
      { ttl: this.config.sessionTtlMs },
    );
    return token;
  }

  private async askBvn({ input }: Context): Promise<Transition> {
    const bvn = await this.checkBvn(input.text);
    if (!bvn.ok)
      return { next: { step: "ask_bvn" }, replies: [text(bvn.error)] };
    return {
      next: { step: "ask_dob", bvn: bvn.value },
      replies: [text(dobPrompt("*Step 2 of 4*\nPlease enter"))],
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
      replies: [text(productsPrompt("*Step 3 of 4*\nWhich products are"))],
    };
  }

  private selectProducts(
    session: Extract<Session, { step: "select_products" }>,
    { input }: Context,
  ): Transition {
    const products = parseProducts(input.text);
    if (!products.ok) return { next: session, replies: [text(products.error)] };
    return {
      next: {
        step: "set_pin",
        bvn: session.bvn,
        dateOfBirth: session.dateOfBirth,
        productCodes: products.value,
      },
      replies: [
        text(
          `You selected: ${products.value.map(productTitle).join(", ")}.\n\n` +
            pinPrompt("*Step 4 of 4*\nCreate a"),
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
    { input }: Context,
  ): Promise<Transition> {
    const { step: _step, ...draft } = session;
    const check = await confirmNewPin(input.text, draft.pinHash);
    if (check === "invalid")
      return {
        next: session,
        replies: [text("Please enter your 4-digit PIN again to confirm it.")],
      };
    if (check === "mismatch") {
      const { pinHash: _pinHash, ...rest } = draft;
      return {
        next: { ...rest, step: "set_pin" },
        replies: [
          text("Those PINs don't match. Please create your 4-digit PIN again."),
        ],
      };
    }
    return this.showReview(draft, "Almost done! ✅");
  }

  /* ------------------------------------------------- onboarding review */

  /** Shows every answer, with a row to confirm and one to change each of them. */
  private showReview(draft: OnboardingDraft, lead: string): Transition {
    const products = productsText(draft.productCodes);
    return {
      next: { step: "review", draft },
      replies: [
        list(
          `${lead}\n\n*Please review your details*\n\n` +
            `BVN: ${hideBvn(draft.bvn)}\n` +
            `Date of birth: ${formatDob(draft.dateOfBirth)}\n` +
            `Products: ${products}\n` +
            "PIN: ••••\n\n" +
            "Tap *Review* to confirm and open your account, or to change any of these.",
          "Review",
          [
            {
              title: "Your details",
              rows: [
                {
                  id: REVIEW.confirm,
                  title: "Confirm & create",
                  description: "Open your InvestNow account",
                },
                {
                  id: REVIEW.bvn,
                  title: "Edit BVN",
                  description: hideBvn(draft.bvn),
                },
                {
                  id: REVIEW.dob,
                  title: "Edit date of birth",
                  description: formatDob(draft.dateOfBirth),
                },
                {
                  id: REVIEW.products,
                  title: "Edit products",
                  description: products,
                },
                {
                  id: REVIEW.pin,
                  title: "Change PIN",
                  description: "Set a new 4-digit PIN",
                },
              ],
            },
          ],
          { footer: "Or reply 1 to 5, or CANCEL to stop" },
        ),
      ],
    };
  }

  private async review(
    session: Extract<Session, { step: "review" }>,
    { answer, contact }: Context,
  ): Promise<Transition> {
    const { draft } = session;
    const choice = matchChoice(answer, [
      [REVIEW.confirm, ["1", "confirm", "create", "yes", "y", "ok"]],
      [REVIEW.bvn, ["2", "bvn", "edit bvn"]],
      [REVIEW.dob, ["3", "dob", "date of birth", "edit date of birth"]],
      [REVIEW.products, ["4", "products", "edit products"]],
      [REVIEW.pin, ["5", "pin", "change pin"]],
    ]);
    const keep = "\n\nReply *BACK* to keep it as it is.";
    switch (choice) {
      case REVIEW.confirm:
        return this.createAccount(draft, contact);
      case REVIEW.bvn:
        return {
          next: { step: "edit_bvn", draft },
          replies: [
            text(
              bvnPrompt(`*Edit BVN*\nCurrent: ${hideBvn(draft.bvn)}\n\nEnter`) +
                keep,
            ),
          ],
        };
      case REVIEW.dob:
        return {
          next: { step: "edit_dob", draft },
          replies: [
            text(
              dobPrompt(
                `*Edit date of birth*\nCurrent: ${formatDob(draft.dateOfBirth)}\n\nEnter`,
              ) + keep,
            ),
          ],
        };
      case REVIEW.products:
        return {
          next: { step: "edit_products", draft },
          replies: [
            text(
              productsPrompt(
                `*Edit products*\nCurrent: ${productsText(draft.productCodes)}\n\nWhich products are`,
              ) + keep,
            ),
          ],
        };
      case REVIEW.pin:
        return {
          next: { step: "edit_pin", draft },
          replies: [text(pinPrompt("*Change PIN*\nCreate a new") + keep)],
        };
      default:
        return this.showReview(
          draft,
          "Sorry, I didn't catch that. Please choose an option.",
        );
    }
  }

  /** One answer being changed from the review: a valid new value, or BACK, returns to it. */
  private async edit(
    session: Extract<
      Session,
      {
        step:
          | "edit_bvn"
          | "edit_dob"
          | "edit_products"
          | "edit_pin"
          | "edit_pin_confirm";
      }
    >,
    { input, answer }: Context,
  ): Promise<Transition> {
    const { draft } = session;
    if (KEEP_WORDS.has(answer))
      return this.showReview(draft, "No changes made.");

    switch (session.step) {
      case "edit_bvn": {
        const bvn = await this.checkBvn(input.text);
        if (!bvn.ok) return { next: session, replies: [text(bvn.error)] };
        return this.showReview({ ...draft, bvn: bvn.value }, "BVN updated. ✅");
      }
      case "edit_dob": {
        const dob = parseDateOfBirth(input.text);
        if (!dob.ok) return { next: session, replies: [text(dob.error)] };
        return this.showReview(
          { ...draft, dateOfBirth: dob.value },
          "Date of birth updated. ✅",
        );
      }
      case "edit_products": {
        const products = parseProducts(input.text);
        if (!products.ok)
          return { next: session, replies: [text(products.error)] };
        return this.showReview(
          { ...draft, productCodes: products.value },
          "Products updated. ✅",
        );
      }
      case "edit_pin": {
        const pin = parseNewPin(input.text);
        if (!pin.ok) return { next: session, replies: [text(pin.error)] };
        return {
          next: {
            step: "edit_pin_confirm",
            draft,
            newPinHash: await Bun.password.hash(pin.value),
          },
          replies: [text("Please enter your new PIN again to confirm it.")],
        };
      }
      case "edit_pin_confirm": {
        const check = await confirmNewPin(input.text, session.newPinHash);
        if (check === "invalid")
          return {
            next: session,
            replies: [
              text("Please enter your new 4-digit PIN again to confirm it."),
            ],
          };
        if (check === "mismatch")
          return {
            next: { step: "edit_pin", draft },
            replies: [
              text(
                "Those PINs don't match. Please create your new 4-digit PIN again, or reply *BACK* to keep your current PIN.",
              ),
            ],
          };
        return this.showReview(
          { ...draft, pinHash: session.newPinHash },
          "PIN changed. ✅",
        );
      }
    }
  }

  private async createAccount(
    draft: OnboardingDraft,
    contact: Contact,
  ): Promise<Transition> {
    let user: User;
    try {
      user = await this.users.create({
        waId: contact.waId,
        name: contact.name ?? null,
        ...draft,
      });
    } catch (error) {
      if (error instanceof DuplicateUserError && error.field === "bvn") {
        return {
          next: { step: "edit_bvn", draft },
          replies: [
            text(
              "This BVN was just linked to another InvestNow account. Please enter a different BVN, " +
                "or reply *BACK* to review your details.",
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
            `BVN: ${hideBvn(user.bvn)}\n` +
            `Products: ${productsText(draft.productCodes)}\n\n` +
            "Fund your wallet to start investing.",
        ),
        ...menu.replies,
      ],
    };
  }

  /** A well-formed BVN that isn't registered yet. */
  async checkBvn(input: string): Promise<Parsed<string>> {
    const bvn = parseBvn(input);
    if (!bvn.ok) return bvn;
    if (await this.users.isBvnRegistered(bvn.value))
      return { ok: false, error: BVN_TAKEN };
    return bvn;
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

  private async menuChoice(user: User, ctx: Context): Promise<Transition> {
    const { answer } = ctx;
    const choice = matchChoice(answer, [
      [CHOICE.fund, ["1", "fund", "fund wallet"]],
      [CHOICE.balance, ["2", "balance", "check balance"]],
      [CHOICE.withdraw, ["3", "withdraw"]],
      [CHOICE.buy, ["4", "buy", "buy products"]],
      [CHOICE.close, ["5", "close session"]],
    ]);

    switch (choice) {
      case CHOICE.fund:
        return this.startTransaction("fund", user, ctx);
      case CHOICE.balance:
        return this.askPin(
          ctx,
          { type: "balance" },
          "Please enter your 4-digit PIN to view your balances.",
        );
      case CHOICE.withdraw:
        return this.startTransaction("withdraw", user, ctx);
      case CHOICE.buy:
        return this.startTransaction("buy", user, ctx);
      case CHOICE.close:
        return this.close();
      default:
        return this.menu(
          "Sorry, I didn't catch that. Please choose an option from the menu.",
        );
    }
  }

  /* ------------------------------------------------------------ actions */

  /** Fund, withdraw or buy: in the transaction Flow when it's on, or step by step in the chat. */
  private async startTransaction(
    type: TransactionType,
    user: User,
    ctx: Context,
  ): Promise<Transition> {
    if (!this.flowsOn("transaction", ctx.source))
      return this.startInChat(type, user);
    const wallet = await this.users.walletBalance(user.id);
    if (type === "withdraw" && wallet === 0)
      return this.menu(
        "Your wallet is empty, so there's nothing to withdraw yet.",
      );
    if (type === "buy" && wallet === 0)
      return this.menu(
        "Your wallet balance is ₦0.00. Please fund your wallet first, then buy the product.",
      );
    const token = await this.newFlowToken("transaction", ctx);
    return {
      next: { step: "transaction", type, flowToken: token, attempts: 0 },
      replies: [transactionFlowMessage(type, token)],
    };
  }

  /** The chat steps for a transaction: the amount (and product) typed or tapped, then the PIN. */
  private async startInChat(
    type: TransactionType,
    user: User,
  ): Promise<Transition> {
    if (type === "buy")
      return {
        next: { step: "buy_product" },
        replies: [productPicker(await this.ownedProducts(user.id))],
      };
    const wallet = await this.users.walletBalance(user.id);
    if (type === "fund")
      return {
        next: { step: "fund_amount" },
        replies: [
          text(
            `How much would you like to add to your wallet? Send the amount in naira, e.g. 5000.\n\nWallet balance: ${formatNaira(wallet)}`,
          ),
        ],
      };
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

  /** A message while the transaction form is open: TYPE switches to the chat steps; anything else shows the form again. */
  private async transaction(
    session: Extract<Session, { step: "transaction" }>,
    user: User,
    { answer }: Context,
  ): Promise<Transition> {
    if (TYPE_WORDS.has(answer)) {
      await this.sessions.delete(flowKey(session.flowToken));
      return this.startInChat(session.type, user);
    }
    return {
      next: session,
      replies: [transactionFlowMessage(session.type, session.flowToken)],
    };
  }

  private fundAmount(ctx: Context): Promise<Transition> {
    const amount = parseAmount(ctx.input.text);
    if (!amount.ok)
      return Promise.resolve({
        next: { step: "fund_amount" },
        replies: [text(amount.error)],
      });
    return this.askPin(
      ctx,
      { type: "fund", amountKobo: amount.value },
      `Fund your wallet with *${formatNaira(amount.value)}*.\n\nEnter your 4-digit PIN to approve, or reply CANCEL.`,
    );
  }

  private async withdrawAmount(user: User, ctx: Context): Promise<Transition> {
    const amount = parseAmount(ctx.input.text);
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
      ctx,
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
    ctx: Context,
  ): Promise<Transition> {
    const amount = parseAmount(ctx.input.text);
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
      ctx,
      {
        type: "buy",
        productCode: session.productCode,
        amountKobo: amount.value,
      },
      `Buy *${formatNaira(amount.value)}* of *${productTitle(session.productCode)}* from your wallet.\n\n` +
        "Enter your 4-digit PIN to approve, or reply CANCEL.",
    );
  }

  /** Asks for the PIN that approves `action`: in the PIN Flow when it's on, or typed in the chat. */
  private async askPin(
    ctx: Context,
    action: PendingAction,
    prompt: string,
  ): Promise<Transition> {
    if (this.flowsOn("pin", ctx.source)) {
      const token = await this.newFlowToken("pin", ctx);
      return {
        next: { step: "authorize", action, attempts: 0, flowToken: token },
        replies: [pinFlowMessage(action, token)],
      };
    }
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
    case "onboarding_flow":
    case "ask_bvn":
    case "ask_dob":
    case "select_products":
    case "set_pin":
    case "confirm_pin":
    case "review":
    case "edit_bvn":
    case "edit_dob":
    case "edit_products":
    case "edit_pin":
    case "edit_pin_confirm":
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

/** The BVN prompt, after `lead` (e.g. "*Step 1 of 4*\nPlease enter"). */
function bvnPrompt(lead: string): string {
  return (
    `${lead} your 11-digit Bank Verification Number (BVN).\n\n` +
    `Don't know it? Dial ${ussd(BVN_USSD)} from the phone number linked to your bank account.`
  );
}

function dobPrompt(lead: string): string {
  return `${lead} your date of birth as DD/MM/YYYY, for example 25/12/1990.`;
}

function productsPrompt(lead: string): string {
  const lines = PRODUCTS.map(
    (p, i) => `*${i + 1}.* ${p.title} — ${p.description}`,
  );
  return (
    `${lead} you interested in? You can choose more than one.\n\n` +
    `${lines.join("\n")}\n\n` +
    "Reply with the numbers separated by commas (e.g. *1,3,5*), or *all*."
  );
}

function pinPrompt(lead: string): string {
  return (
    `${lead} 4-digit transaction PIN. You'll use it to approve transactions and view balances.\n\n` +
    "🔒 _You can delete your PIN messages from this chat after sending them._"
  );
}

/** The product codes a selection like "1,3,5" names. */
function parseProducts(input: string): Parsed<string[]> {
  const selection = parseSelection(input, PRODUCTS.length);
  if (!selection.ok) return selection;
  return { ok: true, value: selection.value.map((i) => PRODUCTS[i]!.code) };
}

/** Checks the repeat of a new PIN against its hash. */
async function confirmNewPin(
  input: string,
  pinHash: string,
): Promise<"invalid" | "mismatch" | "ok"> {
  const pin = input.trim();
  if (!/^\d{4}$/.test(pin)) return "invalid";
  return (await Bun.password.verify(pin, pinHash)) ? "ok" : "mismatch";
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

/** Whether every onboarding answer is in. */
function isCompleteDraft(
  draft: Partial<OnboardingDraft>,
): draft is OnboardingDraft {
  return Boolean(
    draft.bvn &&
    draft.dateOfBirth &&
    draft.productCodes?.length &&
    draft.pinHash,
  );
}

const TYPE_INSTEAD =
  "Can't open the form? Reply *TYPE* to answer here in the chat instead.";

function flowMessage(
  flow: FlowName,
  token: string,
  body: string,
  cta: string,
  fallback: string,
): OutboundMessage {
  return { kind: "flow", flow, token, body, cta, fallback };
}

function onboardingFlowMessage(token: string, lead: string): OutboundMessage {
  return flowMessage(
    "onboarding",
    token,
    `${lead}\n\nTap *Open form* to enter your BVN, date of birth, products and PIN. ` +
      "What you enter in the form is sent securely and isn't shown in this chat, " +
      "and you can review and change it before your account is created.\n\n" +
      TYPE_INSTEAD,
    "Open form",
    `${lead}\n\nReply *TYPE* to answer a few questions here in the chat: your BVN, ` +
      "date of birth, the products you're interested in, and a PIN.",
  );
}

const TRANSACTION_CTA: Record<TransactionType, string> = {
  fund: "Fund wallet",
  withdraw: "Withdraw",
  buy: "Buy a product",
};

function transactionFlowMessage(
  type: TransactionType,
  token: string,
): OutboundMessage {
  const what = {
    fund: "enter how much to add to your wallet",
    withdraw: "enter how much to withdraw to your bank account",
    buy: "choose a product and how much to invest",
  }[type];
  return flowMessage(
    "transaction",
    token,
    `Tap *${TRANSACTION_CTA[type]}* to ${what}, then approve it with your PIN.\n\n` +
      `${TYPE_INSTEAD} Or reply MENU to go back.`,
    TRANSACTION_CTA[type],
    `Reply *TYPE* to ${what} here in the chat, or MENU to go back.`,
  );
}

function pinFlowMessage(action: PendingAction, token: string): OutboundMessage {
  return flowMessage(
    "pin",
    token,
    `*${actionSummary(action)}*\n\nTap *Enter PIN* to approve. Can't open it? Reply with your 4-digit PIN instead, or CANCEL.`,
    "Enter PIN",
    `*${actionSummary(action)}*\n\nPlease enter your 4-digit PIN to approve, or reply CANCEL.`,
  );
}
