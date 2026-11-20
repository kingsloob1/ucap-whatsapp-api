import type { Cache } from "@kingsleyweb/bun-cache";
import { InjectCache } from "@kingsleyweb/bun-nest/cache";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import {
  DuplicateUserError,
  InsufficientFundsError,
  InsufficientHoldingError,
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
  parseFullName,
  parseNewPin,
  parseSelection,
  MAX_AMOUNT_KOBO,
} from "./parsers";
import {
  FIF_TENORS,
  LIQUIDATION_NOTES,
  MAX_SHARES,
  RELATIONSHIPS,
  STOCKS,
  TRUST_SERVICES,
} from "./investments.constants";
import {
  amountPrompt,
  buyNote,
  buyQuote,
  defaultDetails,
  sharesPrompt,
  stockByTicker,
  tenorPrompt,
} from "./investments.service";
import { PRODUCTS, productByCode, productTitle } from "./products";
import {
  BVN_USSD,
  flowKey,
  INVESTNOW_USSD,
  MAX_PIN_ATTEMPTS,
  ONBOARDING_PRIVACY_TIP,
  PRIVACY_TIP,
  SESSION_CACHE,
  sessionKey,
  ussd,
} from "./conversation.constants";
import {
  actionSummary,
  formatDob,
  formatWhen,
  hideBvn,
  productsText,
} from "./format";
import type { SessionSource } from "../database/sessions.interface";
import type { FlowName, FlowRef } from "../flows/flows.interface";
import type { TransactionRecord, User } from "../database/users.interface";
import type {
  InboundInput,
  OutboundMessage,
} from "../whatsapp/whatsapp.interface";
import type {
  BrowseView,
  BuyDetails,
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

/** Words that end the conversation. */
const CLOSE_WORDS = new Set(["exit", "close", "quit", "stop", "bye", "end"]);
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
/**
 * Words that cancel what is in progress (onboarding, a transaction, a PIN
 * approval) and go back to the menu. In an edit step, BACK and GO BACK return
 * to the review instead.
 */
const CANCEL_WORDS = new Set([
  "cancel",
  "cancel it",
  "cancel this",
  "cancel that",
  "back",
  "go back",
  "abort",
  "never mind",
  "nevermind",
  "nvm",
  "forget it",
  "forget about it",
  "not now",
  "no thanks",
  "no thank you",
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
  liquidate: "menu:liquidate",
  products: "menu:products",
  history: "menu:history",
  /** The paginated views' buttons; Menu is the MENU command itself. */
  next: "page:next",
  previous: "page:previous",
  menu: "menu",
  /** The purchase confirmation's buttons; Cancel is the CANCEL command itself. */
  confirmBuy: "buy:confirm",
  changeBuy: "buy:change",
  confirmLiquidate: "liquidate:confirm",
  changeLiquidate: "liquidate:change",
  cancel: "cancel",
} as const;

const CONFIRM_WORDS = new Set(["confirm", "yes", "y", "ok", "okay", "proceed"]);
/** What a user types to liquidate everything a product holds. */
const ALL_WORDS = new Set(["all", "everything", "all of it", "full", "max"]);
const CHANGE_WORDS = new Set([
  "change",
  "change amount",
  "change shares",
  "edit",
]);

/** Items on one page of My products or Transaction history. */
const PAGE_SIZE = 5;
const NEXT_WORDS = new Set(["next", "more", "n", "next page"]);
const PREVIOUS_WORDS = new Set(["previous", "prev", "p", "previous page"]);

/** The review's list rows. */
const REVIEW = {
  confirm: "review:confirm",
  bvn: "review:bvn",
  dob: "review:dob",
  products: "review:products",
  pin: "review:pin",
} as const;

/** What an edit step accepts to leave the current value as it is. */
const KEEP_WORDS = new Set(["back", "go back", "keep", "review"]);

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

  /**
   * WhatsApp refused to deliver a form (Meta's 139000 integrity block, for
   * one): the conversation moves on to the chat steps, and this answers what
   * to send instead of the form, the first chat question. Nothing when the
   * session no longer waits for that form.
   */
  formRefused(
    waId: string,
    message: Extract<OutboundMessage, { kind: "flow" }>,
  ): Promise<OutboundMessage[]> {
    return this.mutex.run(waId, async () => {
      const [session, user] = await Promise.all([
        this.sessions.get(sessionKey(waId)),
        this.users.findByWaId(waId),
      ]);
      if (!session || !("flowToken" in session)) return [];
      if (session.flowToken !== message.token) return [];
      await this.sessions.delete(flowKey(message.token));
      let next: Session;
      let replies: OutboundMessage[];
      switch (session.step) {
        case "onboarding_flow":
          next = { step: "ask_bvn" };
          replies = [text(message.fallback)];
          break;
        case "transaction": {
          if (!user) return [];
          const chat = await this.startInChat(session.type, user);
          if (!chat.next) return chat.replies;
          next = chat.next;
          replies = chat.replies;
          break;
        }
        case "authorize": {
          // A typed PIN is accepted all along; only the form goes.
          const { flowToken: _refused, ...rest } = session;
          next = rest;
          replies = [text(message.fallback)];
          break;
        }
        default:
          return [];
      }
      await this.saveSession(waId, next);
      this.logger.debug(
        `${waId}: the ${message.flow} form was refused: ${session.step} -> ${next.step}`,
      );
      return replies;
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
    const phrase = asPhrase(answer);

    if (ctx.input.flowToken) return this.flowFinished(session, ctx);
    if (CLOSE_WORDS.has(phrase) || answer === CHOICE.close) return this.close();
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

    if (
      CANCEL_WORDS.has(phrase) &&
      !(isEditStep(session) && KEEP_WORDS.has(phrase))
    )
      return this.cancel(session);

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
      case "buy_tenor":
        return this.buyTenor(user!, ctx);
      case "buy_stock":
        return this.buyStock(user!, ctx);
      case "buy_shares":
        return this.buyShares(session, user!, ctx);
      case "buy_trust":
        return this.buyTrust(ctx);
      case "buy_beneficiary":
        return this.buyBeneficiary(session, ctx);
      case "buy_relationship":
        return this.buyRelationship(session, user!, ctx);
      case "buy_amount":
        return this.buyAmount(session, user!, ctx);
      case "buy_confirm":
        return this.buyConfirm(session, user!, ctx);
      case "liquidate_product":
        return this.liquidateProduct(user!, ctx);
      case "liquidate_amount":
        return this.liquidateAmount(session, user!, ctx);
      case "liquidate_confirm":
        return this.liquidateConfirm(session, user!, ctx);
      case "transaction":
        return this.transaction(session, user!, ctx);
      case "browse":
        return this.browse(session, user!, ctx);
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

  /**
   * CANCEL (or BACK, NEVER MIND…): drops what is in progress, says so, and
   * shows the menu again. Onboarding, which has no menu yet, goes back to the
   * Proceed/Close prompt; at that prompt, cancelling ends the conversation.
   */
  private async cancel(session: Session): Promise<Transition> {
    if ("flowToken" in session && session.flowToken)
      await this.sessions.delete(flowKey(session.flowToken));

    if (session.step === "onboarding_prompt") return this.close();
    if (!isOnboardedStep(session))
      return {
        next: { step: "onboarding_prompt" },
        replies: [
          text("❌ Your account setup was cancelled. Nothing was saved."),
          buttons("Would you like to start again? It takes about 2 minutes.", [
            { id: CHOICE.proceed, title: "Proceed" },
            { id: CHOICE.close, title: "Close" },
          ]),
        ],
      };

    // Leaving a paginated view isn't cancelling anything.
    if (session.step === "browse")
      return this.menu("What would you like to do?");
    const what = cancelledWhat(session);
    if (!what)
      return this.menu("There's nothing to cancel. What would you like to do?");
    const money =
      what !== "balance" && what !== "products" && what !== "history";
    return this.menu("What would you like to do next?", [
      text(
        `❌ ${CANCELLED[what]} was cancelled.${money ? " No money was moved." : ""}`,
      ),
    ]);
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
            onboardingFlowMessage(
              token,
              `Great, let's get you set up! 🚀\n\n${ONBOARDING_PRIVACY_TIP}`,
            ),
          ],
        };
      }
      return {
        next: { step: "ask_bvn" },
        replies: [
          text(
            `Great, let's get you set up! 🚀\n\n${ONBOARDING_PRIVACY_TIP}\n\n` +
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
          { offerChat: true },
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
      return this.approved(session.action, ctx.user);
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
            `Fund your wallet to start investing.\n\n${PRIVACY_TIP}`,
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
                  id: CHOICE.liquidate,
                  title: "Liquidate",
                  description: "Move money from a product back to your wallet",
                },
                {
                  id: CHOICE.products,
                  title: "My products",
                  description: "Your products and what you hold in each",
                },
                {
                  id: CHOICE.history,
                  title: "Transaction history",
                  description: "Your funding, withdrawals and purchases",
                },
                {
                  id: CHOICE.close,
                  title: "Close session",
                  description: "End this conversation",
                },
              ],
            },
          ],
          {
            footer:
              "Reply CANCEL to stop anything in progress, or CLOSE to end",
          },
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
      [
        CHOICE.liquidate,
        ["5", "liquidate", "sell", "redeem", "liquidate investment"],
      ],
      [CHOICE.products, ["6", "products", "my products"]],
      [CHOICE.history, ["7", "history", "transactions", "transaction history"]],
      [CHOICE.close, ["8", "close session"]],
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
      case CHOICE.liquidate:
        return this.startLiquidation(user);
      case CHOICE.products:
        return this.askPin(
          ctx,
          { type: "products" },
          "Please enter your 4-digit PIN to view your products.",
        );
      case CHOICE.history:
        return this.askPin(
          ctx,
          { type: "history" },
          "Please enter your 4-digit PIN to view your transaction history.",
        );
      case CHOICE.close:
        return this.close();
      default:
        return this.menu(
          "Sorry, I didn't catch that. Please choose an option from the menu.",
        );
    }
  }

  /* ------------------------------------------------------------ actions */

  /** Fund or withdraw in the transaction Flow when it's on; buying, and everything without Flows, step by step in the chat. */
  private async startTransaction(
    type: TransactionType,
    user: User,
    ctx: Context,
  ): Promise<Transition> {
    // Buying has each product's own questions, so it is always asked in the chat.
    if (type === "buy" || !this.flowsOn("transaction", ctx.source))
      return this.startInChat(type, user);
    const wallet = await this.users.walletBalance(user.id);
    if (type === "withdraw" && wallet === 0)
      return this.menu(
        "Your wallet is empty, so there's nothing to withdraw yet.",
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
    const wallet = await this.users.walletBalance(user.id);
    if (type === "buy") {
      if (wallet === 0)
        return this.menu(
          "Your wallet balance is ₦0.00. Please fund your wallet first, then buy the product.",
        );
      return {
        next: { step: "buy_product" },
        replies: [productPicker(await this.ownedProducts(user.id))],
      };
    }
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
      replies: [
        transactionFlowMessage(session.type, session.flowToken, {
          offerChat: true,
        }),
      ],
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
    switch (product.code) {
      case "FIF":
        return { next: { step: "buy_tenor" }, replies: [tenorPicker()] };
      case "STK":
        return { next: { step: "buy_stock" }, replies: [stockPicker()] };
      case "TRS":
        return { next: { step: "buy_trust" }, replies: [trustPicker()] };
      default:
        return this.askBuyAmount(
          product.code,
          defaultDetails(product.code),
          user,
        );
    }
  }

  /** The amount question, with what the product's figures mean for an example principal. */
  private async askBuyAmount(
    productCode: string,
    details: BuyDetails | undefined,
    user: User,
  ): Promise<Transition> {
    const wallet = await this.users.walletBalance(user.id);
    return {
      next: {
        step: "buy_amount",
        productCode,
        ...(details ? { details } : {}),
      },
      replies: [text(amountPrompt(productCode, details, wallet))],
    };
  }

  /** Fixed Income Fund: the term, which sets the rate. */
  private buyTenor(user: User, { answer }: Context): Promise<Transition> {
    const days = Number(answer.replace(/^tenor:/, "").replace(/\s*days?$/, ""));
    const tenor = FIF_TENORS.find((t) => t.days === days);
    if (!tenor)
      return Promise.resolve({
        next: { step: "buy_tenor" },
        replies: [tenorPicker()],
      });
    return this.askBuyAmount(
      "FIF",
      { kind: "tenor", days: tenor.days, ratePct: tenor.ratePct },
      user,
    );
  }

  /** Stocks: which one, then how many shares. */
  private async buyStock(user: User, { answer }: Context): Promise<Transition> {
    const stock =
      stockByTicker(answer.replace(/^stock:/, "").toUpperCase()) ??
      (/^\d+$/.test(answer) ? STOCKS[Number(answer) - 1] : undefined) ??
      STOCKS.find((s) => s.name.toLowerCase() === answer);
    if (!stock)
      return {
        next: { step: "buy_stock" },
        replies: [stockPicker("Please choose a stock from the list.")],
      };
    const wallet = await this.users.walletBalance(user.id);
    return {
      next: { step: "buy_shares", ticker: stock.ticker },
      replies: [text(sharesPrompt(stock, wallet))],
    };
  }

  private async buyShares(
    session: Extract<Session, { step: "buy_shares" }>,
    user: User,
    { input }: Context,
  ): Promise<Transition> {
    const stock = stockByTicker(session.ticker);
    if (!stock)
      return { next: { step: "buy_stock" }, replies: [stockPicker()] };
    const typed = input.text.trim().replace(/,/g, "");
    const shares = /^\d+$/.test(typed) ? Number(typed) : NaN;
    if (!Number.isInteger(shares) || shares < 1 || shares > MAX_SHARES)
      return {
        next: session,
        replies: [
          text(
            `Please send a whole number of shares, from 1 to ${MAX_SHARES.toLocaleString("en-NG")}, e.g. 10.`,
          ),
        ],
      };
    const cost = shares * stock.priceKobo;
    const wallet = await this.users.walletBalance(user.id);
    if (cost > wallet || cost > MAX_AMOUNT_KOBO) {
      const most = Math.floor(
        Math.min(wallet, MAX_AMOUNT_KOBO) / stock.priceKobo,
      );
      return {
        next: session,
        replies: [
          text(
            `${shares.toLocaleString("en-NG")} shares cost ${formatNaira(cost)}` +
              (cost > wallet
                ? `, more than your wallet balance of ${formatNaira(wallet)}.`
                : `, more than the ${formatNaira(MAX_AMOUNT_KOBO)} an order can be.`) +
              ` You can buy up to ${most.toLocaleString("en-NG")}. Please send a smaller number, or reply MENU.`,
          ),
        ],
      };
    }
    return this.confirmBuy("STK", cost, {
      kind: "shares",
      ticker: stock.ticker,
      shares,
      priceKobo: stock.priceKobo,
    });
  }

  /** Trustees: the service, the beneficiary's name, then who they are to the user. */
  private buyTrust({ answer }: Context): Transition {
    const index = /^trust:\d+$/.test(answer)
      ? Number(answer.slice("trust:".length))
      : /^\d+$/.test(answer)
        ? Number(answer) - 1
        : TRUST_SERVICES.findIndex((t) => t.title.toLowerCase() === answer);
    const service = TRUST_SERVICES[index];
    if (!service)
      return {
        next: { step: "buy_trust" },
        replies: [trustPicker("Please choose a service from the list.")],
      };
    return {
      next: { step: "buy_beneficiary", service: service.title },
      replies: [text(beneficiaryPrompt(service.title))],
    };
  }

  private buyBeneficiary(
    session: Extract<Session, { step: "buy_beneficiary" }>,
    { input }: Context,
  ): Transition {
    const name = parseFullName(input.text);
    if (!name.ok) return { next: session, replies: [text(name.error)] };
    return {
      next: {
        step: "buy_relationship",
        service: session.service,
        beneficiary: name.value,
      },
      replies: [relationshipPicker(name.value)],
    };
  }

  private buyRelationship(
    session: Extract<Session, { step: "buy_relationship" }>,
    user: User,
    { answer }: Context,
  ): Promise<Transition> {
    const typed = answer.replace(/^rel:/, "");
    const relationship =
      RELATIONSHIPS.find((r) => r.toLowerCase() === typed) ??
      (/^\d+$/.test(typed) ? RELATIONSHIPS[Number(typed) - 1] : undefined);
    if (!relationship)
      return Promise.resolve({
        next: session,
        replies: [relationshipPicker(session.beneficiary)],
      });
    return this.askBuyAmount(
      "TRS",
      {
        kind: "trust",
        service: session.service,
        beneficiary: session.beneficiary,
        relationship,
      },
      user,
    );
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
    return this.confirmBuy(session.productCode, amount.value, session.details);
  }

  /** What the purchase is and what to expect, with Confirm, Change and Cancel. */
  private confirmBuy(
    productCode: string,
    amountKobo: number,
    details: BuyDetails | undefined,
  ): Transition {
    return {
      next: {
        step: "buy_confirm",
        productCode,
        amountKobo,
        ...(details ? { details } : {}),
      },
      replies: [buyConfirmation(productCode, amountKobo, details)],
    };
  }

  /** Confirm asks for the PIN; Change goes back to the amount (or the shares). */
  private async buyConfirm(
    session: Extract<Session, { step: "buy_confirm" }>,
    user: User,
    ctx: Context,
  ): Promise<Transition> {
    const phrase = asPhrase(ctx.answer);
    const { productCode, amountKobo, details } = session;
    if (ctx.answer === CHOICE.confirmBuy || CONFIRM_WORDS.has(phrase)) {
      const action: PendingAction = {
        type: "buy",
        productCode,
        amountKobo,
        ...(details ? { details } : {}),
      };
      return this.askPin(
        ctx,
        action,
        `*${actionSummary(action)}*\n\nEnter your 4-digit PIN to approve, or reply CANCEL.`,
      );
    }
    if (ctx.answer === CHOICE.changeBuy || CHANGE_WORDS.has(phrase)) {
      if (details?.kind === "shares") {
        const stock = stockByTicker(details.ticker)!;
        return {
          next: { step: "buy_shares", ticker: details.ticker },
          replies: [
            text(sharesPrompt(stock, await this.users.walletBalance(user.id))),
          ],
        };
      }
      return this.askBuyAmount(productCode, details, user);
    }
    return {
      next: session,
      replies: [buyConfirmation(productCode, amountKobo, details)],
    };
  }

  /* --------------------------------------------------------- liquidating */

  /** The products with money in them, to choose one to liquidate. */
  private async startLiquidation(user: User): Promise<Transition> {
    const holdings = (await this.users.holdings(user.id)).filter(
      (h) => h.balanceKobo > 0,
    );
    if (holdings.length === 0)
      return this.menu("What would you like to do?", [
        text(
          "You don't have any investments to liquidate yet. Choose *Buy products* to invest.",
        ),
      ]);
    return {
      next: { step: "liquidate_product" },
      replies: [liquidationPicker(holdings)],
    };
  }

  private async liquidateProduct(
    user: User,
    { answer }: Context,
  ): Promise<Transition> {
    const holdings = (await this.users.holdings(user.id)).filter(
      (h) => h.balanceKobo > 0,
    );
    const code = answer.startsWith("liquidate:")
      ? answer.slice("liquidate:".length).toUpperCase()
      : /^\d+$/.test(answer)
        ? holdings[Number(answer) - 1]?.productCode
        : holdings.find(
            (h) =>
              productTitle(h.productCode).toLowerCase() === answer ||
              h.productCode.toLowerCase() === answer,
          )?.productCode;
    const holding = holdings.find((h) => h.productCode === code);
    if (!holding) {
      if (holdings.length === 0) return this.startLiquidation(user);
      return {
        next: { step: "liquidate_product" },
        replies: [
          liquidationPicker(holdings, "Please choose a product from the list."),
        ],
      };
    }
    return {
      next: { step: "liquidate_amount", productCode: holding.productCode },
      replies: [
        text(liquidationPrompt(holding.productCode, holding.balanceKobo)),
      ],
    };
  }

  private async liquidateAmount(
    session: Extract<Session, { step: "liquidate_amount" }>,
    user: User,
    ctx: Context,
  ): Promise<Transition> {
    const held = await this.holdingOf(user, session.productCode);
    if (held === 0) return this.startLiquidation(user);
    let amountKobo: number;
    if (ALL_WORDS.has(asPhrase(ctx.answer))) amountKobo = held;
    else {
      const amount = parseAmount(ctx.input.text);
      if (!amount.ok) return { next: session, replies: [text(amount.error)] };
      amountKobo = amount.value;
    }
    if (amountKobo > held)
      return {
        next: session,
        replies: [
          text(
            `You hold ${formatNaira(held)} in ${productTitle(session.productCode)}. Please send a smaller amount, or *ALL* for everything.`,
          ),
        ],
      };
    const wallet = await this.users.walletBalance(user.id);
    return {
      next: {
        step: "liquidate_confirm",
        productCode: session.productCode,
        amountKobo,
      },
      replies: [
        liquidationConfirmation(session.productCode, amountKobo, held, wallet),
      ],
    };
  }

  /** Confirm asks for the PIN; Change goes back to the amount. */
  private async liquidateConfirm(
    session: Extract<Session, { step: "liquidate_confirm" }>,
    user: User,
    ctx: Context,
  ): Promise<Transition> {
    const phrase = asPhrase(ctx.answer);
    if (ctx.answer === CHOICE.confirmLiquidate || CONFIRM_WORDS.has(phrase)) {
      const action: PendingAction = {
        type: "liquidate",
        productCode: session.productCode,
        amountKobo: session.amountKobo,
      };
      return this.askPin(
        ctx,
        action,
        `*${actionSummary(action)}*\n\nEnter your 4-digit PIN to approve, or reply CANCEL.`,
      );
    }
    const held = await this.holdingOf(user, session.productCode);
    if (ctx.answer === CHOICE.changeLiquidate || CHANGE_WORDS.has(phrase))
      return {
        next: { step: "liquidate_amount", productCode: session.productCode },
        replies: [text(liquidationPrompt(session.productCode, held))],
      };
    return {
      next: session,
      replies: [
        liquidationConfirmation(
          session.productCode,
          session.amountKobo,
          held,
          await this.users.walletBalance(user.id),
        ),
      ],
    };
  }

  private async holdingOf(user: User, productCode: string): Promise<number> {
    return (
      (await this.users.holdings(user.id)).find(
        (h) => h.productCode === productCode,
      )?.balanceKobo ?? 0
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
    return this.approved(session.action, user);
  }

  /** A request the PIN approved: a paginated view opens on its first page; anything else runs, then the menu. */
  private async approved(
    action: PendingAction,
    user: User,
  ): Promise<Transition> {
    if (action.type === "products" || action.type === "history")
      return this.page(action.type, 1, user);
    return this.menu("Anything else?", [await this.execute(action, user)]);
  }

  /* ------------------------------------------------------ paginated views */

  /** Next / Previous on a page; anything else is read as a menu choice, so "fund" or "2" works from here too. */
  private browse(
    session: Extract<Session, { step: "browse" }>,
    user: User,
    ctx: Context,
  ): Promise<Transition> {
    const phrase = asPhrase(ctx.answer);
    if (ctx.answer === CHOICE.next || NEXT_WORDS.has(phrase))
      return this.page(session.view, session.page + 1, user);
    if (ctx.answer === CHOICE.previous || PREVIOUS_WORDS.has(phrase))
      return this.page(session.view, session.page - 1, user);
    return this.menuChoice(user, ctx);
  }

  /** One page of a view, with Previous / Next / Menu buttons. A page out of range shows the nearest one. */
  private async page(
    view: BrowseView,
    requested: number,
    user: User,
  ): Promise<Transition> {
    const content =
      view === "products"
        ? await this.productsPage(requested, user)
        : await this.historyPage(requested, user);
    if (!content) {
      return this.menu("What would you like to do?", [
        text(
          view === "products"
            ? "You don't have any products yet. Choose *Buy products* to invest in one."
            : "You haven't made any transactions yet. Choose *Fund wallet* to make your first one.",
        ),
      ]);
    }
    const { body, page, pages } = content;
    const nav = [
      ...(page > 1 ? [{ id: CHOICE.previous, title: "◀ Previous" }] : []),
      ...(page < pages ? [{ id: CHOICE.next, title: "Next ▶" }] : []),
      { id: CHOICE.menu, title: "Menu" },
    ];
    return {
      next: { step: "browse", view, page },
      replies: [
        buttons(body, nav, pages > 1 ? `Page ${page} of ${pages}` : undefined),
      ],
    };
  }

  private async productsPage(
    requested: number,
    user: User,
  ): Promise<{ body: string; page: number; pages: number } | null> {
    const holdings = await this.users.holdings(user.id);
    if (holdings.length === 0) return null;
    const pages = Math.ceil(holdings.length / PAGE_SIZE);
    const page = Math.min(Math.max(requested, 1), pages);
    const first = (page - 1) * PAGE_SIZE;
    const total = holdings.reduce((sum, h) => sum + h.balanceKobo, 0);
    const lines = holdings
      .slice(first, first + PAGE_SIZE)
      .map(
        (h, i) =>
          `${first + i + 1}. *${productTitle(h.productCode)}*\n${formatNaira(h.balanceKobo)}`,
      );
    return {
      body:
        `📊 *Your products*\n\n${lines.join("\n\n")}\n\n` +
        `*Total invested: ${formatNaira(total)}*`,
      page,
      pages,
    };
  }

  private async historyPage(
    requested: number,
    user: User,
  ): Promise<{ body: string; page: number; pages: number } | null> {
    const load = (page: number) =>
      this.users.transactions(user.id, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
    const wanted = Math.max(requested, 1);
    const asked = await load(wanted);
    if (asked.total === 0) return null;
    const pages = Math.ceil(asked.total / PAGE_SIZE);
    // A Next tapped on an old page asks past the end: the last page is shown.
    const page = Math.min(wanted, pages);
    const { items } = page === wanted ? asked : await load(page);
    const first = (page - 1) * PAGE_SIZE;
    const lines = items.map(
      (t, i) => `${first + i + 1}. ${transactionLine(t)}`,
    );
    return {
      body: `🧾 *Transaction history*\n_Newest first_\n\n${lines.join("\n\n")}`,
      page,
      pages,
    };
  }

  private async execute(
    action: Exclude<PendingAction, { type: BrowseView }>,
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
              `Wallet balance: ${formatNaira(result.balanceKobo)}\nRef: ${result.reference}\n\n_Demo: no real payment was taken._\n\n${PRIVACY_TIP}`,
          );
        }
        case "withdraw": {
          const result = await this.users.withdrawFromWallet(
            user.id,
            action.amountKobo,
          );
          return text(
            `✅ Your withdrawal of ${formatNaira(action.amountKobo)} is on its way to your bank account.\n\n` +
              `Wallet balance: ${formatNaira(result.balanceKobo)}\nRef: ${result.reference}\n\n_Demo: no real transfer was made._\n\n${PRIVACY_TIP}`,
          );
        }
        case "buy": {
          const note = buyNote(action.amountKobo, action.details);
          const result = await this.users.buyProduct(
            user.id,
            action.productCode,
            action.amountKobo,
            note,
          );
          const title = productTitle(action.productCode);
          return text(
            `✅ You bought ${formatNaira(action.amountKobo)} of ${title}.\n` +
              (note ? `${note[0]!.toUpperCase()}${note.slice(1)}\n` : "") +
              `\n${title}: ${formatNaira(result.productBalanceKobo)}\n` +
              `Wallet balance: ${formatNaira(result.walletBalanceKobo)}\nRef: ${result.reference}\n\n${PRIVACY_TIP}`,
          );
        }
        case "balance":
          return this.balances(user);
        case "liquidate": {
          const result = await this.users.liquidateProduct(
            user.id,
            action.productCode,
            action.amountKobo,
          );
          const title = productTitle(action.productCode);
          return text(
            `✅ ${formatNaira(action.amountKobo)} of ${title} was liquidated into your wallet.\n\n` +
              `${title}: ${formatNaira(result.productBalanceKobo)}\n` +
              `Wallet balance: ${formatNaira(result.walletBalanceKobo)}\nRef: ${result.reference}\n\n` +
              `_Demo: no real redemption was made._\n\n${PRIVACY_TIP}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof InsufficientHoldingError) {
        return text(
          `❌ That product now holds ${formatNaira(error.availableKobo)}, which isn't enough for this request. Nothing was moved.`,
        );
      }
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

/** An answer as a phrase to match word lists: letters, digits and single spaces ("Cancel!" → "cancel"). */
function asPhrase(answer: string): string {
  return answer
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isEditStep(session: Session): boolean {
  return session.step.startsWith("edit_");
}

/** What a cancelled request is called in the confirmation. */
const CANCELLED = {
  fund: "Your wallet funding",
  withdraw: "Your withdrawal",
  buy: "Your purchase",
  balance: "Your balance check",
  products: "Viewing your products",
  history: "Viewing your transaction history",
  liquidate: "Your liquidation",
} as const satisfies Record<PendingAction["type"], string>;

/** The request a session of an onboarded user has in progress, or null at the menu. */
function cancelledWhat(session: Session): PendingAction["type"] | null {
  switch (session.step) {
    case "fund_amount":
      return "fund";
    case "withdraw_amount":
      return "withdraw";
    case "buy_product":
    case "buy_tenor":
    case "buy_stock":
    case "buy_shares":
    case "buy_trust":
    case "buy_beneficiary":
    case "buy_relationship":
    case "buy_amount":
    case "buy_confirm":
      return "buy";
    case "liquidate_product":
    case "liquidate_amount":
    case "liquidate_confirm":
      return "liquidate";
    case "transaction":
      return session.type;
    case "authorize":
      return session.action.type;
    default:
      return null;
  }
}

/** One transaction in the history: what it was, the amount, when, and its reference. */
function transactionLine(t: TransactionRecord): string {
  const product = t.productCode ? productTitle(t.productCode) : "a product";
  const amount = formatNaira(t.amountKobo);
  const what = {
    fund: `*Wallet funded* · +${amount}`,
    withdraw: `*Withdrawal* · −${amount}`,
    buy: `*Bought ${product}* · ${amount}`,
    liquidate: `*Liquidated ${product}* · +${amount} to wallet`,
  }[t.type];
  const status = t.status === "successful" ? "" : ` (${t.status})`;
  const note = t.note ? `\n${t.note}` : "";
  return `${what}${status}${note}\n${formatWhen(t.createdAt)} · Ref ${t.reference}`;
}

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

function liquidationPicker(
  holdings: { productCode: string; balanceKobo: number }[],
  body = "Which investment would you like to liquidate? The money goes back to your wallet.",
): OutboundMessage {
  return list(body, "Investments", [
    {
      title: "Your investments",
      rows: holdings.map((h) => ({
        id: `liquidate:${h.productCode}`,
        title: productTitle(h.productCode),
        description: `${formatNaira(h.balanceKobo)} invested`,
      })),
    },
  ]);
}

function liquidationPrompt(productCode: string, heldKobo: number): string {
  const note = LIQUIDATION_NOTES[productCode];
  return (
    `*${productTitle(productCode)}*\nYou hold *${formatNaira(heldKobo)}*.\n\n` +
    (note ? `${note}\n\n` : "") +
    "How much would you like to liquidate into your wallet? Send the amount in naira, or *ALL* for everything."
  );
}

function liquidationConfirmation(
  productCode: string,
  amountKobo: number,
  heldKobo: number,
  walletKobo: number,
): OutboundMessage {
  const title = productTitle(productCode);
  const note = LIQUIDATION_NOTES[productCode];
  return buttons(
    `*Please confirm your liquidation*\n\n` +
      `Product: ${title}\nAmount: *${formatNaira(amountKobo)}*\n` +
      `Left in ${title}: ${formatNaira(heldKobo - amountKobo)}\n` +
      `Wallet after: ${formatNaira(walletKobo + amountKobo)}` +
      (note ? `\n\n${note}` : ""),
    [
      { id: CHOICE.confirmLiquidate, title: "Confirm" },
      { id: CHOICE.changeLiquidate, title: "Change amount" },
      { id: CHOICE.cancel, title: "Cancel" },
    ],
  );
}

function tenorPicker(): OutboundMessage {
  return buttons(
    tenorPrompt(),
    FIF_TENORS.map((t) => ({ id: `tenor:${t.days}`, title: `${t.days} days` })),
  );
}

function stockPicker(
  body = "Which stock would you like to buy?",
): OutboundMessage {
  return list(`*${productTitle("STK")}*\n\n${body}`, "Stocks", [
    {
      title: "Nigerian Exchange",
      rows: STOCKS.map((st) => ({
        id: `stock:${st.ticker}`,
        title: st.name,
        description: `${st.ticker} · ${formatNaira(st.priceKobo)} a share`,
      })),
    },
  ]);
}

function trustPicker(body = "Which service would you like?"): OutboundMessage {
  return list(`*${productTitle("TRS")}*\n\n${body}`, "Services", [
    {
      title: "Trustee services",
      rows: TRUST_SERVICES.map((t, i) => ({
        id: `trust:${i}`,
        title: t.title,
        description: t.description,
      })),
    },
  ]);
}

function beneficiaryPrompt(service: string): string {
  return service === "Simple will"
    ? "Who is the main beneficiary of your will? Please send their full name, e.g. Ada Obi."
    : `Who is the ${service.toLowerCase()} for? Please send the beneficiary's full name, e.g. Ada Obi.`;
}

function relationshipPicker(beneficiary: string): OutboundMessage {
  return list(`What is ${beneficiary} to you?`, "Relationship", [
    {
      title: "Relationship",
      rows: RELATIONSHIPS.map((r) => ({
        id: `rel:${r.toLowerCase()}`,
        title: r,
      })),
    },
  ]);
}

function buyConfirmation(
  productCode: string,
  amountKobo: number,
  details: BuyDetails | undefined,
): OutboundMessage {
  return buttons(
    `*Please confirm your purchase*\n\n${buyQuote(productCode, amountKobo, details)}`,
    [
      { id: CHOICE.confirmBuy, title: "Confirm" },
      {
        id: CHOICE.changeBuy,
        title: details?.kind === "shares" ? "Change shares" : "Change amount",
      },
      { id: CHOICE.cancel, title: "Cancel" },
    ],
  );
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

/**
 * The first form message doesn't mention TYPE: when WhatsApp refuses the form,
 * the chat steps start by themselves. The reminder sent when the user writes
 * instead of filling it in offers them, for a phone that can't open forms.
 */
interface FormOptions {
  offerChat?: boolean;
}

function onboardingFlowMessage(
  token: string,
  lead: string,
  { offerChat = false }: FormOptions = {},
): OutboundMessage {
  return flowMessage(
    "onboarding",
    token,
    `${lead}\n\nTap *Open form* to enter your BVN, date of birth, products and PIN. ` +
      "What you enter in the form is sent securely and isn't shown in this chat, " +
      "and you can review and change it before your account is created." +
      (offerChat ? `\n\n${TYPE_INSTEAD}` : ""),
    "Open form",
    // Sent if WhatsApp refuses the form: the chat steps' first question.
    `${lead}\n\n${bvnPrompt("*Step 1 of 4*\nPlease enter")}`,
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
  { offerChat = false }: FormOptions = {},
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
      (offerChat
        ? `${TYPE_INSTEAD} Or reply MENU to go back.`
        : "Or reply MENU to go back."),
    TRANSACTION_CTA[type],
    // Unused: a refused transaction form is replaced by the chat steps' own first question.
    "Let's do it here in the chat.",
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
