import {
  Describe,
  Validate,
  ValidBody,
  ValidParams,
  ValidQuery,
} from "@kingsleyweb/bun-nest";
import {
  Controller,
  Delete,
  Get,
  GoneException,
  HttpCode,
  Inject,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { SQL } from "bun";
import { ConversationService } from "../conversation/conversation.service";
import { APP_DB } from "../database/database";
import { SessionsRepository } from "../database/sessions.repository";
import { QueueService } from "../queue/queue.service";
import { toPlainText } from "../whatsapp/messages";
import { FLOW_DEFINITIONS } from "../flows/definitions";
import {
  FlowExchangeService,
  FlowTokenError,
} from "../flows/flow-exchange.service";
import { WhatsAppClient } from "../whatsapp/whatsapp.client";
import type {
  ConversationQuery,
  ConversationResponse,
  FlowDefinitionResponse,
  FlowExchangeBody,
  FlowExchangeResponse,
  FlowNameParams,
  OutboxResponse,
  ResetParams,
  ResetResponse,
  SendMessageResponse,
  SimulateBody,
  SimulateResponse,
} from "./dev.interface";
import {
  ConversationParamsDto,
  ConversationQueryDto,
  ConversationResponseDto,
  ErrorResponseDto,
  FlowDefinitionDto,
  FlowExchangeBodyDto,
  FlowExchangeResponseDto,
  FlowNameParamsDto,
  OutboxResponseDto,
  ResetParamsDto,
  ResetResponseDto,
  SendMessageResponseDto,
  SimulateBodyDto,
  SimulateResponseDto,
} from "./dev.dto";

/** How often a waiting conversation read looks for something new. */
const POLL_MS = 250;

/**
 * Chat with the bot without WhatsApp: the API behind the chat UI. Only
 * mounted when ENABLE_DEV_ROUTES is on, never in production.
 *
 * - `POST /dev/messages` puts a message on the inbound queue, exactly as a
 *   webhook delivery does; its replies go through the outbound queue, which
 *   delivers them to the simulator instead of WhatsApp.
 * - `GET /dev/conversations/:waId` reads the stored conversation, from any
 *   device, and can wait for new entries (long polling).
 * - `POST /dev/simulate` runs the state machine directly and answers the
 *   replies in the response (the tests and scripts use it).
 */
@Controller("dev")
@Describe({ tags: ["dev"] })
export class DevController {
  constructor(
    private readonly conversation: ConversationService,
    private readonly whatsapp: WhatsAppClient,
    private readonly queues: QueueService,
    private readonly log: SessionsRepository,
    private readonly flows: FlowExchangeService,
    @Inject(APP_DB) private readonly sql: SQL,
  ) {}

  /** A Flow's Flow JSON, which the simulator renders as WhatsApp would. */
  @Get("flows/:name")
  @Validate({
    params: FlowNameParamsDto,
    responses: { 200: FlowDefinitionDto, 400: ErrorResponseDto },
  })
  @Describe({
    operationId: "flowDefinition",
    summary: "The Flow JSON of a WhatsApp Flow (onboarding, pin, transaction)",
  })
  flowDefinition(
    @ValidParams() params: FlowNameParams,
  ): FlowDefinitionResponse {
    return { ...FLOW_DEFINITIONS[params.name] };
  }

  /**
   * A form's request, as WhatsApp would send it to the Flow endpoint but
   * unencrypted: the simulator's forms. Only simulator conversations' tokens
   * are accepted.
   */
  @Post("flows/exchange")
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Validate({
    body: FlowExchangeBodyDto,
    responses: {
      200: FlowExchangeResponseDto,
      400: ErrorResponseDto,
      410: ErrorResponseDto,
      429: ErrorResponseDto,
    },
  })
  @Describe({
    operationId: "flowExchange",
    summary:
      "Send a simulator form's request to the Flow endpoint's logic (no encryption)",
  })
  async flowExchange(
    @ValidBody() body: FlowExchangeBody,
  ): Promise<FlowExchangeResponse> {
    try {
      return await this.flows.exchange(body, { simulatorOnly: true });
    } catch (error) {
      if (error instanceof FlowTokenError)
        throw new GoneException("This form has expired. Open the latest one.");
      throw error;
    }
  }

  @Post("messages")
  @HttpCode(202)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Validate({
    body: SimulateBodyDto,
    responses: {
      202: SendMessageResponseDto,
      400: ErrorResponseDto,
      429: ErrorResponseDto,
    },
  })
  @Describe({
    operationId: "sendMessage",
    summary:
      "Send a message as a WhatsApp user, through the same queues as a webhook delivery",
  })
  async send(@ValidBody() body: SimulateBody): Promise<SendMessageResponse> {
    const now = new Date();
    const messageId = `sim.${crypto.randomUUID()}`;
    await this.queues.enqueueInbound([
      {
        messageId,
        phoneNumberId: null,
        waId: body.from,
        ...(body.name ? { name: body.name } : {}),
        timestamp: Math.floor(now.getTime() / 1000),
        input: {
          text: body.text,
          ...(body.choiceId ? { choiceId: body.choiceId } : {}),
        },
        source: "simulator",
      },
    ]);
    return { messageId, at: now.toISOString() };
  }

  @Get("conversations/:waId")
  @Validate({
    params: ConversationParamsDto,
    query: ConversationQueryDto,
    responses: {
      200: ConversationResponseDto,
      400: ErrorResponseDto,
      429: ErrorResponseDto,
    },
  })
  @Describe({
    operationId: "conversation",
    summary:
      "A number's stored conversation, oldest first; `wait` holds the answer until something new arrives",
  })
  async conversationOf(
    @ValidParams() params: { waId: string },
    @ValidQuery() query: ConversationQuery,
  ): Promise<ConversationResponse> {
    // Waits stay under Bun's default 10 s idle timeout (the DTO caps them at 8 s).
    const until = Date.now() + query.wait * 1000;
    let entries = await this.log.conversation(params.waId, query.after);
    while (entries.length === 0 && Date.now() < until) {
      await Bun.sleep(POLL_MS);
      entries = await this.log.conversation(params.waId, query.after);
    }
    const session = await this.conversation.session(params.waId);
    return { step: session?.step ?? null, entries };
  }

  @Post("simulate")
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Validate({
    body: SimulateBodyDto,
    responses: {
      200: SimulateResponseDto,
      400: ErrorResponseDto,
      429: ErrorResponseDto,
    },
  })
  @Describe({
    operationId: "simulate",
    summary: "Send one message to the bot as a WhatsApp user",
  })
  async simulate(@ValidBody() body: SimulateBody): Promise<SimulateResponse> {
    const replies = await this.conversation.handle(
      { waId: body.from, ...(body.name ? { name: body.name } : {}) },
      {
        text: body.text,
        ...(body.choiceId ? { choiceId: body.choiceId } : {}),
      },
      { source: "simulator" },
    );
    const session = await this.conversation.session(body.from);
    return {
      step: session?.step ?? null,
      replies,
      transcript: replies.map(toPlainText).join("\n\n────────\n\n"),
    };
  }

  /** Forgets a number: its session and its account, so it can onboard again. */
  @Delete("users/:waId")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Validate({
    params: ResetParamsDto,
    responses: {
      200: ResetResponseDto,
      400: ErrorResponseDto,
      429: ErrorResponseDto,
    },
  })
  @Describe({
    operationId: "resetUser",
    summary: "Delete a test number's account, session and stored conversation",
  })
  async reset(@ValidParams() params: ResetParams): Promise<ResetResponse> {
    await this.conversation.endSession(params.waId, "reset from the simulator");
    await this.log.deleteConversation(params.waId);
    const rows: unknown[] = await this
      .sql`DELETE FROM users WHERE wa_id = ${params.waId} RETURNING id`;
    return { deletedUser: rows.length > 0 };
  }

  /** What dry-run mode recorded instead of sending (the last 200 messages). */
  @Get("outbox")
  @Validate({ responses: { 200: OutboxResponseDto } })
  @Describe({
    operationId: "outbox",
    summary: "Messages the dry-run WhatsApp client recorded",
  })
  outbox(): OutboxResponse {
    return {
      dryRun: this.whatsapp.dryRun,
      messages: this.whatsapp.sent.map((m) => ({
        ...m,
        at: m.at.toISOString(),
      })),
    };
  }
}
