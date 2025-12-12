import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker } from "bullmq";
import { ALERTS_QUEUE, ALERTS_QUEUE_EVENTS, ALERTS_QUEUE_NAME } from "./alerts.constants";
import { AlertsService, AlertJobPayload } from "./alerts.service";
import { EnvService } from "../config/config.service";
import { createLogger, ensureTraceId, runWithTraceId } from "@modular/utils";

const logger = createLogger({ name: "alerts-worker" });

@Injectable()
export class AlertsProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AlertJobPayload>;

  constructor(
    private readonly env: EnvService,
    private readonly alertsService: AlertsService,
    @Inject(ALERTS_QUEUE) private readonly queue: Queue<AlertJobPayload>,
    @Inject(ALERTS_QUEUE_EVENTS) private readonly events: QueueEvents
  ) {}

  async onModuleInit() {
    await this.alertsService.scheduleScanJob();
    await this.alertsService.ensureAllSchedules();
    this.worker = new Worker<AlertJobPayload>(
      ALERTS_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          if (job.name === "scan-active-rules") {
            await this.alertsService.enqueueActiveRuleChecks();
            return;
          }
          if (job.name.startsWith("evaluate-rule") && job.data.type === "evaluate" && job.data.ruleId) {
            await this.alertsService.evaluateRule(job.data.ruleId);
            return;
          }
          if (job.name.startsWith("deliver-notification") && job.data.type === "deliver" && job.data.deliveryId) {
            await this.alertsService.handleDeliveryJob(job);
            return;
          }
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency: this.env.alertingConfig.queueConcurrency,
        settings: {
          backoffStrategies: {
            alertNotifications: (attemptsMade) => this.alertsService.getNotificationBackoffDelay(attemptsMade)
          }
        }
      }
    );

    this.worker.on("failed", (job, error) => {
      const traceId = job?.data?.traceId;
      if (traceId) {
        runWithTraceId(traceId, () => logger.error({ jobId: job?.id, error }, "Alerts worker failed"));
      } else {
        logger.error({ jobId: job?.id, error }, "Alerts worker failed");
      }
    });

    this.events.on("failed", (event) => {
      logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, "Alerts queue event failed");
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.events.close();
  }
}
