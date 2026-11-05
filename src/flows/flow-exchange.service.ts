import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { MAX_PIN_ATTEMPTS } from "../conversation/conversation.constants";
import { ConversationService } from "../conversation/conversation.service";
import {
  actionSummary,
  formatDob,
  hideBvn,
  productsText,
} from "../conversation/format";
import {
  formatNaira,
  MAX_AGE,
  MIN_AGE,
  parseAmount,
  parseDateOfBirth,
  parseNewPin,
} from "../conversation/parsers";
import { PRODUCTS, productByCode } from "../conversation/products";
import { SessionsRepository } from "../database/sessions.repository";
import { UsersRepository } from "../database/users.repository";
import { QueueService } from "../queue/queue.service";
import { text } from "../whatsapp/messages";
import type {
  OnboardingDraft,
  PendingAction,
  Session,
} from "../conversation/conversation.interface";
import type { User } from "../database/users.interface";
import type { OutboundMessage } from "../whatsapp/whatsapp.interface";
import type { FlowRef, FlowRequest, FlowResponse } from "./flows.interface";

/** A token that isn't (or no longer) the conversation's open form: HTTP 427, and WhatsApp closes the form. */
export class FlowTokenError extends Error {
  constructor() {
    super("This form is no longer valid");
  }
}

type OnboardingSession = Extract<Session, { step: "onboarding_flow" }>;
type TransactionSession = Extract<Session, { step: "transaction" }>;
type AuthorizeSession = Extract<Session, { step: "authorize" }>;

/** One answer, as the history shows it: masked, with the error the form showed, if any. */
interface Answer {
  text: string;
  error?: string;
}

/** What one request did: the screen to answer, the session to keep, and the answer to log. */
interface Outcome {
  response: FlowResponse;
  next: Session;
  /** Logged at once: an answer the form moves on from, or one it refused. */
  answer?: Answer;
  /**
   * The form is done: this answer is queued as the user's message instead of
   * logged, and the state machine finishes the request (creates the account,
   * moves the money) and sends its replies through the outbound queue.
   */
  finish?: string;
}

const close = (token: string): FlowResponse => ({
  screen: "SUCCESS",
  data: { extension_message_response: { params: { flow_token: token } } },
});

const PIN_MASK = "••••";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isComplete(draft: Partial<OnboardingDraft>): draft is OnboardingDraft {
  return Boolean(
    draft.bvn &&
    draft.dateOfBirth &&
    draft.productCodes?.length &&
    draft.pinHash,
  );
}

/** YYYY-MM-DD, `years` before `now` (UTC). */
function yearsAgo(years: number, now = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()),
  );
  return d.toISOString().slice(0, 10);
}

/**
 * The Flow endpoint's logic, after decryption (WhatsApp) or as is (the
 * simulator): each screen's answer is validated before the next screen opens,
 * and logged in the conversation's history as the user's message, masked (a
 * BVN to its last 4 digits, PINs as dots). Sessions are updated under the
 * conversation's own lock, so a form and a chat message never race.
 */
@Injectable()
export class FlowExchangeService {
  private readonly logger = new Logger(FlowExchangeService.name);

