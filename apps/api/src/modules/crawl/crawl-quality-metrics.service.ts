import { CrawlResultContentModel, TaskLogModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertOperator, AlertStatus } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

interface CrawlQualityRejectBreakdown {
  includePattern: number;
  excludePattern: number;
  publishConfidence: number;
}

interface CrawlQualityConfidenceBuckets {
  lt04: number;
  from04To06: number;
  from06To08: number;
  gte08: number;
}

interface CrawlQualityAlertThresholds {
  preflightFailureRateHigh: number;
  http304HitRateLow: number;
  orgHashDedupeHitRateHigh: number;
}

const DEFAULT_CRAWL_QUALITY_ALERT_THRESHOLDS: CrawlQualityAlertThresholds = {
  preflightFailureRateHigh: 0.15,
  http304HitRateLow: 0.05,
  orgHashDedupeHitRateHigh: 0.3
};

export interface CrawlQualityMetricsSnapshot {
  orgId: string;
  from: string;
  to: string;
  taskCount: number;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects: CrawlQualityRejectBreakdown;
  publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
  fitMarkdownPreferenceRate: number;
  headSignalSuccessRate: number;
  headSignalSoftFailureRate: number;
  headSignalTruncatedRate: number;
  headSignalNoPublishSignalRate: number;
  http304HitRate: number;
  orgHashDedupeHitRate: number;
  preflightFailureRate: number;
  alertThresholds: CrawlQualityAlertThresholds;
  groupedBySource: Array<{
    sourceId: string;
    taskCount: number;
    lowSignalRatio: number;
    expansionSuccessRate: number;
    avgMarkdownChars: number;
    candidateRejects: CrawlQualityRejectBreakdown;
    publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
    fitMarkdownPreferenceRate: number;
    headSignalSuccessRate: number;
    headSignalSoftFailureRate: number;
    headSignalTruncatedRate: number;
    headSignalNoPublishSignalRate: number;
    http304HitRate: number;
    orgHashDedupeHitRate: number;
    preflightFailureRate: number;
  }>;
}

@Injectable()
export class CrawlQualityMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(orgId: string, lookbackHours = 24): Promise<CrawlQualityMetricsSnapshot> {
    const safeHours = Math.max(1, Math.min(24 * 14, Math.floor(lookbackHours)));
    const to = new Date();
    const from = new Date(to.getTime() - safeHours * 60 * 60 * 1000);
    const alertThresholds = await this.resolveAlertThresholds(orgId);

    const tasks = await this.prisma.crawlTask.findMany({
      where: {
        orgId,
        createdAt: { gte: from }
      },
      select: {
        id: true,
        displayName: true,
        config: true
      }
    });

    const taskIds = tasks.map((task) => task.id);
    if (taskIds.length === 0) {
      return {
        orgId,
        from: from.toISOString(),
        to: to.toISOString(),
        taskCount: 0,
        lowSignalRatio: 0,
        emptyMarkdownRate: 0,
        expansionTriggerRate: 0,
        expansionSuccessRate: 0,
        avgMarkdownChars: 0,
        candidateRejects: this.createEmptyRejectBreakdown(),
        publishConfidenceBuckets: this.createEmptyConfidenceBuckets(),
        fitMarkdownPreferenceRate: 0,
        headSignalSuccessRate: 0,
        headSignalSoftFailureRate: 0,
        headSignalTruncatedRate: 0,
        headSignalNoPublishSignalRate: 0,
        http304HitRate: 0,
        orgHashDedupeHitRate: 0,
        preflightFailureRate: 0,
        alertThresholds,
        groupedBySource: []
      };
    }

