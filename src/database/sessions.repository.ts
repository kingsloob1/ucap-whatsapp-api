import { Inject, Injectable } from "@nestjs/common";
import type { SQL } from "bun";
import { APP_DB } from "./database";
import type { OutboundMessage } from "../whatsapp/whatsapp.interface";
import type {
  ConversationEntry,
  Exchange,
  ListSessionsQuery,
  SessionEvent,
  SessionRecord,
  SessionRow,
} from "./sessions.interface";

/** Steps whose typed input is a secret (a PIN) or PII (a BVN), and how to log it. */
const REDACT: Record<string, (text: string) => string> = {
  set_pin: () => "••••",
  confirm_pin: () => "••••",
  authorize: () => "••••",
  ask_bvn: (text) => {
    const digits = text.replace(/\D/g, "");
    return digits.length > 4
      ? `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`
      : "•".repeat(digits.length);
  },
};

function toRecord(row: SessionRow): SessionRecord {
  return {
    waId: row.wa_id,
    source: row.source,
    profileName: row.profile_name,
    phoneNumberId: row.phone_number_id,
    step: row.step,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    messageCount: Number(row.message_count),
    endedAt: row.ended_at,
    endReason: row.end_reason,
    onboarded: Boolean(Number(row.onboarded)),
  };
}

/** The admin's record of conversations: one row per WhatsApp id, and the messages exchanged. */
@Injectable()
export class SessionsRepository {
  constructor(@Inject(APP_DB) private readonly sql: SQL) {}

  async record(x: Exchange): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = x.stepAfter
      ? new Date(now.getTime() + x.ttlMs).toISOString()
      : null;
    const ended = x.stepAfter === null;
    const name = x.profileName ?? null;
    const phoneNumberId = x.phoneNumberId ?? null;
    const redact = x.stepBefore ? REDACT[x.stepBefore] : undefined;
    const inText = x.input.choiceId
      ? x.input.text
      : redact
        ? redact(x.input.text)
        : x.input.text;

