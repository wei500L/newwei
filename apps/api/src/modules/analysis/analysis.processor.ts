import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";
import { randomUUID } from "node:crypto";

import { EnvService } from "../config/config.service";

import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS, ANALYSIS_QUEUE_NAME } from "./analysis.constants";
import { AnalysisService } from "./analysis.service";
import type { AnalysisJobPayload } from "./analysis.types";

const logger = createLogger({ name: "analysis-worker" });

// BullMQ's Job type does not expose the per-attempt lock token, but the
// runtime instance carries it. Read it with a narrow type guard instead of a
// double assertion so a future BullMQ change cannot silently collapse to the
// local fallback.
function jobLockToken(job: unknown): string | undefined {
  if (!job || typeof job !== "object" || !("token" in job)) {
    return undefined;
  }
  const token = (job as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

@Injectable()
export class AnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AnalysisJobPayload>;
  private readonly handleQueueFailed = (event: { jobId: string; failedReason?: string }) => {
    logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, "Analysis queue event failed");
  };

  constructor(
    private readonly env: EnvService,
    private readonly analysisService: AnalysisService,
    @Inject(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJobPayload>,
    @Inject(ANALYSIS_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onModuleInit() {
    if (!this.env.bullmqWorkersEnabled) {
      logger.warn("BullMQ workers disabled on this process");
      return;
    }
    // The queue owner is a separate switch from the three request Mutations.
    // When Go owns the consumer this processor creates no Worker, but the
    // AnalysisService implementation stays available for a rollback. The Go
    // worker publishes the shared Redis subscription event, so a local bus
    // cannot be the owner configuration on either side.
    if (this.env.apiGoAnalysisWorkerMode === "go") {
      if (this.env.graphqlSubscriptionBus !== "redis") {
        throw new Error(
          "API_GO_ANALYSIS_WORKER_MODE=go requires GRAPHQL_SUBSCRIPTION_BUS=redis",
        );
      }
      logger.info(
        "Analysis worker owner is go; this process does not start the analysis consumer",
      );
      return;
    }
    this.worker = new Worker<AnalysisJobPayload>(
      ANALYSIS_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        // BullMQ attaches the per-attempt lock token to the fetched Job. The
        // service persists it as the Mongo fencing token so a stale attempt
        // cannot overwrite a newer lease. A locally generated token keeps the
        // behavior safe if a test invokes the processor without one.
        const token = jobLockToken(job) ?? randomUUID();
        return runWithTraceId(traceId, async () => {
          await this.analysisService.process(job.data, token);
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency: this.env.analysisConfig.queueConcurrency
      }
    );

    this.worker.on("failed", (job, error) => {
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () => logger.error({ jobId: job?.id, error }, "Analysis worker failed"));
      } else {
        logger.error({ jobId: job?.id, error }, "Analysis worker failed");
      }
      // Only announce a failure once the run has exhausted all retries;
      // transient failures are retried by BullMQ and should not spam the
      // user with notifications.
      const attemptsMade = job?.attemptsMade ?? 0;
      const attempts = job?.opts?.attempts ?? 1;
      // BullMQ also finalizes a job whose stalled recovery exceeded the
      // allowable limit even when retry attempts remain. That job is final, so
      // the user must still receive exactly one failure notification.
      const deferredStalledFailure =
        job?.failedReason === "job stalled more than allowable limit";
      if (job?.data?.analysisId && deferredStalledFailure) {
        // A stalled-terminal job never reaches process(), so this attempt must
        // take the still-running row over under its fresh BullMQ lock before
        // sending the single final notification.
        void this.analysisService
          .finalizeStalledFailure(
            job.data,
            jobLockToken(job),
            job.failedReason ?? error.message,
          )
          .catch((finalizeError: unknown) => {
            logger.error(
              { jobId: job?.id, error: finalizeError },
              "Failed to finalize a stalled analysis run",
            );
          });
      } else if (job?.data?.analysisId && attemptsMade >= attempts) {
        // The ordinary final failure path already wrote and published failed
        // in process(); only the user notification remains.
        void this.analysisService.notifyFinalFailure(job.data.analysisId);
      }
    });

    this.events.on("failed", this.handleQueueFailed);
  }

  async onModuleDestroy() {
    this.events.off("failed", this.handleQueueFailed);
    await this.worker?.close();
  }
}