    const [expansionLogs, preflightLogs, dedupeLogs, markdownDocs] = await Promise.all([
      TaskLogModel.find({
        orgId,
        queue: "crawl4ai",
        stage: "expansion",
        createdAt: { $gte: from }
      })
        .select({ jobId: 1, status: 1, data: 1 })
        .lean(),
      TaskLogModel.find({
        orgId,
        queue: "crawl4ai",
        stage: "preflight",
        createdAt: { $gte: from }
      })
        .select({ jobId: 1, status: 1, data: 1 })
        .lean(),
      TaskLogModel.find({
        orgId,
        queue: "crawl4ai",
        stage: "dedupe",
        createdAt: { $gte: from }
      })
        .select({ jobId: 1, status: 1, data: 1 })
        .lean(),
      CrawlResultContentModel.find({
        taskId: { $in: taskIds },
        createdAt: { $gte: from }
      })
        .select({ taskId: 1, markdown: 1 })
        .lean()
    ]);

    const taskIdSet = new Set(taskIds);
    const expansionByTask = new Map<
      string,
      {
        triggered: boolean;
        improved: number;
        lowSignal: boolean;
        candidateRejects: CrawlQualityRejectBreakdown;
        publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
        preferFitMarkdown: boolean;
        headSignalAttempted: number;
        headSignalSucceeded: number;
        headSignalSoftFailures: number;
        headSignalTruncated: number;
        headSignalNoPublishSignal: number;
        preflightRuns: number;
        preflightFailures: number;
        preflight304Hits: number;
        dedupeEvaluated: number;
        dedupeOrgReuse: number;
      }
    >();
    const lowSignalTaskSet = new Set<string>();

