import axios from "axios";
import type { useTranslation } from "react-i18next";

import {
  findUnsupportedProxyIssues,
  getCrawlConfigPolicyIssueTranslationKey,
  type CrawlConfigPolicyIssue,
} from "@/lib/crawl-config-policy";
import { buildNewsSourceCloudflarePresetValues } from "@/lib/crawl-presets";
import {
  buildSeedConfigFromFormValues,
  DEFAULT_SEED_FORM_VALUES,
  normalizeSeedMode,
  readSeedFormValuesFromConfig,
  type SeedSchedulerRuntimeSettings,
} from "@/lib/news-source-seed";

import type {
  Crawl4aiQualitySnapshot,
  Crawl4aiQualitySourceMetric,
  CrawlQualityRateAlert,
  CrawlQualitySampleCounts,
  CrawlQualitySampleMetric,
  CrawlQualityThresholds,
  CrawlQualityThresholdStatus,
  CrawlStrategyTagDescriptor,
  LiveEventSource,
  NewsSourceApiRecord,
  NewsSourceFormValues,
  NewsSourceRecord,
} from "./news-sources.types";

export const REALTIME_SOCKET_TIMEOUT_MS = 10_000;
export function mapNewsSourceRecord(record: NewsSourceApiRecord): NewsSourceRecord {
  const runtime = record.opsSummary?.runtime;
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    siteType: record.siteType,
    language: record.language ?? null,
    crawlTemplateId: record.crawlTemplateId ?? null,
    workflowId: record.workflowId ?? null,
    workflowVersionId: record.workflowVersionId ?? null,
    workflowBindingMode: record.workflowBindingMode,
    group: record.group ?? null,
    frequencySeconds: record.frequencySeconds,
    priority: record.priority,
    isActive: record.isActive,
    lastRunAt: record.lastRunAt ?? null,
    lastSuccessAt: record.lastSuccessAt ?? null,
    lastFailureAt: record.lastFailureAt ?? null,
    consecutiveFailures: record.consecutiveFailures ?? 0,
    circuitOpenUntil: record.circuitOpenUntil ?? null,
    nextRunAt: record.nextRunAt ?? null,
    backpressureUntil: runtime?.backpressureUntil ?? null,
    backpressurePendingJobs: runtime?.backpressurePendingJobs ?? null,
    backpressureThreshold: runtime?.backpressureThreshold ?? null,
    rssAdaptiveState: runtime?.rssAdaptiveState,
    config: record.config ?? null,
    latestJob: record.opsSummary?.latestJob ?? null,
    latestCrawlTask: record.opsSummary?.latestCrawlTask ?? null,
    latestArticle: record.opsSummary?.latestArticle ?? null,
    crawlTaskQueuedCount: runtime?.crawlTaskQueuedCount ?? 0,
    crawlTaskRunningCount: runtime?.crawlTaskRunningCount ?? 0,
    backpressureCount24h: runtime?.backpressureCount24h ?? 0,
    stats24h: record.opsSummary?.stats24h ?? {
      completed: 0,
      failed: 0,
      successRate: null,
      avgDurationMs: null,
    },
  };
}
export const NEWS_SOURCE_CREATE_INITIAL_VALUES: Partial<NewsSourceFormValues> = {
  siteType: "general",
  workflowBindingMode: "published",
  frequencySeconds: 3600,
  priority: 0,
  isActive: true,
  scheduleMode: "interval",
  cronExpression: "",
  cronTimezone: "",
  forceRefresh: false,
  seedEnabled: false,
  seedMode: "sitemap",
  seedDomain: "",
  seedPattern: "",
  seedFeedUrl: "",
  seedRssAdaptiveEnabled: DEFAULT_SEED_FORM_VALUES.seedRssAdaptiveEnabled,
  seedRssAdvancedEnabled: DEFAULT_SEED_FORM_VALUES.seedRssAdvancedEnabled,
  seedRssRequestTimeoutMs: DEFAULT_SEED_FORM_VALUES.seedRssRequestTimeoutMs,
  seedRssBodySourceStrategy: DEFAULT_SEED_FORM_VALUES.seedRssBodySourceStrategy,
  seedRssNoBodyPolicy: DEFAULT_SEED_FORM_VALUES.seedRssNoBodyPolicy,
  seedQuery: "",
  crawlScanMode: "default",
  crawlScrollDelayMs: undefined,
  crawlVirtualScrollContainerSelector: "",
  crawlVirtualScrollScrollCount: 10,
  crawlVirtualScrollScrollBy: "page_height",
  crawlVirtualScrollScrollByPixels: 500,
  crawlVirtualScrollWaitAfterScrollMs: 600,
  crawlQualityProfile: undefined,
  crawlPageTypeHint: undefined,
  crawlAutoExpandDetails: false,
  crawlDetailMaxUrls: 8,
  crawlDetailMinRelevanceScore: 0.2,
  crawlDetailRequireSameDomain: true,
  crawlDetailAllowExternalLinks: true,
  crawlDetailMinPublishTimeConfidence: 0.55,
  crawlDetailPreferFitMarkdownForQuality: true,
  crawlDetailIncludeUrlPatterns: [],
  crawlDetailExcludeUrlPatterns: [],
  crawlMarkdownContentSource: "cleaned_html",
  crawlMarkdownEscapeHtmlMode: "auto",
  crawlMarkdownCitationsMode: "auto",
  ...buildNewsSourceCloudflarePresetValues(),
  crawlAntiBotMode: "auto",
  seedMaxUrls: DEFAULT_SEED_FORM_VALUES.seedMaxUrls,
  seedMaxNewUrlsPerRun: DEFAULT_SEED_FORM_VALUES.seedMaxNewUrlsPerRun,
  seedScoreThreshold: DEFAULT_SEED_FORM_VALUES.seedScoreThreshold,
  seedDedupeWindowHours: DEFAULT_SEED_FORM_VALUES.seedDedupeWindowHours,
  seedCacheTtlSeconds: DEFAULT_SEED_FORM_VALUES.seedCacheTtlSeconds,
  seedConcurrency: DEFAULT_SEED_FORM_VALUES.seedConcurrency,
  seedListMaxPages: DEFAULT_SEED_FORM_VALUES.seedListMaxPages,
  seedListPageConcurrency: DEFAULT_SEED_FORM_VALUES.seedListPageConcurrency,
  seedFollowPagination: DEFAULT_SEED_FORM_VALUES.seedFollowPagination,
  seedDeepMaxPages: DEFAULT_SEED_FORM_VALUES.seedDeepMaxPages,
  seedDeepMaxDepth: DEFAULT_SEED_FORM_VALUES.seedDeepMaxDepth,
  seedDeepTimeBudgetSeconds: DEFAULT_SEED_FORM_VALUES.seedDeepTimeBudgetSeconds,
  seedDeepPageConcurrency: DEFAULT_SEED_FORM_VALUES.seedDeepPageConcurrency,
  seedDeepScoreThreshold: DEFAULT_SEED_FORM_VALUES.seedDeepScoreThreshold,
  seedDeepCandidatePoolSize: DEFAULT_SEED_FORM_VALUES.seedDeepCandidatePoolSize,
  seedDeepHeadFetchTopK: DEFAULT_SEED_FORM_VALUES.seedDeepHeadFetchTopK,
  seedDeepPreferPathDate: DEFAULT_SEED_FORM_VALUES.seedDeepPreferPathDate,
  seedDeepEnableSecondaryHubs:
    DEFAULT_SEED_FORM_VALUES.seedDeepEnableSecondaryHubs,
  seedDeepIgnoreRobotsTxt: DEFAULT_SEED_FORM_VALUES.seedDeepIgnoreRobotsTxt,
  seedQueryParamAllowlist: DEFAULT_SEED_FORM_VALUES.seedQueryParamAllowlist,
};

