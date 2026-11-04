import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import {
  Describe,
  Validate,
  ValidBody,
  ValidParams,
  ValidQuery,
} from "@kingsleyweb/bun-nest";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { APP_CONFIG, type AppConfig } from "../config";
import { ConversationService } from "../conversation/conversation.service";
import { clientIp } from "../security/client-ip";
import { maskBvn } from "../conversation/parsers";
import { SessionsRepository } from "../database/sessions.repository";
import { UsersRepository } from "../database/users.repository";
import { AdminAuthService } from "./admin-auth.service";
import type { SessionRecord } from "../database/sessions.interface";
import type {
  AdminRequest,
  AdminSession,
  LoginBody,
  MeResponse,
  SessionDetail,
  SessionSummary,
  SessionsQuery,
  SessionsResponse,
} from "./admin.interface";
import {
  LoginBodyDto,
  MeResponseDto,
  OkResponseDto,
  ProblemResponseDto,
  ResetSessionResponseDto,
  SessionDetailDto,
  SessionsQueryDto,
  SessionsResponseDto,
  WaIdParamsDto,
} from "./admin.dto";
import type { Session } from "../conversation/conversation.interface";

/** Lets a request through only with a live admin session cookie. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const admin = await this.auth.authenticate(req);
    if (!admin) throw new UnauthorizedException("Sign in to continue.");
    req.admin = admin;
    return true;
  }
}

function toMe(session: AdminSession): MeResponse {
  return {
    admin: {
      id: session.adminId,
      email: session.email,
      username: session.username,
    },
    expiresAt: session.expiresAt,
  };
}

/** Removes what an admin must never see from a live state: the PIN hash, the full BVN. */
function redactState(state: Session): Record<string, unknown> {
  const out: Record<string, unknown> = { ...state };
  if ("pinHash" in out) out.pinHash = "[redacted]";
  if (typeof out.bvn === "string") out.bvn = maskBvn(out.bvn);
  return out;
}