    for (const log of expansionLogs) {
      const taskId = typeof log.jobId === "string" ? log.jobId : "";
      if (!taskId || !taskIdSet.has(taskId)) {
        continue;
      }

      const data =
        log.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : {};
      const current =
        expansionByTask.get(taskId) ??
        {
          triggered: false,
          improved: 0,
          lowSignal: false,
          candidateRejects: this.createEmptyRejectBreakdown(),
          publishConfidenceBuckets: this.createEmptyConfidenceBuckets(),
          preferFitMarkdown: false,
          headSignalAttempted: 0,
          headSignalSucceeded: 0,
          headSignalSoftFailures: 0,
          headSignalTruncated: 0,
          headSignalNoPublishSignal: 0,
          preflightRuns: 0,
          preflightFailures: 0,
          preflight304Hits: 0,
          dedupeEvaluated: 0,
          dedupeOrgReuse: 0
        };
      current.triggered = true;
      const improvedSuccesses =
        typeof data.improvedSuccesses === "number" && Number.isFinite(data.improvedSuccesses)
          ? Math.max(0, Math.round(data.improvedSuccesses))
          : 0;
      current.improved = Math.max(current.improved, improvedSuccesses);

      const lowSignalResults =
        typeof data.lowSignalResults === "number" && Number.isFinite(data.lowSignalResults)
          ? Math.max(0, Math.round(data.lowSignalResults))
          : 0;
      if (lowSignalResults > 0) {
        lowSignalTaskSet.add(taskId);
        current.lowSignal = true;
      }

      const rejects = this.parseCandidateRejectBreakdown(data.candidateRejects);
      current.candidateRejects.includePattern = Math.max(
        current.candidateRejects.includePattern,
        rejects.includePattern
      );
      current.candidateRejects.excludePattern = Math.max(
        current.candidateRejects.excludePattern,
        rejects.excludePattern
      );
      current.candidateRejects.publishConfidence = Math.max(
        current.candidateRejects.publishConfidence,
        rejects.publishConfidence
      );

      const confidenceBuckets = this.parseConfidenceBuckets(data.publishConfidenceBuckets);
      current.publishConfidenceBuckets.lt04 = Math.max(
        current.publishConfidenceBuckets.lt04,
        confidenceBuckets.lt04
      );
      current.publishConfidenceBuckets.from04To06 = Math.max(
        current.publishConfidenceBuckets.from04To06,
        confidenceBuckets.from04To06
      );
      current.publishConfidenceBuckets.from06To08 = Math.max(
        current.publishConfidenceBuckets.from06To08,
        confidenceBuckets.from06To08
      );
      current.publishConfidenceBuckets.gte08 = Math.max(
        current.publishConfidenceBuckets.gte08,
        confidenceBuckets.gte08
      );

      const detailExpansion =
        data.detailExpansion &&
        typeof data.detailExpansion === "object" &&
        !Array.isArray(data.detailExpansion)
          ? (data.detailExpansion as Record<string, unknown>)
          : undefined;
      if (detailExpansion?.preferFitMarkdownForQuality === true) {
        current.preferFitMarkdown = true;
      }

      const headSignal =
        data.headSignalEnrichment &&
        typeof data.headSignalEnrichment === "object" &&
        !Array.isArray(data.headSignalEnrichment)
          ? (data.headSignalEnrichment as Record<string, unknown>)
          : undefined;
      const attempted =
        typeof headSignal?.attempted === "number" && Number.isFinite(headSignal.attempted)
          ? Math.max(0, Math.round(headSignal.attempted))
          : 0;
      const succeeded =
        typeof headSignal?.succeeded === "number" && Number.isFinite(headSignal.succeeded)
          ? Math.max(0, Math.round(headSignal.succeeded))
          : 0;
      const truncatedResponses =
        typeof headSignal?.truncatedResponses === "number" &&
        Number.isFinite(headSignal.truncatedResponses)
          ? Math.max(0, Math.round(headSignal.truncatedResponses))
          : 0;
      const headSignalSoftFailuresRecord =
        headSignal?.softFailures &&
        typeof headSignal.softFailures === "object" &&
        !Array.isArray(headSignal.softFailures)
          ? (headSignal.softFailures as Record<string, unknown>)
          : undefined;
      const noPublishSignalSoftFailures = this.toSafeNonNegativeInt(
        headSignalSoftFailuresRecord?.noPublishSignal
      );
      const inferredSoftFailureCount = headSignalSoftFailuresRecord
        ? this.toSafeNonNegativeInt(headSignalSoftFailuresRecord.httpStatus) +
          this.toSafeNonNegativeInt(headSignalSoftFailuresRecord.nonHtml) +
          this.toSafeNonNegativeInt(headSignalSoftFailuresRecord.emptyHtml) +
          this.toSafeNonNegativeInt(headSignalSoftFailuresRecord.networkOrTimeout) +
          noPublishSignalSoftFailures
        : noPublishSignalSoftFailures;
      const softFailureCount =
        typeof headSignal?.softFailureCount === "number" &&
        Number.isFinite(headSignal.softFailureCount)
          ? Math.max(0, Math.round(headSignal.softFailureCount))
          : inferredSoftFailureCount;
      current.headSignalAttempted = Math.max(current.headSignalAttempted, attempted);
      current.headSignalSucceeded = Math.max(current.headSignalSucceeded, succeeded);
      current.headSignalSoftFailures = Math.max(
        current.headSignalSoftFailures,
        softFailureCount
      );
      current.headSignalTruncated = Math.max(
        current.headSignalTruncated,
        truncatedResponses
      );
      current.headSignalNoPublishSignal = Math.max(
        current.headSignalNoPublishSignal,
        noPublishSignalSoftFailures
      );

      expansionByTask.set(taskId, current);
    }

    for (const log of preflightLogs) {
      const taskId = typeof log.jobId === "string" ? log.jobId : "";
      if (!taskId || !taskIdSet.has(taskId)) {
        continue;
      }

      const data =
        log.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : {};
      const current =
        expansionByTask.get(taskId) ??
        {
          triggered: false,
          improved: 0,
          lowSignal: false,
          candidateRejects: this.createEmptyRejectBreakdown(),
          publishConfidenceBuckets: this.createEmptyConfidenceBuckets(),
          preferFitMarkdown: false,
          headSignalAttempted: 0,
          headSignalSucceeded: 0,
          headSignalSoftFailures: 0,
          headSignalTruncated: 0,
          headSignalNoPublishSignal: 0,
          preflightRuns: 0,
          preflightFailures: 0,
          preflight304Hits: 0,
          dedupeEvaluated: 0,
          dedupeOrgReuse: 0
        };

      current.preflightRuns += 1;
      if (log.status === "failed") {
        current.preflightFailures += 1;
      }

      const status = this.toSafeNonNegativeInt(data.status);
      if (status === 304) {
        current.preflight304Hits += 1;
      }

      expansionByTask.set(taskId, current);
    }