export const parseStringList = (value?: string) =>
  (value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const formatStringList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string").join("\n")
    : "";

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
) {
  const resolvedLimit = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: resolvedLimit }).map(async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index] as T);
      }
    }),
  );

  return results;
}

export const extractApiErrorMessage = (error: unknown) => {
  if (!axios.isAxiosError(error)) {
    return null;
  }

  const payload = error.response?.data as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const rawMessage = (payload as { message?: unknown }).message;
  const rawDetail = (payload as { detail?: unknown }).detail;

  const parts: string[] = [];
  if (typeof rawMessage === "string" && rawMessage.trim().length > 0) {
    parts.push(rawMessage.trim());
  } else if (Array.isArray(rawMessage)) {
    parts.push(
      ...rawMessage
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
        .map((entry) => entry.trim()),
    );
  }
  if (typeof rawDetail === "string" && rawDetail.trim().length > 0) {
    parts.push(rawDetail.trim());
  }

  return parts.length > 0 ? parts.join("\n") : null;
};

export const parseJsonField = (value: string | undefined, label: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : `${label} must be a valid JSON object`,
    );
  }
};

export const inferSourceNameFromUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return parsed.hostname || trimmed;
  } catch {
    return trimmed;
  }
};

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const DISALLOWED_CRAWL4AI_LLM_NORMALIZED_KEYS = new Set([
  "extractionstrategy",
  "llmconfig",
]);

export const normalizeLooseKey = (key: string) =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

export const findDisallowedCrawl4aiLlmKeys = (
  value: unknown,
  prefix = "",
  seen = new Set<unknown>(),
): string[] => {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findDisallowedCrawl4aiLlmKeys(entry, `${prefix}[${index}]`, seen),
    );
  }

  const record = value as Record<string, unknown>;
  const hits: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    const normalized = normalizeLooseKey(key);
    const path = prefix ? `${prefix}.${key}` : key;
    if (DISALLOWED_CRAWL4AI_LLM_NORMALIZED_KEYS.has(normalized)) {
      hits.push(path);
    }
    if (isPlainObject(entry) || Array.isArray(entry)) {
      hits.push(...findDisallowedCrawl4aiLlmKeys(entry, path, seen));
    }
  }

  return hits;
};

export const formatPolicyIssues = (
  issues: CrawlConfigPolicyIssue[],
  t: ReturnType<typeof useTranslation>["t"],
) =>
  issues
    .map(
      (issue) =>
        `${issue.path}: ${t(getCrawlConfigPolicyIssueTranslationKey(issue.code), {
          defaultValue: issue.code,
        })}`,
    )
    .join(", ");

export const hasSeedConfig = (
  config: unknown,
): config is Record<string, unknown> & { seed: Record<string, unknown> } => {
  if (!isPlainObject(config)) {
    return false;
  }
  return isPlainObject((config as Record<string, unknown>).seed);
};

export const getSeedMode = (
  config: unknown,
): "sitemap" | "rss" | "list" | "deep" | null => {
  if (!hasSeedConfig(config) || config.seed.enabled !== true) {
    return null;
  }
  const rawMode =
    typeof config.seed.mode === "string"
      ? config.seed.mode.trim().toLowerCase()
      : "";
  if (rawMode === "rss") {
    return "rss";
  }
  if (rawMode === "list") {
    return "list";
  }
  if (rawMode === "deep") {
    return "deep";
  }
  return "sitemap";
};

export const resolveScheduleDeliveryMode = (
  targets: Pick<NewsSourceRecord, "config">[],
): "crawl4ai" | "rss" | "mixed" => {
  let hasRss = false;
  let hasCrawl4ai = false;

  for (const target of targets) {
    if (getSeedMode(target.config) === "rss") {
      hasRss = true;
    } else {
      hasCrawl4ai = true;
    }
    if (hasRss && hasCrawl4ai) {
      return "mixed";
    }
  }

  return hasRss ? "rss" : "crawl4ai";
};
export const getCrawlStrategyTags = (
  config: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): CrawlStrategyTagDescriptor[] => {
  if (getSeedMode(config) === "rss") {
    return [];
  }
  if (!isPlainObject(config) || !isPlainObject(config.crawlOptions)) {
    return [];
  }
  const crawlOptions = config.crawlOptions as Record<string, unknown>;
  const tags: CrawlStrategyTagDescriptor[] = [];

  const hasVirtualScroll =
    crawlOptions.virtualScroll &&
    typeof crawlOptions.virtualScroll === "object" &&
    !Array.isArray(crawlOptions.virtualScroll);
  if (hasVirtualScroll) {
    tags.push({
      key: "scanMode",
      color: "cyan",
      label: t("newsSources.scanMode.virtualScroll"),
    });
  } else if (crawlOptions.scanFullPage === true) {
    tags.push({
      key: "scanMode",
      color: "blue",
      label: t("newsSources.scanMode.fullPage"),
    });
  }

  const qualityProfile =
    typeof crawlOptions.qualityProfile === "string"
      ? crawlOptions.qualityProfile.trim().toLowerCase()
      : "";
  if (qualityProfile === "quality_first") {
    tags.push({
      key: "qualityProfile",
      color: "purple",
      label: t("crawl.settings.qualityProfileOptions.qualityFirst"),
    });
  } else if (qualityProfile === "balanced") {
    tags.push({
      key: "qualityProfile",
      color: "purple",
      label: t("crawl.settings.qualityProfileOptions.balanced"),
    });
  } else if (qualityProfile === "speed_first") {
    tags.push({
      key: "qualityProfile",
      color: "purple",
      label: t("crawl.settings.qualityProfileOptions.speedFirst"),
    });
  }

  const pageTypeHint =
    typeof crawlOptions.pageTypeHint === "string"
      ? crawlOptions.pageTypeHint.trim().toLowerCase()
      : "";
  if (pageTypeHint === "list") {
    tags.push({
      key: "pageTypeHint",
      color: "magenta",
      label: t("crawl.settings.pageTypeHintOptions.list"),
    });
  } else if (pageTypeHint === "detail") {
    tags.push({
      key: "pageTypeHint",
      color: "magenta",
      label: t("crawl.settings.pageTypeHintOptions.detail"),
    });
  }

  if (crawlOptions.autoExpandDetails === true) {
    tags.push({
      key: "autoExpandDetails",
      color: "green",
      label: t("crawl.settings.autoExpandDetails"),
    });
  }

  const antiBotMode =
    typeof crawlOptions.antiBotMode === "string"
      ? crawlOptions.antiBotMode.trim().toLowerCase()
      : "";
  if (antiBotMode === "enabled") {
    tags.push({
      key: "antiBotMode",
      color: "volcano",
      label: t("newsSources.tags.antiBotEnabled"),
    });
  } else if (antiBotMode === "disabled") {
    tags.push({
      key: "antiBotMode",
      color: "default",
      label: t("newsSources.tags.antiBotDisabled"),
    });
  }

  const markdownOptions =
    crawlOptions.markdownOptions &&
    typeof crawlOptions.markdownOptions === "object" &&
    !Array.isArray(crawlOptions.markdownOptions)
      ? (crawlOptions.markdownOptions as Record<string, unknown>)
      : null;
  if (markdownOptions?.contentSource === "cleaned_html") {
    tags.push({
      key: "ragReady",
      color: "geekblue",
      label: t("crawl.markdown.ragReadyTitle"),
    });
  }

  return tags;
};

