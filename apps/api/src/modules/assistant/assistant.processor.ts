import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";

import { EnvService } from "../config/config.service";

import { ASSISTANT_QUEUE, ASSISTANT_QUEUE_EVENTS, ASSISTANT_QUEUE_NAME } from "./assistant.constants";
import { AssistantService } from "./assistant.service";
import { AssistantJobPayload } from "./assistant.types";

const logger = createLogger({ name: "assistant-worker" });

@Injectable()
export class AssistantProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AssistantJobPayload>;

  constructor(
    private readonly env: EnvService,
    private readonly assistantService: AssistantService,
    @Inject(ASSISTANT_QUEUE) private readonly queue: Queue<AssistantJobPayload>,
    @Inject(ASSISTANT_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onModuleInit() {
    this.worker = new Worker<AssistantJobPayload>(
      ASSISTANT_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          await this.assistantService.process(job.data);
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency: this.env.assistantConfig.queueConcurrency
      }
    );

    this.worker.on("failed", (job, error) => {
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () => logger.error({ jobId: job?.id, error }, "Assistant worker failed"));
      } else {
        logger.error({ jobId: job?.id, error }, "Assistant worker failed");
      }
    });

    this.events.on("failed", (event) => {
      logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, "Assistant queue event failed");
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.events.close();
  }
}

