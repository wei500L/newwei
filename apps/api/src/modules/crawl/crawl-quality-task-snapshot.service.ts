import { CrawlResultContentModel, TaskLogModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CrawlTaskStatus, Prisma } from "@prisma/client";

import { settleWithConcurrency } from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import type {
  CrawlQualityMetricsAggregates,
  CrawlQualityMetricsSourceSnapshot,
} from "./crawl-quality-metrics.types";
import {
  buildCrawlQualityTaskSnapshotRows,
  type CrawlQualityTaskDedupeSummary,
  type CrawlQualityTaskExpansionSummary,
  type CrawlQualityTaskMarkdownSummary,
  type CrawlQualityTaskPreflightSummary,
  type CrawlQualityTaskSnapshotWriteRow,
} from "./crawl-quality-task-snapshot.helpers";

const logger = createLogger({ name: "crawl-quality-task-snapshot" });

const ACTIVE_TASK_REFRESH_MAX_AGE_MS = 5 * 60 * 1000;
const RECENT_CHANGE_LOOKBACK_MS = 15 * 60 * 1000;
const RECENT_REFRESH_ORG_CONCURRENCY = 2;
const REFRESH_BATCH_SIZE = 200;
const REFRESH_LOCK_TTL_MS = 4 * 60 * 1000;
const ACTIVE_TASK_STATUSES = new Set<CrawlTaskStatus>([
  CrawlTaskStatus.pending,
  CrawlTaskStatus.queued,
  CrawlTaskStatus.running,
]);

interface CrawlQualityWindowTaskRow {
  id: string;
  status: CrawlTaskStatus;
  updatedAt: Date;
}

interface CrawlQualitySnapshotMetadataRow {
  taskId: string;
  taskUpdatedAt: Date;
  rolledAt: Date;
}

interface CrawlQualityAggregateSqlRow {
  sourceId?: unknown;
  taskCount?: unknown;
  lowSignalTaskCount?: unknown;
  expansionTriggeredTaskCount?: unknown;
  expansionImprovedTaskCount?: unknown;
  markdownCount?: unknown;
  markdownCharsTotal?: unknown;
  emptyMarkdownCount?: unknown;
  candidateRejectIncludePatternCount?: unknown;
  candidateRejectExcludePatternCount?: unknown;
  candidateRejectPublishConfidenceCount?: unknown;
  publishConfidenceLt04Count?: unknown;
  publishConfidenceFrom04To06Count?: unknown;
  publishConfidenceFrom06To08Count?: unknown;
  publishConfidenceGte08Count?: unknown;
  fitMarkdownPreferenceTaskCount?: unknown;
  headSignalAttemptedCount?: unknown;
  headSignalSucceededCount?: unknown;
  headSignalSoftFailureCount?: unknown;
  headSignalTruncatedCount?: unknown;
  headSignalNoPublishSignalCount?: unknown;
  preflightRunCount?: unknown;
  preflightFailureCount?: unknown;
  preflight304HitCount?: unknown;
  dedupeEvaluatedCount?: unknown;
  dedupeOrgReuseCount?: unknown;
}

@Injectable()
export class CrawlQualityTaskSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshRecentSnapshots() {
    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    if (orgs.length === 0) {
      return;
    }

    const results = await settleWithConcurrency(
      orgs,
      RECENT_REFRESH_ORG_CONCURRENCY,
      async (org) => await this.refreshRecentSnapshotsForOrgWithLock(org.id),
    );

