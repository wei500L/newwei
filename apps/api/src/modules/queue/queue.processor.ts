import { RawItemModel, TaskLogModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Worker } from "bullmq";
import type { Queue } from "bullmq";

import { EnvService } from "../config/config.service";
import { NewsPipelineService } from "../news-pipeline/news-pipeline.service";
import type {
  PipelineJobContext,
  RawPipelineItem,
} from "../news-pipeline/news-pipeline.types";

import { ITEM_PIPELINE_QUEUE_NAME, PIPELINE_QUEUE } from "./queue.module";

const logger = createLogger({ name: "queue" });

@Injectable()
export class QueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    private readonly env: EnvService,
    private readonly pipeline: NewsPipelineService,
  ) {}

  async onModuleInit() {
    const config = this.env.bullmqConfig;
    this.worker = new Worker(
      ITEM_PIPELINE_QUEUE_NAME,
      async (job) => {
        const { rawItemId, itemMetaId, orgId: jobOrgId } = job.data as {
          rawItemId: string;
          itemMetaId: string;
          orgId?: string;
        };
        const orgId = jobOrgId ?? "unknown";
        logger.info({ jobId: job.id }, "Processing item pipeline job");

        const rawItem = await RawItemModel.findById(rawItemId);
        if (!rawItem) {
          await TaskLogModel.create({
            queue: ITEM_PIPELINE_QUEUE_NAME,
            jobId: job.id,
            orgId,
            stage: "dedupe",
            status: "failed",
            message: "Raw item not found",
            data: job.data,
          });
          throw new Error("Raw item not found");
        }

        await TaskLogModel.create({
          queue: ITEM_PIPELINE_QUEUE_NAME,
          jobId: job.id,
          orgId,
          stage: "dedupe",
          status: "completed",
          message: "Item deduplicated",
          data: { itemMetaId },
        });

        const pipelineJob: PipelineJobContext = {
          queue: ITEM_PIPELINE_QUEUE_NAME,
          jobId: job.id ? String(job.id) : "",
          itemMetaId,
          rawItemId,
          orgId,
        };
        const rawPayload: RawPipelineItem = {
          id: rawItem._id.toString(),
          itemMetaId,
          payload: rawItem.payload,
          source: rawItem.source ?? undefined,
        };

        const processed = await this.pipeline.process(pipelineJob, rawPayload);

        await TaskLogModel.create({
          queue: ITEM_PIPELINE_QUEUE_NAME,
          jobId: job.id,
          orgId,
          stage: "complete",
          status: "completed",
          data: { processedId: processed.id ?? rawItemId },
        });

        return processed;
      },
      {
        connection: {
          host: config.connection.host,
          port: config.connection.port,
          username: config.connection.username,
          db: config.connection.db,
        },
        concurrency: 3,
      },
    );

    this.worker.on("failed", async (job, err) => {
      logger.error({ jobId: job?.id, err }, "Queue job failed");
      if (job) {
        const jobOrgId = (job.data as { orgId?: string } | undefined)?.orgId ?? "unknown";
        await TaskLogModel.create({
          queue: ITEM_PIPELINE_QUEUE_NAME,
          jobId: job.id,
          orgId: jobOrgId,
          stage: "worker",
          status: "failed",
          error: {
            message: err.message,
          },
        });
      }
    });
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
  }
}