export const pipelineJobStatusColors: Record<string, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  delayed: "orange",
  completed: "green",
  failed: "red",
};

export const crawlTaskStatusColors: Record<string, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple",
};
export const LIVE_EVENT_SOURCES: LiveEventSource[] = [
  "pipeline",
  "crawl",
  "analysis",
  "assistant",
  "alerts",
];
export const LIVE_EVENT_SOURCE_SET = new Set<LiveEventSource>(LIVE_EVENT_SOURCES);

export const createEmptyLiveEventCounts = (): Record<LiveEventSource, number> => ({
  pipeline: 0,
  crawl: 0,
  analysis: 0,
  assistant: 0,
  alerts: 0,
});

export const createDefaultLiveRefreshSources = (): Record<
  LiveEventSource,
  boolean
> => ({
  pipeline: true,
  crawl: true,
  analysis: false,
  assistant: false,
  alerts: false,
});

export const CRAWL_QUALITY_ALERT_RATE_THRESHOLD = 0.15;
export const DEFAULT_CRAWL_QUALITY_LOW_304_HIT_RATE_THRESHOLD = 0.05;
export const DEFAULT_CRAWL_QUALITY_HIGH_ORG_HASH_DEDUPE_RATE_THRESHOLD = 0.3;
export const DEFAULT_CRAWL_QUALITY_PREFLIGHT_FAILURE_RATE_THRESHOLD = 0.15;
export const normalizeRateValue = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
export const normalizeCountValue = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export const getSampleCount = (
  sampleCounts: CrawlQualitySampleCounts | undefined,
  key: CrawlQualitySampleMetric,
): number => normalizeCountValue(sampleCounts?.[key]);