    let failed = 0;
    let skipped = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failed += 1;
        logger.warn(
          { err: result.reason, orgId: result.item.id },
          "Crawl quality task snapshot refresh failed",
        );
        continue;
      }
      if (result.value === "skipped") {
        skipped += 1;
      }
    }

    logger.info(
      { orgCount: orgs.length, failed, skipped },
      "Crawl quality task snapshot refresh tick completed",
    );
  }

  async ensureSnapshotsForWindow(
    orgId: string,
    from: Date,
    to: Date,
    tasks: CrawlQualityWindowTaskRow[],
    now = new Date(),
  ): Promise<void> {
    if (tasks.length === 0) {
      return;
    }

    const snapshots = await this.prisma.crawlQualityTaskSnapshot.findMany({
      where: {
        orgId,
        taskCreatedAt: {
          gte: from,
          lte: to,
        },
      },
      select: {
        taskId: true,
        taskUpdatedAt: true,
        rolledAt: true,
      },
    });
    const byTaskId = new Map<string, CrawlQualitySnapshotMetadataRow>(
      snapshots.map((snapshot) => [snapshot.taskId, snapshot]),
    );
    const activeRefreshCutoff = now.getTime() - ACTIVE_TASK_REFRESH_MAX_AGE_MS;
    const staleTaskIds: string[] = [];

    for (const task of tasks) {
      const snapshot = byTaskId.get(task.id);
      if (!snapshot) {
        staleTaskIds.push(task.id);
        continue;
      }
      if (snapshot.taskUpdatedAt.getTime() < task.updatedAt.getTime()) {
        staleTaskIds.push(task.id);
        continue;
      }
      if (
        ACTIVE_TASK_STATUSES.has(task.status) &&
        snapshot.rolledAt.getTime() < activeRefreshCutoff
      ) {
        staleTaskIds.push(task.id);
      }
    }

    if (staleTaskIds.length > 0) {
      await this.refreshSnapshotsForTaskIds(orgId, staleTaskIds);
    }
  }

  async readAggregates(
    orgId: string,
    from: Date,
    to: Date,
  ): Promise<CrawlQualityMetricsAggregates> {
    const [overallRows, groupedRows] = await Promise.all([
      this.queryOverallAggregate(orgId, from, to),
      this.queryGroupedAggregates(orgId, from, to),
    ]);
    const overall = this.buildAggregateMetrics(overallRows[0]);
    const groupedBySource = groupedRows
      .map((row) => this.buildGroupedMetrics(row))
      .sort((left, right) => right.taskCount - left.taskCount);

    return {
      ...overall,
      groupedBySource,
    };
  }

  async refreshSnapshotsForTaskIds(
    orgId: string,
    taskIds: string[],
  ): Promise<void> {
    const uniqueTaskIds = Array.from(
      new Set(
        taskIds.filter(
          (taskId): taskId is string =>
            typeof taskId === "string" && taskId.trim().length > 0,
        ),
      ),
    );
    if (uniqueTaskIds.length === 0) {
      return;
    }

    for (
      let index = 0;
      index < uniqueTaskIds.length;
      index += REFRESH_BATCH_SIZE
    ) {
      const batchTaskIds = uniqueTaskIds.slice(
        index,
        index + REFRESH_BATCH_SIZE,
      );
      await this.refreshSnapshotBatch(orgId, batchTaskIds);
    }
  }

  private async refreshRecentSnapshotsForOrgWithLock(
    orgId: string,
  ): Promise<"completed" | "skipped"> {
    const locked = await this.cache.withLock(
      `cron:crawl-quality-task-snapshot:org:${orgId}`,
      REFRESH_LOCK_TTL_MS,
      async () => {
        const since = new Date(Date.now() - RECENT_CHANGE_LOOKBACK_MS);
        const taskIds = await this.discoverRecentlyChangedTaskIds(orgId, since);
        if (taskIds.length > 0) {
          await this.refreshSnapshotsForTaskIds(orgId, taskIds);
        }
        return "completed" as const;
      },
    );

    if (locked !== null) {
      return locked;
    }

    logger.info(
      { orgId },
      "Skipped crawl quality task snapshot refresh because previous org run is still in progress",
    );
    return "skipped";
  }

  private async discoverRecentlyChangedTaskIds(orgId: string, since: Date) {
    const [createdTasks, updatedTasks, logs, results] = await Promise.all([
      this.prisma.crawlTask.findMany({
        where: {
          orgId,
          createdAt: { gte: since },
        },
        select: { id: true },
      }),
      this.prisma.crawlTask.findMany({
        where: {
          orgId,
          createdAt: { lt: since },
          updatedAt: { gte: since },
        },
        select: { id: true },
      }),
      TaskLogModel.find({
        orgId,
        queue: "crawl4ai",
        stage: { $in: ["expansion", "preflight", "dedupe"] },
        createdAt: { $gte: since },
      })
        .select({ jobId: 1 })
        .lean(),
      this.prisma.crawlResult.findMany({
        where: {
          orgId,
          fetchedAt: { gte: since },
        },
        select: { taskId: true },
      }),
    ]);

    return Array.from(
      new Set([
        ...createdTasks.map((task) => task.id),
        ...updatedTasks.map((task) => task.id),
        ...logs
          .map((log) => (typeof log.jobId === "string" ? log.jobId.trim() : ""))
          .filter((taskId) => taskId.length > 0),
        ...results
          .map((result) =>
            typeof result.taskId === "string" ? result.taskId.trim() : "",
          )
          .filter((taskId) => taskId.length > 0),
      ]),
    );
  }

  private async refreshSnapshotBatch(
    orgId: string,
    taskIds: string[],
  ): Promise<void> {
    const tasks = await this.prisma.crawlTask.findMany({
      where: {
        orgId,
        id: { in: taskIds },
      },
      select: {
        id: true,
        orgId: true,
        newsSourceId: true,
        displayName: true,
        config: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (tasks.length === 0) {
      return;
    }

    const existingTaskIds = tasks.map((task) => task.id);
    const [expansionRows, preflightRows, dedupeRows, markdownRows] =
      await Promise.all([
        this.aggregateExpansionRows(orgId, existingTaskIds),
        this.aggregatePreflightRows(orgId, existingTaskIds),
        this.aggregateDedupeRows(orgId, existingTaskIds),
        this.aggregateMarkdownRows(existingTaskIds),
      ]);

    const rows = buildCrawlQualityTaskSnapshotRows(
      tasks,
      {
        expansionRows,
        preflightRows,
        dedupeRows,
        markdownRows,
      },
      new Date(),
    );

    await this.upsertSnapshotRows(rows);
  }

  private async aggregateExpansionRows(
    orgId: string,
    taskIds: string[],
  ): Promise<CrawlQualityTaskExpansionSummary[]> {
    return TaskLogModel.aggregate<CrawlQualityTaskExpansionSummary>([
      {
        $match: {
          orgId,
          queue: "crawl4ai",
          stage: "expansion",
          jobId: { $in: taskIds },
        },
      },
      {
        $project: {
          taskId: "$jobId",
          improvedSuccesses: this.toNonNegativeIntExpr(
            "$data.improvedSuccesses",
          ),
          lowSignalResults: this.toNonNegativeIntExpr("$data.lowSignalResults"),
          candidateRejectIncludePatternCount: this.toNonNegativeIntExpr({
            $ifNull: [
              "$data.candidateRejects.includePatternRejected",
              "$data.candidateRejects.includePattern",
            ],
          }),
          candidateRejectExcludePatternCount: this.toNonNegativeIntExpr({
            $ifNull: [
              "$data.candidateRejects.excludePatternRejected",
              "$data.candidateRejects.excludePattern",
            ],
          }),
          candidateRejectPublishConfidenceCount: this.toNonNegativeIntExpr({
            $ifNull: [
              "$data.candidateRejects.publishConfidenceRejected",
              "$data.candidateRejects.publishConfidence",
            ],
          }),
          publishConfidenceLt04Count: this.toNonNegativeIntExpr(
            "$data.publishConfidenceBuckets.lt04",
          ),
          publishConfidenceFrom04To06Count: this.toNonNegativeIntExpr(
            "$data.publishConfidenceBuckets.from04To06",
          ),
          publishConfidenceFrom06To08Count: this.toNonNegativeIntExpr(
            "$data.publishConfidenceBuckets.from06To08",
          ),
          publishConfidenceGte08Count: this.toNonNegativeIntExpr(
            "$data.publishConfidenceBuckets.gte08",
          ),
          fitMarkdownPreferenceTaskCount: {
            $cond: [
              {
                $eq: [
                  "$data.detailExpansion.preferFitMarkdownForQuality",
                  true,
                ],
              },
              1,
              0,
            ],
          },
          headSignalAttemptedCount: this.toNonNegativeIntExpr(
            "$data.headSignalEnrichment.attempted",
          ),
          headSignalSucceededCount: this.toNonNegativeIntExpr(
            "$data.headSignalEnrichment.succeeded",
          ),
          headSignalTruncatedCount: this.toNonNegativeIntExpr(
            "$data.headSignalEnrichment.truncatedResponses",
          ),
          headSignalNoPublishSignalCount: this.toNonNegativeIntExpr(
            "$data.headSignalEnrichment.softFailures.noPublishSignal",
          ),
          explicitHeadSignalSoftFailureCount: this.toNonNegativeIntExpr(
            "$data.headSignalEnrichment.softFailureCount",
          ),
          inferredHeadSignalSoftFailureCount: {
            $add: [
              this.toNonNegativeIntExpr(
                "$data.headSignalEnrichment.softFailures.httpStatus",
              ),
              this.toNonNegativeIntExpr(
                "$data.headSignalEnrichment.softFailures.nonHtml",
              ),
              this.toNonNegativeIntExpr(
                "$data.headSignalEnrichment.softFailures.emptyHtml",
              ),
              this.toNonNegativeIntExpr(
                "$data.headSignalEnrichment.softFailures.networkOrTimeout",
              ),
              this.toNonNegativeIntExpr(
                "$data.headSignalEnrichment.softFailures.noPublishSignal",
              ),
            ],
          },
        },
      },
      {
        $project: {
          taskId: 1,
          lowSignalTaskCount: {
            $cond: [{ $gt: ["$lowSignalResults", 0] }, 1, 0],
          },
          expansionTriggeredTaskCount: { $literal: 1 },
          expansionImprovedTaskCount: {
            $cond: [{ $gt: ["$improvedSuccesses", 0] }, 1, 0],
          },
          candidateRejectIncludePatternCount: 1,
          candidateRejectExcludePatternCount: 1,
          candidateRejectPublishConfidenceCount: 1,
          publishConfidenceLt04Count: 1,
          publishConfidenceFrom04To06Count: 1,
          publishConfidenceFrom06To08Count: 1,
          publishConfidenceGte08Count: 1,
          fitMarkdownPreferenceTaskCount: 1,
          headSignalAttemptedCount: 1,
          headSignalSucceededCount: 1,
          headSignalSoftFailureCount: {
            $cond: [
              { $gt: ["$explicitHeadSignalSoftFailureCount", 0] },
              "$explicitHeadSignalSoftFailureCount",
              "$inferredHeadSignalSoftFailureCount",
            ],
          },
          headSignalTruncatedCount: 1,
          headSignalNoPublishSignalCount: 1,
        },
      },
      {
        $group: {
          _id: "$taskId",
          lowSignalTaskCount: { $max: "$lowSignalTaskCount" },
          expansionTriggeredTaskCount: {
            $max: "$expansionTriggeredTaskCount",
          },
          expansionImprovedTaskCount: { $max: "$expansionImprovedTaskCount" },
          candidateRejectIncludePatternCount: {
            $max: "$candidateRejectIncludePatternCount",
          },
          candidateRejectExcludePatternCount: {
            $max: "$candidateRejectExcludePatternCount",
          },
          candidateRejectPublishConfidenceCount: {
            $max: "$candidateRejectPublishConfidenceCount",
          },
          publishConfidenceLt04Count: { $max: "$publishConfidenceLt04Count" },
          publishConfidenceFrom04To06Count: {
            $max: "$publishConfidenceFrom04To06Count",
          },
          publishConfidenceFrom06To08Count: {
            $max: "$publishConfidenceFrom06To08Count",
          },
          publishConfidenceGte08Count: {
            $max: "$publishConfidenceGte08Count",
          },
          fitMarkdownPreferenceTaskCount: {
            $max: "$fitMarkdownPreferenceTaskCount",
          },
          headSignalAttemptedCount: { $max: "$headSignalAttemptedCount" },
          headSignalSucceededCount: { $max: "$headSignalSucceededCount" },
          headSignalSoftFailureCount: { $max: "$headSignalSoftFailureCount" },
          headSignalTruncatedCount: { $max: "$headSignalTruncatedCount" },
          headSignalNoPublishSignalCount: {
            $max: "$headSignalNoPublishSignalCount",
          },
        },
      },
      {
        $project: {
          _id: 0,
          taskId: "$_id",
          lowSignalTaskCount: 1,
          expansionTriggeredTaskCount: 1,
          expansionImprovedTaskCount: 1,
          candidateRejectIncludePatternCount: 1,
          candidateRejectExcludePatternCount: 1,
          candidateRejectPublishConfidenceCount: 1,
          publishConfidenceLt04Count: 1,
          publishConfidenceFrom04To06Count: 1,
          publishConfidenceFrom06To08Count: 1,
          publishConfidenceGte08Count: 1,
          fitMarkdownPreferenceTaskCount: 1,
          headSignalAttemptedCount: 1,
          headSignalSucceededCount: 1,
          headSignalSoftFailureCount: 1,
          headSignalTruncatedCount: 1,
          headSignalNoPublishSignalCount: 1,
        },
      },
    ]);
  }

  private async aggregatePreflightRows(
    orgId: string,
    taskIds: string[],
  ): Promise<CrawlQualityTaskPreflightSummary[]> {
    return TaskLogModel.aggregate<CrawlQualityTaskPreflightSummary>([
      {
        $match: {
          orgId,
          queue: "crawl4ai",
          stage: "preflight",
          jobId: { $in: taskIds },
        },
      },
      {
        $project: {
          taskId: "$jobId",
          preflightRunCount: { $literal: 1 },
          preflightFailureCount: {
            $cond: [{ $eq: ["$status", "failed"] }, 1, 0],
          },
          preflight304HitCount: {
            $cond: [
              {
                $eq: [this.toNonNegativeIntExpr("$data.status"), 304],
              },
              1,
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$taskId",
          preflightRunCount: { $sum: "$preflightRunCount" },
          preflightFailureCount: { $sum: "$preflightFailureCount" },
          preflight304HitCount: { $sum: "$preflight304HitCount" },
        },
      },
      {
        $project: {
          _id: 0,
          taskId: "$_id",
          preflightRunCount: 1,
          preflightFailureCount: 1,
          preflight304HitCount: 1,
        },
      },
    ]);
  }

  private async aggregateDedupeRows(
    orgId: string,
    taskIds: string[],
  ): Promise<CrawlQualityTaskDedupeSummary[]> {
    return TaskLogModel.aggregate<CrawlQualityTaskDedupeSummary>([
      {
        $match: {
          orgId,
          queue: "crawl4ai",
          stage: "dedupe",
          jobId: { $in: taskIds },
        },
      },
      {
        $project: {
          taskId: "$jobId",
          dedupeEvaluatedCount: this.toNonNegativeIntExpr(
            "$data.evaluatedCount",
          ),
          dedupeOrgReuseCount: this.toNonNegativeIntExpr("$data.orgReuseCount"),
        },
      },
      {
        $group: {
          _id: "$taskId",
          dedupeEvaluatedCount: { $sum: "$dedupeEvaluatedCount" },
          dedupeOrgReuseCount: { $sum: "$dedupeOrgReuseCount" },
        },
      },
      {
        $project: {
          _id: 0,
          taskId: "$_id",
          dedupeEvaluatedCount: 1,
          dedupeOrgReuseCount: 1,
        },
      },
    ]);
  }

  private async aggregateMarkdownRows(
    taskIds: string[],
  ): Promise<CrawlQualityTaskMarkdownSummary[]> {
    return CrawlResultContentModel.aggregate<CrawlQualityTaskMarkdownSummary>([
      {
        $match: {
          taskId: { $in: taskIds },
        },
      },
      {
        $project: {
          taskId: 1,
          markdownLength: {
            $strLenCP: { $ifNull: ["$markdown", ""] },
          },
          trimmedMarkdownLength: {
            $strLenCP: {
              $trim: {
                input: { $ifNull: ["$markdown", ""] },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: "$taskId",
          markdownCount: { $sum: 1 },
          markdownCharsTotal: { $sum: "$markdownLength" },
          emptyMarkdownCount: {
            $sum: {
              $cond: [{ $eq: ["$trimmedMarkdownLength", 0] }, 1, 0],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          taskId: "$_id",
          markdownCount: 1,
          markdownCharsTotal: 1,
          emptyMarkdownCount: 1,
        },
      },
    ]);
  }

  private async upsertSnapshotRows(
    rows: CrawlQualityTaskSnapshotWriteRow[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const values = rows.map(
      (row) => Prisma.sql`(
        ${row.taskId},
        ${row.orgId},
        ${row.sourceId},
        ${row.taskCreatedAt},
        ${row.taskUpdatedAt},
        ${row.rolledAt},
        ${row.lowSignalTaskCount},
        ${row.expansionTriggeredTaskCount},
        ${row.expansionImprovedTaskCount},
        ${row.markdownCount},
        ${row.markdownCharsTotal},
        ${row.emptyMarkdownCount},
        ${row.candidateRejectIncludePatternCount},
        ${row.candidateRejectExcludePatternCount},
        ${row.candidateRejectPublishConfidenceCount},
        ${row.publishConfidenceLt04Count},
        ${row.publishConfidenceFrom04To06Count},
        ${row.publishConfidenceFrom06To08Count},
        ${row.publishConfidenceGte08Count},
        ${row.fitMarkdownPreferenceTaskCount},
        ${row.headSignalAttemptedCount},
        ${row.headSignalSucceededCount},
        ${row.headSignalSoftFailureCount},
        ${row.headSignalTruncatedCount},
        ${row.headSignalNoPublishSignalCount},
        ${row.preflightRunCount},
        ${row.preflightFailureCount},
        ${row.preflight304HitCount},
        ${row.dedupeEvaluatedCount},
        ${row.dedupeOrgReuseCount},
        ${row.rolledAt},
        ${row.rolledAt}
      )`,
    );

    await this.prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO \`CrawlQualityTaskSnapshot\` (
          \`taskId\`,
          \`orgId\`,
          \`sourceId\`,
          \`taskCreatedAt\`,
          \`taskUpdatedAt\`,
          \`rolledAt\`,
          \`lowSignalTaskCount\`,
          \`expansionTriggeredTaskCount\`,
          \`expansionImprovedTaskCount\`,
          \`markdownCount\`,
          \`markdownCharsTotal\`,
          \`emptyMarkdownCount\`,
          \`candidateRejectIncludePatternCount\`,
          \`candidateRejectExcludePatternCount\`,
          \`candidateRejectPublishConfidenceCount\`,
          \`publishConfidenceLt04Count\`,
          \`publishConfidenceFrom04To06Count\`,
          \`publishConfidenceFrom06To08Count\`,
          \`publishConfidenceGte08Count\`,
          \`fitMarkdownPreferenceTaskCount\`,
          \`headSignalAttemptedCount\`,
          \`headSignalSucceededCount\`,
          \`headSignalSoftFailureCount\`,
          \`headSignalTruncatedCount\`,
          \`headSignalNoPublishSignalCount\`,
          \`preflightRunCount\`,
          \`preflightFailureCount\`,
          \`preflight304HitCount\`,
          \`dedupeEvaluatedCount\`,
          \`dedupeOrgReuseCount\`,
          \`createdAt\`,
          \`updatedAt\`
        )
        VALUES ${Prisma.join(values)}
        ON DUPLICATE KEY UPDATE
          \`orgId\` = VALUES(\`orgId\`),
          \`sourceId\` = VALUES(\`sourceId\`),
          \`taskCreatedAt\` = VALUES(\`taskCreatedAt\`),
          \`taskUpdatedAt\` = VALUES(\`taskUpdatedAt\`),
          \`rolledAt\` = VALUES(\`rolledAt\`),
          \`lowSignalTaskCount\` = VALUES(\`lowSignalTaskCount\`),
          \`expansionTriggeredTaskCount\` = VALUES(\`expansionTriggeredTaskCount\`),
          \`expansionImprovedTaskCount\` = VALUES(\`expansionImprovedTaskCount\`),
          \`markdownCount\` = VALUES(\`markdownCount\`),
          \`markdownCharsTotal\` = VALUES(\`markdownCharsTotal\`),
          \`emptyMarkdownCount\` = VALUES(\`emptyMarkdownCount\`),
          \`candidateRejectIncludePatternCount\` = VALUES(\`candidateRejectIncludePatternCount\`),
          \`candidateRejectExcludePatternCount\` = VALUES(\`candidateRejectExcludePatternCount\`),
          \`candidateRejectPublishConfidenceCount\` = VALUES(\`candidateRejectPublishConfidenceCount\`),
          \`publishConfidenceLt04Count\` = VALUES(\`publishConfidenceLt04Count\`),
          \`publishConfidenceFrom04To06Count\` = VALUES(\`publishConfidenceFrom04To06Count\`),
          \`publishConfidenceFrom06To08Count\` = VALUES(\`publishConfidenceFrom06To08Count\`),
          \`publishConfidenceGte08Count\` = VALUES(\`publishConfidenceGte08Count\`),
          \`fitMarkdownPreferenceTaskCount\` = VALUES(\`fitMarkdownPreferenceTaskCount\`),
          \`headSignalAttemptedCount\` = VALUES(\`headSignalAttemptedCount\`),
          \`headSignalSucceededCount\` = VALUES(\`headSignalSucceededCount\`),
          \`headSignalSoftFailureCount\` = VALUES(\`headSignalSoftFailureCount\`),
          \`headSignalTruncatedCount\` = VALUES(\`headSignalTruncatedCount\`),
          \`headSignalNoPublishSignalCount\` = VALUES(\`headSignalNoPublishSignalCount\`),
          \`preflightRunCount\` = VALUES(\`preflightRunCount\`),
          \`preflightFailureCount\` = VALUES(\`preflightFailureCount\`),
          \`preflight304HitCount\` = VALUES(\`preflight304HitCount\`),
          \`dedupeEvaluatedCount\` = VALUES(\`dedupeEvaluatedCount\`),
          \`dedupeOrgReuseCount\` = VALUES(\`dedupeOrgReuseCount\`),
          \`updatedAt\` = VALUES(\`updatedAt\`)
      `,
    );
  }

  private async queryOverallAggregate(orgId: string, from: Date, to: Date) {
    return this.prisma.$queryRaw<CrawlQualityAggregateSqlRow[]>(
      Prisma.sql`
        SELECT
          COUNT(*) AS \`taskCount\`,
          COALESCE(SUM(\`lowSignalTaskCount\`), 0) AS \`lowSignalTaskCount\`,
          COALESCE(SUM(\`expansionTriggeredTaskCount\`), 0) AS \`expansionTriggeredTaskCount\`,
          COALESCE(SUM(\`expansionImprovedTaskCount\`), 0) AS \`expansionImprovedTaskCount\`,
          COALESCE(SUM(\`markdownCount\`), 0) AS \`markdownCount\`,
          COALESCE(SUM(\`markdownCharsTotal\`), 0) AS \`markdownCharsTotal\`,
          COALESCE(SUM(\`emptyMarkdownCount\`), 0) AS \`emptyMarkdownCount\`,
          COALESCE(SUM(\`candidateRejectIncludePatternCount\`), 0) AS \`candidateRejectIncludePatternCount\`,
          COALESCE(SUM(\`candidateRejectExcludePatternCount\`), 0) AS \`candidateRejectExcludePatternCount\`,
          COALESCE(SUM(\`candidateRejectPublishConfidenceCount\`), 0) AS \`candidateRejectPublishConfidenceCount\`,
          COALESCE(SUM(\`publishConfidenceLt04Count\`), 0) AS \`publishConfidenceLt04Count\`,
          COALESCE(SUM(\`publishConfidenceFrom04To06Count\`), 0) AS \`publishConfidenceFrom04To06Count\`,
          COALESCE(SUM(\`publishConfidenceFrom06To08Count\`), 0) AS \`publishConfidenceFrom06To08Count\`,
          COALESCE(SUM(\`publishConfidenceGte08Count\`), 0) AS \`publishConfidenceGte08Count\`,
          COALESCE(SUM(\`fitMarkdownPreferenceTaskCount\`), 0) AS \`fitMarkdownPreferenceTaskCount\`,
          COALESCE(SUM(\`headSignalAttemptedCount\`), 0) AS \`headSignalAttemptedCount\`,
          COALESCE(SUM(\`headSignalSucceededCount\`), 0) AS \`headSignalSucceededCount\`,
          COALESCE(SUM(\`headSignalSoftFailureCount\`), 0) AS \`headSignalSoftFailureCount\`,
          COALESCE(SUM(\`headSignalTruncatedCount\`), 0) AS \`headSignalTruncatedCount\`,
          COALESCE(SUM(\`headSignalNoPublishSignalCount\`), 0) AS \`headSignalNoPublishSignalCount\`,
          COALESCE(SUM(\`preflightRunCount\`), 0) AS \`preflightRunCount\`,
          COALESCE(SUM(\`preflightFailureCount\`), 0) AS \`preflightFailureCount\`,
          COALESCE(SUM(\`preflight304HitCount\`), 0) AS \`preflight304HitCount\`,
          COALESCE(SUM(\`dedupeEvaluatedCount\`), 0) AS \`dedupeEvaluatedCount\`,
          COALESCE(SUM(\`dedupeOrgReuseCount\`), 0) AS \`dedupeOrgReuseCount\`
        FROM \`CrawlQualityTaskSnapshot\`
        WHERE \`orgId\` = ${orgId}
          AND \`taskCreatedAt\` >= ${from}
          AND \`taskCreatedAt\` <= ${to}
      `,
    );
  }

  private async queryGroupedAggregates(orgId: string, from: Date, to: Date) {
    return this.prisma.$queryRaw<CrawlQualityAggregateSqlRow[]>(
      Prisma.sql`
        SELECT
          \`sourceId\`,
          COUNT(*) AS \`taskCount\`,
          COALESCE(SUM(\`lowSignalTaskCount\`), 0) AS \`lowSignalTaskCount\`,
          COALESCE(SUM(\`expansionTriggeredTaskCount\`), 0) AS \`expansionTriggeredTaskCount\`,
          COALESCE(SUM(\`expansionImprovedTaskCount\`), 0) AS \`expansionImprovedTaskCount\`,
          COALESCE(SUM(\`markdownCount\`), 0) AS \`markdownCount\`,
          COALESCE(SUM(\`markdownCharsTotal\`), 0) AS \`markdownCharsTotal\`,
          COALESCE(SUM(\`emptyMarkdownCount\`), 0) AS \`emptyMarkdownCount\`,
          COALESCE(SUM(\`candidateRejectIncludePatternCount\`), 0) AS \`candidateRejectIncludePatternCount\`,
          COALESCE(SUM(\`candidateRejectExcludePatternCount\`), 0) AS \`candidateRejectExcludePatternCount\`,
          COALESCE(SUM(\`candidateRejectPublishConfidenceCount\`), 0) AS \`candidateRejectPublishConfidenceCount\`,
          COALESCE(SUM(\`publishConfidenceLt04Count\`), 0) AS \`publishConfidenceLt04Count\`,
          COALESCE(SUM(\`publishConfidenceFrom04To06Count\`), 0) AS \`publishConfidenceFrom04To06Count\`,
          COALESCE(SUM(\`publishConfidenceFrom06To08Count\`), 0) AS \`publishConfidenceFrom06To08Count\`,
          COALESCE(SUM(\`publishConfidenceGte08Count\`), 0) AS \`publishConfidenceGte08Count\`,
          COALESCE(SUM(\`fitMarkdownPreferenceTaskCount\`), 0) AS \`fitMarkdownPreferenceTaskCount\`,
          COALESCE(SUM(\`headSignalAttemptedCount\`), 0) AS \`headSignalAttemptedCount\`,
          COALESCE(SUM(\`headSignalSucceededCount\`), 0) AS \`headSignalSucceededCount\`,
          COALESCE(SUM(\`headSignalSoftFailureCount\`), 0) AS \`headSignalSoftFailureCount\`,
          COALESCE(SUM(\`headSignalTruncatedCount\`), 0) AS \`headSignalTruncatedCount\`,
          COALESCE(SUM(\`headSignalNoPublishSignalCount\`), 0) AS \`headSignalNoPublishSignalCount\`,
          COALESCE(SUM(\`preflightRunCount\`), 0) AS \`preflightRunCount\`,
          COALESCE(SUM(\`preflightFailureCount\`), 0) AS \`preflightFailureCount\`,
          COALESCE(SUM(\`preflight304HitCount\`), 0) AS \`preflight304HitCount\`,
          COALESCE(SUM(\`dedupeEvaluatedCount\`), 0) AS \`dedupeEvaluatedCount\`,
          COALESCE(SUM(\`dedupeOrgReuseCount\`), 0) AS \`dedupeOrgReuseCount\`
        FROM \`CrawlQualityTaskSnapshot\`
        WHERE \`orgId\` = ${orgId}
          AND \`taskCreatedAt\` >= ${from}
          AND \`taskCreatedAt\` <= ${to}
        GROUP BY \`sourceId\`
        ORDER BY \`taskCount\` DESC, \`sourceId\` ASC
      `,
    );
  }

  private buildAggregateMetrics(
    row: CrawlQualityAggregateSqlRow | undefined,
  ): Omit<CrawlQualityMetricsAggregates, "groupedBySource"> {
    const taskCount = this.toSafeNonNegativeInt(row?.taskCount);
    const markdownCount = this.toSafeNonNegativeInt(row?.markdownCount);
    const markdownCharsTotal = this.toSafeNonNegativeInt(
      row?.markdownCharsTotal,
    );
    const expansionTriggeredTaskCount = this.toSafeNonNegativeInt(
      row?.expansionTriggeredTaskCount,
    );
    const headSignalAttemptedCount = this.toSafeNonNegativeInt(
      row?.headSignalAttemptedCount,
    );
    const preflightRunCount = this.toSafeNonNegativeInt(row?.preflightRunCount);
    const dedupeEvaluatedCount = this.toSafeNonNegativeInt(
      row?.dedupeEvaluatedCount,
    );

    return {
      taskCount,
      lowSignalRatio: this.safeRatio(
        this.toSafeNonNegativeInt(row?.lowSignalTaskCount),
        taskCount,
      ),
      emptyMarkdownRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.emptyMarkdownCount),
        markdownCount,
      ),
      expansionTriggerRate: this.safeRatio(
        expansionTriggeredTaskCount,
        taskCount,
      ),
      expansionSuccessRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.expansionImprovedTaskCount),
        expansionTriggeredTaskCount,
      ),
      avgMarkdownChars:
        markdownCount > 0 ? Math.round(markdownCharsTotal / markdownCount) : 0,
      candidateRejects: {
        includePattern: this.toSafeNonNegativeInt(
          row?.candidateRejectIncludePatternCount,
        ),
        excludePattern: this.toSafeNonNegativeInt(
          row?.candidateRejectExcludePatternCount,
        ),
        publishConfidence: this.toSafeNonNegativeInt(
          row?.candidateRejectPublishConfidenceCount,
        ),
      },
      publishConfidenceBuckets: {
        lt04: this.toSafeNonNegativeInt(row?.publishConfidenceLt04Count),
        from04To06: this.toSafeNonNegativeInt(
          row?.publishConfidenceFrom04To06Count,
        ),
        from06To08: this.toSafeNonNegativeInt(
          row?.publishConfidenceFrom06To08Count,
        ),
        gte08: this.toSafeNonNegativeInt(row?.publishConfidenceGte08Count),
      },
      fitMarkdownPreferenceRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.fitMarkdownPreferenceTaskCount),
        expansionTriggeredTaskCount,
      ),
      headSignalSuccessRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.headSignalSucceededCount),
        headSignalAttemptedCount,
      ),
      headSignalSoftFailureRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.headSignalSoftFailureCount),
        headSignalAttemptedCount,
      ),
      headSignalTruncatedRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.headSignalTruncatedCount),
        headSignalAttemptedCount,
      ),
      headSignalNoPublishSignalRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.headSignalNoPublishSignalCount),
        headSignalAttemptedCount,
      ),
      http304HitRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.preflight304HitCount),
        preflightRunCount,
      ),
      orgHashDedupeHitRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.dedupeOrgReuseCount),
        dedupeEvaluatedCount,
      ),
      preflightFailureRate: this.safeRatio(
        this.toSafeNonNegativeInt(row?.preflightFailureCount),
        preflightRunCount,
      ),
    };
  }

  private buildGroupedMetrics(
    row: CrawlQualityAggregateSqlRow,
  ): CrawlQualityMetricsSourceSnapshot {
    const metrics = this.buildAggregateMetrics(row);
    return {
      sourceId:
        typeof row.sourceId === "string" && row.sourceId.length > 0
          ? row.sourceId
          : "unknown",
      taskCount: metrics.taskCount,
      lowSignalRatio: metrics.lowSignalRatio,
      emptyMarkdownRate: metrics.emptyMarkdownRate,
      expansionTriggerRate: metrics.expansionTriggerRate,
      expansionSuccessRate: metrics.expansionSuccessRate,
      avgMarkdownChars: metrics.avgMarkdownChars,
      candidateRejects: metrics.candidateRejects,
      publishConfidenceBuckets: metrics.publishConfidenceBuckets,
      fitMarkdownPreferenceRate: metrics.fitMarkdownPreferenceRate,
      headSignalSuccessRate: metrics.headSignalSuccessRate,
      headSignalSoftFailureRate: metrics.headSignalSoftFailureRate,
      headSignalTruncatedRate: metrics.headSignalTruncatedRate,
      headSignalNoPublishSignalRate: metrics.headSignalNoPublishSignalRate,
      http304HitRate: metrics.http304HitRate,
      orgHashDedupeHitRate: metrics.orgHashDedupeHitRate,
      preflightFailureRate: metrics.preflightFailureRate,
    };
  }

  private toSafeNonNegativeInt(value: unknown): number {
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "bigint"
          ? Number(value)
          : Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Math.max(0, Math.round(numeric));
  }

  private safeRatio(numerator: number, denominator: number): number {
    if (
      !Number.isFinite(numerator) ||
      !Number.isFinite(denominator) ||
      denominator <= 0
    ) {
      return 0;
    }
    return Number((Math.max(0, numerator) / denominator).toFixed(4));
  }

  private toNonNegativeIntExpr(input: unknown) {
    return {
      $max: [
        0,
        {
          $convert: {
            input,
            to: "int",
            onError: 0,
            onNull: 0,
          },
        },
      ],
    };
  }
}