    for (const log of dedupeLogs) {
      const taskId = typeof log.jobId === "string" ? log.jobId : "";
      if (!taskId || !taskIdSet.has(taskId)) {
        continue;
      }

      const data =
        log.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : {};
      const current =
        expansionByTask.get(taskId) ??
        {
          triggered: false,
          improved: 0,
          lowSignal: false,
          candidateRejects: this.createEmptyRejectBreakdown(),
          publishConfidenceBuckets: this.createEmptyConfidenceBuckets(),
          preferFitMarkdown: false,
          headSignalAttempted: 0,
          headSignalSucceeded: 0,
          headSignalSoftFailures: 0,
          headSignalTruncated: 0,
          headSignalNoPublishSignal: 0,
          preflightRuns: 0,
          preflightFailures: 0,
          preflight304Hits: 0,
          dedupeEvaluated: 0,
          dedupeOrgReuse: 0
        };

      current.dedupeEvaluated += this.toSafeNonNegativeInt(data.evaluatedCount);
      current.dedupeOrgReuse += this.toSafeNonNegativeInt(data.orgReuseCount);
      expansionByTask.set(taskId, current);
    }

    const markdownByTask = new Map<string, { count: number; totalChars: number; emptyCount: number }>();
    for (const doc of markdownDocs) {
      const taskId = typeof doc.taskId === "string" ? doc.taskId : "";
      if (!taskId) {
        continue;
      }
      const markdown = typeof doc.markdown === "string" ? doc.markdown : "";
      const entry = markdownByTask.get(taskId) ?? { count: 0, totalChars: 0, emptyCount: 0 };
      entry.count += 1;
      entry.totalChars += markdown.length;
      if (markdown.trim().length === 0) {
        entry.emptyCount += 1;
      }
      markdownByTask.set(taskId, entry);
    }

    const taskCount = taskIds.length;
    const expansionTriggered = Array.from(expansionByTask.values()).filter((entry) => entry.triggered).length;
    const expansionImproved = Array.from(expansionByTask.values()).filter((entry) => entry.improved > 0).length;
    const candidateRejects = this.createEmptyRejectBreakdown();
    const publishConfidenceBuckets = this.createEmptyConfidenceBuckets();
    let fitMarkdownPreferenceTasks = 0;
    let headSignalAttemptedTotal = 0;
    let headSignalSucceededTotal = 0;
    let headSignalSoftFailureTotal = 0;
    let headSignalTruncatedTotal = 0;
    let headSignalNoPublishSignalTotal = 0;
    let preflightRunsTotal = 0;
    let preflightFailuresTotal = 0;
    let preflight304HitsTotal = 0;
    let dedupeEvaluatedTotal = 0;
    let dedupeOrgReuseTotal = 0;
    for (const entry of expansionByTask.values()) {
      candidateRejects.includePattern += entry.candidateRejects.includePattern;
      candidateRejects.excludePattern += entry.candidateRejects.excludePattern;
      candidateRejects.publishConfidence += entry.candidateRejects.publishConfidence;
      publishConfidenceBuckets.lt04 += entry.publishConfidenceBuckets.lt04;
      publishConfidenceBuckets.from04To06 += entry.publishConfidenceBuckets.from04To06;
      publishConfidenceBuckets.from06To08 += entry.publishConfidenceBuckets.from06To08;
      publishConfidenceBuckets.gte08 += entry.publishConfidenceBuckets.gte08;
      if (entry.preferFitMarkdown) {
        fitMarkdownPreferenceTasks += 1;
      }
      headSignalAttemptedTotal += entry.headSignalAttempted;
      headSignalSucceededTotal += entry.headSignalSucceeded;
      headSignalSoftFailureTotal += entry.headSignalSoftFailures;
      headSignalTruncatedTotal += entry.headSignalTruncated;
      headSignalNoPublishSignalTotal += entry.headSignalNoPublishSignal;
      preflightRunsTotal += entry.preflightRuns;
      preflightFailuresTotal += entry.preflightFailures;
      preflight304HitsTotal += entry.preflight304Hits;
      dedupeEvaluatedTotal += entry.dedupeEvaluated;
      dedupeOrgReuseTotal += entry.dedupeOrgReuse;
    }