export function buildNewsSourceFormValues(
  source: NewsSourceRecord,
  resolvedSeedRuntimeSettings: SeedSchedulerRuntimeSettings,
): Partial<NewsSourceFormValues> {
  const config =
    source.config &&
    typeof source.config === "object" &&
    !Array.isArray(source.config)
      ? (source.config as Record<string, unknown>)
      : null;
  const scheduleConfig =
    config?.schedule &&
    typeof config.schedule === "object" &&
    !Array.isArray(config.schedule)
      ? (config.schedule as Record<string, unknown>)
      : null;
  const scheduleMode = scheduleConfig?.mode === "cron" ? "cron" : "interval";
  const cronConfig =
    scheduleConfig?.cron &&
    typeof scheduleConfig.cron === "object" &&
    !Array.isArray(scheduleConfig.cron)
      ? (scheduleConfig.cron as Record<string, unknown>)
      : null;
  const cronExpression =
    typeof cronConfig?.expression === "string" ? cronConfig.expression : "";
  const cronTimezone =
    typeof cronConfig?.timezone === "string" ? cronConfig.timezone : "";
  const cronWindow =
    scheduleConfig?.window &&
    typeof scheduleConfig.window === "object" &&
    !Array.isArray(scheduleConfig.window)
      ? (scheduleConfig.window as Record<string, unknown>)
      : null;
  const cronWindowDaysOfWeek = Array.isArray(cronWindow?.daysOfWeek)
    ? (cronWindow.daysOfWeek as unknown[])
        .filter(
          (entry): entry is number =>
            typeof entry === "number" && Number.isFinite(entry),
        )
        .map((value) => Math.floor(value))
        .filter((value) => value >= 0 && value <= 6)
    : undefined;
  const cronWindowStartHour =
    typeof cronWindow?.startHour === "number" &&
    Number.isFinite(cronWindow.startHour)
      ? cronWindow.startHour
      : undefined;
  const cronWindowEndHour =
    typeof cronWindow?.endHour === "number" &&
    Number.isFinite(cronWindow.endHour)
      ? cronWindow.endHour
      : undefined;
  const seedConfig =
    config?.seed &&
    typeof config.seed === "object" &&
    !Array.isArray(config.seed)
      ? (config.seed as Record<string, unknown>)
      : null;
  const seedFormValues = readSeedFormValuesFromConfig(
    config,
    resolvedSeedRuntimeSettings,
  );
  const seedMode = normalizeSeedMode(seedConfig?.mode);
  const crawlOptionsConfig =
    config?.crawlOptions &&
    typeof config.crawlOptions === "object" &&
    !Array.isArray(config.crawlOptions)
      ? (config.crawlOptions as Record<string, unknown>)
      : null;
  const crawlHeadlessMode =
    typeof crawlOptionsConfig?.headless === "boolean"
      ? crawlOptionsConfig.headless
        ? "headless"
        : "headed"
      : "auto";
  const crawlUndetectedMode =
    typeof crawlOptionsConfig?.enableUndetectedBrowser === "boolean"
      ? crawlOptionsConfig.enableUndetectedBrowser
        ? "enable"
        : "disable"
      : "auto";
  const crawlStealthMode =
    typeof crawlOptionsConfig?.enableStealthMode === "boolean"
      ? crawlOptionsConfig.enableStealthMode
        ? "enable"
        : "disable"
      : "auto";
  const crawlAntiBotModeRaw =
    typeof crawlOptionsConfig?.antiBotMode === "string"
      ? crawlOptionsConfig.antiBotMode.trim().toLowerCase()
      : "";
  const crawlAntiBotMode =
    crawlAntiBotModeRaw === "enabled"
      ? "enable"
      : crawlAntiBotModeRaw === "disabled"
        ? "disable"
        : "auto";
  const virtualScrollConfig =
    crawlOptionsConfig?.virtualScroll &&
    typeof crawlOptionsConfig.virtualScroll === "object" &&
    !Array.isArray(crawlOptionsConfig.virtualScroll)
      ? (crawlOptionsConfig.virtualScroll as Record<string, unknown>)
      : null;
  const crawlScanMode =
    virtualScrollConfig !== null
      ? "virtual_scroll"
      : crawlOptionsConfig?.scanFullPage === true
        ? "full_page"
        : "default";
  const crawlScrollDelayMs =
    typeof crawlOptionsConfig?.scrollDelayMs === "number" &&
    Number.isFinite(crawlOptionsConfig.scrollDelayMs)
      ? crawlOptionsConfig.scrollDelayMs
      : undefined;
  const crawlVirtualScrollContainerSelector =
    typeof virtualScrollConfig?.containerSelector === "string"
      ? virtualScrollConfig.containerSelector
      : "";
  const crawlVirtualScrollScrollCount =
    typeof virtualScrollConfig?.scrollCount === "number" &&
    Number.isFinite(virtualScrollConfig.scrollCount)
      ? virtualScrollConfig.scrollCount
      : 10;
  const crawlVirtualScrollScrollBy =
    virtualScrollConfig?.scrollBy === "container_height" ||
    virtualScrollConfig?.scrollBy === "page_height" ||
    virtualScrollConfig?.scrollBy === "pixels"
      ? (virtualScrollConfig.scrollBy as
          | "container_height"
          | "page_height"
          | "pixels")
      : "page_height";
  const crawlVirtualScrollScrollByPixels =
    typeof virtualScrollConfig?.scrollByPixels === "number" &&
    Number.isFinite(virtualScrollConfig.scrollByPixels)
      ? virtualScrollConfig.scrollByPixels
      : 500;
  const crawlVirtualScrollWaitAfterScrollMs =
    typeof virtualScrollConfig?.waitAfterScrollMs === "number" &&
    Number.isFinite(virtualScrollConfig.waitAfterScrollMs)
      ? virtualScrollConfig.waitAfterScrollMs
      : 600;
  const crawlQualityProfileRaw =
    typeof crawlOptionsConfig?.qualityProfile === "string"
      ? crawlOptionsConfig.qualityProfile.trim().toLowerCase()
      : "";
  const crawlQualityProfile =
    crawlQualityProfileRaw === "quality_first" ||
    crawlQualityProfileRaw === "balanced" ||
    crawlQualityProfileRaw === "speed_first"
      ? (crawlQualityProfileRaw as
          | "quality_first"
          | "balanced"
          | "speed_first")
      : undefined;
  const crawlPageTypeHintRaw =
    typeof crawlOptionsConfig?.pageTypeHint === "string"
      ? crawlOptionsConfig.pageTypeHint.trim().toLowerCase()
      : "";
  const crawlPageTypeHint =
    crawlPageTypeHintRaw === "auto" ||
    crawlPageTypeHintRaw === "list" ||
    crawlPageTypeHintRaw === "detail"
      ? (crawlPageTypeHintRaw as "auto" | "list" | "detail")
      : undefined;
  const detailExpansionConfig =
    crawlOptionsConfig?.detailExpansion &&
    typeof crawlOptionsConfig.detailExpansion === "object" &&
    !Array.isArray(crawlOptionsConfig.detailExpansion)
      ? (crawlOptionsConfig.detailExpansion as Record<string, unknown>)
      : null;
  const crawlAutoExpandDetails =
    crawlOptionsConfig?.autoExpandDetails === true;
  const crawlDetailMaxUrls =
    typeof detailExpansionConfig?.maxDetailUrls === "number" &&
    Number.isFinite(detailExpansionConfig.maxDetailUrls)
      ? detailExpansionConfig.maxDetailUrls
      : 8;
  const crawlDetailMinRelevanceScore =
    typeof detailExpansionConfig?.minRelevanceScore === "number" &&
    Number.isFinite(detailExpansionConfig.minRelevanceScore)
      ? Number(
          Math.max(
            0,
            Math.min(1, detailExpansionConfig.minRelevanceScore),
          ).toFixed(3),
        )
      : 0.2;
  const crawlDetailRequireSameDomain =
    typeof detailExpansionConfig?.requireSameDomain === "boolean"
      ? detailExpansionConfig.requireSameDomain
      : true;
  const crawlDetailAllowExternalLinks =
    typeof detailExpansionConfig?.allowExternalLinks === "boolean"
      ? detailExpansionConfig.allowExternalLinks
      : true;
  const crawlDetailMinPublishTimeConfidence =
    typeof detailExpansionConfig?.minPublishTimeConfidence === "number" &&
    Number.isFinite(detailExpansionConfig.minPublishTimeConfidence)
      ? Number(
          Math.max(
            0,
            Math.min(1, detailExpansionConfig.minPublishTimeConfidence),
          ).toFixed(3),
        )
      : 0.55;
  const crawlDetailPreferFitMarkdownForQuality =
    typeof detailExpansionConfig?.preferFitMarkdownForQuality === "boolean"
      ? detailExpansionConfig.preferFitMarkdownForQuality
      : true;
  const crawlDetailIncludeUrlPatterns = Array.isArray(
    detailExpansionConfig?.includeUrlPatterns,
  )
    ? detailExpansionConfig.includeUrlPatterns
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 25)
    : [];
  const crawlDetailExcludeUrlPatterns = Array.isArray(
    detailExpansionConfig?.excludeUrlPatterns,
  )
    ? detailExpansionConfig.excludeUrlPatterns
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 25)
    : [];
  const markdownOptionsConfig =
    crawlOptionsConfig?.markdownOptions &&
    typeof crawlOptionsConfig.markdownOptions === "object" &&
    !Array.isArray(crawlOptionsConfig.markdownOptions)
      ? (crawlOptionsConfig.markdownOptions as Record<string, unknown>)
      : null;
  const crawlMarkdownContentSource =
    markdownOptionsConfig?.contentSource === "cleaned_html" ||
    markdownOptionsConfig?.contentSource === "raw_html" ||
    markdownOptionsConfig?.contentSource === "fit_html"
      ? (markdownOptionsConfig.contentSource as
          | "cleaned_html"
          | "raw_html"
          | "fit_html")
      : "cleaned_html";
  const crawlMarkdownEscapeHtmlMode =
    typeof markdownOptionsConfig?.escapeHtml === "boolean"
      ? markdownOptionsConfig.escapeHtml
        ? "enable"
        : "disable"
      : "auto";
  const crawlMarkdownCitationsMode =
    typeof markdownOptionsConfig?.citations === "boolean"
      ? markdownOptionsConfig.citations
        ? "enable"
        : "disable"
      : "auto";

  const nextFormValues: Partial<NewsSourceFormValues> = {
    ...NEWS_SOURCE_CREATE_INITIAL_VALUES,
    name: source.name,
    url: source.url,
    siteType: source.siteType,
    language: source.language ?? "",
    group: source.group ? [source.group] : null,
    crawlTemplateId: source.crawlTemplateId ?? undefined,
    workflowId: source.workflowId ?? undefined,
    workflowVersionId: source.workflowVersionId ?? undefined,
    workflowBindingMode: source.workflowBindingMode ?? "published",
    frequencySeconds: source.frequencySeconds,
    priority: source.priority,
    isActive: source.isActive,
    scheduleMode,
    cronExpression,
    cronTimezone,
    cronWindowDaysOfWeek,
    cronWindowStartHour,
    cronWindowEndHour,
    keywords: formatStringList(config?.keywords),
    tags: formatStringList(config?.tags),
    summaryHints: formatStringList(config?.summaryHints),
    metadataJson: config?.metadata
      ? JSON.stringify(config.metadata, null, 2)
      : "",
    crawlScanMode,
    crawlScrollDelayMs,
    crawlVirtualScrollContainerSelector,
    crawlVirtualScrollScrollCount,
    crawlVirtualScrollScrollBy,
    crawlVirtualScrollScrollByPixels,
    crawlVirtualScrollWaitAfterScrollMs,
    crawlQualityProfile,
    crawlPageTypeHint,
    crawlAutoExpandDetails,
    crawlDetailMaxUrls,
    crawlDetailMinRelevanceScore,
    crawlDetailRequireSameDomain,
    crawlDetailAllowExternalLinks,
    crawlDetailMinPublishTimeConfidence,
    crawlDetailPreferFitMarkdownForQuality,
    crawlDetailIncludeUrlPatterns,
    crawlDetailExcludeUrlPatterns,
    crawlMarkdownContentSource,
    crawlMarkdownEscapeHtmlMode,
    crawlMarkdownCitationsMode,
    crawlOptionsJson: config?.crawlOptions
      ? JSON.stringify(config.crawlOptions, null, 2)
      : "",
    crawlHeadlessMode,
    crawlUndetectedMode,
    crawlStealthMode,
    crawlAntiBotMode,
    forceRefresh: config?.forceRefresh === true,
    seedEnabled: seedConfig?.enabled === true,
    seedMode,
    ...seedFormValues,
  };

  return nextFormValues;
}