  constructor(
    private readonly conversation: ConversationService,
    private readonly users: UsersRepository,
    private readonly log: SessionsRepository,
    private readonly queues: QueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Answers one request. `simulatorOnly` refuses tokens of WhatsApp
   * conversations: the simulator's unencrypted route must never drive them.
   */
  async exchange(
    request: FlowRequest,
    { simulatorOnly = false }: { simulatorOnly?: boolean } = {},
  ): Promise<FlowResponse> {
    if (request.action === "ping") return { data: { status: "active" } };
    if (request.data && "error" in request.data) {
      this.logger.warn(
        `WhatsApp reported a Flow error on ${request.screen ?? "?"}: ${str(request.data.error)} ${str(request.data.error_message)}`,
      );
      return { data: { acknowledged: true } };
    }

    const token = request.flow_token ?? "";
    const ref = token ? await this.conversation.flowRef(token) : undefined;
    if (!ref || (simulatorOnly && ref.source !== "simulator"))
      throw new FlowTokenError();

    return this.conversation.exclusive(ref.waId, async () => {
      const session = await this.conversation.session(ref.waId);
      if (!session || !("flowToken" in session) || session.flowToken !== token)
        throw new FlowTokenError();

      const outcome = await this.route(session, request, ref);
      await this.conversation.saveSession(ref.waId, outcome.next);
      if (outcome.answer) await this.record(ref, session, outcome);
      if (outcome.finish !== undefined) await this.finish(ref, token, outcome);
      return outcome.response;
    });
  }

  private route(
    session: Session,
    request: FlowRequest,
    ref: FlowRef,
  ): Promise<Outcome> {
    switch (session.step) {
      case "onboarding_flow":
        return this.onboarding(session, request);
      case "transaction":
        return this.transaction(session, request, ref);
      case "authorize":
        return this.authorize(session, request, ref);
      default:
        throw new FlowTokenError();
    }
  }

  /* --------------------------------------------------------- onboarding */

  private async onboarding(
    session: OnboardingSession,
    request: FlowRequest,
  ): Promise<Outcome> {
    const draft = { ...session.draft };
    const data = request.data ?? {};
    if (request.action !== "data_exchange")
      return { response: bvnScreen(""), next: session };

    switch (request.screen) {
      case "BVN": {
        const raw = str(data.bvn);
        const answer = { text: `BVN: ${hideBvn(raw)}` };
        const bvn = await this.conversation.checkBvn(raw);
        if (!bvn.ok)
          return {
            response: bvnScreen(bvn.error),
            next: session,
            answer: { ...answer, error: bvn.error },
          };
        draft.bvn = bvn.value;
        return {
          response: isComplete(draft) ? reviewScreen(draft) : dobScreen(""),
          next: { ...session, draft },
          answer,
        };
      }
      case "DOB": {
        const raw = str(data.dob);
        const answer = { text: `Date of birth: ${formatDob(raw)}` };
        const dob = parseDateOfBirth(raw);
        if (!dob.ok)
          return {
            response: dobScreen(dob.error),
            next: session,
            answer: { ...answer, error: dob.error },
          };
        draft.dateOfBirth = dob.value;
        return {
          response: isComplete(draft) ? reviewScreen(draft) : productsScreen(),
          next: { ...session, draft },
          answer,
        };
      }
      case "PRODUCTS": {
        const ids = Array.isArray(data.products)
          ? data.products.filter((id): id is string => typeof id === "string")
          : [];
        const known = ids.filter((id) => productByCode(id));
        // In the catalogue's order, once each.
        const codes = PRODUCTS.map((p) => p.code).filter((c) =>
          known.includes(c),
        );
        const answer = {
          text: `Products: ${codes.length ? productsText(codes) : "none"}`,
        };
        if (codes.length === 0 || known.length !== ids.length) {
          const error = "Please choose at least one product.";
          return {
            response: productsScreen(error),
            next: session,
            answer: { ...answer, error },
          };
        }
        draft.productCodes = codes;
        return {
          response: isComplete(draft) ? reviewScreen(draft) : pinScreen("", ""),
          next: { ...session, draft },
          answer,
        };
      }
      case "PIN": {
        const pin = str(data.pin);
        const confirm = str(data.pin_confirm);
        const answer = { text: `PIN: ${PIN_MASK} · Confirm PIN: ${PIN_MASK}` };
        const parsed = parseNewPin(pin, draft.dateOfBirth);
        if (!parsed.ok)
          return {
            response: pinScreen(parsed.error, ""),
            next: session,
            answer: { ...answer, error: parsed.error },
          };
        if (confirm !== pin) {
          const error =
            "The PINs don't match. Please enter the same PIN twice.";
          return {
            response: pinScreen("", error),
            next: session,
            answer: { ...answer, error },
          };
        }
        draft.pinHash = await Bun.password.hash(pin);
        if (!isComplete(draft)) throw new FlowTokenError();
        return {
          response: reviewScreen(draft),
          next: { ...session, draft },
          answer: { text: `PIN: ${PIN_MASK} (confirmed)` },
        };
      }
      case "REVIEW": {
        if (!isComplete(draft)) {
          const error =
            "Some answers are missing. Please go back and fill them in.";
          return {
            response: { screen: "REVIEW", data: { error_message: error } },
            next: session,
            answer: { text: "Confirm & create", error },
          };
        }
        return {
          response: close(session.flowToken),
          next: { ...session, draft, submitted: true },
          finish: "Confirm & create",
        };
      }
      default:
        return { response: bvnScreen(""), next: session };
    }
  }

  /* ------------------------------------------------- fund/withdraw/buy */

  private async transaction(
    session: TransactionSession,
    request: FlowRequest,
    ref: FlowRef,
  ): Promise<Outcome> {
    const user = await this.users.findByWaId(ref.waId);
    if (!user) throw new FlowTokenError();
    const wallet = await this.users.walletBalance(user.id);
    const data = request.data ?? {};

    if (request.action !== "data_exchange" || request.screen !== "AMOUNT") {
      if (request.action === "data_exchange" && request.screen === "PIN")
        return this.checkPin(session, user, str(data.pin));
      return { response: amountScreen(session, wallet, ""), next: session };
    }

    let productCode: string | undefined;
    if (session.type === "buy") {
      productCode = productByCode(str(data.product))?.code;
      if (!productCode) {
        const error = "Please choose a product.";
        return {
          response: {
            ...amountScreen(session, wallet, ""),
            data: {
              ...amountScreen(session, wallet, "").data,
              error_message: error,
            },
          },
          next: session,
          answer: { text: "Product: none", error },
        };
      }
    }
    const amount = parseAmount(str(data.amount));
    const shown = amount.ok ? formatNaira(amount.value) : str(data.amount);
    const answer = {
      text: productCode
        ? `${productsText([productCode])} · ${shown}`
        : `Amount: ${shown}`,
    };
    let error = amount.ok ? "" : amount.error;
    if (amount.ok && session.type !== "fund" && amount.value > wallet)
      error = `Your wallet balance is ${formatNaira(wallet)}. Please enter a smaller amount.`;
    if (error || !amount.ok)
      return {
        response: amountScreen(session, wallet, error),
        next: session,
        answer: { ...answer, error },
      };

    const action: PendingAction =
      session.type === "buy"
        ? { type: "buy", productCode: productCode!, amountKobo: amount.value }
        : { type: session.type, amountKobo: amount.value };
    return {
      response: approveScreen(action, ""),
      next: { ...session, action, attempts: 0 },
      answer,
    };
  }

  /* ---------------------------------------------------------------- PIN */

  private async authorize(
    session: AuthorizeSession,
    request: FlowRequest,
    ref: FlowRef,
  ): Promise<Outcome> {
    const user = await this.users.findByWaId(ref.waId);
    if (!user) throw new FlowTokenError();
    if (request.action === "data_exchange" && request.screen === "PIN")
      return this.checkPin(session, user, str(request.data?.pin));
    return { response: approveScreen(session.action, ""), next: session };
  }

  /**
   * The PIN that approves a request: 4 digits, checked against the user's
   * (the strength rules are for a new PIN only). The third wrong one closes
   * the form and cancels the request.
   */
  private async checkPin<S extends TransactionSession | AuthorizeSession>(
    session: S,
    user: User,
    pin: string,
  ): Promise<Outcome> {
    const action = session.action;
    if (!action) throw new FlowTokenError();
    const answer = { text: `PIN: ${PIN_MASK}` };
    if (!/^\d{4}$/.test(pin)) {
      const error = "Your PIN is 4 digits.";
      return {
        response: approveScreen(action, error),
        next: session,
        answer: { ...answer, error },
      };
    }
    if (await Bun.password.verify(pin, user.pinHash))
      return {
        response: close(session.flowToken!),
        next: { ...session, approved: true },
        finish: answer.text,
      };

    const attempts = session.attempts + 1;
    if (attempts >= MAX_PIN_ATTEMPTS)
      return {
        response: close(session.flowToken!),
        next: { ...session, attempts },
        finish: answer.text,
      };
    const left = MAX_PIN_ATTEMPTS - attempts;
    const error = `Incorrect PIN. You have ${left} attempt${left === 1 ? "" : "s"} left.`;
    return {
      response: approveScreen(action, error),
      next: { ...session, attempts },
      answer: { ...answer, error },
    };
  }

  /* ------------------------------------------------------------ history */

  /** Logs an answer as the user's message, and a refusal as the reply the form showed. */
  private async record(
    ref: FlowRef,
    before: Session,
    outcome: Outcome,
  ): Promise<void> {
    const { answer, next } = outcome;
    const replies: OutboundMessage[] = answer!.error
      ? [text(answer!.error)]
      : [];
    await this.log.record({
      waId: ref.waId,
      source: ref.source,
      ...(ref.profileName ? { profileName: ref.profileName } : {}),
      phoneNumberId:
        ref.source === "whatsapp" ? this.config.whatsapp.phoneNumberId : null,
      stepBefore: before.step,
      stepAfter: next.step,
      input: { text: answer!.text },
      replies,
      ttlMs: this.config.sessionTtlMs,
      masked: true,
      inKind: "flow",
    });
  }

  /**
   * Queues the form's last answer as the user's message, as a webhook delivery
   * would: the state machine logs it and finishes the request.
   */
  private async finish(
    ref: FlowRef,
    token: string,
    outcome: Outcome,
  ): Promise<void> {
    await this.queues.enqueueInbound([
      {
        messageId: `flow.${crypto.randomUUID()}`,
        phoneNumberId:
          ref.source === "whatsapp"
            ? this.config.whatsapp.phoneNumberId || null
            : null,
        waId: ref.waId,
        ...(ref.profileName ? { name: ref.profileName } : {}),
        timestamp: Math.floor(Date.now() / 1000),
        input: { text: outcome.finish!, flowToken: token },
        source: ref.source,
      },
    ]);
  }
}

/* ------------------------------------------------------------- screens */

function bvnScreen(error: string): FlowResponse {
  return { screen: "BVN", data: { bvn_error: error } };
}

function dobScreen(error: string): FlowResponse {
  return {
    screen: "DOB",
    data: {
      min_date: yearsAgo(MAX_AGE),
      max_date: yearsAgo(MIN_AGE),
      dob_error: error,
    },
  };
}

function productsScreen(error?: string): FlowResponse {
  return {
    screen: "PRODUCTS",
    data: {
      products: PRODUCTS.map((p) => ({ id: p.code, title: p.title })),
      ...(error ? { error_message: error } : {}),
    },
  };
}

function pinScreen(pinError: string, confirmError: string): FlowResponse {
  return {
    screen: "PIN",
    data: { pin_error: pinError, pin_confirm_error: confirmError },
  };
}

function reviewScreen(draft: OnboardingDraft): FlowResponse {
  return {
    screen: "REVIEW",
    data: {
      bvn_masked: hideBvn(draft.bvn),
      dob_text: formatDob(draft.dateOfBirth),
      products_text: productsText(draft.productCodes),
    },
  };
}

function amountScreen(
  session: TransactionSession,
  walletKobo: number,
  error: string,
): FlowResponse {
  const heading = {
    fund: "Fund your wallet",
    withdraw: "Withdraw to your bank",
    buy: "Buy a product",
  }[session.type];
  const details =
    session.type === "fund"
      ? `Wallet balance: ${formatNaira(walletKobo)}`
      : `Available in your wallet: ${formatNaira(walletKobo)}`;
  return {
    screen: "AMOUNT",
    data: {
      heading,
      details,
      choose_product: session.type === "buy",
      products: PRODUCTS.map((p) => ({ id: p.code, title: p.title })),
      amount_error: error,
    },
  };
}

function approveScreen(action: PendingAction, error: string): FlowResponse {
  return {
    screen: "PIN",
    data: { summary: `${actionSummary(action)}.`, pin_error: error },
  };
}
