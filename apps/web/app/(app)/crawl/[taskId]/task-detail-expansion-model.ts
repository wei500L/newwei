/**
 * Crawl Task Detail 展开策略模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：detailExpansion 配置摘要来自 config JSON；expansion 质量
 * 指标与 head-signal 摘要来自 task logs；软失败/回退明细做 i18n 组装。
 */

import {
  parseExpansionHeadSignalSummary,
  resolveHeadSignalFallbackHint,
  type ExpansionHeadSignalSummary,
} from "@/lib/crawl-task-head-signal";

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import type { TaskDetailTranslate, TaskLogRecord } from "./task-detail-types";

export interface ExpansionQualitySummary {
  candidateCount: number;
  batchCount: number;
  improvedSuccesses: number;
  primaryCandidatePool?: number;
  fallbackCandidatePool?: number;
  minimumCandidateCount?: number;
  strictCandidateCount?: number;
  relaxedCandidateCount?: number;
  linkFallbackCandidateCount?: number;
}

export interface DetailExpansionSummary {
  maxDetailUrls: number | null;
  minRelevanceScore: number | null;
  requireSameDomain: boolean | null;
  allowExternalLinks: boolean | null;
  minPublishTimeConfidence: number | null;
  preferFitMarkdownForQuality: boolean | null;
  includeUrlPatterns: string[];
  excludeUrlPatterns: string[];
}

export function buildDetailExpansionSummary(
  config: CrawlTaskConfig,
): DetailExpansionSummary | null {
  if (
    !config ||
    typeof config.detailExpansion !== "object" ||
    !config.detailExpansion
  ) {
    return null;
  }
  const value = config.detailExpansion as Record<string, unknown>;
  const maxDetailUrls =
    typeof value.maxDetailUrls === "number" &&
    Number.isFinite(value.maxDetailUrls)
      ? value.maxDetailUrls
      : null;
  const minRelevanceScore =
    typeof value.minRelevanceScore === "number" &&
    Number.isFinite(value.minRelevanceScore)
      ? value.minRelevanceScore
      : null;
  const requireSameDomain =
    typeof value.requireSameDomain === "boolean"
      ? value.requireSameDomain
      : null;
  const allowExternalLinks =
    typeof value.allowExternalLinks === "boolean"
      ? value.allowExternalLinks
      : null;
  const minPublishTimeConfidence =
    typeof value.minPublishTimeConfidence === "number" &&
    Number.isFinite(value.minPublishTimeConfidence)
      ? value.minPublishTimeConfidence
      : null;
  const preferFitMarkdownForQuality =
    typeof value.preferFitMarkdownForQuality === "boolean"
      ? value.preferFitMarkdownForQuality
      : null;
  const toPatternList = (entry: unknown): string[] =>
    Array.isArray(entry)
      ? entry
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
  const includeUrlPatterns = toPatternList(value.includeUrlPatterns);
  const excludeUrlPatterns = toPatternList(value.excludeUrlPatterns);
  if (
    maxDetailUrls == null &&
    minRelevanceScore == null &&
    requireSameDomain == null &&
    allowExternalLinks == null &&
    minPublishTimeConfidence == null &&
    preferFitMarkdownForQuality == null &&
    includeUrlPatterns.length === 0 &&
    excludeUrlPatterns.length === 0
  ) {
    return null;
  }
  return {
    maxDetailUrls,
    minRelevanceScore,
    requireSameDomain,
    allowExternalLinks,
    minPublishTimeConfidence,
    preferFitMarkdownForQuality,
    includeUrlPatterns,
    excludeUrlPatterns,
  };
}

export function buildExpansionQualitySummary(
  taskLogs: TaskLogRecord[],
): ExpansionQualitySummary | null {
  for (const log of taskLogs) {
    if (log.stage !== "expansion") {
      continue;
    }
    if (
      !log.data ||
      typeof log.data !== "object" ||
      Array.isArray(log.data)
    ) {
      continue;
    }

    const data = log.data as Record<string, unknown>;
    const candidateCount =
      typeof data.candidateCount === "number" &&
      Number.isFinite(data.candidateCount)
        ? data.candidateCount
        : null;
    const batchCount =
      typeof data.batchCount === "number" && Number.isFinite(data.batchCount)
        ? data.batchCount
        : null;
    const improvedSuccesses =
      typeof data.improvedSuccesses === "number" &&
      Number.isFinite(data.improvedSuccesses)
        ? data.improvedSuccesses
        : null;

    if (
      candidateCount == null ||
      batchCount == null ||
      improvedSuccesses == null
    ) {
      continue;
    }

    const getOptionalNumber = (key: string) => {
      const value = data[key];
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    };

    return {
      candidateCount,
      batchCount,
      improvedSuccesses,
      primaryCandidatePool: getOptionalNumber("primaryCandidatePool"),
      fallbackCandidatePool: getOptionalNumber("fallbackCandidatePool"),
      minimumCandidateCount: getOptionalNumber("minimumCandidateCount"),
      strictCandidateCount: getOptionalNumber("strictCandidateCount"),
      relaxedCandidateCount: getOptionalNumber("relaxedCandidateCount"),
      linkFallbackCandidateCount: getOptionalNumber(
        "linkFallbackCandidateCount",
      ),
    };
  }

  return null;
}

export function parseTaskHeadSignalSummary(
  taskLogs: TaskLogRecord[],
): ExpansionHeadSignalSummary | null {
  return parseExpansionHeadSignalSummary(taskLogs);
}

export function buildHeadSignalSoftFailureDetails(
  summary: ExpansionHeadSignalSummary | null,
  t: TaskDetailTranslate,
): string {
  if (!summary || summary.softFailureCount <= 0) {
    return "";
  }
  const parts: string[] = [];
  if (summary.softFailures.httpStatus > 0) {
    parts.push(
      t("crawl.detail.expansion.softFailures.httpStatus", {
        count: summary.softFailures.httpStatus,
      }),
    );
  }
  if (summary.softFailures.nonHtml > 0) {
    parts.push(
      t("crawl.detail.expansion.softFailures.nonHtml", {
        count: summary.softFailures.nonHtml,
      }),
    );
  }
  if (summary.softFailures.emptyHtml > 0) {
    parts.push(
      t("crawl.detail.expansion.softFailures.emptyHtml", {
        count: summary.softFailures.emptyHtml,
      }),
    );
  }
  if (summary.softFailures.networkOrTimeout > 0) {
    parts.push(
      t("crawl.detail.expansion.softFailures.networkOrTimeout", {
        count: summary.softFailures.networkOrTimeout,
      }),
    );
  }
  if (summary.softFailures.noPublishSignal > 0) {
    parts.push(
      t("crawl.detail.expansion.softFailures.noPublishSignal", {
        count: summary.softFailures.noPublishSignal,
      }),
    );
  }
  return parts.join(" · ");
}

export function resolveTaskHeadSignalFallbackHint(
  summary: ExpansionHeadSignalSummary | null,
) {
  return resolveHeadSignalFallbackHint(summary);
}
