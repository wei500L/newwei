import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";
import { createLogger } from "@modular/utils";
import { ProcessedItemModel, RawItemModel, TaskLogModel } from "@modular/mongo";
import { EnvService } from "../config/config.service";
import { PIPELINE_QUEUE } from "./queue.module";
import type { Queue } from "bullmq";

const logger = createLogger({ name: "queue" });

@Injectable()
export class QueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue,
    private readonly env: EnvService
  ) {}

  async onModuleInit() {
    const config = this.env.bullmqConfig;
    this.worker = new Worker(
      "itemPipeline",
      async (job) => {
        const { rawItemId, itemMetaId } = job.data as {
          rawItemId: string;
          itemMetaId: string;
        };
        logger.info({ jobId: job.id }, "Processing item pipeline job");

        const rawItem = await RawItemModel.findById(rawItemId);
        if (!rawItem) {
          await TaskLogModel.create({
            queue: "itemPipeline",
            jobId: job.id,
            stage: "dedupe",
            status: "failed",
            message: "Raw item not found",
            data: job.data
          });
          throw new Error("Raw item not found");
        }

        await TaskLogModel.create({
          queue: "itemPipeline",
          jobId: job.id,
          stage: "dedupe",
          status: "completed",
          message: "Item deduplicated",
          data: { itemMetaId }
        });

        const transformedPayload = {
          ...rawItem.payload,
          processedAt: new Date().toISOString()
        };
        await TaskLogModel.create({
          queue: "itemPipeline",
          jobId: job.id,
          stage: "transform",
          status: "completed",
          data: transformedPayload
        });

        const tags = Array.from(
          new Set(["sample", transformedPayload?.category, transformedPayload?.status].filter(Boolean))
        );
        await TaskLogModel.create({
          queue: "itemPipeline",
          jobId: job.id,
          stage: "tag",
          status: "completed",
          data: { tags }
        });

        const score = Math.round(Math.random() * 100);
        const processed = await ProcessedItemModel.create({
          rawItemId,
          itemMetaId,
          status: "completed",
          tags,
          result: {
            ...transformedPayload,
            score
          }
        });

        await TaskLogModel.create({
          queue: "itemPipeline",
          jobId: job.id,
          stage: "score",
          status: "completed",
          data: { score }
        });

        return processed.toJSON();
      },
      {
        connection: {
          host: config.connection.host,
          port: config.connection.port,
          username: config.connection.username,
          db: config.connection.db
        },
        concurrency: 3
      }
    );

    this.worker.on("failed", async (job, err) => {
      logger.error({ jobId: job?.id, err }, "Queue job failed");
      if (job) {
        await TaskLogModel.create({
          queue: "itemPipeline",
          jobId: job.id,
          stage: "worker",
          status: "failed",
          error: {
            message: err.message
          }
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
