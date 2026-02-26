import { TaskLogModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule, CrawlTaskStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";
import { CRAWL_QUEUE_NAME } from "../../crawl/crawl.constants";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

type CrawlQualityMetricSlug =
  | "crawl_quality.preflight_failure_rate"
  | "crawl_quality.http_304_hit_rate"
  | "crawl_quality.org_hash_dedupe_hit_rate";

const CRAWL_QUALITY_PREFLIGHT_FAILURE_RATE_METRIC_SLUG: CrawlQualityMetricSlug =
  "crawl_quality.preflight_failure_rate";
const CRAWL_QUALITY_HTTP_304_HIT_RATE_METRIC_SLUG: CrawlQualityMetricSlug =
  "crawl_quality.http_304_hit_rate";
const CRAWL_QUALITY_ORG_HASH_DEDUPE_HIT_RATE_METRIC_SLUG: CrawlQualityMetricSlug =
  "crawl_quality.org_hash_dedupe_hit_rate";

@Injectable()
export class CrawlMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.crawl_task;

  constructor(private readonly prisma: PrismaService) {}

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const metricSlug = rule.metricSlug.trim();
    if (this.isQualityMetricSlug(metricSlug)) {
      return this.fetchQualityRateMetric(rule.orgId, rule.changeWindowMin ?? 60, metricSlug);
    }

    return this.fetchTaskCountMetric(rule);
  }

  private async fetchTaskCountMetric(
    rule: Pick<AlertRule, "changeWindowMin" | "metadata" | "orgId">
  ): Promise<MetricEvaluation> {
    const windowMinutes = rule.changeWindowMin ?? 60;
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();
    const windowStart = new Date(now - windowMs);
    const previousWindowStart = new Date(now - 2 * windowMs);

    const allowedStatuses = Object.values(CrawlTaskStatus);
    const metadata =
      rule.metadata && typeof rule.metadata === "object" && !Array.isArray(rule.metadata)
        ? (rule.metadata as Record<string, unknown>)
        : null;
    const requestedStatuses = Array.isArray(metadata?.statuses)
      ? metadata.statuses.filter((status): status is string => typeof status === "string")
      : typeof metadata?.status === "string"
        ? [metadata.status]
        : undefined;
    const statuses =
      (requestedStatuses?.filter((status): status is CrawlTaskStatus =>
        allowedStatuses.includes(status as CrawlTaskStatus)
      ) ?? [CrawlTaskStatus.failed]);

    const createdById = typeof metadata?.createdById === "string" ? metadata.createdById : undefined;

    const baseWhere: Prisma.CrawlTaskWhereInput = {
      orgId: rule.orgId,
      status: { in: statuses },
      ...(createdById ? { createdById } : {})
    };

    const [latest, previous] = await Promise.all([
      this.prisma.crawlTask.count({
        where: {
          ...baseWhere,
          updatedAt: { gte: windowStart }
        }
      }),
      this.prisma.crawlTask.count({
        where: {
          ...baseWhere,
          updatedAt: { gte: previousWindowStart, lt: windowStart }
        }
      })
    ]);

    const changePercent = previous ? ((latest - previous) / previous) * 100 : null;

    return {
      latest,
      previous,
      changePercent,
      context: { windowMinutes, statuses, createdById }
    };
  }

  private async fetchQualityRateMetric(
    orgId: string,
    windowMinutesRaw: number,
    metricSlug: CrawlQualityMetricSlug
  ): Promise<MetricEvaluation> {
    const windowMinutes = this.normalizeWindowMinutes(windowMinutesRaw);
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();
    const windowStart = new Date(now - windowMs);
    const previousWindowStart = new Date(now - 2 * windowMs);

    if (metricSlug === CRAWL_QUALITY_ORG_HASH_DEDUPE_HIT_RATE_METRIC_SLUG) {
      const [latestCounts, previousCounts] = await Promise.all([
        this.collectDedupeCounts(orgId, windowStart),
        this.collectDedupeCounts(orgId, previousWindowStart, windowStart)
      ]);
      const latest = this.safeRate(latestCounts.orgReuseCount, latestCounts.evaluatedCount);
      const previous = this.safeRate(previousCounts.orgReuseCount, previousCounts.evaluatedCount);
      return {
        latest,
        previous,
        changePercent: this.computeChangePercent(latest, previous),
        context: {
          windowMinutes,
          metricSlug,
          latestCounts,
          previousCounts
        }
      };
    }

    const [latestCounts, previousCounts] = await Promise.all([
      this.collectPreflightCounts(orgId, windowStart),
      this.collectPreflightCounts(orgId, previousWindowStart, windowStart)
    ]);
    const latest =
      metricSlug === CRAWL_QUALITY_PREFLIGHT_FAILURE_RATE_METRIC_SLUG
        ? this.safeRate(latestCounts.failures, latestCounts.runs)
        : this.safeRate(latestCounts.http304Hits, latestCounts.runs);
    const previous =
      metricSlug === CRAWL_QUALITY_PREFLIGHT_FAILURE_RATE_METRIC_SLUG
        ? this.safeRate(previousCounts.failures, previousCounts.runs)
        : this.safeRate(previousCounts.http304Hits, previousCounts.runs);
    return {
      latest,
      previous,
      changePercent: this.computeChangePercent(latest, previous),
      context: {
        windowMinutes,
        metricSlug,
        latestCounts,
        previousCounts
      }
    };
  }

  private isQualityMetricSlug(slug: string): slug is CrawlQualityMetricSlug {
    return (
      slug === CRAWL_QUALITY_PREFLIGHT_FAILURE_RATE_METRIC_SLUG ||
      slug === CRAWL_QUALITY_HTTP_304_HIT_RATE_METRIC_SLUG ||
      slug === CRAWL_QUALITY_ORG_HASH_DEDUPE_HIT_RATE_METRIC_SLUG
    );
  }

  private normalizeWindowMinutes(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return 60;
    }
    return Math.max(1, Math.min(24 * 60, Math.round(value)));
  }

  private async collectPreflightCounts(orgId: string, from: Date, to?: Date) {
    const logs = await TaskLogModel.find({
      orgId,
      queue: CRAWL_QUEUE_NAME,
      stage: "preflight",
      createdAt: to ? { $gte: from, $lt: to } : { $gte: from }
    })
      .select({ status: 1, data: 1 })
      .lean();

    let runs = 0;
    let failures = 0;
    let http304Hits = 0;
    for (const log of logs) {
      runs += 1;
      if (log.status === "failed") {
        failures += 1;
      }
      const data =
        log.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : undefined;
      if (this.toSafeNonNegativeInt(data?.status) === 304) {
        http304Hits += 1;
      }
    }

    return { runs, failures, http304Hits };
  }

  private async collectDedupeCounts(orgId: string, from: Date, to?: Date) {
    const logs = await TaskLogModel.find({
      orgId,
      queue: CRAWL_QUEUE_NAME,
      stage: "dedupe",
      createdAt: to ? { $gte: from, $lt: to } : { $gte: from }
    })
      .select({ data: 1 })
      .lean();

    let evaluatedCount = 0;
    let orgReuseCount = 0;
    for (const log of logs) {
      const data =
        log.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : undefined;
      evaluatedCount += this.toSafeNonNegativeInt(data?.evaluatedCount);
      orgReuseCount += this.toSafeNonNegativeInt(data?.orgReuseCount);
    }

    return { evaluatedCount, orgReuseCount };
  }

  private safeRate(numerator: number, denominator: number): number | null {
    if (denominator <= 0) {
      return null;
    }
    return numerator / denominator;
  }

  private computeChangePercent(latest: number | null, previous: number | null): number | null {
    if (latest === null || previous === null || previous === 0) {
      return null;
    }
    return ((latest - previous) / previous) * 100;
  }

  private toSafeNonNegativeInt(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.round(value));
  }
}
