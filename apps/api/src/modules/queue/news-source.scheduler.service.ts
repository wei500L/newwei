import { RawItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PipelineJobStatus, type NewsSource } from "@prisma/client";

import { ItemStatus } from "../../common/pipeline-status";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";
import { QueueService } from "./queue.service";

const logger = createLogger({ name: "news-source-scheduler" });

@Injectable()
export class NewsSourceSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleCron() {
    const config = this.env.newsSourceSchedulerConfig;
    if (!config.enabled) {
      return;
    }

    await this.cache.withLock(
      "cron:news-source-scheduler",
      config.lockTtlMs,
      async () => this.scheduleDueSources(new Date(), config.batchSize),
    );
  }

  private normalizeStringList(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  private buildPayload(source: NewsSource) {
    const config =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : {};
    const metadata =
      config.metadata && typeof config.metadata === "object" && !Array.isArray(config.metadata)
        ? (config.metadata as Record<string, unknown>)
        : {};
    return {
      url: source.url,
      language: source.language ?? undefined,
      sourceName: source.name ?? undefined,
      keywords: this.normalizeStringList(config.keywords),
      tags: this.normalizeStringList(config.tags),
      summaryHints: this.normalizeStringList(config.summaryHints),
      metadata: {
        sourceId: source.id,
        sourceType: source.siteType,
        ...metadata,
      },
      crawlOptions:
        config.crawlOptions && typeof config.crawlOptions === "object"
          ? config.crawlOptions
          : undefined,
      forceRefresh: Boolean(config.forceRefresh),
    };
  }

  private async scheduleDueSources(now: Date, batchSize: number) {
    const sources = await this.prisma.newsSource.findMany({
      where: {
        isActive: true,
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      },
      orderBy: [{ nextRunAt: "asc" }, { updatedAt: "asc" }],
      take: batchSize,
    });

    for (const source of sources) {
      const scheduledFor = source.nextRunAt ?? now;
      const nextRunAt = new Date(
        scheduledFor.getTime() + source.frequencySeconds * 1000,
      );
      try {
        const payload = this.buildPayload(source);
        const { pipelineJob, itemMetaId, rawItemId } =
          await this.prisma.$transaction(async (tx) => {
            const pipelineJob = await tx.pipelineJob.create({
              data: {
                orgId: source.orgId,
                sourceId: source.id,
                url: source.url,
                status: PipelineJobStatus.queued,
                queueName: ITEM_PIPELINE_QUEUE_NAME,
                scheduledFor,
                metadata: {
                  sourceName: source.name,
                  sourceType: source.siteType,
                },
              },
            });

            const itemMeta = await tx.itemMeta.create({
              data: {
                orgId: source.orgId,
                externalId: pipelineJob.id,
                name: source.name ?? source.url,
                status: ItemStatus.Pending,
                mongoRef: "",
              },
            });

            const rawItem = await RawItemModel.create({
              itemMetaId: itemMeta.id,
              payload,
              source: "news-source",
            });

            await tx.itemMeta.update({
              where: { id: itemMeta.id },
              data: { mongoRef: rawItem.id },
            });

            await tx.newsSource.update({
              where: { id: source.id },
              data: {
                lastRunAt: scheduledFor,
                nextRunAt,
              },
            });

            return {
              pipelineJob,
              itemMetaId: itemMeta.id,
              rawItemId: rawItem.id,
            };
          });
        try {
          await this.queueService.enqueueItem(
            source.orgId,
            itemMetaId,
            rawItemId,
            {},
            { pipelineJobId: pipelineJob.id, sourceId: source.id },
          );
        } catch (queueError) {
          logger.error(
            { error: queueError, pipelineJobId: pipelineJob.id, orgId: source.orgId },
            "Failed to enqueue news source pipeline job",
          );
          await Promise.allSettled([
            this.prisma.pipelineJob.updateMany({
              where: { id: pipelineJob.id },
              data: {
                status: PipelineJobStatus.failed,
                error: queueError instanceof Error ? queueError.message : String(queueError),
                completedAt: new Date(),
              },
            }),
            this.prisma.itemMeta.updateMany({
              where: { id: itemMetaId },
              data: { status: ItemStatus.Failed },
            }),
          ]);
        }
      } catch (error) {
        logger.error(
          { error, sourceId: source.id, orgId: source.orgId },
          "Failed to schedule news source pipeline job",
        );
      }
    }
  }
}
