import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BunJobs,
  type BunQueue,
  type BunQueueWorker,
  MemoryDriver,
  UnrecoverableJobError,
} from "@kingsleyweb/bun-jobs";
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { ConversationService } from "../conversation/conversation.service";
import { SessionsRepository } from "../database/sessions.repository";
import { KeyedMutex } from "../conversation/keyed-mutex";
import {
  PermanentSendError,
  WhatsAppClient,
} from "../whatsapp/whatsapp.client";
import type { InboundMessage } from "../whatsapp/whatsapp.interface";
import type { OutboundJob } from "./queue.interface";

export const JOBS_NAMESPACE = "investnow";
export const INBOUND_QUEUE = "whatsapp-inbound";
export const OUTBOUND_QUEUE = "whatsapp-outbound";

const DAY_MS = 86_400_000;

/** The bun-jobs context: `<dataDir>/jobs.db`, or memory for `DATA_DIR=:memory:` (tests). */
export function createJobs(config: AppConfig): BunJobs {
  let driver: ConstructorParameters<typeof BunJobs>[0]["driver"];
  if (config.dataDir === ":memory:") {
    driver = new MemoryDriver();
  } else {
    mkdirSync(config.dataDir, { recursive: true });
    driver = {
      type: "sql",
      url: `sqlite://${join(config.dataDir, "jobs.db")}`,
    };
  }
  // publishEvents feeds the management API's live view at /admin/jobs.
  return new BunJobs({
    namespace: JOBS_NAMESPACE,
    driver,
    service: "ucap-whatsapp-api",
    publishEvents: true,
  });
}

/**
 * The two queues of the WhatsApp pipeline, on the app's `BunJobs` context:
 *
 * - **inbound**: one job per user message, its id the WhatsApp message id, so
 *   Meta's redeliveries of a webhook are dropped as duplicates. The worker runs
 *   the state machine and queues the replies. One attempt only: a retry after
 *   the session moved on would answer the wrong step.
 * - **outbound**: one job per set of replies, sent in order and retried with
 *   backoff. Its progress counts the messages already sent, so a retry never
 *   sends one twice.
 */
@Injectable()
export class QueueService
  implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(QueueService.name);
  private inbound!: BunQueue<InboundMessage, void>;
  private outbound!: BunQueue<OutboundJob, number>;
  private readonly workers: BunQueueWorker<never, unknown>[] = [];
  /** Keeps one recipient's replies in order across concurrent outbound jobs. */
  private readonly sendLock = new KeyedMutex();

  constructor(
    private readonly jobs: BunJobs,
    private readonly conversation: ConversationService,
    private readonly whatsapp: WhatsAppClient,
    private readonly log: SessionsRepository,
  ) {}

  onModuleInit(): void {
    const jobs = this.jobs;
    this.inbound = jobs.queue<InboundMessage, void>(INBOUND_QUEUE, {
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { ttl: DAY_MS },
        removeOnFail: { ttl: 7 * DAY_MS },
      },
    });
    this.outbound = jobs.queue<OutboundJob, number>(OUTBOUND_QUEUE, {
      defaultJobOptions: {
        attempts: 6,
        backoff: {
          type: "exponential",
          delay: 2_000,
          max: 60_000,
          jitter: 0.2,
        },
        timeout: 60_000,
        removeOnComplete: { ttl: DAY_MS },
        removeOnFail: { ttl: 7 * DAY_MS },
      },
    });

    const inboundWorker = jobs.worker<InboundMessage, void>(
      INBOUND_QUEUE,
      async (job) => {
        const { waId, name, input, messageId, phoneNumberId } = job.data;
        const source = job.data.source ?? "whatsapp";
        const replies = await this.conversation.handle(
          { waId, ...(name ? { name } : {}) },
          input,
          { source, phoneNumberId, messageId },
        );
        if (replies.length > 0) {
          await this.outbound.add(
            "reply",
            { to: waId, inReplyTo: messageId, messages: replies, source },
            { jobId: `reply:${messageId}` },
          );
        }
      },
      // Messages from one user are serialised by the conversation's own lock, so
      // several users can be handled at once.
      { concurrency: 8, name: "inbound" },
    );

    const outboundWorker = jobs.worker<OutboundJob, number>(
      OUTBOUND_QUEUE,
      (job, ctx) =>
        this.sendLock.run(job.data.to, async () => {
          let sent = typeof job.progress === "number" ? job.progress : 0;
          // The simulator's replies are delivered to the simulator (marked
          // delivered, read back by its page), never sent to WhatsApp.
          const toWhatsApp = (job.data.source ?? "whatsapp") === "whatsapp";
          for (; sent < job.data.messages.length; sent++) {
            try {
              if (toWhatsApp) {
                await this.whatsapp.send(
                  job.data.to,
                  job.data.messages[sent]!,
                  ctx.signal,
                );
              }
              await this.log.markDelivered(job.data.inReplyTo, sent);
            } catch (error) {
              if (error instanceof PermanentSendError) {
                throw new UnrecoverableJobError(
                  error.message,
                  { status: error.status, to: job.data.to },
                  { cause: error },
                );
              }
              throw error;
            }
            await job.updateProgress(sent + 1);
          }
          return sent;
        }),
      { concurrency: 8, name: "outbound" },
    );

    inboundWorker.on("failed", (job, error) => {
      this.logger.error(
        `Inbound ${job.id} from ${job.data.waId} failed: ${error.message}`,
        error.stack,
      );
    });
    outboundWorker.on("failed", (job, error) => {
      this.logger.warn(
        `Reply ${job.id} to ${job.data.to} failed (attempt ${job.attemptsMade}): ${error.message}`,
      );
    });

    this.workers.push(inboundWorker as never, outboundWorker as never);
    for (const worker of this.workers) void worker.run();
  }

  /** Queues inbound messages; ones already queued (a webhook redelivery) are dropped. Answers how many were new. */
  async enqueueInbound(messages: InboundMessage[]): Promise<number> {
    let added = 0;
    for (const message of messages) {
      const job = await this.inbound.add("message", message, {
        jobId: message.messageId,
      });
      if (job.wasAdded) added++;
    }
    return added;
  }

  /**
   * Stops the workers first, letting jobs in flight finish while the database
   * and session store are still open. The queues stay open until the HTTP
   * server has drained, so a webhook still being answered can enqueue; its job
   * waits in jobs.db for the next start.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close({ timeout: 10_000 })));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.jobs.close({ timeout: 10_000 });
    const driver = this.jobs.driver;
    // A driver instance passed in (memory, in tests) is left open by the context.
    if (driver instanceof MemoryDriver) await driver.close();
  }
}

/** Provides the app's `BunJobs` context, injected by class (QueueService and the jobs management API). */
export const JOBS_PROVIDER = {
  provide: BunJobs,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => createJobs(config),
};
