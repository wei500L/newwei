import { Injectable } from "@nestjs/common";
import {
  AlertMetricProvider,
  AlertOperator,
  AlertStatus,
  ObservabilitySnapshotScope,
} from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import { ObservabilitySnapshotService } from "../observability/observability-snapshot.service";

import type {
  CrawlQualityAlertThresholds,
  CrawlQualityMetricsSnapshot,
} from "./crawl-quality-metrics.types";
import {
  createEmptyCrawlQualityConfidenceBuckets,
  createEmptyCrawlQualityRejectBreakdown,
} from "./crawl-quality-metrics.types";
import { CrawlQualityTaskSnapshotService } from "./crawl-quality-task-snapshot.service";

const DEFAULT_CRAWL_QUALITY_ALERT_THRESHOLDS: CrawlQualityAlertThresholds = {
  preflightFailureRateHigh: 0.15,
  http304HitRateLow: 0.05,
  orgHashDedupeHitRateHigh: 0.3,
};

@Injectable()
export class CrawlQualityMetricsService {
  private readonly snapshotTtlSeconds = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: ObservabilitySnapshotService,
    private readonly taskSnapshots: CrawlQualityTaskSnapshotService,
  ) {}

  async getSnapshot(
    orgId: string,
    lookbackHours = 24,
  ): Promise<CrawlQualityMetricsSnapshot> {
    const safeHours = Math.max(1, Math.min(24 * 14, Math.floor(lookbackHours)));
    const snapshot =
      await this.snapshots.getOrCreate<CrawlQualityMetricsSnapshot>({
        orgId,
        scope: ObservabilitySnapshotScope.crawl_quality_metrics,
        variantKey: `lookbackHours:${safeHours}`,
        ttlSeconds: this.snapshotTtlSeconds,
        loader: async () => this.buildSnapshot(orgId, safeHours),
      });
    return snapshot.payload;
  }

  async getSourceSnapshot(
    orgId: string,
    sourceId: string,
    lookbackHours = 24,
  ): Promise<CrawlQualityMetricsSnapshot> {
    const snapshot = await this.getSnapshot(orgId, lookbackHours);
    const filtered = snapshot.groupedBySource.filter(
      (entry) => entry.sourceId === sourceId,
    );
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
        candidateRejects: createEmptyCrawlQualityRejectBreakdown(),
        publishConfidenceBuckets: createEmptyCrawlQualityConfidenceBuckets(),
        fitMarkdownPreferenceRate: 0,
        headSignalSuccessRate: 0,
        headSignalSoftFailureRate: 0,
        headSignalTruncatedRate: 0,
        headSignalNoPublishSignalRate: 0,
        http304HitRate: 0,
        orgHashDedupeHitRate: 0,
        preflightFailureRate: 0,
        groupedBySource: [],
      };
    }

    return {
      ...snapshot,
      taskCount: entry.taskCount,
      lowSignalRatio: entry.lowSignalRatio,
      emptyMarkdownRate: entry.emptyMarkdownRate,
      expansionTriggerRate: entry.expansionTriggerRate,
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
      groupedBySource: filtered,
    };
  }

  private async buildSnapshot(
    orgId: string,
    safeHours: number,
  ): Promise<CrawlQualityMetricsSnapshot> {
    const to = new Date();
    const from = new Date(to.getTime() - safeHours * 60 * 60 * 1000);
    const alertThresholds = await this.resolveAlertThresholds(orgId);

    const tasks = await this.prisma.crawlTask.findMany({
      where: {
        orgId,
        createdAt: {
          gte: from,
          lte: to,
        },
      },
      select: {
        id: true,
        status: true,
        updatedAt: true,
      },
    });
    if (tasks.length === 0) {
      return this.buildEmptySnapshot(orgId, from, to, alertThresholds);
    }

    await this.taskSnapshots.ensureSnapshotsForWindow(
      orgId,
      from,
      to,
      tasks,
      to,
    );
    const aggregates = await this.taskSnapshots.readAggregates(orgId, from, to);

    return {
      orgId,
      from: from.toISOString(),
      to: to.toISOString(),
      ...aggregates,
      alertThresholds,
    };
  }

  private async resolveAlertThresholds(
    orgId: string,
  ): Promise<CrawlQualityAlertThresholds> {
    const thresholds: CrawlQualityAlertThresholds = {
      ...DEFAULT_CRAWL_QUALITY_ALERT_THRESHOLDS,
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
            "crawl_quality.org_hash_dedupe_hit_rate",
          ],
        },
        thresholdValue: { not: null },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        metricSlug: true,
        operator: true,
        thresholdValue: true,
      },
    });

    const pickThreshold = (
      metricSlug: string,
      allowedOperators: AlertOperator[],
    ) => {
      const exact = rules.find(
        (entry) =>
          entry.metricSlug === metricSlug &&
          allowedOperators.includes(entry.operator),
      );
      if (
        exact?.thresholdValue !== null &&
        exact?.thresholdValue !== undefined
      ) {
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

    const preflightFailure = pickThreshold(
      "crawl_quality.preflight_failure_rate",
      [AlertOperator.gte, AlertOperator.gt],
    );
    if (
      typeof preflightFailure === "number" &&
      Number.isFinite(preflightFailure)
    ) {
      thresholds.preflightFailureRateHigh = Math.max(0, preflightFailure);
    }

    const http304Low = pickThreshold("crawl_quality.http_304_hit_rate", [
      AlertOperator.lte,
      AlertOperator.lt,
    ]);
    if (typeof http304Low === "number" && Number.isFinite(http304Low)) {
      thresholds.http304HitRateLow = Math.max(0, http304Low);
    }

    const orgHashHigh = pickThreshold(
      "crawl_quality.org_hash_dedupe_hit_rate",
      [AlertOperator.gte, AlertOperator.gt],
    );
    if (typeof orgHashHigh === "number" && Number.isFinite(orgHashHigh)) {
      thresholds.orgHashDedupeHitRateHigh = Math.max(0, orgHashHigh);
    }

    return thresholds;
  }

  private buildEmptySnapshot(
    orgId: string,
    from: Date,
    to: Date,
    alertThresholds: CrawlQualityAlertThresholds,
  ): CrawlQualityMetricsSnapshot {
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
      candidateRejects: createEmptyCrawlQualityRejectBreakdown(),
      publishConfidenceBuckets: createEmptyCrawlQualityConfidenceBuckets(),
      fitMarkdownPreferenceRate: 0,
      headSignalSuccessRate: 0,
      headSignalSoftFailureRate: 0,
      headSignalTruncatedRate: 0,
      headSignalNoPublishSignalRate: 0,
      http304HitRate: 0,
      orgHashDedupeHitRate: 0,
      preflightFailureRate: 0,
      alertThresholds,
      groupedBySource: [],
    };
  }
}