export function buildNewsSourceConfig(
  values: NewsSourceFormValues,
  editingSource: NewsSourceRecord | null,
  t: ReturnType<typeof useTranslation>["t"],
): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  const keywords = parseStringList(values.keywords);
  const tags = parseStringList(values.tags);
  const summaryHints = parseStringList(values.summaryHints);
  const activeSeedMode =
    values.seedEnabled === true ? normalizeSeedMode(values.seedMode) : null;
  const isRssSeedMode = activeSeedMode === "rss";
  const existingConfig =
    editingSource?.config &&
    typeof editingSource.config === "object" &&
    !Array.isArray(editingSource.config)
      ? (editingSource.config as Record<string, unknown>)
      : null;
  const existingCrawlOptions =
    existingConfig?.crawlOptions &&
    typeof existingConfig.crawlOptions === "object" &&
    !Array.isArray(existingConfig.crawlOptions)
      ? ({
          ...(existingConfig.crawlOptions as Record<string, unknown>),
        } as Record<string, unknown>)
      : null;
  const existingForceRefresh = existingConfig?.forceRefresh === true;

  if (keywords.length) {
    config.keywords = keywords;
  }
  if (tags.length) {
    config.tags = tags;
  }
  if (summaryHints.length) {
    config.summaryHints = summaryHints;
  }

  const metadata = parseJsonField(values.metadataJson, "metadata");
  if (metadata) {
    config.metadata = metadata;
  }
  const crawlHeadlessMode =
    values.crawlHeadlessMode === "headless"
      ? "headless"
      : values.crawlHeadlessMode === "headed"
        ? "headed"
        : "auto";
  const crawlUndetectedMode =
    values.crawlUndetectedMode === "enable"
      ? "enable"
      : values.crawlUndetectedMode === "disable"
        ? "disable"
        : "auto";
  const crawlStealthMode =
    values.crawlStealthMode === "enable"
      ? "enable"
      : values.crawlStealthMode === "disable"
        ? "disable"
        : "auto";
  const crawlAntiBotMode =
    values.crawlAntiBotMode === "enable"
      ? "enable"
      : values.crawlAntiBotMode === "disable"
        ? "disable"
        : "auto";
  const crawlOptions = parseJsonField(
    values.crawlOptionsJson,
    "crawlOptions",
  );
  let resolvedCrawlOptions = crawlOptions ? { ...crawlOptions } : null;
  if (crawlHeadlessMode === "headless" || crawlHeadlessMode === "headed") {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.headless = crawlHeadlessMode === "headless";
  } else if (
    resolvedCrawlOptions &&
    typeof resolvedCrawlOptions.headless === "boolean"
  ) {
    delete resolvedCrawlOptions.headless;
  }

  if (crawlUndetectedMode === "enable" || crawlUndetectedMode === "disable") {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.enableUndetectedBrowser =
      crawlUndetectedMode === "enable";
  } else if (
    resolvedCrawlOptions &&
    typeof resolvedCrawlOptions.enableUndetectedBrowser === "boolean"
  ) {
    delete resolvedCrawlOptions.enableUndetectedBrowser;
  }

  if (crawlStealthMode === "enable" || crawlStealthMode === "disable") {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.enableStealthMode = crawlStealthMode === "enable";
  } else if (
    resolvedCrawlOptions &&
    typeof resolvedCrawlOptions.enableStealthMode === "boolean"
  ) {
    delete resolvedCrawlOptions.enableStealthMode;
  }

  if (crawlAntiBotMode === "enable" || crawlAntiBotMode === "disable") {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.antiBotMode =
      crawlAntiBotMode === "enable" ? "enabled" : "disabled";
  } else if (
    resolvedCrawlOptions &&
    typeof resolvedCrawlOptions.antiBotMode === "string"
  ) {
    delete resolvedCrawlOptions.antiBotMode;
  }

  const crawlScanMode =
    values.crawlScanMode === "full_page"
      ? "full_page"
      : values.crawlScanMode === "virtual_scroll"
        ? "virtual_scroll"
        : "default";

  if (crawlScanMode === "full_page") {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.scanFullPage = true;
    delete resolvedCrawlOptions.virtualScroll;
    if (
      typeof values.crawlScrollDelayMs === "number" &&
      Number.isFinite(values.crawlScrollDelayMs)
    ) {
      resolvedCrawlOptions.scrollDelayMs = Math.max(
        0,
        Math.min(5000, Math.round(values.crawlScrollDelayMs)),
      );
    } else {
      delete resolvedCrawlOptions.scrollDelayMs;
    }
  } else if (crawlScanMode === "virtual_scroll") {
    const scrollBy =
      values.crawlVirtualScrollScrollBy === "container_height" ||
      values.crawlVirtualScrollScrollBy === "pixels"
        ? values.crawlVirtualScrollScrollBy
        : "page_height";
    const virtualScroll: Record<string, unknown> = {
      containerSelector:
        values.crawlVirtualScrollContainerSelector?.trim() &&
        values.crawlVirtualScrollContainerSelector.trim().length > 0
          ? values.crawlVirtualScrollContainerSelector.trim()
          : "body",
      scrollCount:
        typeof values.crawlVirtualScrollScrollCount === "number" &&
        Number.isFinite(values.crawlVirtualScrollScrollCount)
          ? Math.max(
              1,
              Math.min(
                1000,
                Math.round(values.crawlVirtualScrollScrollCount),
              ),
            )
          : 10,
      scrollBy,
      waitAfterScrollMs:
        typeof values.crawlVirtualScrollWaitAfterScrollMs === "number" &&
        Number.isFinite(values.crawlVirtualScrollWaitAfterScrollMs)
          ? Math.max(
              0,
              Math.min(
                60000,
                Math.round(values.crawlVirtualScrollWaitAfterScrollMs),
              ),
            )
          : 600,
    };
    if (scrollBy === "pixels") {
      virtualScroll.scrollByPixels =
        typeof values.crawlVirtualScrollScrollByPixels === "number" &&
        Number.isFinite(values.crawlVirtualScrollScrollByPixels)
          ? Math.max(
              1,
              Math.min(
                20000,
                Math.round(values.crawlVirtualScrollScrollByPixels),
              ),
            )
          : 500;
    }
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.scanFullPage = false;
    resolvedCrawlOptions.virtualScroll = virtualScroll;
    delete resolvedCrawlOptions.scrollDelayMs;
  } else if (resolvedCrawlOptions) {
    delete resolvedCrawlOptions.scanFullPage;
    delete resolvedCrawlOptions.scrollDelayMs;
    delete resolvedCrawlOptions.virtualScroll;
  }

  if (
    values.crawlQualityProfile === "quality_first" ||
    values.crawlQualityProfile === "balanced" ||
    values.crawlQualityProfile === "speed_first"
  ) {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.qualityProfile = values.crawlQualityProfile;
  } else if (
    resolvedCrawlOptions &&
    typeof resolvedCrawlOptions.qualityProfile === "string"
  ) {
    delete resolvedCrawlOptions.qualityProfile;
  }

  if (
    values.crawlPageTypeHint === "auto" ||
    values.crawlPageTypeHint === "list" ||
    values.crawlPageTypeHint === "detail"
  ) {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.pageTypeHint = values.crawlPageTypeHint;
  } else if (
    resolvedCrawlOptions &&
    typeof resolvedCrawlOptions.pageTypeHint === "string"
  ) {
    delete resolvedCrawlOptions.pageTypeHint;
  }

  if (values.crawlAutoExpandDetails) {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    resolvedCrawlOptions.autoExpandDetails = true;
    const detailExpansion: Record<string, unknown> = {};
    if (
      typeof values.crawlDetailMaxUrls === "number" &&
      Number.isFinite(values.crawlDetailMaxUrls)
    ) {
      detailExpansion.maxDetailUrls = Math.max(
        1,
        Math.min(30, Math.round(values.crawlDetailMaxUrls)),
      );
    }
    if (
      typeof values.crawlDetailMinRelevanceScore === "number" &&
      Number.isFinite(values.crawlDetailMinRelevanceScore)
    ) {
      detailExpansion.minRelevanceScore = Number(
        Math.max(0, Math.min(1, values.crawlDetailMinRelevanceScore)).toFixed(
          3,
        ),
      );
    }
    if (typeof values.crawlDetailRequireSameDomain === "boolean") {
      detailExpansion.requireSameDomain = values.crawlDetailRequireSameDomain;
    }
    if (typeof values.crawlDetailAllowExternalLinks === "boolean") {
      detailExpansion.allowExternalLinks =
        values.crawlDetailAllowExternalLinks;
    }
    if (
      typeof values.crawlDetailMinPublishTimeConfidence === "number" &&
      Number.isFinite(values.crawlDetailMinPublishTimeConfidence)
    ) {
      detailExpansion.minPublishTimeConfidence = Number(
        Math.max(
          0,
          Math.min(1, values.crawlDetailMinPublishTimeConfidence),
        ).toFixed(3),
      );
    }
    if (typeof values.crawlDetailPreferFitMarkdownForQuality === "boolean") {
      detailExpansion.preferFitMarkdownForQuality =
        values.crawlDetailPreferFitMarkdownForQuality;
    }
    const includeUrlPatterns = Array.isArray(
      values.crawlDetailIncludeUrlPatterns,
    )
      ? values.crawlDetailIncludeUrlPatterns
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
          .slice(0, 25)
      : [];
    if (includeUrlPatterns.length > 0) {
      detailExpansion.includeUrlPatterns = includeUrlPatterns;
    }
    const excludeUrlPatterns = Array.isArray(
      values.crawlDetailExcludeUrlPatterns,
    )
      ? values.crawlDetailExcludeUrlPatterns
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
          .slice(0, 25)
      : [];
    if (excludeUrlPatterns.length > 0) {
      detailExpansion.excludeUrlPatterns = excludeUrlPatterns;
    }
    if (Object.keys(detailExpansion).length > 0) {
      resolvedCrawlOptions.detailExpansion = detailExpansion;
    } else {
      delete resolvedCrawlOptions.detailExpansion;
    }
  } else if (resolvedCrawlOptions) {
    delete resolvedCrawlOptions.autoExpandDetails;
    delete resolvedCrawlOptions.detailExpansion;
  }

  if (
    values.crawlMarkdownContentSource === "cleaned_html" ||
    values.crawlMarkdownContentSource === "raw_html" ||
    values.crawlMarkdownContentSource === "fit_html"
  ) {
    resolvedCrawlOptions = resolvedCrawlOptions ?? {};
    const markdownOptions =
      typeof resolvedCrawlOptions.markdownOptions === "object" &&
      resolvedCrawlOptions.markdownOptions &&
      !Array.isArray(resolvedCrawlOptions.markdownOptions)
        ? {
            ...(resolvedCrawlOptions.markdownOptions as Record<
              string,
              unknown
            >),
          }
        : {};
    markdownOptions.contentSource = values.crawlMarkdownContentSource;

    if (values.crawlMarkdownEscapeHtmlMode === "enable") {
      markdownOptions.escapeHtml = true;
    } else if (values.crawlMarkdownEscapeHtmlMode === "disable") {
      markdownOptions.escapeHtml = false;
    } else {
      delete markdownOptions.escapeHtml;
    }

    if (values.crawlMarkdownCitationsMode === "enable") {
      markdownOptions.citations = true;
    } else if (values.crawlMarkdownCitationsMode === "disable") {
      markdownOptions.citations = false;
    } else {
      delete markdownOptions.citations;
    }

    if (Object.keys(markdownOptions).length > 0) {
      resolvedCrawlOptions.markdownOptions = markdownOptions;
    } else {
      delete resolvedCrawlOptions.markdownOptions;
    }
  }

  if (resolvedCrawlOptions) {
    const proxyIssues = findUnsupportedProxyIssues(
      resolvedCrawlOptions,
      "config.crawlOptions",
    );
    if (proxyIssues.length > 0) {
      throw new Error(formatPolicyIssues(proxyIssues, t));
    }
    const blockedKeys = findDisallowedCrawl4aiLlmKeys(resolvedCrawlOptions);
    if (blockedKeys.length > 0) {
      const list = blockedKeys.slice(0, 5).join(", ");
      const suffix =
        blockedKeys.length > 5 ? ` (+${blockedKeys.length - 5} more)` : "";
      throw new Error(
        t("newsSources.errors.crawlOptionsLlmBlocked", {
          keys: list,
          suffix,
        }),
      );
    }
  }
  const finalCrawlOptions = isRssSeedMode
    ? existingCrawlOptions
    : resolvedCrawlOptions;
  if (finalCrawlOptions) {
    const proxyIssues = findUnsupportedProxyIssues(
      finalCrawlOptions,
      "config.crawlOptions",
    );
    if (proxyIssues.length > 0) {
      throw new Error(formatPolicyIssues(proxyIssues, t));
    }
  }
  if (isRssSeedMode) {
    if (
      existingCrawlOptions &&
      Object.keys(existingCrawlOptions).length > 0
    ) {
      config.crawlOptions = existingCrawlOptions;
    }
    if (existingForceRefresh) {
      config.forceRefresh = true;
    }
  } else {
    if (
      resolvedCrawlOptions &&
      Object.keys(resolvedCrawlOptions).length > 0
    ) {
      config.crawlOptions = resolvedCrawlOptions;
    }
    if (values.forceRefresh) {
      config.forceRefresh = true;
    }
  }

  const scheduleMode = values.scheduleMode === "cron" ? "cron" : "interval";
  if (scheduleMode === "cron") {
    const expression = values.cronExpression?.trim() ?? "";
    if (expression) {
      const schedule: Record<string, unknown> = {
        mode: "cron",
        cron: {
          expression,
        },
      };

      const timezone = values.cronTimezone?.trim();
      if (timezone) {
        (schedule.cron as Record<string, unknown>).timezone = timezone;
      }

      const window: Record<string, unknown> = {};
      const daysOfWeek = Array.isArray(values.cronWindowDaysOfWeek)
        ? values.cronWindowDaysOfWeek
        : [];
      const normalizedDays = daysOfWeek
        .filter(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
        .map((value) => Math.floor(value))
        .filter((value) => value >= 0 && value <= 6);
      if (normalizedDays.length > 0) {
        window.daysOfWeek = Array.from(new Set(normalizedDays));
      }

      if (
        typeof values.cronWindowStartHour === "number" &&
        Number.isFinite(values.cronWindowStartHour)
      ) {
        window.startHour = Math.max(
          0,
          Math.min(23, Math.floor(values.cronWindowStartHour)),
        );
      }
      if (
        typeof values.cronWindowEndHour === "number" &&
        Number.isFinite(values.cronWindowEndHour)
      ) {
        window.endHour = Math.max(
          1,
          Math.min(24, Math.floor(values.cronWindowEndHour)),
        );
      }
      if (Object.keys(window).length > 0) {
        schedule.window = window;
      }

      config.schedule = schedule;
    }
  }

  const configWithSeed = buildSeedConfigFromFormValues(values, config);
  if (configWithSeed) {
    Object.assign(config, configWithSeed);
  }

  return Object.keys(config).length ? config : null;
}