/** The admin API behind the admin UI: sign-in, and the conversations the bot is having. */
@Controller("admin/api")
@Describe({ tags: ["admin"] })
export class AdminController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly sessions: SessionsRepository,
    private readonly users: UsersRepository,
    private readonly conversation: ConversationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("login")
  @HttpCode(200)
  // On top of the per-account lockout: 10 attempts a minute per address, then 15 minutes out.
  @Throttle({ default: { limit: 10, ttl: 60_000, blockDuration: 15 * 60_000 } })
  @Validate({
    body: LoginBodyDto,
    responses: {
      200: MeResponseDto,
      400: ProblemResponseDto,
      401: ProblemResponseDto,
      429: ProblemResponseDto,
    },
  })
  @Describe({
    operationId: "adminLogin",
    summary: "Sign in with an email or username and a password",
  })
  async login(
    @ValidBody() body: LoginBody,
    @Req() req: BunRequest,
    @Res({ passthrough: true }) res: BunResponse,
  ): Promise<MeResponse> {
    const { token, session } = await this.auth.login(
      body.identifier,
      body.password,
      clientIp(req, this.config),
    );
    this.auth.setCookie(res, token);
    return toMe(session);
  }

  @Post("logout")
  @HttpCode(200)
  @Validate({ responses: { 200: OkResponseDto } })
  @Describe({ operationId: "adminLogout", summary: "Sign out" })
  async logout(
    @Req() req: BunRequest,
    @Res({ passthrough: true }) res: BunResponse,
  ): Promise<{ ok: true }> {
    await this.auth.logout(req);
    this.auth.clearCookie(res);
    return { ok: true };
  }

  @Get("me")
  @UseGuards(AdminGuard)
  @Validate({ responses: { 200: MeResponseDto, 401: ProblemResponseDto } })
  @Describe({ operationId: "adminMe", summary: "The signed-in admin" })
  me(@Req() req: AdminRequest): MeResponse {
    return toMe(req.admin!);
  }

  @Get("sessions")
  @UseGuards(AdminGuard)
  @Validate({
    query: SessionsQueryDto,
    responses: {
      200: SessionsResponseDto,
      400: ProblemResponseDto,
      401: ProblemResponseDto,
      429: ProblemResponseDto,
    },
  })
  @Describe({
    operationId: "adminSessions",
    summary: "Conversations, newest activity first",
  })
  async list(@ValidQuery() query: SessionsQuery): Promise<SessionsResponse> {
    const [{ total, sessions }, stats] = await Promise.all([
      this.sessions.list({
        ...(query.source ? { source: query.source } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search ? { search: query.search } : {}),
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      }),
      this.sessions.stats(),
    ]);
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      sessions: await Promise.all(sessions.map((s) => this.summarise(s))),
      stats,
    };
  }

  @Get("sessions/:waId")
  @UseGuards(AdminGuard)
  @Validate({
    params: WaIdParamsDto,
    responses: {
      200: SessionDetailDto,
      401: ProblemResponseDto,
      404: ProblemResponseDto,
    },
  })
  @Describe({
    operationId: "adminSession",
    summary: "One conversation: its live state, the user and the messages",
  })
  async detail(
    @ValidParams() params: { waId: string },
  ): Promise<SessionDetail> {
    const record = await this.sessions.get(params.waId);
    if (!record)
      throw new NotFoundException("No conversation with this number.");
    const [state, user, events] = await Promise.all([
      this.conversation.session(params.waId),
      this.users.findByWaId(params.waId),
      this.sessions.events(params.waId),
    ]);
    return {
      session: await this.summarise(record, state),
      state: state ? redactState(state) : null,
      user: user
        ? {
            id: user.id,
            name: user.name,
            bvn: maskBvn(user.bvn),
            dateOfBirth: user.dateOfBirth,
            walletBalanceKobo: user.walletBalanceKobo,
            createdAt: user.createdAt,
            holdings: await this.users.holdings(user.id),
          }
        : null,
      events,
    };
  }

  @Post("sessions/:waId/reset")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @Validate({
    params: WaIdParamsDto,
    responses: {
      200: ResetSessionResponseDto,
      401: ProblemResponseDto,
      404: ProblemResponseDto,
    },
  })
  @Describe({
    operationId: "adminResetSession",
    summary: "End a conversation: its next message starts from the welcome",
  })
  async reset(
    @ValidParams() params: { waId: string },
    @Req() req: AdminRequest,
  ): Promise<{ wasLive: boolean }> {
    if (!(await this.sessions.get(params.waId)))
      throw new NotFoundException("No conversation with this number.");
    const wasLive = await this.conversation.endSession(
      params.waId,
      `reset by admin ${req.admin!.username}`,
    );
    return { wasLive };
  }

  /** A record with its status; an active one's step read live from the session store. */
  private async summarise(
    record: SessionRecord,
    live?: Session,
  ): Promise<SessionSummary> {
    const now = Date.now();
    const status = record.endedAt
      ? "ended"
      : record.expiresAt && Date.parse(record.expiresAt) > now
        ? "active"
        : "expired";
    const state =
      status === "active"
        ? (live ?? (await this.conversation.session(record.waId)))
        : undefined;
    // A store entry gone before its recorded expiry (e.g. reset elsewhere) means the session is over.
    const effective = status === "active" && !state ? "expired" : status;
    return {
      waId: record.waId,
      source: record.source,
      status: effective,
      profileName: record.profileName,
      step: state?.step ?? record.step,
      onboarded: record.onboarded,
      phoneNumberId: record.phoneNumberId,
      startedAt: record.startedAt,
      lastActivityAt: record.lastActivityAt,
      expiresAt: record.expiresAt,
      messageCount: record.messageCount,
      endedAt: record.endedAt,
      endReason: record.endReason,
    };
  }
}
