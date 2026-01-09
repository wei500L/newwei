import { RawItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PipelineJobStatus, Prisma } from "@prisma/client";

import { ItemStatus } from "../../common/pipeline-status";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";
import { QueueService } from "./queue.service";

const logger = createLogger({ name: "news-source-scheduler" });
const ACTIVE_PIPELINE_JOB_STATUSES: PipelineJobStatus[] = [
  PipelineJobStatus.pending,
  PipelineJobStatus.queued,
  PipelineJobStatus.running,
  PipelineJobStatus.delayed,
];

type NewsSourceWithTemplate = Prisma.NewsSourceGetPayload<{
  include: { crawlTemplate: { select: { id: true; isActive: true; crawlOptions: true } } };
}>;

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

  private normalizeOptions(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private mergeOptions(
    base: Record<string, unknown> | undefined,
    override: Record<string, unknown> | undefined
  ) {
    if (!base && !override) {
      return undefined;
    }
    if (!base) {
      return override;
    }
    if (!override) {
      return base;
    }
    return { ...base, ...override };
  }

  private buildPayload(source: NewsSourceWithTemplate) {
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
        crawlTemplateId: source.crawlTemplateId ?? undefined,
        ...metadata,
      },
      crawlOptions: this.mergeOptions(
        source.crawlTemplate?.isActive
          ? this.normalizeOptions(source.crawlTemplate.crawlOptions)
          : undefined,
        this.normalizeOptions(config.crawlOptions)
      ),
      forceRefresh: Boolean(config.forceRefresh),
    };
  }

  private async scheduleDueSources(now: Date, batchSize: number) {
    const sources = await this.prisma.newsSource.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
          { OR: [{ circuitOpenUntil: null }, { circuitOpenUntil: { lte: now } }] },
        ],
      },
      include: {
        crawlTemplate: {
          select: { id: true, isActive: true, crawlOptions: true }
        }
      },
      orderBy: [{ nextRunAt: "asc" }, { updatedAt: "asc" }],
      take: batchSize,
    });

    for (const source of sources) {
      const activeCutoff = new Date(now.getTime() - this.env.newsSourceSchedulerConfig.inFlightLookbackMs);
      const activeJob = await this.prisma.pipelineJob.findFirst({
        where: {
          sourceId: source.id,
          status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
          createdAt: { gte: activeCutoff },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true },
      });

      if (activeJob) {
        const rescheduleAt = new Date(
          now.getTime() + this.env.newsSourceSchedulerConfig.inFlightRescheduleDelayMs,
        );
        try {
          await this.prisma.newsSource.updateMany({
            where: {
              id: source.id,
              OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
            },
            data: { nextRunAt: rescheduleAt },
          });
        } catch (error) {
          logger.warn(
            { error, sourceId: source.id, orgId: source.orgId },
            "Failed to reschedule news source with in-flight pipeline job",
          );
        }

        logger.info(
          {
            sourceId: source.id,
            orgId: source.orgId,
            activeJobId: activeJob.id,
            activeJobStatus: activeJob.status,
            activeJobCreatedAt: activeJob.createdAt,
            rescheduleAt,
          },
          "Skipped scheduling due to in-flight pipeline job",
        );
        continue;
      }

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

            await tx.pipelineJob.update({
              where: { id: pipelineJob.id },
              data: {
                metadata: {
                  ...(pipelineJob.metadata as Record<string, unknown> | null | undefined),
                  itemMetaId: itemMeta.id,
                  rawItemId: rawItem.id,
                },
              },
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