export const getNewsSourceSiteTypeOptions = (
  t: (key: string, options?: Record<string, unknown>) => string,
) => [
  {
    value: "general",
    label: t("newsSources.types.general"),
  },
  {
    value: "finance",
    label: t("newsSources.types.finance"),
  },
  {
    value: "technology",
    label: t("newsSources.types.technology"),
  },
  {
    value: "politics",
    label: t("newsSources.types.politics"),
  },
  {
    value: "regulatory",
    label: t("newsSources.types.regulatory"),
  },
  {
    value: "other",
    label: t("newsSources.types.other"),
  },
];

export const resolveCrawlQualityThresholds = (
  crawlQualityStats: Crawl4aiQualitySnapshot | null,
): CrawlQualityThresholds => {
  const preflightFailureRateHigh =
    typeof crawlQualityStats?.alertThresholds?.preflightFailureRateHigh ===
      "number" &&
    Number.isFinite(
      crawlQualityStats.alertThresholds.preflightFailureRateHigh,
    )
      ? Math.max(
          0,
          crawlQualityStats.alertThresholds.preflightFailureRateHigh,
        )
      : DEFAULT_CRAWL_QUALITY_PREFLIGHT_FAILURE_RATE_THRESHOLD;
  const http304HitRateLow =
    typeof crawlQualityStats?.alertThresholds?.http304HitRateLow ===
      "number" &&
    Number.isFinite(crawlQualityStats.alertThresholds.http304HitRateLow)
      ? Math.max(0, crawlQualityStats.alertThresholds.http304HitRateLow)
      : DEFAULT_CRAWL_QUALITY_LOW_304_HIT_RATE_THRESHOLD;
  const orgHashDedupeHitRateHigh =
    typeof crawlQualityStats?.alertThresholds?.orgHashDedupeHitRateHigh ===
      "number" &&
    Number.isFinite(
      crawlQualityStats.alertThresholds.orgHashDedupeHitRateHigh,
    )
      ? Math.max(
          0,
          crawlQualityStats.alertThresholds.orgHashDedupeHitRateHigh,
        )
      : DEFAULT_CRAWL_QUALITY_HIGH_ORG_HASH_DEDUPE_RATE_THRESHOLD;

  return {
    preflightFailureRateHigh,
    http304HitRateLow,
    orgHashDedupeHitRateHigh,
  };

};

