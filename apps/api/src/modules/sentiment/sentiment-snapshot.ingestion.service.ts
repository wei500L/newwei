import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { PipelineStage } from "mongoose";

import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";

const logger = createLogger({ name: "sentiment-snapshot" });

const DAY_MS = 24 * 60 * 60 * 1000;
const REBUILD_DAYS = 2;
const MIN_ENTITY_CONFIDENCE = 0.5;
const MAX_ROWS_PER_BUCKET = 5_000;
const SENTIMENT_SNAPSHOT_TICK_GATE_TTL_MS = 55 * 60_000;
const SENTIMENT_SNAPSHOT_ORG_LOCK_TTL_MS = 5 * 60_000;

type SentimentSnapshotSchedulerOrgRunStatus = "completed" | "skipped";

interface SentimentAggregateRow {
  name: string;
  type: string;
  totalDocs: number;
  negativeDocs: number;
  positiveDocs: number;
  neutralDocs: number;
  scoreSum: number;
}

interface TopicAggregateRow {
  topic: string;
  totalDocs: number;
  negativeDocs: number;
  positiveDocs: number;
  neutralDocs: number;
  scoreSum: number;
}

@Injectable()
export class SentimentSnapshotIngestionService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async rebuildRecentSnapshots() {
    const claimed = await claimSchedulerTick(
      this.cache,
      "cron:sentiment-snapshot:tick-gate",
      SENTIMENT_SNAPSHOT_TICK_GATE_TTL_MS,
    );
    if (!claimed) {
      logger.info(
        "Skipped sentiment snapshot scheduler tick because another instance already claimed this interval",
      );
      return;
    }

    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    if (orgs.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.sentimentSnapshotOrgConcurrency;
    logger.info(
      { orgCount: orgs.length, concurrency },
      "Sentiment snapshot scheduler tick started",
    );

    const results = await settleWithConcurrency(
      orgs,
      concurrency,
      async (org) => await this.rebuildOrgWithLock(org.id),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        logger.warn(
          { err: result.reason, orgId: result.item.id },
          "Sentiment snapshot rebuild failed",
        );
        continue;
      }

      if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "Sentiment snapshot scheduler tick completed",
    );
  }

  private async rebuildOrgWithLock(
    orgId: string,
  ): Promise<SentimentSnapshotSchedulerOrgRunStatus> {
    const locked = await this.cache.withLock(
      `cron:sentiment-snapshot:org:${orgId}`,
      SENTIMENT_SNAPSHOT_ORG_LOCK_TTL_MS,
      async () => {
        await this.rebuildOrg(orgId);
        return "completed" as const;
      },
    );

    if (locked !== null) {
      return locked;
    }

    logger.info(
      { orgId },
      "Skipped sentiment snapshot rebuild because previous org run is still in progress",
    );
    return "skipped";
  }

  private async rebuildOrg(orgId: string) {
    const now = Date.now();
    const todayStart = this.toUtcDayStart(new Date(now));

    for (let offset = 0; offset < REBUILD_DAYS; offset += 1) {
      const bucketStart = new Date(todayStart.getTime() - offset * DAY_MS);
      const bucketEnd = new Date(bucketStart.getTime() + DAY_MS);

      const [entityRows, topicRows] = await Promise.all([
        this.aggregateEntitySentiment(orgId, bucketStart, bucketEnd),
        this.aggregateTopicSentiment(orgId, bucketStart, bucketEnd),
      ]);

      await this.prisma.runInTransaction(async (tx) => {
        await Promise.all([
          tx.entitySentimentSnapshot.deleteMany({
            where: { orgId, bucketStart },
          }),
          tx.topicSentimentSnapshot.deleteMany({
            where: { orgId, bucketStart },
          }),
        ]);

        if (entityRows.length > 0) {
          await tx.entitySentimentSnapshot.createMany({
            data: entityRows.map((row) => ({
              orgId,
              entityName: row.name,
              entityType: row.type,
              bucketStart,
              totalDocs: row.totalDocs,
              negativeDocs: row.negativeDocs,
              positiveDocs: row.positiveDocs,
              neutralDocs: row.neutralDocs,
              scoreSum: row.scoreSum,
              avgScore: row.totalDocs > 0 ? row.scoreSum / row.totalDocs : 0,
              negativeRatio:
                row.totalDocs > 0 ? row.negativeDocs / row.totalDocs : 0,
            })),
          });
        }

        if (topicRows.length > 0) {
          await tx.topicSentimentSnapshot.createMany({
            data: topicRows.map((row) => ({
              orgId,
              topic: row.topic,
              bucketStart,
              totalDocs: row.totalDocs,
              negativeDocs: row.negativeDocs,
              positiveDocs: row.positiveDocs,
              neutralDocs: row.neutralDocs,
              scoreSum: row.scoreSum,
              avgScore: row.totalDocs > 0 ? row.scoreSum / row.totalDocs : 0,
              negativeRatio:
                row.totalDocs > 0 ? row.negativeDocs / row.totalDocs : 0,
            })),
          });
        }
      });
    }

    logger.info(
      { orgId, days: REBUILD_DAYS },
      "Sentiment snapshot rebuild completed",
    );
  }

  private async aggregateEntitySentiment(
    orgId: string,
    start: Date,
    end: Date,
  ): Promise<SentimentAggregateRow[]> {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: "completed",
          createdAt: { $gte: start, $lt: end },
          "result.sentiment_label": { $exists: true, $ne: null },
          "result.entities": { $exists: true, $ne: [] },
        },
      },
      { $unwind: "$result.entities" },
      {
        $match: {
          "result.entities.name": { $type: "string", $ne: "" },
          "result.entities.confidence": { $gte: MIN_ENTITY_CONFIDENCE },
        },
      },
      {
        $project: {
          name: "$result.entities.name",
          type: { $toLower: { $ifNull: ["$result.entities.type", ""] } },
          sentiment: { $toLower: "$result.sentiment_label" },
        },
      },
      {
        $project: {
          name: 1,
          type: 1,
          score: {
            $switch: {
              branches: [
                { case: { $eq: ["$sentiment", "positive"] }, then: 1 },
                { case: { $eq: ["$sentiment", "neutral"] }, then: 0 },
                { case: { $eq: ["$sentiment", "negative"] }, then: -1 },
              ],
              default: 0,
            },
          },
          neg: { $cond: [{ $eq: ["$sentiment", "negative"] }, 1, 0] },
          pos: { $cond: [{ $eq: ["$sentiment", "positive"] }, 1, 0] },
          neu: { $cond: [{ $eq: ["$sentiment", "neutral"] }, 1, 0] },
        },
      },
      {
        $group: {
          _id: { name: "$name", type: "$type" },
          totalDocs: { $sum: 1 },
          negativeDocs: { $sum: "$neg" },
          positiveDocs: { $sum: "$pos" },
          neutralDocs: { $sum: "$neu" },
          scoreSum: { $sum: "$score" },
        },
      },
      {
        $project: {
          _id: 0,
          name: { $substrCP: ["$_id.name", 0, 191] },
          type: { $substrCP: ["$_id.type", 0, 191] },
          totalDocs: 1,
          negativeDocs: 1,
          positiveDocs: 1,
          neutralDocs: 1,
          scoreSum: 1,
        },
      },
      { $sort: { totalDocs: -1, negativeDocs: -1 } },
      { $limit: MAX_ROWS_PER_BUCKET },
    ];

    const rows =
      await ProcessedItemModel.aggregate<SentimentAggregateRow>(
        pipeline,
      ).allowDiskUse(true);
    return rows.filter(
      (row) => typeof row.name === "string" && row.name.length > 0,
    );
  }

  private async aggregateTopicSentiment(
    orgId: string,
    start: Date,
    end: Date,
  ): Promise<TopicAggregateRow[]> {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: "completed",
          createdAt: { $gte: start, $lt: end },
          "result.sentiment_label": { $exists: true, $ne: null },
          "result.topics": { $exists: true, $ne: [] },
        },
      },
      { $unwind: "$result.topics" },
      { $match: { "result.topics": { $type: "string", $ne: "" } } },
      {
        $project: {
          topic: "$result.topics",
          sentiment: { $toLower: "$result.sentiment_label" },
        },
      },
      {
        $project: {
          topic: 1,
          score: {
            $switch: {
              branches: [
                { case: { $eq: ["$sentiment", "positive"] }, then: 1 },
                { case: { $eq: ["$sentiment", "neutral"] }, then: 0 },
                { case: { $eq: ["$sentiment", "negative"] }, then: -1 },
              ],
              default: 0,
            },
          },
          neg: { $cond: [{ $eq: ["$sentiment", "negative"] }, 1, 0] },
          pos: { $cond: [{ $eq: ["$sentiment", "positive"] }, 1, 0] },
          neu: { $cond: [{ $eq: ["$sentiment", "neutral"] }, 1, 0] },
        },
      },
      {
        $group: {
          _id: { topic: "$topic" },
          totalDocs: { $sum: 1 },
          negativeDocs: { $sum: "$neg" },
          positiveDocs: { $sum: "$pos" },
          neutralDocs: { $sum: "$neu" },
          scoreSum: { $sum: "$score" },
        },
      },
      {
        $project: {
          _id: 0,
          topic: { $substrCP: ["$_id.topic", 0, 191] },
          totalDocs: 1,
          negativeDocs: 1,
          positiveDocs: 1,
          neutralDocs: 1,
          scoreSum: 1,
        },
      },
      { $sort: { totalDocs: -1, negativeDocs: -1 } },
      { $limit: MAX_ROWS_PER_BUCKET },
    ];

    const rows =
      await ProcessedItemModel.aggregate<TopicAggregateRow>(
        pipeline,
      ).allowDiskUse(true);
    return rows.filter(
      (row) => typeof row.topic === "string" && row.topic.length > 0,
    );
  }

  private toUtcDayStart(value: Date): Date {
    const d = new Date(value);
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }
}