    await this.sql.begin(async (tx) => {
      if (x.stepBefore === null) {
        // A new session (the first message, or the first after one ended or expired).
        await tx`
          INSERT INTO conversation_sessions
            (wa_id, source, profile_name, phone_number_id, step, started_at, last_activity_at, expires_at, message_count, ended_at, end_reason)
          VALUES (${x.waId}, ${x.source}, ${name}, ${phoneNumberId}, ${x.stepAfter}, ${nowIso}, ${nowIso}, ${expiresAt}, 1,
                  ${ended ? nowIso : null}, ${ended ? "closed" : null})
          ON CONFLICT (wa_id) DO UPDATE SET
            source = excluded.source, profile_name = coalesce(excluded.profile_name, profile_name),
            phone_number_id = coalesce(excluded.phone_number_id, phone_number_id), step = excluded.step,
            started_at = excluded.started_at, last_activity_at = excluded.last_activity_at,
            expires_at = excluded.expires_at, message_count = 1,
            ended_at = excluded.ended_at, end_reason = excluded.end_reason`;
      } else {
        await tx`
          UPDATE conversation_sessions SET
            source = ${x.source}, profile_name = coalesce(${name}, profile_name),
            phone_number_id = coalesce(${phoneNumberId}, phone_number_id), step = ${x.stepAfter},
            last_activity_at = ${nowIso}, expires_at = ${expiresAt}, message_count = message_count + 1,
            ended_at = ${ended ? nowIso : null}, end_reason = ${ended ? "closed" : null}
          WHERE wa_id = ${x.waId}`;
      }
      const messageId = x.messageId ?? null;
      const inPayload = JSON.stringify({
        text: inText,
        choiceId: x.input.choiceId ?? null,
      });
      await tx`
        INSERT INTO conversation_events
          (wa_id, source, direction, step_before, step_after, text, choice_id, kind, message_id, payload, at)
        VALUES (${x.waId}, ${x.source}, 'in', ${x.stepBefore}, ${x.stepAfter}, ${inText}, ${x.input.choiceId ?? null},
                'text', ${messageId}, ${inPayload}, ${nowIso})`;
      // Replies are delivered by the outbound job (markDelivered); without a
      // message id (the direct /dev/simulate path) they are answered at once.
      const deliveredAt = messageId ? null : nowIso;
      for (const [index, reply] of x.replies.entries()) {
        await tx`
          INSERT INTO conversation_events
            (wa_id, source, direction, step_before, step_after, text, kind, message_id, reply_index, payload, delivered_at, at)
          VALUES (${x.waId}, ${x.source}, 'out', ${x.stepBefore}, ${x.stepAfter}, ${reply.body}, ${reply.kind},
                  ${messageId}, ${index}, ${JSON.stringify(reply)}, ${deliveredAt}, ${nowIso})`;
      }
    });
  }

  /** Marks a reply delivered: sent to WhatsApp, or handed to the simulator. */
  async markDelivered(messageId: string, replyIndex: number): Promise<void> {
    const now = new Date().toISOString();
    await this.sql`
      UPDATE conversation_events SET delivered_at = ${now}
      WHERE message_id = ${messageId} AND direction = 'out' AND reply_index = ${replyIndex} AND delivered_at IS NULL`;
  }

  /**
   * A conversation as the simulator shows it, oldest first: the user's messages
   * (as stored, so PINs and BVNs redacted) and the replies already delivered.
   * `afterId` answers only newer entries.
   */
  async conversation(
    waId: string,
    afterId = 0,
    limit = 500,
  ): Promise<ConversationEntry[]> {
    const rows: {
      id: number;
      direction: "in" | "out";
      at: string;
      message_id: string | null;
      reply_index: number | null;
      payload: string | null;
      text: string | null;
      choice_id: string | null;
      kind: string | null;
      delivered_at: string | null;
    }[] = await this.sql`
      SELECT id, direction, at, message_id, reply_index, payload, text, choice_id, kind, delivered_at
      FROM conversation_events
      WHERE wa_id = ${waId} AND id > ${afterId} AND (direction = 'in' OR delivered_at IS NOT NULL)
      ORDER BY id LIMIT ${limit}`;
    return rows.map((r): ConversationEntry => {
      if (r.direction === "in") {
        return {
          id: Number(r.id),
          direction: "in",
          at: r.at,
          messageId: r.message_id,
          text: r.text ?? "",
          choiceId: r.choice_id,
        };
      }
      // Rows written before payloads existed hold the body only: shown as text.
      const message: OutboundMessage = r.payload
        ? (JSON.parse(r.payload) as OutboundMessage)
        : { kind: "text", body: r.text ?? "" };
      return {
        id: Number(r.id),
        direction: "out",
        at: r.at,
        messageId: r.message_id,
        replyIndex: Number(r.reply_index ?? 0),
        deliveredAt: r.delivered_at!,
        message,
      };
    });
  }

  /** Forgets a number's conversation: its messages and its session record. */
  async deleteConversation(waId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM conversation_events WHERE wa_id = ${waId}`;
      await tx`DELETE FROM conversation_sessions WHERE wa_id = ${waId}`;
    });
  }

  /** Marks a session ended by an admin (or a reset from the simulator). */
  async markEnded(waId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.sql`
      UPDATE conversation_sessions SET step = NULL, expires_at = NULL, ended_at = ${now}, end_reason = ${reason}
      WHERE wa_id = ${waId} AND ended_at IS NULL`;
  }

  async get(waId: string): Promise<SessionRecord | null> {
    const rows: SessionRow[] = await this.sql`
      SELECT *, EXISTS (SELECT 1 FROM users u WHERE u.wa_id = conversation_sessions.wa_id) AS onboarded FROM conversation_sessions WHERE wa_id = ${waId}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(
    q: ListSessionsQuery,
  ): Promise<{ total: number; sessions: SessionRecord[] }> {
    const now = new Date().toISOString();
    const source = q.source ?? null;
    const status = q.status ?? null;
    const search = q.search?.trim()
      ? `%${q.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`
      : null;
    const where = this.sql`
      (${source} IS NULL OR source = ${source})
      AND (${search} IS NULL OR wa_id LIKE ${search} ESCAPE '\\' OR profile_name LIKE ${search} ESCAPE '\\')
      AND (${status} IS NULL
        OR (${status} = 'active'  AND ended_at IS NULL AND expires_at > ${now})
        OR (${status} = 'expired' AND ended_at IS NULL AND (expires_at IS NULL OR expires_at <= ${now}))
        OR (${status} = 'ended'   AND ended_at IS NOT NULL))`;
    const [count]: { n: number }[] = await this
      .sql`SELECT count(*) AS n FROM conversation_sessions WHERE ${where}`;
    const rows: SessionRow[] = await this.sql`
      SELECT *, EXISTS (SELECT 1 FROM users u WHERE u.wa_id = conversation_sessions.wa_id) AS onboarded FROM conversation_sessions WHERE ${where}
      ORDER BY last_activity_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`;
    return { total: Number(count?.n ?? 0), sessions: rows.map(toRecord) };
  }

  async events(waId: string, limit = 200): Promise<SessionEvent[]> {
    const rows: {
      id: number;
      direction: "in" | "out";
      step_before: string | null;
      step_after: string | null;
      text: string | null;
      choice_id: string | null;
      kind: string | null;
      at: string;
    }[] = await this.sql`
      SELECT * FROM (SELECT * FROM conversation_events WHERE wa_id = ${waId} ORDER BY id DESC LIMIT ${limit}) ORDER BY id`;
    return rows.map((r) => ({
      id: Number(r.id),
      direction: r.direction,
      stepBefore: r.step_before,
      stepAfter: r.step_after,
      text: r.text,
      choiceId: r.choice_id,
      kind: r.kind,
      at: r.at,
    }));
  }

  /** Session counts for the dashboard. */
  async stats(): Promise<{
    active: number;
    whatsapp: number;
    simulator: number;
    total: number;
  }> {
    const now = new Date().toISOString();
    const [row]: {
      active: number;
      whatsapp: number;
      simulator: number;
      total: number;
    }[] = await this.sql`
      SELECT
        sum(CASE WHEN ended_at IS NULL AND expires_at > ${now} THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN source = 'whatsapp' THEN 1 ELSE 0 END) AS whatsapp,
        sum(CASE WHEN source = 'simulator' THEN 1 ELSE 0 END) AS simulator,
        count(*) AS total
      FROM conversation_sessions`;
    return {
      active: Number(row?.active ?? 0),
      whatsapp: Number(row?.whatsapp ?? 0),
      simulator: Number(row?.simulator ?? 0),
      total: Number(row?.total ?? 0),
    };
  }
}