export const resolveCrawlQualityThresholdStatus = (
  crawlQualityStats: Crawl4aiQualitySnapshot | null,
  crawlQualityThresholds: CrawlQualityThresholds,
): CrawlQualityThresholdStatus | null => {
  if (!crawlQualityStats) {
    return null;
  }
  const preflightFailureRate = normalizeRateValue(
    crawlQualityStats.preflightFailureRate,
  );
  const http304HitRate = normalizeRateValue(crawlQualityStats.http304HitRate);
  const orgHashDedupeHitRate = normalizeRateValue(
    crawlQualityStats.orgHashDedupeHitRate,
  );
  const preflightRunCount = getSampleCount(
    crawlQualityStats.sampleCounts,
    "preflightRunCount",
  );
  const dedupeEvaluatedCount = getSampleCount(
    crawlQualityStats.sampleCounts,
    "dedupeEvaluatedCount",
  );

  return {
    preflightFailureRate,
    http304HitRate,
    orgHashDedupeHitRate,
    preflightRunCount,
    dedupeEvaluatedCount,
    preflightFailureBreached:
      preflightRunCount > 0 &&
      preflightFailureRate >= crawlQualityThresholds.preflightFailureRateHigh,
    http304Breached:
      preflightRunCount > 0 &&
      http304HitRate <= crawlQualityThresholds.http304HitRateLow,
    orgHashDedupeBreached:
      dedupeEvaluatedCount > 0 &&
      orgHashDedupeHitRate >= crawlQualityThresholds.orgHashDedupeHitRateHigh,
  };

};