    let markdownCount = 0;
    let markdownChars = 0;
    let emptyMarkdownCount = 0;
    for (const entry of markdownByTask.values()) {
      markdownCount += entry.count;
      markdownChars += entry.totalChars;
      emptyMarkdownCount += entry.emptyCount;
    }

    const groupedBySource = this.groupBySource(tasks, expansionByTask, markdownByTask);

    return {
      orgId,
      from: from.toISOString(),
      to: to.toISOString(),
      taskCount,
      lowSignalRatio: this.safeRatio(lowSignalTaskSet.size, taskCount),
      emptyMarkdownRate: this.safeRatio(emptyMarkdownCount, markdownCount),
      expansionTriggerRate: this.safeRatio(expansionTriggered, taskCount),
      expansionSuccessRate: this.safeRatio(expansionImproved, expansionTriggered),
      avgMarkdownChars: markdownCount > 0 ? Math.round(markdownChars / markdownCount) : 0,
      candidateRejects,
      publishConfidenceBuckets,
      fitMarkdownPreferenceRate: this.safeRatio(fitMarkdownPreferenceTasks, expansionTriggered),
      headSignalSuccessRate: this.safeRatio(headSignalSucceededTotal, headSignalAttemptedTotal),
      headSignalSoftFailureRate: this.safeRatio(headSignalSoftFailureTotal, headSignalAttemptedTotal),
      headSignalTruncatedRate: this.safeRatio(headSignalTruncatedTotal, headSignalAttemptedTotal),
      headSignalNoPublishSignalRate: this.safeRatio(
        headSignalNoPublishSignalTotal,
        headSignalAttemptedTotal
      ),
      http304HitRate: this.safeRatio(preflight304HitsTotal, preflightRunsTotal),
      orgHashDedupeHitRate: this.safeRatio(
        dedupeOrgReuseTotal,
        dedupeEvaluatedTotal
      ),
      preflightFailureRate: this.safeRatio(
        preflightFailuresTotal,
        preflightRunsTotal
      ),
      alertThresholds,
      groupedBySource
    };
  }

  async getSourceSnapshot(orgId: string, sourceId: string, lookbackHours = 24): Promise<CrawlQualityMetricsSnapshot> {
    const snapshot = await this.getSnapshot(orgId, lookbackHours);
    const filtered = snapshot.groupedBySource.filter((entry) => entry.sourceId === sourceId);
    const entry = filtered[0];
    if (!entry) {
      return {
        ...snapshot,
        taskCount: 0,
        lowSignalRatio: 0,
        emptyMarkdownRate: 0,
        expansionTriggerRate: 0,
        expansionSuccessRate: 0,
        avgMarkdownChars: 0,
        candidateRejects: this.createEmptyRejectBreakdown(),
        publishConfidenceBuckets: this.createEmptyConfidenceBuckets(),
        fitMarkdownPreferenceRate: 0,
        headSignalSuccessRate: 0,
        headSignalSoftFailureRate: 0,
        headSignalTruncatedRate: 0,
        headSignalNoPublishSignalRate: 0,
        http304HitRate: 0,
        orgHashDedupeHitRate: 0,
        preflightFailureRate: 0,
        groupedBySource: []
      };
    }
    return {
      ...snapshot,
      taskCount: entry.taskCount,
      lowSignalRatio: entry.lowSignalRatio,
      expansionSuccessRate: entry.expansionSuccessRate,
      avgMarkdownChars: entry.avgMarkdownChars,
      candidateRejects: entry.candidateRejects,
      publishConfidenceBuckets: entry.publishConfidenceBuckets,
      fitMarkdownPreferenceRate: entry.fitMarkdownPreferenceRate,
      headSignalSuccessRate: entry.headSignalSuccessRate,
      headSignalSoftFailureRate: entry.headSignalSoftFailureRate,
      headSignalTruncatedRate: entry.headSignalTruncatedRate,
      headSignalNoPublishSignalRate: entry.headSignalNoPublishSignalRate,
      http304HitRate: entry.http304HitRate,
      orgHashDedupeHitRate: entry.orgHashDedupeHitRate,
      preflightFailureRate: entry.preflightFailureRate,
      groupedBySource: filtered
    };
  }

  private groupBySource(
    tasks: Array<{ id: string; displayName: string | null; config: unknown }>,
    expansionByTask: Map<
      string,
      {
        triggered: boolean;
        improved: number;
        lowSignal: boolean;
        candidateRejects: CrawlQualityRejectBreakdown;
        publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
        preferFitMarkdown: boolean;
        headSignalAttempted: number;
        headSignalSucceeded: number;
        headSignalSoftFailures: number;
        headSignalTruncated: number;
        headSignalNoPublishSignal: number;
        preflightRuns: number;
        preflightFailures: number;
        preflight304Hits: number;
        dedupeEvaluated: number;
        dedupeOrgReuse: number;
      }
    >,
    markdownByTask: Map<string, { count: number; totalChars: number; emptyCount: number }>
  ) {
    const bySource = new Map<
      string,
      {
        taskCount: number;
        lowSignalCount: number;
        expansionTriggered: number;
        expansionImproved: number;
        markdownCount: number;
        markdownChars: number;
        candidateRejects: CrawlQualityRejectBreakdown;
        publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
        fitMarkdownCount: number;
        headSignalAttempted: number;
        headSignalSucceeded: number;
        headSignalSoftFailures: number;
        headSignalTruncated: number;
        headSignalNoPublishSignal: number;
        preflightRuns: number;
        preflightFailures: number;
        preflight304Hits: number;
        dedupeEvaluated: number;
        dedupeOrgReuse: number;
      }
    >();

    for (const task of tasks) {
      const sourceId = this.extractSourceId(task.config, task.displayName) ?? "unknown";
      const current =
        bySource.get(sourceId) ??
        {
          taskCount: 0,
          lowSignalCount: 0,
          expansionTriggered: 0,
          expansionImproved: 0,
          markdownCount: 0,
          markdownChars: 0,
          candidateRejects: this.createEmptyRejectBreakdown(),
          publishConfidenceBuckets: this.createEmptyConfidenceBuckets(),
          fitMarkdownCount: 0,
          headSignalAttempted: 0,
          headSignalSucceeded: 0,
          headSignalSoftFailures: 0,
          headSignalTruncated: 0,
          headSignalNoPublishSignal: 0,
          preflightRuns: 0,
          preflightFailures: 0,
          preflight304Hits: 0,
          dedupeEvaluated: 0,
          dedupeOrgReuse: 0
        };

      current.taskCount += 1;
      const expansion = expansionByTask.get(task.id);
      if (expansion?.triggered) {
        current.expansionTriggered += 1;
      }
      if (expansion?.lowSignal) {
        current.lowSignalCount += 1;
      }
      if ((expansion?.improved ?? 0) > 0) {
        current.expansionImproved += 1;
      }
      if (expansion?.preferFitMarkdown) {
        current.fitMarkdownCount += 1;
      }
      if (expansion) {
        current.candidateRejects.includePattern += expansion.candidateRejects.includePattern;
        current.candidateRejects.excludePattern += expansion.candidateRejects.excludePattern;
        current.candidateRejects.publishConfidence += expansion.candidateRejects.publishConfidence;
        current.publishConfidenceBuckets.lt04 += expansion.publishConfidenceBuckets.lt04;
        current.publishConfidenceBuckets.from04To06 += expansion.publishConfidenceBuckets.from04To06;
        current.publishConfidenceBuckets.from06To08 += expansion.publishConfidenceBuckets.from06To08;
        current.publishConfidenceBuckets.gte08 += expansion.publishConfidenceBuckets.gte08;
        current.headSignalAttempted += expansion.headSignalAttempted;
        current.headSignalSucceeded += expansion.headSignalSucceeded;
        current.headSignalSoftFailures += expansion.headSignalSoftFailures;
        current.headSignalTruncated += expansion.headSignalTruncated;
        current.headSignalNoPublishSignal += expansion.headSignalNoPublishSignal;
        current.preflightRuns += expansion.preflightRuns;
        current.preflightFailures += expansion.preflightFailures;
        current.preflight304Hits += expansion.preflight304Hits;
        current.dedupeEvaluated += expansion.dedupeEvaluated;
        current.dedupeOrgReuse += expansion.dedupeOrgReuse;
      }

      const markdown = markdownByTask.get(task.id);
      if (markdown) {
        current.markdownCount += markdown.count;
        current.markdownChars += markdown.totalChars;
      }

      bySource.set(sourceId, current);
    }

    return Array.from(bySource.entries())
      .map(([sourceId, value]) => ({
        sourceId,
        taskCount: value.taskCount,
        lowSignalRatio: this.safeRatio(value.lowSignalCount, value.taskCount),
        expansionSuccessRate: this.safeRatio(value.expansionImproved, value.expansionTriggered),
        avgMarkdownChars: value.markdownCount > 0 ? Math.round(value.markdownChars / value.markdownCount) : 0,
        candidateRejects: value.candidateRejects,
        publishConfidenceBuckets: value.publishConfidenceBuckets,
        fitMarkdownPreferenceRate: this.safeRatio(value.fitMarkdownCount, value.expansionTriggered),
        headSignalSuccessRate: this.safeRatio(value.headSignalSucceeded, value.headSignalAttempted),
        headSignalSoftFailureRate: this.safeRatio(
          value.headSignalSoftFailures,
          value.headSignalAttempted
        ),
        headSignalTruncatedRate: this.safeRatio(
          value.headSignalTruncated,
          value.headSignalAttempted
        ),
        headSignalNoPublishSignalRate: this.safeRatio(
          value.headSignalNoPublishSignal,
          value.headSignalAttempted
        ),
        http304HitRate: this.safeRatio(value.preflight304Hits, value.preflightRuns),
        orgHashDedupeHitRate: this.safeRatio(
          value.dedupeOrgReuse,
          value.dedupeEvaluated
        ),
        preflightFailureRate: this.safeRatio(
          value.preflightFailures,
          value.preflightRuns
        )
      }))
      .sort((left, right) => right.taskCount - left.taskCount);
  }

  private async resolveAlertThresholds(orgId: string): Promise<CrawlQualityAlertThresholds> {
    const thresholds: CrawlQualityAlertThresholds = {
      ...DEFAULT_CRAWL_QUALITY_ALERT_THRESHOLDS
    };
    const rules = await this.prisma.alertRule.findMany({
      where: {
        orgId,
        status: AlertStatus.active,
        metricProvider: AlertMetricProvider.crawl_task,
        metricSlug: {
          in: [
            "crawl_quality.preflight_failure_rate",
            "crawl_quality.http_304_hit_rate",
            "crawl_quality.org_hash_dedupe_hit_rate"
          ]
        },
        thresholdValue: { not: null }
      },
      orderBy: { updatedAt: "desc" },
      select: {
        metricSlug: true,
        operator: true,
        thresholdValue: true
      }
    });

    const pickThreshold = (
      metricSlug: string,
      allowedOperators: AlertOperator[]
    ) => {
      const exact = rules.find(
        (entry) =>
          entry.metricSlug === metricSlug &&
          allowedOperators.includes(entry.operator)
      );
      if (exact?.thresholdValue !== null && exact?.thresholdValue !== undefined) {
        return Number(exact.thresholdValue);
      }
      const fallback = rules.find((entry) => entry.metricSlug === metricSlug);
      if (
        fallback?.thresholdValue !== null &&
        fallback?.thresholdValue !== undefined
      ) {
        return Number(fallback.thresholdValue);
      }
      return null;
    };

    const preflightFailure = pickThreshold("crawl_quality.preflight_failure_rate", [
      AlertOperator.gte,
      AlertOperator.gt
    ]);
    if (typeof preflightFailure === "number" && Number.isFinite(preflightFailure)) {
      thresholds.preflightFailureRateHigh = Math.max(0, preflightFailure);
    }

    const http304Low = pickThreshold("crawl_quality.http_304_hit_rate", [
      AlertOperator.lte,
      AlertOperator.lt
    ]);
    if (typeof http304Low === "number" && Number.isFinite(http304Low)) {
      thresholds.http304HitRateLow = Math.max(0, http304Low);
    }

    const orgHashHigh = pickThreshold(
      "crawl_quality.org_hash_dedupe_hit_rate",
      [AlertOperator.gte, AlertOperator.gt]
    );
    if (typeof orgHashHigh === "number" && Number.isFinite(orgHashHigh)) {
      thresholds.orgHashDedupeHitRateHigh = Math.max(0, orgHashHigh);
    }

    return thresholds;
  }

  private createEmptyRejectBreakdown(): CrawlQualityRejectBreakdown {
    return {
      includePattern: 0,
      excludePattern: 0,
      publishConfidence: 0
    };
  }

  private createEmptyConfidenceBuckets(): CrawlQualityConfidenceBuckets {
    return {
      lt04: 0,
      from04To06: 0,
      from06To08: 0,
      gte08: 0
    };
  }

  private parseCandidateRejectBreakdown(value: unknown): CrawlQualityRejectBreakdown {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.createEmptyRejectBreakdown();
    }
    const record = value as Record<string, unknown>;
    return {
      includePattern: this.toSafeNonNegativeInt(
        record.includePatternRejected ?? record.includePattern
      ),
      excludePattern: this.toSafeNonNegativeInt(
        record.excludePatternRejected ?? record.excludePattern
      ),
      publishConfidence: this.toSafeNonNegativeInt(
        record.publishConfidenceRejected ?? record.publishConfidence
      )
    };
  }

  private parseConfidenceBuckets(value: unknown): CrawlQualityConfidenceBuckets {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.createEmptyConfidenceBuckets();
    }
    const record = value as Record<string, unknown>;
    return {
      lt04: this.toSafeNonNegativeInt(record.lt04),
      from04To06: this.toSafeNonNegativeInt(record.from04To06),
      from06To08: this.toSafeNonNegativeInt(record.from06To08),
      gte08: this.toSafeNonNegativeInt(record.gte08)
    };
  }

  private toSafeNonNegativeInt(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.round(value));
  }

  private extractSourceId(config: unknown, displayName: string | null): string | undefined {
    if (config && typeof config === "object" && !Array.isArray(config)) {
      const record = config as Record<string, unknown>;
      const itemPayload =
        record.itemPayload && typeof record.itemPayload === "object" && !Array.isArray(record.itemPayload)
          ? (record.itemPayload as Record<string, unknown>)
          : null;
      const metadata =
        itemPayload?.metadata && typeof itemPayload.metadata === "object" && !Array.isArray(itemPayload.metadata)
          ? (itemPayload.metadata as Record<string, unknown>)
          : null;
      const sourceId = typeof metadata?.sourceId === "string" ? metadata.sourceId.trim() : "";
      if (sourceId.length > 0) {
        return sourceId;
      }
    }

    if (typeof displayName === "string") {
      const match = /^NewsSource:([^:]+):/.exec(displayName);
      if (match?.[1]) {
        return match[1];
      }
    }

    return undefined;
  }

  private safeRatio(numerator: number, denominator: number): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return 0;
    }
    return Number((Math.max(0, numerator) / denominator).toFixed(4));
  }
}
