import {
  Describe,
  Validate,
  ValidBody,
  ValidParams,
} from "@kingsleyweb/bun-nest";
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { SQL } from "bun";
import { ConversationService } from "../conversation/conversation.service";
import { APP_DB } from "../database/database";
import { toPlainText } from "../whatsapp/messages";
import { WhatsAppClient } from "../whatsapp/whatsapp.client";
import type {
  OutboxResponse,
  ResetParams,
  ResetResponse,
  SimulateBody,
  SimulateResponse,
} from "./dev.interface";
import {
  ErrorResponseDto,
  OutboxResponseDto,
  ResetParamsDto,
  ResetResponseDto,
  SimulateBodyDto,
  SimulateResponseDto,
} from "./dev.dto";

/**
 * Chat with the bot without WhatsApp: the API behind the chat UI. Only
 * mounted when ENABLE_DEV_ROUTES is on, never in production. The conversation
 * runs directly, not through the queues, so the replies come back in the
 * response.
 */
@Controller("dev")
@Describe({ tags: ["dev"] })
export class DevController {
  constructor(
    private readonly conversation: ConversationService,
    private readonly whatsapp: WhatsAppClient,
    @Inject(APP_DB) private readonly sql: SQL,
  ) {}

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
    summary: "Delete a test user's account and session",
  })
  async reset(@ValidParams() params: ResetParams): Promise<ResetResponse> {
    await this.conversation.endSession(params.waId, "reset from the simulator");
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