export const resolveCrawlQualityRateAlerts = (
  crawlQualityStats: Crawl4aiQualitySnapshot | null,
  crawlQualityThresholds: CrawlQualityThresholds,
): CrawlQualityRateAlert[] => {
  if (!crawlQualityStats) {
    return [];
  }
  const grouped = Array.isArray(crawlQualityStats.groupedBySource)
    ? crawlQualityStats.groupedBySource
    : [];
  const resolveExtremeSource = (
    selector: (entry: Crawl4aiQualitySourceMetric) => number | undefined,
    direction: "high" | "low",
    sampleSelector?: (entry: Crawl4aiQualitySourceMetric) => number,
  ) => {
    let best: { sourceId: string; rate: number } | null = null;
    for (const entry of grouped) {
      if (sampleSelector && sampleSelector(entry) <= 0) {
        continue;
      }
      const value = selector(entry);
      const rate =
        typeof value === "number" && Number.isFinite(value)
          ? Math.max(0, value)
          : 0;
      if (
        !best ||
        (direction === "high" ? rate > best.rate : rate < best.rate)
      ) {
        best = { sourceId: entry.sourceId, rate };
      }
    }
    return best;
  };
  const alerts: {
    key:
      | "softFailure"
      | "truncated"
      | "noPublishSignal"
      | "preflightFailure"
      | "http304Low"
      | "orgHashDedupeHigh";
    direction: "high" | "low";
    threshold: number;
    overallRate: number;
    extremeSource?: { sourceId: string; rate: number } | null;
  }[] = [];
  const pushHighAlert = (
    key:
      | "softFailure"
      | "truncated"
      | "noPublishSignal"
      | "preflightFailure"
      | "orgHashDedupeHigh",
    threshold: number,
    rawRate: number | undefined,
    selector: (entry: Crawl4aiQualitySourceMetric) => number | undefined,
    sampleCountRaw?: number,
    sampleSelector?: (entry: Crawl4aiQualitySourceMetric) => number,
  ) => {
    const sampleCount = normalizeCountValue(sampleCountRaw);
    if (sampleCount <= 0) {
      return;
    }
    const overallRate =
      typeof rawRate === "number" && Number.isFinite(rawRate)
        ? Math.max(0, rawRate)
        : 0;
    if (overallRate < threshold) {
      return;
    }
    alerts.push({
      key,
      direction: "high",
      threshold,
      overallRate,
      extremeSource: resolveExtremeSource(selector, "high", sampleSelector),
    });
  };
  const pushLowAlert = (
    key: "http304Low",
    threshold: number,
    rawRate: number | undefined,
    selector: (entry: Crawl4aiQualitySourceMetric) => number | undefined,
    sampleCountRaw?: number,
    sampleSelector?: (entry: Crawl4aiQualitySourceMetric) => number,
  ) => {
    const sampleCount = normalizeCountValue(sampleCountRaw);
    if (sampleCount <= 0) {
      return;
    }
    const overallRate =
      typeof rawRate === "number" && Number.isFinite(rawRate)
        ? Math.max(0, rawRate)
        : 0;
    if (overallRate > threshold) {
      return;
    }
    alerts.push({
      key,
      direction: "low",
      threshold,
      overallRate,
      extremeSource: resolveExtremeSource(selector, "low", sampleSelector),
    });
  };
  pushHighAlert(
    "softFailure",
    CRAWL_QUALITY_ALERT_RATE_THRESHOLD,
    crawlQualityStats.headSignalSoftFailureRate,
    (entry) => entry.headSignalSoftFailureRate,
    getSampleCount(crawlQualityStats.sampleCounts, "headSignalAttemptedCount"),
    (entry) => getSampleCount(entry.sampleCounts, "headSignalAttemptedCount"),
  );
  pushHighAlert(
    "truncated",
    CRAWL_QUALITY_ALERT_RATE_THRESHOLD,
    crawlQualityStats.headSignalTruncatedRate,
    (entry) => entry.headSignalTruncatedRate,
    getSampleCount(crawlQualityStats.sampleCounts, "headSignalAttemptedCount"),
    (entry) => getSampleCount(entry.sampleCounts, "headSignalAttemptedCount"),
  );
  pushHighAlert(
    "noPublishSignal",
    CRAWL_QUALITY_ALERT_RATE_THRESHOLD,
    crawlQualityStats.headSignalNoPublishSignalRate,
    (entry) => entry.headSignalNoPublishSignalRate,
    getSampleCount(crawlQualityStats.sampleCounts, "headSignalAttemptedCount"),
    (entry) => getSampleCount(entry.sampleCounts, "headSignalAttemptedCount"),
  );
  pushHighAlert(
    "preflightFailure",
    crawlQualityThresholds.preflightFailureRateHigh,
    crawlQualityStats.preflightFailureRate,
    (entry) => entry.preflightFailureRate,
    getSampleCount(crawlQualityStats.sampleCounts, "preflightRunCount"),
    (entry) => getSampleCount(entry.sampleCounts, "preflightRunCount"),
  );
  pushHighAlert(
    "orgHashDedupeHigh",
    crawlQualityThresholds.orgHashDedupeHitRateHigh,
    crawlQualityStats.orgHashDedupeHitRate,
    (entry) => entry.orgHashDedupeHitRate,
    getSampleCount(crawlQualityStats.sampleCounts, "dedupeEvaluatedCount"),
    (entry) => getSampleCount(entry.sampleCounts, "dedupeEvaluatedCount"),
  );
  pushLowAlert(
    "http304Low",
    crawlQualityThresholds.http304HitRateLow,
    crawlQualityStats.http304HitRate,
    (entry) => entry.http304HitRate,
    getSampleCount(crawlQualityStats.sampleCounts, "preflightRunCount"),
    (entry) => getSampleCount(entry.sampleCounts, "preflightRunCount"),
  );
  return alerts;

};
