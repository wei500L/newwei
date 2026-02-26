export interface ExpansionHeadSignalSoftFailures {
  httpStatus: number;
  nonHtml: number;
  emptyHtml: number;
  networkOrTimeout: number;
  noPublishSignal: number;
}

export interface ExpansionHeadSignalSummary {
  attempted?: number;
  succeeded?: number;
  failed?: number;
  topK?: number;
  skipped?: boolean;
  configuredTimeoutMs?: number;
  configuredConcurrency?: number;
  configuredMaxReadBytes?: number;
  effectiveTimeoutMs?: number;
  effectiveConcurrency?: number;
  maxReadBytes?: number;
  truncatedResponses?: number;
  earlyStoppedResponses?: number;
  urlPathFallbackCount?: number;
  totalSignalCandidates?: number;
  urlPathFallbackRatio?: number;
  softFailureCount: number;
  softFailures: ExpansionHeadSignalSoftFailures;
}

export interface ExpansionHeadSignalFallbackHint {
  fallbackCount: number;
  totalCandidates: number;
  fallbackRatio: number;
}

interface CrawlTaskLogLike {
  stage: string;
  data?: unknown;
}

const EMPTY_SOFT_FAILURES: ExpansionHeadSignalSoftFailures = {
  httpStatus: 0,
  nonHtml: 0,
  emptyHtml: 0,
  networkOrTimeout: 0,
  noPublishSignal: 0,
};

const toOptionalNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const toCount = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
};

export function parseExpansionHeadSignalSummary(
  taskLogs: CrawlTaskLogLike[],
): ExpansionHeadSignalSummary | null {
  for (const log of taskLogs) {
    if (log.stage !== 'expansion') {
      continue;
    }
    if (!log.data || typeof log.data !== 'object' || Array.isArray(log.data)) {
      continue;
    }
    const data = log.data as Record<string, unknown>;
    const headSignalRaw = data.headSignalEnrichment;
    if (
      !headSignalRaw ||
      typeof headSignalRaw !== 'object' ||
      Array.isArray(headSignalRaw)
    ) {
      continue;
    }
    const headSignal = headSignalRaw as Record<string, unknown>;
    const skipped =
      typeof headSignal.skipped === 'boolean' ? headSignal.skipped : undefined;
    const softFailuresRaw = headSignal.softFailures;
    const softFailures: ExpansionHeadSignalSoftFailures =
      softFailuresRaw &&
      typeof softFailuresRaw === 'object' &&
      !Array.isArray(softFailuresRaw)
        ? {
            httpStatus: toCount(softFailuresRaw as Record<string, unknown>, 'httpStatus'),
            nonHtml: toCount(softFailuresRaw as Record<string, unknown>, 'nonHtml'),
            emptyHtml: toCount(softFailuresRaw as Record<string, unknown>, 'emptyHtml'),
            networkOrTimeout: toCount(
              softFailuresRaw as Record<string, unknown>,
              'networkOrTimeout',
            ),
            noPublishSignal: toCount(
              softFailuresRaw as Record<string, unknown>,
              'noPublishSignal',
            ),
          }
        : EMPTY_SOFT_FAILURES;
    const inferredSoftFailureCount =
      softFailures.httpStatus +
      softFailures.nonHtml +
      softFailures.emptyHtml +
      softFailures.networkOrTimeout +
      softFailures.noPublishSignal;
    const softFailureCountRaw = headSignal.softFailureCount;
    const softFailureCount =
      typeof softFailureCountRaw === 'number' &&
      Number.isFinite(softFailureCountRaw)
        ? Math.max(0, Math.round(softFailureCountRaw))
        : inferredSoftFailureCount;

    return {
      attempted: toOptionalNumber(headSignal, 'attempted'),
      succeeded: toOptionalNumber(headSignal, 'succeeded'),
      failed: toOptionalNumber(headSignal, 'failed'),
      topK: toOptionalNumber(headSignal, 'topK'),
      skipped,
      configuredTimeoutMs: toOptionalNumber(headSignal, 'configuredTimeoutMs'),
      configuredConcurrency: toOptionalNumber(headSignal, 'configuredConcurrency'),
      configuredMaxReadBytes: toOptionalNumber(headSignal, 'configuredMaxReadBytes'),
      effectiveTimeoutMs: toOptionalNumber(headSignal, 'effectiveTimeoutMs'),
      effectiveConcurrency: toOptionalNumber(headSignal, 'effectiveConcurrency'),
      maxReadBytes: toOptionalNumber(headSignal, 'maxReadBytes'),
      truncatedResponses: toOptionalNumber(headSignal, 'truncatedResponses'),
      earlyStoppedResponses: toOptionalNumber(headSignal, 'earlyStoppedResponses'),
      urlPathFallbackCount: toOptionalNumber(headSignal, 'urlPathFallbackCount'),
      totalSignalCandidates: toOptionalNumber(headSignal, 'totalSignalCandidates'),
      urlPathFallbackRatio: toOptionalNumber(headSignal, 'urlPathFallbackRatio'),
      softFailureCount,
      softFailures,
    };
  }
  return null;
}

export function resolveHeadSignalFallbackHint(
  summary: ExpansionHeadSignalSummary | null,
): ExpansionHeadSignalFallbackHint | null {
  if (!summary) {
    return null;
  }
  const fallbackCount = summary.urlPathFallbackCount ?? 0;
  const totalCandidates = summary.totalSignalCandidates ?? summary.attempted ?? 0;
  if (fallbackCount <= 0 || totalCandidates <= 0) {
    return null;
  }
  const rawRatio = summary.urlPathFallbackRatio;
  const fallbackRatio =
    typeof rawRatio === 'number' && Number.isFinite(rawRatio)
      ? Math.max(0, Math.min(1, rawRatio))
      : fallbackCount / totalCandidates;
  return {
    fallbackCount,
    totalCandidates,
    fallbackRatio,
  };
}
