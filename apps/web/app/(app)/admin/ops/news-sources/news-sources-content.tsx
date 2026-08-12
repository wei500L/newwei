"use client";

import { sanitizeCrawlOptions } from "@modular/utils";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Divider,
  Dropdown,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Popover,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import axios from "axios";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import { Crawl4aiHealthCard } from "@/app/(app)/crawl/components/Crawl4aiHealthCard";
import { CreateCrawlTaskDrawer } from "@/app/(app)/crawl/components/CreateCrawlTaskDrawer";
import type { CreateCrawlTaskFormValues } from "@/app/(app)/crawl/types";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { applyAutoBrowserHeadersToCrawlOptions } from "@/lib/crawl-browser-headers";
import {
  findUnsupportedProxyIssues,
  getCrawlConfigPolicyIssueTranslationKey,
  type CrawlConfigPolicyIssue,
} from "@/lib/crawl-config-policy";
import { normalizeHeadlessModeFormValues } from "@/lib/crawl-headless-mode";
import {
  buildNewsSourceCloudflarePresetValues,
  buildNewsSourceReutersCfPresetValues,
} from "@/lib/crawl-presets";
import { env } from "@/lib/env";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { resolveRssAdaptiveListUiModel } from "@/lib/news-source-rss-adaptive-ui";
import { formatRealtimeSocketError } from "@/lib/realtime-socket-errors";
import {
  buildSeedConfigFromFormValues,
  type SeedSchedulerRuntimeSettings,
  DEFAULT_SEED_FORM_VALUES,
  getDefaultSeedCacheTtlSecondsByMode,
  normalizeSeedMode,
  resolveSeedCacheTtlPolicy,
  resolveSeedSchedulerRuntimeSettings,
  readSeedFormValuesFromConfig,
  shouldShowCrawlSettingsForSeedMode,
} from "@/lib/news-source-seed";

interface NewsSourceApiRecord {
  id: string;
  name: string;
  url: string;
  siteType: string;
  language?: string | null;
  crawlTemplateId?: string | null;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  workflowBindingMode?: "published" | "pinned";
  group?: string | null;
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number | null;
  circuitOpenUntil?: string | null;
  nextRunAt?: string | null;
  config?: Record<string, unknown> | null;
  opsSummary?: {
    latestJob?: NewsSourceRecord["latestJob"];
    latestCrawlTask?: NewsSourceRecord["latestCrawlTask"];
    latestArticle?: NewsSourceRecord["latestArticle"];
    stats24h?: NewsSourceRecord["stats24h"];
    runtime?: {
      crawlTaskQueuedCount: number;
      crawlTaskRunningCount: number;
      backpressureUntil?: string | null;
      backpressurePendingJobs?: number | null;
      backpressureThreshold?: number | null;
      backpressureCount24h: number;
      rssAdaptiveState?: unknown;
    };
  };
}

interface NewsSourceListResponse {
  sources: NewsSourceApiRecord[];
  total: number;
  page: number;
  pageSize: number;
}

const REALTIME_SOCKET_TIMEOUT_MS = 10_000;

interface NewsSourceRecord {
  id: string;
  name: string;
  url: string;
  siteType: string;
  language?: string | null;
  crawlTemplateId?: string | null;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  workflowBindingMode?: "published" | "pinned";
  group?: string | null;
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number | null;
  circuitOpenUntil?: string | null;
  nextRunAt?: string | null;
  backpressureUntil?: string | null;
  backpressurePendingJobs?: number | null;
  backpressureThreshold?: number | null;
  rssAdaptiveState?: unknown;
  config?: Record<string, unknown> | null;
  latestJob?: {
    id: string;
    status: string;
    url: string;
    createdAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  latestCrawlTask?: {
    id: string;
    status: string;
    lastError?: string | null;
    lastRunAt?: string | null;
    lastSuccessAt?: string | null;
    lastResultAt?: string | null;
  } | null;
  latestArticle?: {
    id: string;
    url: string;
    crawlAt: string;
    titleGuess?: string | null;
  } | null;
  crawlTaskQueuedCount: number;
  crawlTaskRunningCount: number;
  backpressureCount24h: number;
  stats24h: {
    completed: number;
    failed: number;
    successRate?: number | null;
    avgDurationMs?: number | null;
  };
}

interface NewsSourceReadinessSummary {
  total: number;
  active: number;
  inactive: number;
  circuitOpen: number;
  failing: number;
}

interface CrawlQualitySampleCounts {
  markdownCount: number;
  expansionTriggeredTaskCount: number;
  headSignalAttemptedCount: number;
  preflightRunCount: number;
  dedupeEvaluatedCount: number;
}

interface RefreshAllOptions {
  silent?: boolean;
  includeQueue?: boolean;
  includeQuality?: boolean;
}

function mapNewsSourceRecord(record: NewsSourceApiRecord): NewsSourceRecord {
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

interface CrawlTemplateRecord {
  id: string;
  name: string;
  isActive: boolean;
}

interface NewsSourcePreviewCandidate {
  url: string;
  status: "success" | "failed";
  title?: string;
  description?: string;
  author?: string;
  relevanceScore?: number;
  publishedAt?: string | null;
  crawledAt?: string | null;
  effectiveAt?: string | null;
  timestampSource?: "published" | "crawled" | "none";
  publishDateMissing?: boolean;
  alreadyCrawled: boolean;
  lastCrawlAt?: string | null;
  alreadyQueued?: boolean;
  inFlightStatus?: string | null;
  error?: string;
}

interface NewsSourcePreviewDeepError {
  code: string;
  message: string;
  detail?: string;
}

interface NewsSourcePreviewDeepFailureStats {
  total24h: number;
  streak: number;
  byCode: { code: string; count: number }[];
  lastFailureAt?: string | null;
  lastCode?: string | null;
  lastMessage?: string | null;
  lastDetail?: string | null;
  nextRetryAt?: string | null;
  circuitOpenUntil?: string | null;
}

interface NewsSourcePreviewResponse {
  mode: "single" | "sitemap" | "rss" | "list" | "deep";
  sourceId: string;
  url: string;
  name: string;
  seed?: Record<string, unknown> | null;
  candidates: NewsSourcePreviewCandidate[];
  availableToSchedule?: number;
  inFlightCount?: number;
  inFlightLimit?: number;
  scheduleCount: number;
  skippedCount: number;
  deepPreviewError?: NewsSourcePreviewDeepError;
  deepFailureStats?: NewsSourcePreviewDeepFailureStats | null;
}

interface Crawl4aiQueueStats {
  queueName: string;
  updatedAt: string;
  pending: number;
  counts: Record<string, number>;
  maxConcurrency?: number;
}

interface Crawl4aiQualitySourceMetric {
  sourceId: string;
  taskCount: number;
  sampleCounts?: CrawlQualitySampleCounts;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects?: {
    includePattern: number;
    excludePattern: number;
    publishConfidence: number;
  };
  publishConfidenceBuckets?: {
    lt04: number;
    from04To06: number;
    from06To08: number;
    gte08: number;
  };
  fitMarkdownPreferenceRate?: number;
  headSignalSuccessRate?: number;
  headSignalSoftFailureRate?: number;
  headSignalTruncatedRate?: number;
  headSignalNoPublishSignalRate?: number;
  http304HitRate?: number;
  orgHashDedupeHitRate?: number;
  preflightFailureRate?: number;
}

interface Crawl4aiQualitySnapshot {
  orgId: string;
  from: string;
  to: string;
  taskCount: number;
  sampleCounts?: CrawlQualitySampleCounts;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects?: {
    includePattern: number;
    excludePattern: number;
    publishConfidence: number;
  };
  publishConfidenceBuckets?: {
    lt04: number;
    from04To06: number;
    from06To08: number;
    gte08: number;
  };
  fitMarkdownPreferenceRate?: number;
  headSignalSuccessRate?: number;
  headSignalSoftFailureRate?: number;
  headSignalTruncatedRate?: number;
  headSignalNoPublishSignalRate?: number;
  http304HitRate?: number;
  orgHashDedupeHitRate?: number;
  preflightFailureRate?: number;
  alertThresholds?: {
    preflightFailureRateHigh?: number;
    http304HitRateLow?: number;
    orgHashDedupeHitRateHigh?: number;
  };
  groupedBySource: Crawl4aiQualitySourceMetric[];
}

interface NewsSourceDispatchResponse {
  sourceId: string;
  mode: "single" | "sitemap" | "rss" | "list" | "deep";
  scheduledFor: string;
  nextRunAt: string;
  scheduledCount: number;
  skippedCount: number;
  rssSkippedNoBodyCount?: number;
  enqueueFailures: number;
  pipelineJobIds: string[];
  crawlTaskIds: string[];
  inFlightCount?: number;
  inFlightLimit?: number;
  reason: "ok" | "in_flight" | "no_new_urls" | "deduped";
  dedupeUntil?: string;
}

interface NewsSourceCancelQueuedResponse {
  sourceId: string;
  removedJobs: number;
  scannedJobs: number;
  canceledTaskIds: string[];
}

interface NewsSourceClearInflightResponse {
  sourceId: string;
  cutoff: string;
  clearedJobs: number;
}

interface NewsSourceRetryLatestResponse {
  sourceId: string;
  retryType: "crawl" | "pipeline";
  crawlTaskId?: string;
  pipelineJobId?: string;
  status: string;
  retried: boolean;
}

interface NewsSourceOpmlPresetSummary {
  id: string;
  name: string;
  description: string;
  defaultLanguage: string;
  entryCount: number;
}

interface NewsSourceOpmlPreviewEntry {
  name: string;
  url: string;
  feedUrl: string;
  language: string;
  group?: string | null;
  enabled: boolean;
  valid: boolean;
  alreadyExists: boolean;
  errors: string[];
}

interface NewsSourceOpmlPreviewResponse {
  presetId: string | null;
  title: string | null;
  entries: NewsSourceOpmlPreviewEntry[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
    enabled: number;
  };
}

interface NewsSourceOpmlImportReport {
  summary: {
    total: number;
    enabled: number;
    created: number;
    skipped: number;
    failed: number;
  };
  created: { id: string; name: string; url: string }[];
  skipped: { name: string; url: string; reason: string }[];
  failed: { name: string; url: string; error: string }[];
}

type NewsSourceOpmlMode = "preset" | "upload";

interface NewsSourceScheduleValues {
  nextRunAt: Dayjs;
}

interface NewsSourceSchedulerSettingsResponse
  extends SeedSchedulerRuntimeSettings {
  source?: "default" | "db";
}

interface NewsSourceFormValues {
  name: string;
  url: string;
  siteType: string;
  language?: string;
  group?: string[] | null;
  crawlTemplateId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  workflowBindingMode?: "published" | "pinned";
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  scheduleMode?: "interval" | "cron";
  cronExpression?: string;
  cronTimezone?: string;
  cronWindowDaysOfWeek?: number[];
  cronWindowStartHour?: number;
  cronWindowEndHour?: number;
  keywords?: string;
  tags?: string;
  summaryHints?: string;
  metadataJson?: string;
  crawlScanMode?: "default" | "full_page" | "virtual_scroll";
  crawlScrollDelayMs?: number;
  crawlVirtualScrollContainerSelector?: string;
  crawlVirtualScrollScrollCount?: number;
  crawlVirtualScrollScrollBy?: "page_height" | "container_height" | "pixels";
  crawlVirtualScrollScrollByPixels?: number;
  crawlVirtualScrollWaitAfterScrollMs?: number;
  crawlQualityProfile?: "quality_first" | "balanced" | "speed_first";
  crawlPageTypeHint?: "auto" | "list" | "detail";
  crawlAutoExpandDetails?: boolean;
  crawlDetailMaxUrls?: number;
  crawlDetailMinRelevanceScore?: number;
  crawlDetailRequireSameDomain?: boolean;
  crawlDetailAllowExternalLinks?: boolean;
  crawlDetailMinPublishTimeConfidence?: number;
  crawlDetailPreferFitMarkdownForQuality?: boolean;
  crawlDetailIncludeUrlPatterns?: string[];
  crawlDetailExcludeUrlPatterns?: string[];
  crawlMarkdownContentSource?: "cleaned_html" | "raw_html" | "fit_html";
  crawlMarkdownEscapeHtmlMode?: "auto" | "enable" | "disable";
  crawlMarkdownCitationsMode?: "auto" | "enable" | "disable";
  crawlOptionsJson?: string;
  crawlHeadlessMode?: "auto" | "headless" | "headed";
  crawlUndetectedMode?: "auto" | "enable" | "disable";
  crawlStealthMode?: "auto" | "enable" | "disable";
  crawlAntiBotMode?: "auto" | "enable" | "disable";
  forceRefresh?: boolean;
  seedEnabled?: boolean;
  seedMode?: "sitemap" | "rss" | "list" | "deep";
  seedDomain?: string;
  seedPattern?: string;
  seedFeedUrl?: string;
  seedRssAdaptiveEnabled?: boolean;
  seedRssAdvancedEnabled?: boolean;
  seedRssRequestTimeoutMs?: number;
  seedRssBodySourceStrategy?: "content_first" | "content_only" | "summary_only";
  seedRssNoBodyPolicy?: "skip" | "title_description_stub";
  seedQuery?: string;
  seedMaxUrls?: number;
  seedMaxNewUrlsPerRun?: number;
  seedScoreThreshold?: number;
  seedDedupeWindowHours?: number;
  seedCacheTtlSeconds?: number;
  seedConcurrency?: number;
  seedListMaxPages?: number;
  seedListPageConcurrency?: number;
  seedFollowPagination?: boolean;
  seedDeepMaxPages?: number;
  seedDeepMaxDepth?: number;
  seedDeepTimeBudgetSeconds?: number;
  seedDeepPageConcurrency?: number;
  seedDeepScoreThreshold?: number;
  seedDeepCandidatePoolSize?: number;
  seedDeepHeadFetchTopK?: number;
  seedDeepPreferPathDate?: boolean;
  seedDeepEnableSecondaryHubs?: boolean;
  seedDeepIgnoreRobotsTxt?: boolean;
  seedQueryParamAllowlist?: string[];
}

const NEWS_SOURCE_CREATE_INITIAL_VALUES: Partial<NewsSourceFormValues> = {
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

const parseStringList = (value?: string) =>
  (value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const formatStringList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string").join("\n")
    : "";

async function mapWithConcurrency<T, R>(
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

const extractApiErrorMessage = (error: unknown) => {
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

const parseJsonField = (value: string | undefined, label: string) => {
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

const inferSourceNameFromUrl = (value: string) => {
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const DISALLOWED_CRAWL4AI_LLM_NORMALIZED_KEYS = new Set([
  "extractionstrategy",
  "llmconfig",
]);

const normalizeLooseKey = (key: string) =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

const findDisallowedCrawl4aiLlmKeys = (
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

const formatPolicyIssues = (
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

const hasSeedConfig = (
  config: unknown,
): config is Record<string, unknown> & { seed: Record<string, unknown> } => {
  if (!isPlainObject(config)) {
    return false;
  }
  return isPlainObject((config as Record<string, unknown>).seed);
};

const getSeedMode = (
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

const resolveScheduleDeliveryMode = (
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

interface CrawlStrategyTagDescriptor {
  key: string;
  color: string;
  label: string;
}

const getCrawlStrategyTags = (
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

const pipelineJobStatusColors: Record<string, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  delayed: "orange",
  completed: "green",
  failed: "red",
};

const crawlTaskStatusColors: Record<string, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple",
};

type LiveEventSource =
  | "pipeline"
  | "crawl"
  | "analysis"
  | "assistant"
  | "alerts";

interface OpsLiveEvent {
  orgId: string;
  source: LiveEventSource;
  event: string;
  jobId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  pipelineJobId?: string;
  sourceId?: string;
  rawItemId?: string;
  itemMetaId?: string;
  processedItemId?: string;
  taskId?: string;
  priorityClass?: "hot" | "normal";
  sourcePriority?: number;
}

const LIVE_EVENT_SOURCES: LiveEventSource[] = [
  "pipeline",
  "crawl",
  "analysis",
  "assistant",
  "alerts",
];
const LIVE_EVENT_SOURCE_SET = new Set<LiveEventSource>(LIVE_EVENT_SOURCES);

const createEmptyLiveEventCounts = (): Record<LiveEventSource, number> => ({
  pipeline: 0,
  crawl: 0,
  analysis: 0,
  assistant: 0,
  alerts: 0,
});

const createDefaultLiveRefreshSources = (): Record<
  LiveEventSource,
  boolean
> => ({
  pipeline: true,
  crawl: true,
  analysis: false,
  assistant: false,
  alerts: false,
});

const CRAWL_QUALITY_ALERT_RATE_THRESHOLD = 0.15;
const DEFAULT_CRAWL_QUALITY_LOW_304_HIT_RATE_THRESHOLD = 0.05;
const DEFAULT_CRAWL_QUALITY_HIGH_ORG_HASH_DEDUPE_RATE_THRESHOLD = 0.3;
const DEFAULT_CRAWL_QUALITY_PREFLIGHT_FAILURE_RATE_THRESHOLD = 0.15;
const normalizeRateValue = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const normalizeCountValue = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

type CrawlQualitySampleMetric =
  | "markdownCount"
  | "expansionTriggeredTaskCount"
  | "headSignalAttemptedCount"
  | "preflightRunCount"
  | "dedupeEvaluatedCount";

const getSampleCount = (
  sampleCounts: CrawlQualitySampleCounts | undefined,
  key: CrawlQualitySampleMetric,
): number => normalizeCountValue(sampleCounts?.[key]);

export function NewsSourcesContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const canWriteItems = permissions.includes("items.write");
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingFromTaskDrawer, setCreatingFromTaskDrawer] = useState(false);
  const [sources, setSources] = useState<NewsSourceRecord[]>([]);
  const [sourceTotal, setSourceTotal] = useState(0);
  const [sourcePage, setSourcePage] = useState(1);
  const [sourcePageSize, setSourcePageSize] = useState(10);
  const [sourceIndex, setSourceIndex] = useState<
    Record<string, NewsSourceRecord>
  >({});
  const [templates, setTemplates] = useState<CrawlTemplateRecord[]>([]);
  const [workflowOptions, setWorkflowOptions] = useState<
    { label: string; value: string }[]
  >([]);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [opmlModalOpen, setOpmlModalOpen] = useState(false);
  const [opmlMode, setOpmlMode] = useState<NewsSourceOpmlMode>("preset");
  const [opmlPresets, setOpmlPresets] = useState<NewsSourceOpmlPresetSummary[]>(
    [],
  );
  const [opmlPresetId, setOpmlPresetId] = useState<string>("");
  const [opmlDefaultLanguage, setOpmlDefaultLanguage] = useState("zh");
  const [opmlContent, setOpmlContent] = useState("");
  const [opmlFileName, setOpmlFileName] = useState<string | null>(null);
  const [opmlPreview, setOpmlPreview] =
    useState<NewsSourceOpmlPreviewResponse | null>(null);
  const [opmlLoadingPresets, setOpmlLoadingPresets] = useState(false);
  const [opmlPreviewing, setOpmlPreviewing] = useState(false);
  const [opmlImporting, setOpmlImporting] = useState(false);
  const [opmlImportReport, setOpmlImportReport] =
    useState<NewsSourceOpmlImportReport | null>(null);
  const [editingSource, setEditingSource] = useState<NewsSourceRecord | null>(
    null,
  );
  const [modalFormValues, setModalFormValues] = useState<
    Partial<NewsSourceFormValues>
  >(NEWS_SOURCE_CREATE_INITIAL_VALUES);
  const [form] = Form.useForm<NewsSourceFormValues>();
  const [createDrawerForm] = Form.useForm<CreateCrawlTaskFormValues>();
  const [scheduleForm] = Form.useForm<NewsSourceScheduleValues>();
  const screens = Grid.useBreakpoint();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRunNowLoading, setPreviewRunNowLoading] = useState(false);
  const [previewSource, setPreviewSource] = useState<NewsSourceRecord | null>(
    null,
  );
  const [previewData, setPreviewData] =
    useState<NewsSourcePreviewResponse | null>(null);
  const [crawlQueueStats, setCrawlQueueStats] =
    useState<Crawl4aiQueueStats | null>(null);
  const [crawlQueueLoading, setCrawlQueueLoading] = useState(false);
  const [crawlQueueError, setCrawlQueueError] = useState<string | null>(null);
  const [crawlQualityStats, setCrawlQualityStats] =
    useState<Crawl4aiQualitySnapshot | null>(null);
  const [crawlQualityLoading, setCrawlQualityLoading] = useState(false);
  const [crawlQualityError, setCrawlQualityError] = useState<string | null>(
    null,
  );
  const [readinessSummary, setReadinessSummary] =
    useState<NewsSourceReadinessSummary | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleTargets, setScheduleTargets] = useState<NewsSourceRecord[]>(
    [],
  );
  const [groups, setGroups] = useState<string[]>([]);
  const [seedSchedulerSettings, setSeedSchedulerSettings] =
    useState<NewsSourceSchedulerSettingsResponse | null>(null);
  const [seedSchedulerSettingsLoadFailed, setSeedSchedulerSettingsLoadFailed] =
    useState(false);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [batchRunLoading, setBatchRunLoading] = useState(false);
  const [batchToggleLoading, setBatchToggleLoading] = useState(false);
  const [batchGroupLoading, setBatchGroupLoading] = useState(false);
  const [dispatchingSourceIds, setDispatchingSourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [opsLoadingSourceIds, setOpsLoadingSourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(30);
  const [liveUpdatesEnabled, setLiveUpdatesEnabled] = useState(true);
  const [liveStatus, setLiveStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveLastEvent, setLiveLastEvent] = useState<OpsLiveEvent | null>(null);
  const [liveEventCount, setLiveEventCount] = useState(0);
  const [liveEventCountsBySource, setLiveEventCountsBySource] = useState<
    Record<LiveEventSource, number>
  >(() => createEmptyLiveEventCounts());
  const [liveRefreshSources, setLiveRefreshSources] = useState<
    Record<LiveEventSource, boolean>
  >(() => createDefaultLiveRefreshSources());
  const liveRefreshSourcesRef = useRef(liveRefreshSources);
  const liveRefreshTimerRef = useRef<number | null>(null);
  const liveSocketRef = useRef<Socket | null>(null);
  const liveUiBusyRef = useRef(false);
  const visibleSourceIdSetRef = useRef<Set<string>>(new Set());
  const refreshAllRef = useRef<((options?: RefreshAllOptions) => Promise<void>) | null>(
    null,
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const refreshRef = useRef(false);
  const pendingRefreshRef = useRef<{
    silent: boolean;
    includeQueue: boolean;
    includeQuality: boolean;
  } | null>(null);
  const seedModeRef = useRef<NewsSourceFormValues["seedMode"]>("sitemap");

  const selectedSources = useMemo(
    () =>
      selectedSourceIds
        .map((id) => sourceIndex[id])
        .filter((source): source is NewsSourceRecord => Boolean(source)),
    [selectedSourceIds, sourceIndex],
  );
  const visibleSourceIdSet = useMemo(
    () => new Set(sources.map((source) => source.id)),
    [sources],
  );
  const watchedSeedEnabled = Form.useWatch("seedEnabled", form);
  const watchedSeedMode = Form.useWatch("seedMode", form);
  const resolvedSeedRuntimeSettings = useMemo(
    () =>
      resolveSeedSchedulerRuntimeSettings(seedSchedulerSettings ?? undefined),
    [seedSchedulerSettings],
  );
  const showCrawlSettings = useMemo(
    () =>
      shouldShowCrawlSettingsForSeedMode(watchedSeedEnabled, watchedSeedMode),
    [watchedSeedEnabled, watchedSeedMode],
  );
  const scheduleDeliveryMode = useMemo(
    () => resolveScheduleDeliveryMode(scheduleTargets),
    [scheduleTargets],
  );

  const uniqueGroups = useMemo(
    () =>
      Array.from(
        new Set([
          ...groups,
          ...sources.map((s) => s.group).filter((g): g is string => Boolean(g)),
        ]),
      ).sort(),
    [groups, sources],
  );

  const crawlQualityThresholds = useMemo(() => {
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
  }, [crawlQualityStats]);

  const crawlQualityThresholdStatus = useMemo(() => {
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
  }, [crawlQualityStats, crawlQualityThresholds]);

  const crawlQualityRateAlerts = useMemo(() => {
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
  }, [crawlQualityStats, crawlQualityThresholds]);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  useEffect(() => {
    liveRefreshSourcesRef.current = liveRefreshSources;
  }, [liveRefreshSources]);

  useEffect(() => {
    visibleSourceIdSetRef.current = visibleSourceIdSet;
  }, [visibleSourceIdSet]);

  const loadSources = useCallback(
    async (options?: {
      silent?: boolean;
      page?: number;
      pageSize?: number;
      search?: string;
    }): Promise<boolean> => {
      const silent = options?.silent === true;
      const page = options?.page ?? sourcePage;
      const pageSize = options?.pageSize ?? sourcePageSize;
      const search = options?.search ?? searchQuery;
      if (!silent) {
        setLoading(true);
      }
      try {
        const response = await apiClient.get<NewsSourceListResponse>(
          "admin/news-sources",
          {
            params: {
              page,
              pageSize,
              search: search || undefined,
            },
          },
        );
        const payload = response.data ?? {
          sources: [],
          total: 0,
          page,
          pageSize,
        };
        const nextSources = (payload.sources ?? []).map(mapNewsSourceRecord);
        setSources(nextSources);
        setSourceIndex((prev) => {
          const next = { ...prev };
          for (const source of nextSources) {
            next[source.id] = source;
          }
          return next;
        });
        setSourceTotal(payload.total ?? 0);
        setSourcePage(payload.page ?? page);
        setSourcePageSize(payload.pageSize ?? pageSize);
        return true;
      } catch (error) {
        captureClientError("Failed to load news sources", error);
        if (!silent) {
          messageApi.error(
            t("newsSources.errors.loadFailed"),
          );
        }
        return false;
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [apiClient, messageApi, searchQuery, sourcePage, sourcePageSize, t],
  );

  const loadReadinessSummary = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!session?.accessToken || !canView) {
        setReadinessSummary(null);
        setReadinessError(null);
        return;
      }

      if (!silent) {
        setReadinessLoading(true);
      }

      try {
        const pageSize = 50;
        const maxPages = 100;
        const allSources: NewsSourceRecord[] = [];
        let total = Number.POSITIVE_INFINITY;
        let page = 1;

        while (page <= maxPages && allSources.length < total) {
          const response = await apiClient.get<NewsSourceListResponse>(
            "admin/news-sources",
            {
              params: {
                page,
                pageSize,
              },
            },
          );
          const payload = response.data ?? {
            sources: [],
            total: 0,
            page,
            pageSize,
          };
          const pageSources = (payload.sources ?? []).map(mapNewsSourceRecord);
          allSources.push(...pageSources);
          total = Math.max(payload.total ?? 0, allSources.length);
          if (pageSources.length < pageSize) {
            break;
          }
          page += 1;
        }

        const now = Date.now();
        const summary = allSources.reduce<NewsSourceReadinessSummary>(
          (acc, source) => {
            acc.total += 1;
            if (source.isActive) {
              acc.active += 1;
            } else {
              acc.inactive += 1;
            }
            if (
              source.circuitOpenUntil &&
              new Date(source.circuitOpenUntil).getTime() > now
            ) {
              acc.circuitOpen += 1;
            }
            if (Number(source.consecutiveFailures ?? 0) > 0) {
              acc.failing += 1;
            }
            return acc;
          },
          {
            total: 0,
            active: 0,
            inactive: 0,
            circuitOpen: 0,
            failing: 0,
          },
        );

        setReadinessSummary(summary);
        setReadinessError(null);
      } catch (error) {
        captureClientError(
          "Failed to load news source readiness summary",
          error,
        );
        setReadinessSummary(null);
        setReadinessError(
          t("newsSources.readiness.loadFailed"),
        );
      } finally {
        if (!silent) {
          setReadinessLoading(false);
        }
      }
    },
    [apiClient, canView, session?.accessToken, t],
  );

  const loadTemplates = useCallback(async () => {
    try {
      const response = await apiClient.get<CrawlTemplateRecord[]>(
        "admin/crawl-templates",
      );
      setTemplates(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl templates", error);
    }
  }, [apiClient]);

  const loadWorkflowOptions = useCallback(async () => {
    try {
      const response = await apiClient.get<{ id: string; name: string }[]>(
        "admin/crawl-frontier/workflows",
      );
      setWorkflowOptions(
        (response.data ?? []).map((workflow) => ({
          label: workflow.name,
          value: workflow.id,
        })),
      );
    } catch (error) {
      captureClientError("Failed to load crawl strategy workflows", error);
    }
  }, [apiClient]);

  const loadGroups = useCallback(async () => {
    try {
      const response = await apiClient.get<string[]>(
        "admin/news-sources/groups",
      );
      setGroups(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load news source groups", error);
    }
  }, [apiClient]);

  const loadSeedSchedulerSettings = useCallback(async () => {
    try {
      const response = await apiClient.get<NewsSourceSchedulerSettingsResponse>(
        "system-settings/news-source-scheduler",
      );
      const data = response.data ?? {};
      const runtimeSettings = resolveSeedSchedulerRuntimeSettings(data);
      setSeedSchedulerSettings({
        source: data.source === "db" ? "db" : "default",
        ...runtimeSettings,
      });
      setSeedSchedulerSettingsLoadFailed(false);
    } catch (error) {
      captureClientError(
        "Failed to load news source scheduler settings",
        error,
      );
      setSeedSchedulerSettings(null);
      setSeedSchedulerSettingsLoadFailed(true);
    }
  }, [apiClient]);

  const loadOpmlPresets = useCallback(async () => {
    setOpmlLoadingPresets(true);
    try {
      const response = await apiClient.get<NewsSourceOpmlPresetSummary[]>(
        "admin/news-sources/opml-presets",
      );
      const presets = response.data ?? [];
      setOpmlPresets(presets);
      const firstPresetId = presets[0]?.id ?? "";
      const firstDefaultLanguage = presets[0]?.defaultLanguage ?? "zh";
      setOpmlPresetId((prev) => prev || firstPresetId);
      setOpmlDefaultLanguage((prev) => prev || firstDefaultLanguage);
    } catch (error) {
      captureClientError("Failed to load OPML presets", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.opml.errors.loadPresets"),
      );
    } finally {
      setOpmlLoadingPresets(false);
    }
  }, [apiClient, messageApi, t]);

  const loadCrawlQueueStats = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent) {
        setCrawlQueueLoading(true);
      }
      setCrawlQueueError(null);
      try {
        const response = await apiClient.get<Crawl4aiQueueStats>(
          "admin/crawl4ai/queue",
        );
        setCrawlQueueStats(response.data ?? null);
      } catch (error) {
        captureClientError("Failed to load crawl queue stats", error);
        setCrawlQueueError(
          extractApiErrorMessage(error) ??
            (error instanceof Error
              ? error.message
              : "Failed to load crawl queue stats."),
        );
        if (!silent) {
          setCrawlQueueStats(null);
        }
      } finally {
        if (!silent) {
          setCrawlQueueLoading(false);
        }
      }
    },
    [apiClient],
  );

  const loadCrawlQualityStats = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent) {
        setCrawlQualityLoading(true);
      }
      setCrawlQualityError(null);
      try {
        const response = await apiClient.get<Crawl4aiQualitySnapshot>(
          "admin/crawl4ai/quality",
        );
        setCrawlQualityStats(response.data ?? null);
      } catch (error) {
        captureClientError("Failed to load crawl quality stats", error);
        setCrawlQualityError(
          extractApiErrorMessage(error) ??
            (error instanceof Error
              ? error.message
              : "Failed to load crawl quality stats."),
        );
        if (!silent) {
          setCrawlQualityStats(null);
        }
      } finally {
        if (!silent) {
          setCrawlQualityLoading(false);
        }
      }
    },
    [apiClient],
  );

  const refreshAll = useCallback(
    async (options?: RefreshAllOptions) => {
      const silent = options?.silent === true;
      const includeQueue = options?.includeQueue !== false;
      const includeQuality = options?.includeQuality !== false;
      if (refreshRef.current) {
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = {
          silent: pending ? pending.silent && silent : silent,
          includeQueue: pending ? pending.includeQueue || includeQueue : includeQueue,
          includeQuality: pending
            ? pending.includeQuality || includeQuality
            : includeQuality,
        };
        return;
      }
      refreshRef.current = true;
      try {
        const [sourcesOk] = await Promise.all([
          loadSources({ silent }),
          loadReadinessSummary({ silent }),
          includeQueue
            ? loadCrawlQueueStats({ silent })
            : Promise.resolve(undefined),
          includeQuality
            ? loadCrawlQualityStats({ silent })
            : Promise.resolve(undefined),
        ]);
        if (sourcesOk) {
          setLastUpdatedAt(new Date().toISOString());
        }
      } finally {
        refreshRef.current = false;
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = null;
        if (pending) {
          void refreshAll(pending);
        }
      }
    },
    [
      loadCrawlQualityStats,
      loadCrawlQueueStats,
      loadReadinessSummary,
      loadSources,
    ],
  );

  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  useEffect(() => {
    if (canView) {
      void loadTemplates();
      void loadWorkflowOptions();
      void loadGroups();
      if (canManage) {
        void loadSeedSchedulerSettings();
      }
    }
  }, [
    canManage,
    canView,
    loadTemplates,
    loadWorkflowOptions,
    loadGroups,
    loadSeedSchedulerSettings,
  ]);

  useEffect(() => {
    if (!canView) {
      return;
    }
    void refreshAll();
  }, [canView, refreshAll]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      const nextSearchQuery = searchInput.trim();
      setSearchQuery((previousSearchQuery) => {
        if (previousSearchQuery === nextSearchQuery) {
          return previousSearchQuery;
        }
        setSourcePage(1);
        return nextSearchQuery;
      });
    }, 300);

    return () => window.clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    if (modalOpen && canManage) {
      void loadSeedSchedulerSettings();
    }
  }, [canManage, loadSeedSchedulerSettings, modalOpen]);

  const liveFallbackPollingEnabled =
    canView &&
    status === "authenticated" &&
    liveUpdatesEnabled &&
    liveStatus !== "connected";
  const intervalRefreshEnabled =
    liveFallbackPollingEnabled || (!liveUpdatesEnabled && autoRefreshEnabled);

  useEffect(() => {
    if (!intervalRefreshEnabled) {
      return;
    }
    const intervalMs = Math.max(5, Math.min(300, autoRefreshSeconds)) * 1000;
    const id = window.setInterval(() => {
      if (modalOpen || createDrawerOpen || previewOpen || scheduleOpen) {
        return;
      }
      if (saving || scheduleLoading || previewLoading || previewRunNowLoading) {
        return;
      }
      if (batchRunLoading || batchToggleLoading) {
        return;
      }
      if (dispatchingSourceIds.size > 0 || opsLoadingSourceIds.size > 0) {
        return;
      }
      void refreshAll({
        silent: true,
        includeQueue: false,
        includeQuality: false,
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [
    autoRefreshEnabled,
    autoRefreshSeconds,
    batchRunLoading,
    batchToggleLoading,
    createDrawerOpen,
    dispatchingSourceIds.size,
    intervalRefreshEnabled,
    modalOpen,
    opsLoadingSourceIds.size,
    previewLoading,
    previewOpen,
    previewRunNowLoading,
    refreshAll,
    saving,
    scheduleLoading,
    scheduleOpen,
  ]);

  useEffect(() => {
    liveUiBusyRef.current =
      modalOpen ||
      createDrawerOpen ||
      previewOpen ||
      scheduleOpen ||
      saving ||
      scheduleLoading ||
      previewLoading ||
      previewRunNowLoading ||
      batchRunLoading ||
      batchToggleLoading ||
      dispatchingSourceIds.size > 0 ||
      opsLoadingSourceIds.size > 0;
  }, [
    batchRunLoading,
    batchToggleLoading,
    createDrawerOpen,
    dispatchingSourceIds.size,
    modalOpen,
    opsLoadingSourceIds.size,
    previewLoading,
    previewOpen,
    previewRunNowLoading,
    saving,
    scheduleLoading,
    scheduleOpen,
  ]);

  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshTimerRef.current) {
      return;
    }
    liveRefreshTimerRef.current = window.setTimeout(() => {
      liveRefreshTimerRef.current = null;
      if (liveUiBusyRef.current) {
        return;
      }
      void refreshAllRef.current?.({
        silent: true,
        includeQueue: false,
        includeQuality: false,
      });
    }, 1200);
  }, []);

  const resetLiveCounters = useCallback(() => {
    setLiveEventCount(0);
    setLiveEventCountsBySource(createEmptyLiveEventCounts());
    setLiveLastEvent(null);
  }, []);

  useEffect(() => {
    if (!canView || !liveUpdatesEnabled || !session?.accessToken) {
      setLiveStatus("disconnected");
      return;
    }

    setLiveStatus("connecting");
    setLiveError(null);

    const socket = io(`${env.apiRoot}/ops`, {
      auth: { token: session.accessToken },
      transports: ["websocket"],
      withCredentials: true,
      autoConnect: false,
      timeout: REALTIME_SOCKET_TIMEOUT_MS,
    });

    liveSocketRef.current = socket;
    const connectTimer = window.setTimeout(() => {
      socket.connect();
    }, 0);

    const handleConnect = () => {
      setLiveStatus("connected");
      setLiveError(null);
      void refreshAllRef.current?.({ silent: true });
    };
    const handleDisconnect = () => setLiveStatus("disconnected");
    const getLocalizedError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
      fallbackKind: "socket" | "connect",
    ) =>
      formatRealtimeSocketError(payload, t, {
        keyPrefix: "newsSources.liveUpdates.connectionError",
        fallbackKind,
        defaults: {
          unauthorized:
            "News source realtime access expired. Please sign in again.",
          tooManyConnections:
            "News source realtime connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many news source realtime connection attempts. Please try again later.",
          rateLimitExceeded:
            "News source realtime connection attempts are too frequent. Please try again later.",
          tooManyFailedAttempts:
            "Too many failed news source realtime sign-in attempts. Please try again later.",
          timeout:
            "Connecting to news source realtime timed out. Please try again.",
          network:
            "Unable to connect to news source realtime. Please check the network and try again.",
          connect:
            "Unable to connect to news source realtime right now. Please try again later.",
          socket:
            "News source realtime connection is unstable. Please try again later.",
        },
      });
    const handleConnectError = (
      error: { code?: string; message?: string; retryAfterMs?: number },
    ) => {
      setLiveStatus("disconnected");
      setLiveError(getLocalizedError(error, "connect"));
    };
    const handleServerError = (payload: unknown) => {
      const candidate =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as {
              code?: string;
              message?: string;
              retryAfterMs?: number;
            })
          : undefined;
      setLiveError(getLocalizedError(candidate, "socket"));
    };
    const handleEvent = (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const record = payload as Record<string, unknown>;
      const sourceRaw = record.source;
      if (
        typeof sourceRaw !== "string" ||
        !LIVE_EVENT_SOURCE_SET.has(sourceRaw as LiveEventSource)
      ) {
        return;
      }
      const source = sourceRaw as LiveEventSource;
      const event = typeof record.event === "string" ? record.event : "EVENT";
      const jobId = typeof record.jobId === "string" ? record.jobId : "";
      const orgId = typeof record.orgId === "string" ? record.orgId : "";
      const sourceId =
        typeof record.sourceId === "string" ? record.sourceId : undefined;
      const timestamp =
        typeof record.timestamp === "string"
          ? record.timestamp
          : new Date().toISOString();

      setLiveLastEvent({ orgId, source, event, jobId, sourceId, timestamp });
      setLiveEventCount((prev) => prev + 1);
      setLiveEventCountsBySource((prev) => ({
        ...prev,
        [source]: (prev[source] ?? 0) + 1,
      }));

      const isPageScopedSource = source === "pipeline" || source === "crawl";
      if (
        isPageScopedSource &&
        (!sourceId || !visibleSourceIdSetRef.current.has(sourceId))
      ) {
        return;
      }

      if (event !== "PROGRESS" && liveRefreshSourcesRef.current[source]) {
        scheduleLiveRefresh();
      }
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("ops:error", handleServerError);
    socket.on("ops:event", handleEvent);

    return () => {
      window.clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("ops:error", handleServerError);
      socket.off("ops:event", handleEvent);
      socket.disconnect();
      if (liveSocketRef.current === socket) {
        liveSocketRef.current = null;
      }
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      pendingRefreshRef.current = null;
    };
  }, [
    canView,
    liveUpdatesEnabled,
    session?.accessToken,
    scheduleLiveRefresh,
  ]);

  useEffect(() => {
    if (!modalOpen) {
      return;
    }

    seedModeRef.current = normalizeSeedMode(modalFormValues.seedMode);
    form.resetFields();
    form.setFieldsValue({
      ...modalFormValues,
      group: modalFormValues.group ?? undefined,
    });
  }, [form, modalFormValues, modalOpen]);

  const resolveRssAdaptiveObservability = useCallback(
    (record: NewsSourceRecord) =>
      resolveRssAdaptiveListUiModel({
        config: record.config,
        frequencySeconds: record.frequencySeconds,
        priority: record.priority,
        rssAdaptiveState: record.rssAdaptiveState,
        runtimeSettings: resolvedSeedRuntimeSettings,
      }),
    [resolvedSeedRuntimeSettings],
  );

  const siteTypeOptions = [
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

  const templateMap = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  );
  const templateOptions = useMemo(
    () =>
      templates.map((template) => ({
        value: template.id,
        label: template.isActive
          ? template.name
          : `${template.name} (${t("common.disabled")})`,
      })),
    [t, templates],
  );

  const livePopoverContent = (
    <div style={{ maxWidth: 420 }}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        {liveError ? (
          <Alert
            type="error"
            showIcon
            message={t("newsSources.liveUpdates.error")}
            description={liveError}
          />
        ) : null}

        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">
            {t("newsSources.liveUpdates.details.lastEvent")}
          </Typography.Text>
          {liveLastEvent ? (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Space wrap>
                <Tag>{liveLastEvent.source}</Tag>
                <Tag color="blue">{liveLastEvent.event}</Tag>
              </Space>
              {liveLastEvent.jobId ? (
                <Typography.Text
                  code
                  copyable
                  ellipsis={{ tooltip: liveLastEvent.jobId }}
                >
                  {liveLastEvent.jobId}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {formatDateTime(liveLastEvent.timestamp, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {t("common.noData")}
            </Typography.Text>
          )}
        </Space>

        <Divider style={{ margin: "4px 0" }} />

        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("newsSources.liveUpdates.details.refreshOn")}
          </Typography.Text>
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            {LIVE_EVENT_SOURCES.map((source) => (
              <div
                key={source}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Checkbox
                  checked={liveRefreshSources[source]}
                  onChange={(event) =>
                    setLiveRefreshSources((prev) => ({
                      ...prev,
                      [source]: event.target.checked,
                    }))
                  }
                >
                  {source}
                </Checkbox>
                <Typography.Text type="secondary">
                  {liveEventCountsBySource[source]}
                </Typography.Text>
              </div>
            ))}
          </Space>
          <Space>
            <Button size="small" onClick={resetLiveCounters}>
              {t("newsSources.liveUpdates.details.resetCounters")}
            </Button>
          </Space>
        </Space>
      </Space>
    </div>
  );

  const openCreate = () => {
    setEditingSource(null);
    setModalOpen(false);
    createDrawerForm.resetFields();
    setCreateDrawerOpen(true);
  };

  const openOpmlImport = async () => {
    setOpmlImportReport(null);
    setOpmlPreview(null);
    setOpmlContent("");
    setOpmlFileName(null);
    setOpmlMode("preset");
    setOpmlDefaultLanguage("zh");
    setOpmlModalOpen(true);
    if (opmlPresets.length === 0) {
      await loadOpmlPresets();
    }
  };

  const openEdit = (source: NewsSourceRecord) => {
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

    setEditingSource(source);
    setModalFormValues(nextFormValues);
    setModalOpen(true);
  };

  const buildConfig = (values: NewsSourceFormValues) => {
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
  };

  const closeCreateDrawer = () => {
    setCreateDrawerOpen(false);
    createDrawerForm.resetFields();
  };

  const normalizeCreateDrawerValues = (
    values: CreateCrawlTaskFormValues,
  ): CreateCrawlTaskFormValues => {
    return normalizeHeadlessModeFormValues(values);
  };

  const handleCreateFromTaskDrawer = async (
    values: CreateCrawlTaskFormValues,
  ) => {
    setCreatingFromTaskDrawer(true);
    let crawlOptions: ReturnType<typeof sanitizeCrawlOptions>;
    try {
      crawlOptions = sanitizeCrawlOptions(normalizeCreateDrawerValues(values));
      const proxyIssues = findUnsupportedProxyIssues(
        crawlOptions,
        "config.crawlOptions",
      );
      if (proxyIssues.length > 0) {
        messageApi.error(formatPolicyIssues(proxyIssues, t));
        setCreatingFromTaskDrawer(false);
        return;
      }
    } catch (error) {
      messageApi.error(
        error instanceof Error ? error.message : "Invalid crawl options",
      );
      setCreatingFromTaskDrawer(false);
      return;
    }

    const url = values.url.trim();
    const name =
      values.displayName?.trim() || inferSourceNameFromUrl(url) || url;
    const config: Record<string, unknown> = {};
    if (values.keywords?.length) {
      config.keywords = values.keywords;
    }
    if (Object.keys(crawlOptions).length > 0) {
      config.crawlOptions = crawlOptions;
    }

    const payload = {
      name,
      url,
      siteType: NEWS_SOURCE_CREATE_INITIAL_VALUES.siteType ?? "general",
      language: "",
      crawlTemplateId: null,
      frequencySeconds:
        NEWS_SOURCE_CREATE_INITIAL_VALUES.frequencySeconds ?? 3600,
      priority: NEWS_SOURCE_CREATE_INITIAL_VALUES.priority ?? 0,
      isActive: NEWS_SOURCE_CREATE_INITIAL_VALUES.isActive ?? true,
      config: Object.keys(config).length ? config : null,
    };

    try {
      const response = await apiClient.post<NewsSourceRecord>(
        "admin/news-sources",
        payload,
      );
      messageApi.success(
        t("newsSources.messages.created"),
      );
      closeCreateDrawer();
      await loadSources();
      if (response.data) {
        openEdit(response.data);
      }
    } catch (error) {
      captureClientError("Failed to create news source (task drawer)", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.errors.saveFailed")),
      );
    } finally {
      setCreatingFromTaskDrawer(false);
    }
  };

  const handleSubmit = async (values: NewsSourceFormValues) => {
    setSaving(true);
    try {
      const config = buildConfig(values);
      const groupValue = values.group?.[0]?.trim() ?? "";
      const payload = {
        name: values.name,
        url: values.url,
        siteType: values.siteType,
        language: values.language?.trim() ?? "",
        group: groupValue || null,
        crawlTemplateId: values.crawlTemplateId?.trim()
          ? values.crawlTemplateId.trim()
          : null,
        workflowId: values.workflowId?.trim() ? values.workflowId.trim() : null,
        workflowVersionId: values.workflowVersionId?.trim()
          ? values.workflowVersionId.trim()
          : null,
        workflowBindingMode: values.workflowBindingMode ?? "published",
        frequencySeconds: values.frequencySeconds,
        priority: values.priority,
        isActive: values.isActive,
        config,
      };
      if (editingSource) {
        await apiClient.patch(
          `admin/news-sources/${editingSource.id}`,
          payload,
        );
      } else {
        await apiClient.post("admin/news-sources", payload);
      }
      messageApi.success(
        editingSource
          ? t("newsSources.messages.updated")
          : t("newsSources.messages.created"),
      );
      setModalOpen(false);
      setEditingSource(null);
      form.resetFields();
      await loadSources();
    } catch (error) {
      captureClientError("Failed to save news source", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.errors.saveFailed")),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleOpmlModeChange = (mode: NewsSourceOpmlMode) => {
    setOpmlMode(mode);
    setOpmlPreview(null);
    setOpmlImportReport(null);
  };

  const handleOpmlFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      setOpmlContent(text);
      setOpmlFileName(file.name);
      setOpmlPreview(null);
      setOpmlImportReport(null);
      setOpmlMode("upload");
    } catch (error) {
      captureClientError("Failed to read OPML file", error);
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("newsSources.opml.errors.readFile"),
      );
    } finally {
      event.target.value = "";
    }
  };

  const handlePreviewOpml = async () => {
    setOpmlPreviewing(true);
    setOpmlImportReport(null);
    try {
      const payload =
        opmlMode === "preset"
          ? {
              presetId: opmlPresetId,
              defaultLanguage: opmlDefaultLanguage,
            }
          : {
              opmlContent,
              defaultLanguage: opmlDefaultLanguage,
            };
      const response = await apiClient.post<NewsSourceOpmlPreviewResponse>(
        "admin/news-sources/opml/preview",
        payload,
      );
      setOpmlPreview(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to preview OPML", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.opml.errors.preview")),
      );
    } finally {
      setOpmlPreviewing(false);
    }
  };

  const handleApplyOpmlDefaultLanguage = () => {
    const language = opmlDefaultLanguage.trim();
    if (!language) {
      return;
    }
    setOpmlPreview((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        entries: prev.entries.map((entry) =>
          entry.enabled
            ? {
                ...entry,
                language,
              }
            : entry,
        ),
      };
    });
  };

  const updateOpmlPreviewEntry = (
    index: number,
    patch: Partial<NewsSourceOpmlPreviewEntry>,
  ) => {
    setOpmlPreview((prev) => {
      if (!prev) {
        return prev;
      }
      if (index < 0 || index >= prev.entries.length) {
        return prev;
      }
      const nextEntries = [...prev.entries];
      const current = nextEntries[index];
      if (!current) {
        return prev;
      }
      nextEntries[index] = {
        ...current,
        ...patch,
      };
      return {
        ...prev,
        entries: nextEntries,
      };
    });
  };

  const handleImportOpml = async () => {
    if (!opmlPreview) {
      messageApi.warning(
        t("newsSources.opml.errors.previewFirst"),
      );
      return;
    }
    setOpmlImporting(true);
    try {
      const payload = {
        entries: opmlPreview.entries.map((entry) => ({
          name: entry.name,
          url: entry.url,
          feedUrl: entry.feedUrl,
          language: entry.language,
          enabled: entry.enabled,
          group: entry.group ?? null,
          siteType: "general",
        })),
        conflictPolicy: "skip",
        runtimeProfile: "steady",
      };

      const response = await apiClient.post<NewsSourceOpmlImportReport>(
        "admin/news-sources/opml/import",
        payload,
      );
      const report = response.data;
      setOpmlImportReport(report);
      messageApi.success(
        t("newsSources.opml.messages.imported", {
          created: report?.summary?.created ?? 0,
          skipped: report?.summary?.skipped ?? 0,
          failed: report?.summary?.failed ?? 0,
        }),
      );
      await loadSources();
    } catch (error) {
      captureClientError("Failed to import OPML", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.opml.errors.import")),
      );
    } finally {
      setOpmlImporting(false);
    }
  };

  const handleToggleActive = async (
    source: NewsSourceRecord,
    nextActive: boolean,
  ) => {
    try {
      await apiClient.patch(`admin/news-sources/${source.id}`, {
        isActive: nextActive,
      });
      await loadSources();
      messageApi.success(
        nextActive
          ? t("newsSources.messages.enabled")
          : t("newsSources.messages.disabled"),
      );
    } catch (error) {
      captureClientError("Failed to update news source", error);
      messageApi.error(
        t("newsSources.errors.saveFailed"),
      );
    }
  };

  const handleRunNow = async (source: NewsSourceRecord) => {
    setDispatchingSourceIds((prev) => {
      const next = new Set(prev);
      next.add(source.id);
      return next;
    });
    try {
      const response = await apiClient.post<NewsSourceDispatchResponse>(
        `admin/news-sources/${source.id}/dispatch`,
      );
      const payload = response.data;
      await loadSources();

      const nextRunAtLabel = payload?.nextRunAt
        ? formatDateTime(payload.nextRunAt, locale, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : null;

      const openTaskButton =
        payload?.crawlTaskIds?.length > 0 ? (
          <Button
            type="link"
            size="small"
            onClick={() =>
              router.push(`/admin/ops/crawl-tasks/${payload.crawlTaskIds[0]}`)
            }
          >
            {t("newsSources.actions.openTask")}
          </Button>
        ) : null;

      if (payload?.reason === "deduped") {
        const untilLabel = payload?.dedupeUntil
          ? formatDateTime(payload.dedupeUntil, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : null;
        messageApi.info(
          <Space size={6} wrap>
            <span>
              {t("newsSources.messages.runDeduped")}
              {untilLabel
                ? ` ${t("newsSources.messages.tryAfter", { time: untilLabel })}`
                : ""}
            </span>
            {openTaskButton}
          </Space>,
        );
        return;
      }

      if (payload?.reason === "in_flight") {
        messageApi.warning(
          <Space size={6} wrap>
            <span>
              {t("newsSources.messages.runSkippedInFlight", {
                count: payload.inFlightCount ?? 0,
                limit: payload.inFlightLimit ?? 0,
              })}
              {nextRunAtLabel
                ? ` ${t("newsSources.messages.nextRunAt", { time: nextRunAtLabel })}`
                : ""}
            </span>
          </Space>,
        );
        return;
      }

      if (payload?.reason === "no_new_urls") {
        messageApi.info(
          <Space size={6} wrap>
            <span>
              {t("newsSources.messages.noNewUrls")}
              {nextRunAtLabel
                ? ` ${t("newsSources.messages.nextRunAt", { time: nextRunAtLabel })}`
                : ""}
            </span>
          </Space>,
        );
        return;
      }

      const queuedText = t(
        payload?.mode === "rss"
          ? "newsSources.messages.runQueuedJobsCount"
          : "newsSources.messages.runQueuedCount",
        {
          defaultValue:
            payload?.mode === "rss"
              ? "Queued {{count}} job(s)."
              : "Queued {{count}} task(s).",
          count: payload?.scheduledCount ?? 0,
        },
      );
      const skippedText =
        typeof payload?.skippedCount === "number" && payload.skippedCount > 0
          ? t("newsSources.messages.runSkippedCount", {
              count: payload.skippedCount,
            })
          : null;
      const failureText =
        typeof payload?.enqueueFailures === "number" &&
        payload.enqueueFailures > 0
          ? t("newsSources.messages.runEnqueueFailures", {
              count: payload.enqueueFailures,
            })
          : null;
      const rssNoBodySkippedText =
        typeof payload?.rssSkippedNoBodyCount === "number" &&
        payload.rssSkippedNoBodyCount > 0
          ? t("newsSources.messages.runRssNoBodySkipped", {
              count: payload.rssSkippedNoBodyCount,
            })
          : null;

      const toastType =
        typeof payload?.enqueueFailures === "number" &&
        payload.enqueueFailures > 0
          ? "warning"
          : "success";
      messageApi.open({
        type: toastType,
        content: (
          <Space size={8} wrap>
            <span>
              {queuedText}
              {skippedText ? ` ${skippedText}` : ""}
              {rssNoBodySkippedText ? ` ${rssNoBodySkippedText}` : ""}
              {failureText ? ` ${failureText}` : ""}
              {nextRunAtLabel
                ? ` ${t("newsSources.messages.nextRunAt", { time: nextRunAtLabel })}`
                : ""}
            </span>
            {openTaskButton}
          </Space>
        ),
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        messageApi.info(
          t("newsSources.messages.dispatchInProgress"),
        );
        return;
      }
      captureClientError("Failed to run news source now", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.errors.runFailed"),
      );
    } finally {
      setDispatchingSourceIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
    }
  };

  const handleBatchToggleActive = async (nextActive: boolean) => {
    const ids = selectedSourceIds;
    if (ids.length === 0) {
      return;
    }

    setBatchToggleLoading(true);
    try {
      const response = await apiClient.patch<{
        updatedCount: number;
        requestedCount: number;
      }>("admin/news-sources/batch/active", {
        ids,
        isActive: nextActive,
      });
      const okCount = response.data.updatedCount ?? ids.length;
      const failedCount = Math.max(0, ids.length - okCount);

      if (failedCount > 0) {
        messageApi.warning(
          t("newsSources.messages.batchTogglePartial", {
            ok: okCount,
            total: ids.length,
          }),
        );
      } else {
        messageApi.success(
          nextActive
            ? t("newsSources.messages.enabledBatch", {
                count: okCount,
              })
            : t("newsSources.messages.disabledBatch", {
                count: okCount,
              }),
        );
      }

      setSelectedSourceIds([]);
      await loadSources();
    } catch (error) {
      captureClientError("Failed to batch update news sources", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.errors.saveFailed"),
      );
    } finally {
      setBatchToggleLoading(false);
    }
  };

  const handleBatchSetGroup = async (group: string | null) => {
    const ids = selectedSourceIds;
    if (ids.length === 0) {
      return;
    }
    setBatchGroupLoading(true);
    try {
      await apiClient.patch("admin/news-sources/batch/group", { ids, group });
      messageApi.success(
        t("newsSources.messages.groupUpdatedBatch", {
          count: ids.length,
        }),
      );
      setSelectedSourceIds([]);
      await loadSources();
      await loadGroups();
    } catch (error) {
      captureClientError("Failed to batch update group", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.errors.saveFailed"),
      );
    } finally {
      setBatchGroupLoading(false);
    }
  };

  const handleBatchRunNow = async () => {
    const targets = selectedSources;
    if (targets.length === 0) {
      return;
    }

    setBatchRunLoading(true);
    try {
      type BatchDispatchResult =
        | { ok: true; sourceId: string; payload: NewsSourceDispatchResponse }
        | {
            ok: false;
            sourceId: string;
            error: string;
            kind?: "conflict" | "error";
          };

      const results = await mapWithConcurrency(
        targets,
        3,
        async (target): Promise<BatchDispatchResult> => {
          try {
            const response = await apiClient.post<NewsSourceDispatchResponse>(
              `admin/news-sources/${target.id}/dispatch`,
            );
            return { ok: true, sourceId: target.id, payload: response.data };
          } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 409) {
              return {
                ok: false,
                sourceId: target.id,
                kind: "conflict",
                error: t("newsSources.messages.dispatchInProgress"),
              };
            }
            return {
              ok: false,
              sourceId: target.id,
              kind: "error",
              error:
                extractApiErrorMessage(error) ??
                (error instanceof Error ? error.message : "Failed to dispatch"),
            };
          }
        },
      );

      const okResults = results.filter(
        (result): result is Extract<BatchDispatchResult, { ok: true }> =>
          result.ok,
      );
      const failedResults = results.filter(
        (result): result is Extract<BatchDispatchResult, { ok: false }> =>
          !result.ok,
      );

      const scheduledTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.scheduledCount ?? 0),
        0,
      );
      const queuedTaskTotal = okResults.reduce(
        (sum, result) =>
          sum +
          (result.payload.mode === "rss"
            ? 0
            : (result.payload.scheduledCount ?? 0)),
        0,
      );
      const queuedJobTotal = okResults.reduce(
        (sum, result) =>
          sum +
          (result.payload.mode === "rss"
            ? (result.payload.scheduledCount ?? 0)
            : 0),
        0,
      );
      const enqueueFailuresTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.enqueueFailures ?? 0),
        0,
      );
      const skippedTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.skippedCount ?? 0),
        0,
      );
      const rssNoBodySkippedTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.rssSkippedNoBodyCount ?? 0),
        0,
      );

      const conflictCount = failedResults.filter(
        (result) => result.kind === "conflict",
      ).length;
      const requestFailureCount = failedResults.length - conflictCount;

      const warning = requestFailureCount > 0 || enqueueFailuresTotal > 0;
      const messageType = warning
        ? "warning"
        : conflictCount > 0
          ? "info"
          : "success";
      const useDetailedBatchMessage =
        queuedJobTotal > 0 || rssNoBodySkippedTotal > 0;
      messageApi.open({
        type: messageType,
        content: useDetailedBatchMessage
          ? t("newsSources.messages.batchDispatchDetailed", {
              sources: targets.length,
              tasks: queuedTaskTotal,
              jobs: queuedJobTotal,
              skipped: skippedTotal,
              rssNoBody: rssNoBodySkippedTotal,
              enqueueFailures: enqueueFailuresTotal,
              conflicts: conflictCount,
              failures: requestFailureCount,
            })
          : t("newsSources.messages.batchDispatch", {
              sources: targets.length,
              tasks: scheduledTotal,
              skipped: skippedTotal,
              enqueueFailures: enqueueFailuresTotal,
              conflicts: conflictCount,
              failures: requestFailureCount,
            }),
      });

      setSelectedSourceIds([]);
      await loadSources();
    } finally {
      setBatchRunLoading(false);
    }
  };

  const handleCancelQueued = async (source: NewsSourceRecord) => {
    Modal.confirm({
      title: t("newsSources.ops.cancelQueued.title"),
      content: t("newsSources.ops.cancelQueued.description"),
      okText: t("newsSources.ops.cancelQueued.ok"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setOpsLoadingSourceIds((prev) => {
          const next = new Set(prev);
          next.add(source.id);
          return next;
        });
        try {
          const response = await apiClient.post<NewsSourceCancelQueuedResponse>(
            `admin/news-sources/${source.id}/cancel-queued`,
          );
          const payload = response.data;
          messageApi.success(
            t("newsSources.ops.cancelQueued.done", {
              removed: payload.removedJobs ?? 0,
              scanned: payload.scannedJobs ?? 0,
            }),
          );
          await loadSources();
        } catch (error) {
          captureClientError("Failed to cancel queued crawls", error);
          messageApi.error(
            extractApiErrorMessage(error) ??
              t("newsSources.ops.cancelQueued.failed"),
          );
        } finally {
          setOpsLoadingSourceIds((prev) => {
            const next = new Set(prev);
            next.delete(source.id);
            return next;
          });
        }
      },
    });
  };

  const handleClearInflight = async (source: NewsSourceRecord) => {
    Modal.confirm({
      title: t("newsSources.ops.clearInflight.title"),
      content: t("newsSources.ops.clearInflight.description"),
      okText: t("newsSources.ops.clearInflight.ok"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setOpsLoadingSourceIds((prev) => {
          const next = new Set(prev);
          next.add(source.id);
          return next;
        });
        try {
          const response =
            await apiClient.post<NewsSourceClearInflightResponse>(
              `admin/news-sources/${source.id}/clear-inflight`,
            );
          const payload = response.data;
          messageApi.success(
            t("newsSources.ops.clearInflight.done", {
              count: payload.clearedJobs ?? 0,
            }),
          );
          await loadSources();
        } catch (error) {
          captureClientError("Failed to clear inflight jobs", error);
          messageApi.error(
            extractApiErrorMessage(error) ??
              t("newsSources.ops.clearInflight.failed"),
          );
        } finally {
          setOpsLoadingSourceIds((prev) => {
            const next = new Set(prev);
            next.delete(source.id);
            return next;
          });
        }
      },
    });
  };

  const handleRetryLatestFailedTask = async (source: NewsSourceRecord) => {
    setOpsLoadingSourceIds((prev) => {
      const next = new Set(prev);
      next.add(source.id);
      return next;
    });
    try {
      const response = await apiClient.post<NewsSourceRetryLatestResponse>(
        `admin/news-sources/${source.id}/retry-latest`,
      );
      const payload = response.data;
      await loadSources();

      if (!payload?.retried) {
        messageApi.info(
          t(
            payload?.retryType === "pipeline"
              ? "newsSources.ops.retryLatest.skippedPipeline"
              : "newsSources.ops.retryLatest.skipped",
            {
              defaultValue:
                payload?.retryType === "pipeline"
                  ? "Latest pipeline job is not failed (status: {{status}})."
                  : "Latest task is not failed (status: {{status}}).",
              status: payload?.status ?? "unknown",
            },
          ),
        );
        return;
      }

      messageApi.success(
        payload.retryType === "crawl" && payload.crawlTaskId ? (
          <Space size={8} wrap>
            <span>
              {t("newsSources.ops.retryLatest.done")}
            </span>
            <Button
              type="link"
              size="small"
              onClick={() =>
                router.push(`/admin/ops/crawl-tasks/${payload.crawlTaskId}`)
              }
            >
              {t("newsSources.actions.openTask")}
            </Button>
          </Space>
        ) : (
          t("newsSources.ops.retryLatest.donePipeline")
        ),
      );
    } catch (error) {
      captureClientError("Failed to retry latest failed task", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.ops.retryLatest.failed"),
      );
    } finally {
      setOpsLoadingSourceIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
    }
  };

  const openSchedule = (source: NewsSourceRecord) => {
    const candidate = source.nextRunAt ? dayjs(source.nextRunAt) : null;
    const initial =
      candidate && candidate.isValid() && candidate.isAfter(dayjs())
        ? candidate
        : dayjs().add(5, "minute");
    setScheduleTargets([source]);
    setScheduleOpen(true);
    scheduleForm.setFieldsValue({ nextRunAt: initial });
  };

  const openBatchSchedule = (targets: NewsSourceRecord[]) => {
    if (targets.length === 0) {
      return;
    }
    setScheduleTargets(targets);
    setScheduleOpen(true);
    scheduleForm.setFieldsValue({ nextRunAt: dayjs().add(5, "minute") });
  };

  const closeSchedule = () => {
    setScheduleOpen(false);
    setScheduleTargets([]);
    scheduleForm.resetFields();
  };

  const handleSchedule = async (values: NewsSourceScheduleValues) => {
    const targets = scheduleTargets;
    if (!targets || targets.length === 0) {
      return;
    }

    if (!values.nextRunAt?.isValid?.() || values.nextRunAt.isBefore(dayjs())) {
      messageApi.error(
        t("newsSources.schedule.validation.future"),
      );
      return;
    }

    setScheduleLoading(true);
    try {
      const scheduledAtIso = values.nextRunAt.toISOString();
      const results = await Promise.allSettled(
        targets.map((target) =>
          apiClient.post(`admin/news-sources/${target.id}/schedule`, {
            nextRunAt: scheduledAtIso,
          }),
        ),
      );
      const okCount = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      const failedCount = results.length - okCount;
      const timeLabel = formatDateTime(scheduledAtIso, locale, {
        dateStyle: "medium",
        timeStyle: "short",
      });

      if (failedCount > 0) {
        messageApi.warning(
          t("newsSources.messages.scheduledBatchPartial", {
            ok: okCount,
            total: results.length,
            time: timeLabel,
          }),
        );
      } else {
        messageApi.success(
          t("newsSources.messages.scheduledBatch", {
            count: okCount,
            time: timeLabel,
          }),
        );
      }
      closeSchedule();
      setSelectedSourceIds([]);
      await loadSources();
    } catch (error) {
      captureClientError("Failed to schedule news source", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          (error instanceof Error
            ? error.message
            : t("newsSources.errors.runFailed")),
      );
    } finally {
      setScheduleLoading(false);
    }
  };

  const handleDelete = (source: NewsSourceRecord) => {
    Modal.confirm({
      title: t("newsSources.delete.title"),
      content: t("newsSources.delete.description"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await apiClient.delete(`admin/news-sources/${source.id}`);
          await loadSources();
          messageApi.success(
            t("newsSources.messages.deleted"),
          );
        } catch (error) {
          captureClientError("Failed to delete news source", error);
          messageApi.error(
            t("newsSources.errors.deleteFailed"),
          );
        }
      },
    });
  };

  const handlePreview = async (source: NewsSourceRecord) => {
    setPreviewSource(source);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const response = await apiClient.get<NewsSourcePreviewResponse>(
        `admin/news-sources/${source.id}/preview`,
      );
      setPreviewData(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to preview news source", error);
      const detail =
        extractApiErrorMessage(error) ??
        (error instanceof Error ? error.message : null);
      messageApi.error(
        detail ??
          t("newsSources.errors.previewFailed"),
      );
      setPreviewOpen(false);
      setPreviewSource(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const reloadPreview = async () => {
    if (!previewSource) {
      return;
    }
    await handlePreview(previewSource);
  };

  const handleRunNowFromPreview = async () => {
    if (!previewSource) {
      return;
    }
    setPreviewRunNowLoading(true);
    try {
      await handleRunNow(previewSource);
    } finally {
      setPreviewRunNowLoading(false);
    }
  };

  const handleScheduleFromPreview = () => {
    if (!previewSource) {
      return;
    }
    const source = previewSource;
    setPreviewOpen(false);
    setPreviewSource(null);
    setPreviewData(null);
    openSchedule(source);
  };

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Typography.Text type="secondary">
          {t("common.loading")}
        </Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("newsSources.title")}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  const schedulerSettingsHref = buildAdminSettingsHref({
    page: "ingestion",
    panel: "news-source-scheduler",
  });
  const readinessState = !readinessSummary
    ? null
    : readinessSummary.total === 0
      ? "empty"
      : readinessSummary.active === 0
        ? "inactive"
        : readinessSummary.circuitOpen > 0 || readinessSummary.failing > 0
          ? "degraded"
          : "ready";
  const readinessTone =
    readinessState === "empty"
      ? "info"
      : readinessState === "inactive" || readinessState === "degraded"
        ? "warning"
        : "success";

  const columns: ColumnsType<NewsSourceRecord> = [
    {
      title: t("newsSources.columns.name"),
      dataIndex: "name",
      key: "name",
      width: 320,
      render: (_, record) => {
        const mode = getSeedMode(record.config);
        const modeTag =
          mode === null
            ? null
            : (() => {
                const color =
                  mode === "rss"
                    ? "blue"
                    : mode === "list"
                      ? "gold"
                      : mode === "deep"
                        ? "geekblue"
                        : "purple";
                const label =
                  mode === "rss"
                    ? t("newsSources.seedMode.rss")
                    : mode === "list"
                      ? t("newsSources.seedMode.list")
                      : mode === "deep"
                        ? t("newsSources.seedMode.deep")
                        : t("newsSources.seedMode.sitemap");
                return <Tag color={color}>{label}</Tag>;
              })();
        const rssAdaptive = resolveRssAdaptiveObservability(record);
        const rssAdaptiveTierColor =
          rssAdaptive?.tier === "hot"
            ? "volcano"
            : rssAdaptive?.tier === "warm"
              ? "gold"
              : rssAdaptive?.tier === "cold"
                ? "blue"
                : "default";
        const rssAdaptiveTierLabel =
          rssAdaptive?.tier === "hot"
            ? t("newsSources.rssAdaptive.tier.hot")
            : rssAdaptive?.tier === "warm"
              ? t("newsSources.rssAdaptive.tier.warm")
              : rssAdaptive?.tier === "cold"
                ? t("newsSources.rssAdaptive.tier.cold")
                : t("newsSources.rssAdaptive.tier.normal");

        return (
          <Space direction="vertical" size={2}>
            <Space size={8} wrap>
              <Typography.Text strong>{record.name}</Typography.Text>
              {modeTag}
              {rssAdaptive ? (
                <Tooltip
                  title={
                    <Space direction="vertical" size={0}>
                      <Typography.Text>
                        {t("newsSources.rssAdaptive.tooltip.hitRate", {
                          value:
                            typeof rssAdaptive.hitRate === "number"
                              ? `${Math.round(rssAdaptive.hitRate * 100)}%`
                              : t("common.emptyValue"),
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {rssAdaptive.hasHistory
                          ? t(
                              "newsSources.rssAdaptive.tooltip.consecutiveNoHit",
                              {
                                value: rssAdaptive.consecutiveNoHit,
                              },
                            )
                          : t("newsSources.rssAdaptive.tooltip.noHistory")}
                      </Typography.Text>
                      {rssAdaptive.updatedAt ? (
                        <Typography.Text type="secondary">
                          {t("newsSources.rssAdaptive.tooltip.updatedAt", {
                            value: formatDateTime(
                              rssAdaptive.updatedAt,
                              locale,
                              {
                                dateStyle: "medium",
                                timeStyle: "short",
                              },
                            ),
                          })}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                >
                  <Tag color={rssAdaptiveTierColor}>
                    {t("newsSources.rssAdaptive.tierTag", {
                      tier: rssAdaptiveTierLabel,
                    })}
                  </Tag>
                </Tooltip>
              ) : null}
              {rssAdaptive ? (
                <Tag>
                  {t("newsSources.rssAdaptive.intervalTag", {
                    seconds: rssAdaptive.effectiveIntervalSeconds,
                  })}
                </Tag>
              ) : null}
              {rssAdaptive ? (
                <Tag>
                  {t("newsSources.rssAdaptive.discoveryTtlTag", {
                    seconds: rssAdaptive.effectiveDiscoveryCacheTtlSeconds,
                  })}
                </Tag>
              ) : null}
            </Space>
            <Space size={6} wrap>
              {record.crawlTaskQueuedCount > 0 ? (
                <Tag color="cyan">
                  {t("newsSources.queueCounts.queued", {
                    count: record.crawlTaskQueuedCount,
                  })}
                </Tag>
              ) : null}
              {record.crawlTaskRunningCount > 0 ? (
                <Tag color="blue">
                  {t("newsSources.queueCounts.active", {
                    count: record.crawlTaskRunningCount,
                  })}
                </Tag>
              ) : null}
              <Button
                size="small"
                type="link"
                onClick={() =>
                  router.push(`/admin/ops/crawl-tasks?sourceId=${record.id}`)
                }
              >
                {t("newsSources.actions.viewTasks")}
              </Button>
            </Space>
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: record.url }}
            >
              {record.url}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.type"),
      dataIndex: "siteType",
      key: "siteType",
      width: 110,
      render: (value: string) => {
        const label =
          siteTypeOptions.find((option) => option.value === value)?.label ??
          value;
        return <Tag>{label}</Tag>;
      },
    },
    {
      title: t("newsSources.columns.template"),
      dataIndex: "crawlTemplateId",
      key: "crawlTemplateId",
      width: 160,
      render: (value?: string | null) => {
        if (!value) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        const template = templateMap.get(value);
        if (!template) {
          return <Tag color="default">{value}</Tag>;
        }
        return (
          <Tag color={template.isActive ? "blue" : "orange"}>
            {template.isActive
              ? template.name
              : `${template.name} (${t("common.disabled")})`}
          </Tag>
        );
      },
    },
    {
      title: t("newsSources.columns.strategy"),
      key: "strategy",
      width: 300,
      render: (_: unknown, record) => {
        const strategyTags = getCrawlStrategyTags(record.config, t);
        if (!strategyTags.length) {
          return (
            <Typography.Text type="secondary">
              {t("newsSources.columns.strategyEmpty")}
            </Typography.Text>
          );
        }
        return (
          <Space wrap size={[4, 4]}>
            {strategyTags.map((tag) => (
              <Tag key={tag.key} color={tag.color}>
                {tag.label}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.frequency"),
      dataIndex: "frequencySeconds",
      key: "frequencySeconds",
      width: 120,
    },
    {
      title: t("newsSources.columns.priority"),
      dataIndex: "priority",
      key: "priority",
      width: 90,
    },
    {
      title: t("newsSources.columns.status"),
      dataIndex: "isActive",
      key: "isActive",
      width: 170,
      render: (value: boolean, record) => {
        const failureCount = Number(record.consecutiveFailures ?? 0);
        const circuitOpenUntil = record.circuitOpenUntil
          ? new Date(record.circuitOpenUntil)
          : null;
        const circuitOpen = circuitOpenUntil
          ? circuitOpenUntil.getTime() > Date.now()
          : false;
        const lastFailureAt = record.lastFailureAt ?? null;

        const healthTag = circuitOpen ? (
          <Tooltip
            title={
              circuitOpenUntil
                ? t("newsSources.health.circuitOpenUntil", {
                    time: formatDateTime(
                      circuitOpenUntil.toISOString(),
                      locale,
                      {
                        dateStyle: "medium",
                        timeStyle: "short",
                      },
                    ),
                  })
                : t("newsSources.health.circuitOpen")
            }
          >
            <Tag color="red">
              {t("newsSources.health.circuitOpen")}
            </Tag>
          </Tooltip>
        ) : failureCount > 0 ? (
          <Tooltip
            title={
              lastFailureAt
                ? t("newsSources.health.lastFailureAt", {
                    time: formatDateTime(lastFailureAt, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })
                : t("newsSources.health.failing")
            }
          >
            <Tag color="orange">
              {t("newsSources.health.failingCount", {
                count: failureCount,
              })}
            </Tag>
          </Tooltip>
        ) : value ? (
          <Tag color="green">
            {t("newsSources.health.healthy")}
          </Tag>
        ) : null;

        return (
          <Space direction="vertical" size={2}>
            {canManage ? (
              <Switch
                checked={value}
                onChange={(next) => void handleToggleActive(record, next)}
              />
            ) : (
              <Tag color={value ? "green" : "default"}>
                {value ? t("common.enabled") : t("common.disabled")}
              </Tag>
            )}
            {healthTag}
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.nextRun"),
      dataIndex: "nextRunAt",
      key: "nextRunAt",
      width: 190,
      render: (value: string | null | undefined, record) => {
        if (!value) {
          return t("common.never");
        }
        const scheduled = dayjs(value);
        const overdue = scheduled.isValid() && scheduled.isBefore(dayjs());
        const backpressureUntil = record.backpressureUntil;
        const backpressurePendingJobs = record.backpressurePendingJobs;
        const backpressureThreshold = record.backpressureThreshold;
        const backpressureAt = backpressureUntil
          ? dayjs(backpressureUntil)
          : null;
        const isBackpressured = Boolean(
          backpressureAt &&
            backpressureAt.isValid() &&
            backpressureAt.isAfter(dayjs()),
        );
        return (
          <Space size={6} wrap>
            {overdue ? (
              <Tag color="gold">
                {t("newsSources.nextRun.due")}
              </Tag>
            ) : null}
            {isBackpressured && backpressureUntil ? (
              <Tooltip
                title={
                  <Space direction="vertical" size={0}>
                    <Typography.Text>
                      {typeof backpressurePendingJobs === "number" &&
                      typeof backpressureThreshold === "number"
                        ? t("newsSources.nextRun.backpressureReason", {
                            pendingJobs: backpressurePendingJobs,
                            threshold: backpressureThreshold,
                          })
                        : t("newsSources.nextRun.backpressureReasonFallback")}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("newsSources.nextRun.backpressureUntil", {
                        time: formatDateTime(backpressureUntil, locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })}
                    </Typography.Text>
                  </Space>
                }
              >
                <Tag color="orange">
                  {t("newsSources.nextRun.backpressure")}
                </Tag>
              </Tooltip>
            ) : null}
            <Typography.Text>
              {formatDateTime(value, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.lastRun"),
      dataIndex: "lastRunAt",
      key: "lastRunAt",
      width: 160,
      render: (value?: string | null) =>
        value
          ? formatDateTime(value, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : t("common.never"),
    },
    {
      title: t("newsSources.columns.lastSuccess"),
      dataIndex: "lastSuccessAt",
      key: "lastSuccessAt",
      width: 160,
      responsive: ["md"],
      render: (value?: string | null) =>
        value
          ? formatDateTime(value, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : t("common.never"),
    },
    {
      title: t("newsSources.columns.stats24h"),
      key: "stats24h",
      width: 110,
      responsive: ["md"],
      render: (_: unknown, record) => {
        const completed = record.stats24h?.completed ?? 0;
        const failed = record.stats24h?.failed ?? 0;
        const successRate =
          typeof record.stats24h?.successRate === "number"
            ? record.stats24h.successRate
            : null;
        const avgDurationMs =
          typeof record.stats24h?.avgDurationMs === "number" &&
          Number.isFinite(record.stats24h.avgDurationMs)
            ? record.stats24h.avgDurationMs
            : null;
        const backpressureCount = record.backpressureCount24h ?? 0;

        const rateLabel =
          typeof successRate === "number" && Number.isFinite(successRate)
            ? `${Math.round(successRate * 100)}%`
            : t("common.emptyValue");
        const color =
          typeof successRate === "number" && Number.isFinite(successRate)
            ? successRate >= 0.9
              ? "green"
              : successRate >= 0.7
                ? "orange"
                : "red"
            : "default";

        const avgLabel =
          typeof avgDurationMs === "number" && Number.isFinite(avgDurationMs)
            ? `${(avgDurationMs / 1000).toFixed(1)}s`
            : t("common.emptyValue");

        return (
          <Tooltip
            title={
              <Space direction="vertical" size={0}>
                <Typography.Text>
                  {t("newsSources.stats24h.jobs", {
                    ok: completed,
                    fail: failed,
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("newsSources.stats24h.avgDuration", {
                    value: avgLabel,
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("newsSources.stats24h.backpressure", {
                    count: backpressureCount,
                  })}
                </Typography.Text>
              </Space>
            }
          >
            <Space direction="vertical" size={2}>
              <Tag color={color}>{rateLabel}</Tag>
              <Typography.Text type="secondary">
                {t("newsSources.stats24h.jobsShort", {
                  ok: completed,
                  fail: failed,
                })}
              </Typography.Text>
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: t("newsSources.columns.latest"),
      key: "latest",
      width: 380,
      responsive: ["md"],
      render: (_: unknown, record) => {
        const job = record.latestJob ?? null;
        const task = record.latestCrawlTask ?? null;
        const article = record.latestArticle ?? null;
        const jobError = job?.error ?? null;
        const taskError = task?.lastError ?? null;
        const ingestPath =
          job?.metadata && isPlainObject(job.metadata)
            ? (job.metadata.ingestPath as string | undefined)
            : undefined;
        const isRssPrefetched = ingestPath === "rss_prefetched";
        const prefetchedMarkdownSource =
          job?.metadata &&
          isPlainObject(job.metadata) &&
          typeof job.metadata.prefetchedMarkdownSource === "string"
            ? job.metadata.prefetchedMarkdownSource.trim().toLowerCase()
            : "";

        const jobTag = job ? (
          <Tooltip
            title={
              jobError
                ? t("newsSources.latest.jobError", {
                    error: jobError,
                  })
                : t("newsSources.latest.jobId", {
                    id: job.id,
                  })
            }
          >
            <Tag color={pipelineJobStatusColors[job.status] ?? "default"}>
              {job.status}
            </Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        );
        const ingestPathTag = isRssPrefetched ? (
          <Tag color="cyan">
            {t("newsSources.latest.rssPrefetched")}
          </Tag>
        ) : null;
        const prefetchedMarkdownSourceTag =
          prefetchedMarkdownSource === "content" ? (
            <Tag color="green">
              {t("newsSources.latest.rssPrefetchedContent")}
            </Tag>
          ) : prefetchedMarkdownSource === "description" ? (
            <Tag color="gold">
              {t("newsSources.latest.rssPrefetchedSummary")}
            </Tag>
          ) : prefetchedMarkdownSource === "stub" ? (
            <Tag color="orange">
              {t("newsSources.latest.rssPrefetchedStub")}
            </Tag>
          ) : null;

        const taskTag = task ? (
          <Tooltip
            title={
              taskError
                ? t("newsSources.latest.taskError", {
                    error: taskError,
                  })
                : t("newsSources.latest.taskId", {
                    id: task.id,
                  })
            }
          >
            <Tag color={crawlTaskStatusColors[task.status] ?? "default"}>
              {task.status}
            </Tag>
          </Tooltip>
        ) : null;
        const noTaskHint =
          !task && isRssPrefetched ? (
            <Typography.Text type="secondary">
              {t("newsSources.latest.noCrawlTask")}
            </Typography.Text>
          ) : null;

        const openTaskButton = task ? (
          <Button
            size="small"
            onClick={() => router.push(`/admin/ops/crawl-tasks/${task.id}`)}
          >
            {t("newsSources.actions.openTask")}
          </Button>
        ) : null;

        const articleLink = article ? (
          <Typography.Link
            href={article.url}
            target="_blank"
            rel="noreferrer"
            ellipsis
            title={article.url}
          >
            {article.titleGuess?.trim()
              ? article.titleGuess.trim()
              : article.url}
          </Typography.Link>
        ) : null;

        return (
          <Space direction="vertical" size={2}>
            <Space size={6} wrap>
              {jobTag}
              {ingestPathTag}
              {prefetchedMarkdownSourceTag}
              {taskTag}
              {openTaskButton}
            </Space>
            {job?.createdAt ? (
              <Typography.Text type="secondary">
                {formatDateTime(job.createdAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
            ) : null}
            {articleLink}
            {noTaskHint}
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.group"),
      dataIndex: "group",
      key: "group",
      width: 140,
      render: (group: string | null) => (group ? <Tag>{group}</Tag> : null),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 340,
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => void handlePreview(record)}>
            {t("newsSources.actions.preview")}
          </Button>
          {canManage ? (
            <Button size="small" onClick={() => openEdit(record)}>
              {t("common.edit")}
            </Button>
          ) : null}
          {canManage ? (
            <Tooltip
              title={
                record.nextRunAt
                  ? t("newsSources.schedule.current", {
                      time: formatDateTime(record.nextRunAt, locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })
                  : t("newsSources.schedule.none")
              }
            >
              <Button size="small" onClick={() => openSchedule(record)}>
                {record.nextRunAt
                  ? t("newsSources.actions.reschedule")
                  : t("newsSources.actions.schedule")}
              </Button>
            </Tooltip>
          ) : null}
          {canManage ? (
            <Button
              size="small"
              onClick={() => void handleRunNow(record)}
              loading={dispatchingSourceIds.has(record.id)}
              disabled={dispatchingSourceIds.has(record.id)}
            >
              {t("newsSources.actions.runNow")}
            </Button>
          ) : null}
          {canManage ? (
            <Dropdown
              menu={{
                items: [
                  {
                    key: "view-tasks",
                    label: t("newsSources.actions.viewTasks"),
                    onClick: () =>
                      router.push(
                        `/admin/ops/crawl-tasks?sourceId=${record.id}`,
                      ),
                  },
                  { type: "divider" },
                  {
                    key: "retry-latest",
                    label: t("newsSources.ops.retryLatest.label"),
                    onClick: () => void handleRetryLatestFailedTask(record),
                  },
                  {
                    key: "cancel-queued",
                    label: t("newsSources.ops.cancelQueued.label"),
                    onClick: () => void handleCancelQueued(record),
                  },
                  {
                    key: "clear-inflight",
                    label: t("newsSources.ops.clearInflight.label"),
                    onClick: () => void handleClearInflight(record),
                  },
                ],
              }}
              placement="bottomRight"
              trigger={["click"]}
            >
              <Button size="small" loading={opsLoadingSourceIds.has(record.id)}>
                {t("newsSources.actions.ops")}
              </Button>
            </Dropdown>
          ) : null}
          {canManage ? (
            <Button size="small" danger onClick={() => handleDelete(record)}>
              {t("common.delete")}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const previewColumns: ColumnsType<NewsSourcePreviewCandidate> = [
    {
      title: t("newsSources.preview.columns.url"),
      dataIndex: "url",
      key: "url",
      render: (value: string, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Link
            href={value}
            target="_blank"
            rel="noreferrer"
            title={value}
            ellipsis
          >
            {value}
          </Typography.Link>
          {record.title ? (
            <Typography.Text type="secondary">{record.title}</Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("newsSources.preview.columns.relevance"),
      dataIndex: "relevanceScore",
      key: "relevanceScore",
      width: 110,
      render: (value?: number) =>
        typeof value === "number" && Number.isFinite(value)
          ? value.toFixed(3)
          : "-",
    },
    {
      title: t("newsSources.preview.columns.timeSignal"),
      key: "timeSignal",
      width: 220,
      render: (_: unknown, record) => {
        if (record.publishedAt) {
          return (
            <Space direction="vertical" size={2}>
              <Typography.Text>
                {formatDateTime(record.publishedAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
              <Tag color="green">
                {t("newsSources.preview.timePublished")}
              </Tag>
            </Space>
          );
        }

        if (record.crawledAt) {
          return (
            <Space direction="vertical" size={2}>
              <Typography.Text>
                {formatDateTime(record.crawledAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
              <Space size={4} wrap>
                <Tag color="blue">
                  {t("newsSources.preview.timeCrawled")}
                </Tag>
                <Tag color="orange">
                  {t("newsSources.preview.publishDateMissing")}
                </Tag>
              </Space>
            </Space>
          );
        }

        return <Typography.Text type="secondary">-</Typography.Text>;
      },
    },
    {
      title: t("newsSources.preview.columns.status"),
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: NewsSourcePreviewCandidate["status"]) =>
        value === "success" ? (
          <Tag color="green">
            {t("common.success")}
          </Tag>
        ) : (
          <Tag color="red">
            {t("common.failed")}
          </Tag>
        ),
    },
    {
      title: t("newsSources.preview.columns.dedupe"),
      dataIndex: "alreadyCrawled",
      key: "alreadyCrawled",
      width: 160,
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          {record.alreadyCrawled ? (
            <Tag color="default">
              {t("newsSources.preview.alreadyCrawled")}
            </Tag>
          ) : (
            <Tag color="blue">
              {t("newsSources.preview.newUrl")}
            </Tag>
          )}
          {record.alreadyQueued ? (
            <Tooltip
              title={
                record.inFlightStatus
                  ? t("newsSources.preview.inFlightStatus", {
                      status: record.inFlightStatus,
                    })
                  : t("newsSources.preview.inFlight")
              }
            >
              <Tag color="orange">
                {t("newsSources.preview.inFlight")}
              </Tag>
            </Tooltip>
          ) : null}
          {record.lastCrawlAt
            ? formatDateTime(record.lastCrawlAt, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })
            : null}
        </Space>
      ),
    },
    {
      title: t("newsSources.preview.columns.error"),
      dataIndex: "error",
      key: "error",
      render: (value?: string) =>
        value ? (
          <Tooltip title={value}>
            <Typography.Text type="danger" ellipsis={{ tooltip: value }}>
              {value}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
  ];

  return (
    <>
      {contextHolder}
      <Card
        className="content-card"
        title={t("newsSources.title")}
        extra={
          <Space wrap>
            <Button
              size="small"
              onClick={() => void refreshAll()}
              loading={loading || crawlQueueLoading}
            >
              {t("common.refresh")}
            </Button>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("newsSources.autoRefresh.label")}
              </Typography.Text>
              <Switch
                checked={autoRefreshEnabled}
                onChange={(checked) => setAutoRefreshEnabled(checked)}
              />
              <InputNumber
                min={5}
                max={300}
                step={5}
                value={autoRefreshSeconds}
                onChange={(value) =>
                  setAutoRefreshSeconds(typeof value === "number" ? value : 30)
                }
                style={{ width: 88 }}
                disabled={!autoRefreshEnabled}
              />
              <Typography.Text type="secondary">s</Typography.Text>
            </Space>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("newsSources.liveUpdates.label")}
              </Typography.Text>
              <Switch
                checked={liveUpdatesEnabled}
                onChange={(checked) => setLiveUpdatesEnabled(checked)}
              />
              {liveUpdatesEnabled ? (
                <Popover
                  content={livePopoverContent}
                  trigger="click"
                  placement="bottomRight"
                >
                  <Tag
                    style={{ cursor: "pointer" }}
                    color={
                      liveError
                        ? "red"
                        : liveStatus === "connected"
                          ? "green"
                          : liveStatus === "connecting"
                            ? "blue"
                            : undefined
                    }
                  >
                    {liveError
                      ? t("newsSources.liveUpdates.error")
                      : liveStatus === "connected"
                        ? t("newsSources.liveUpdates.connected")
                        : liveStatus === "connecting"
                          ? t("newsSources.liveUpdates.connecting")
                          : t("newsSources.liveUpdates.disconnected")}
                    {liveStatus === "connected" && liveEventCount > 0
                      ? ` · ${liveEventCount}`
                      : ""}
                  </Tag>
                </Popover>
              ) : null}
            </Space>
            {canManage ? (
              <Space>
                <Button onClick={() => void openOpmlImport()}>
                  {t("newsSources.actions.importOpml")}
                </Button>
                <Button type="primary" onClick={openCreate}>
                  {t("newsSources.actions.new")}
                </Button>
              </Space>
            ) : null}
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Crawl4aiHealthCard
            onOpenMonitor={() => router.push("/admin/ops/crawl-monitor")}
          />
          <Card
            size="small"
            title={t("newsSources.readiness.title")}
            extra={
              <Button
                size="small"
                onClick={() => void loadReadinessSummary()}
                loading={readinessLoading}
              >
                {t("common.refresh")}
              </Button>
            }
          >
            {readinessError ? (
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.readiness.loadFailed")}
                description={readinessError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            {readinessSummary ? (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Alert
                  type={readinessTone}
                  showIcon
                  message={
                    readinessState === "empty"
                      ? t("newsSources.readiness.noSourcesConfigured")
                      : readinessState === "inactive"
                      ? t("newsSources.readiness.noActiveSources")
                      : readinessState === "degraded"
                        ? t("newsSources.readiness.degraded")
                        : t("newsSources.readiness.ready")
                  }
                  description={
                    readinessState === "empty"
                      ? t("newsSources.readiness.noSourcesConfiguredDescription")
                      : readinessState === "inactive"
                      ? t("newsSources.readiness.noActiveSourcesDescription")
                      : readinessState === "degraded"
                        ? t("newsSources.readiness.degradedDescription")
                        : undefined
                  }
                  action={
                    canManage ? (
                      <Space wrap>
                        <Button size="small" onClick={openCreate}>
                          {t("newsSources.actions.new")}
                        </Button>
                        <Button
                          size="small"
                          onClick={() => void openOpmlImport()}
                        >
                          {t("newsSources.actions.importOpml")}
                        </Button>
                        <Button size="small" href={schedulerSettingsHref}>
                          {t("newsSources.readiness.openSchedulerSettings")}
                        </Button>
                      </Space>
                    ) : null
                  }
                />
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.total")}
                      value={readinessSummary.total}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.active")}
                      value={readinessSummary.active}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.inactive")}
                      value={readinessSummary.inactive}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.circuitOpen")}
                      value={readinessSummary.circuitOpen}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.failing")}
                      value={readinessSummary.failing}
                    />
                  </Col>
                </Row>
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {readinessLoading
                  ? t("common.loading")
                  : t("common.noData")}
              </Typography.Text>
            )}
          </Card>
          <Card
            size="small"
            title={t("newsSources.queue.title")}
            extra={
              <Button
                size="small"
                onClick={() => void loadCrawlQueueStats()}
                loading={crawlQueueLoading}
              >
                {t("common.refresh")}
              </Button>
            }
          >
            {crawlQueueError ? (
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.queue.loadFailed")}
                description={crawlQueueError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            {crawlQueueStats ? (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.pending")}
                      value={crawlQueueStats.pending}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.waiting")}
                      value={crawlQueueStats.counts.waiting ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.active")}
                      value={crawlQueueStats.counts.active ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.delayed")}
                      value={crawlQueueStats.counts.delayed ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.failed")}
                      value={crawlQueueStats.counts.failed ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.concurrency")}
                      value={crawlQueueStats.maxConcurrency ?? "-"}
                    />
                  </Col>
                </Row>
                <Typography.Text type="secondary">
                  {t("newsSources.queue.updatedAt", {
                    time: formatDateTime(crawlQueueStats.updatedAt, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </Typography.Text>
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {crawlQueueLoading
                  ? t("common.loading")
                  : t("common.noData")}
              </Typography.Text>
            )}
          </Card>

          <Card
            size="small"
            title={t("newsSources.quality.title")}
            extra={
              <Space size={8}>
                <Button
                  size="small"
                  onClick={() => void router.push("/admin/alerts")}
                >
                  {t("newsSources.quality.manageThresholds")}
                </Button>
                <Button
                  size="small"
                  onClick={() => void loadCrawlQualityStats()}
                  loading={crawlQualityLoading}
                >
                  {t("common.refresh")}
                </Button>
              </Space>
            }
          >
            {crawlQualityError ? (
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.quality.loadFailed")}
                description={crawlQualityError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            {crawlQualityStats ? (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.taskCount")}
                      value={crawlQualityStats.taskCount}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.lowSignal")}
                      value={Number(
                        (crawlQualityStats.lowSignalRatio * 100).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.emptyMarkdown")}
                      value={Number(
                        (crawlQualityStats.emptyMarkdownRate * 100).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.expansionTrigger")}
                      value={Number(
                        (crawlQualityStats.expansionTriggerRate * 100).toFixed(
                          1,
                        ),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.expansionSuccess")}
                      value={Number(
                        (crawlQualityStats.expansionSuccessRate * 100).toFixed(
                          1,
                        ),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.avgMarkdownChars")}
                      value={crawlQualityStats.avgMarkdownChars}
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.publishConfidenceRejects")}
                      value={
                        crawlQualityStats.candidateRejects?.publishConfidence ??
                        0
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.patternRejects")}
                      value={
                        (crawlQualityStats.candidateRejects?.includePattern ??
                          0) +
                        (crawlQualityStats.candidateRejects?.excludePattern ??
                          0)
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.fitMarkdownPreference")}
                      value={Number(
                        (
                          (crawlQualityStats.fitMarkdownPreferenceRate ?? 0) *
                          100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.headSignalSuccess")}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalSuccessRate ?? 0) * 100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.headSignalSoftFailure")}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalSoftFailureRate ?? 0) *
                          100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.headSignalTruncated")}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalTruncatedRate ?? 0) * 100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t(
                        "newsSources.quality.headSignalNoPublishSignal",
                      )}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalNoPublishSignalRate ??
                            0) * 100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={
                        <Space size={4} wrap>
                          <span>
                            {t("newsSources.quality.http304HitRate")}
                          </span>
                          <Tag
                            color={
                              (crawlQualityThresholdStatus?.preflightRunCount ??
                                0) <= 0
                                ? "default"
                                : crawlQualityThresholdStatus?.http304Breached
                                ? "red"
                                : "green"
                            }
                          >
                            {(crawlQualityThresholdStatus?.preflightRunCount ??
                              0) <= 0
                              ? t("newsSources.quality.thresholdStatusNoData")
                              : crawlQualityThresholdStatus?.http304Breached
                                ? t(
                                    "newsSources.quality.thresholdStatusBreached",
                                  )
                                : t(
                                    "newsSources.quality.thresholdStatusNormal",
                                  )}
                          </Tag>
                          <Tag>
                            {`<= ${Number(
                              (
                                crawlQualityThresholds.http304HitRateLow * 100
                              ).toFixed(1),
                            )}%`}
                          </Tag>
                        </Space>
                      }
                      value={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? Number(
                              ((crawlQualityStats.http304HitRate ?? 0) * 100)
                                .toFixed(1),
                            )
                          : "-"
                      }
                      suffix={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? "%"
                          : ""
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={
                        <Space size={4} wrap>
                          <span>
                            {t("newsSources.quality.preflightFailureRate")}
                          </span>
                          <Tag
                            color={
                              (crawlQualityThresholdStatus?.preflightRunCount ??
                                0) <= 0
                                ? "default"
                                : crawlQualityThresholdStatus?.preflightFailureBreached
                                ? "red"
                                : "green"
                            }
                          >
                            {(crawlQualityThresholdStatus?.preflightRunCount ??
                              0) <= 0
                              ? t("newsSources.quality.thresholdStatusNoData")
                              : crawlQualityThresholdStatus?.preflightFailureBreached
                                ? t(
                                    "newsSources.quality.thresholdStatusBreached",
                                  )
                                : t(
                                    "newsSources.quality.thresholdStatusNormal",
                                  )}
                          </Tag>
                          <Tag>
                            {`>= ${Number(
                              (
                                crawlQualityThresholds.preflightFailureRateHigh *
                                100
                              ).toFixed(1),
                            )}%`}
                          </Tag>
                        </Space>
                      }
                      value={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? Number(
                              (
                                (crawlQualityStats.preflightFailureRate ?? 0) *
                                100
                              ).toFixed(1),
                            )
                          : "-"
                      }
                      suffix={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? "%"
                          : ""
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={
                        <Space size={4} wrap>
                          <span>
                            {t("newsSources.quality.orgHashDedupeHitRate")}
                          </span>
                          <Tag
                            color={
                              (crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                                0) <= 0
                                ? "default"
                                : crawlQualityThresholdStatus?.orgHashDedupeBreached
                                ? "red"
                                : "green"
                            }
                          >
                            {(crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                              0) <= 0
                              ? t("newsSources.quality.thresholdStatusNoData")
                              : crawlQualityThresholdStatus?.orgHashDedupeBreached
                                ? t(
                                    "newsSources.quality.thresholdStatusBreached",
                                  )
                                : t(
                                    "newsSources.quality.thresholdStatusNormal",
                                  )}
                          </Tag>
                          <Tag>
                            {`>= ${Number(
                              (
                                crawlQualityThresholds.orgHashDedupeHitRateHigh *
                                100
                              ).toFixed(1),
                            )}%`}
                          </Tag>
                        </Space>
                      }
                      value={
                        (crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                          0) > 0
                          ? Number(
                              (
                                (crawlQualityStats.orgHashDedupeHitRate ?? 0) *
                                100
                              ).toFixed(1),
                            )
                          : "-"
                      }
                      suffix={
                        (crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                          0) > 0
                          ? "%"
                          : ""
                      }
                    />
                  </Col>
                </Row>
                <Typography.Text type="secondary">
                  {t("newsSources.quality.thresholdHint")}
                </Typography.Text>
                {crawlQualityStats.taskCount === 0 ? (
                  <Alert
                    type="info"
                    showIcon
                    message={t("newsSources.quality.noSamples")}
                    description={t("newsSources.quality.noSamplesDescription")}
                  />
                ) : null}
                {crawlQualityRateAlerts.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t("newsSources.quality.crawlQualityAlertTitle")}
                    description={crawlQualityRateAlerts
                      .map((entry) =>
                        t(
                          `newsSources.quality.crawlQualityAlert.${entry.key}`,
                          {
                            defaultValue:
                              "{{metric}} {{overall}}% (threshold {{operator}} {{threshold}}%; {{extremeLabel}} source: {{source}} {{sourceRate}}%)",
                            metric:
                              entry.key === "softFailure"
                                ? t(
                                    "newsSources.quality.headSignalSoftFailure",
                                  )
                                : entry.key === "truncated"
                                  ? t(
                                      "newsSources.quality.headSignalTruncated",
                                    )
                                  : entry.key === "noPublishSignal"
                                    ? t(
                                        "newsSources.quality.headSignalNoPublishSignal",
                                      )
                                    : entry.key === "preflightFailure"
                                      ? t(
                                          "newsSources.quality.preflightFailureRate",
                                        )
                                      : entry.key === "orgHashDedupeHigh"
                                        ? t(
                                            "newsSources.quality.orgHashDedupeHitRate",
                                          )
                                        : t(
                                            "newsSources.quality.http304HitRate",
                                          ),
                            overall: Number(
                              (entry.overallRate * 100).toFixed(1),
                            ),
                            operator: entry.direction === "high" ? ">=" : "<=",
                            threshold: Number(
                              (entry.threshold * 100).toFixed(1),
                            ),
                            extremeLabel:
                              entry.direction === "high"
                                ? t("newsSources.quality.highestSource")
                                : t("newsSources.quality.lowestSource"),
                            source: entry.extremeSource?.sourceId ?? "unknown",
                            sourceRate: Number(
                              ((entry.extremeSource?.rate ?? 0) * 100).toFixed(
                                1,
                              ),
                            ),
                          },
                        ),
                      )
                      .join(" | ")}
                  />
                ) : null}
                <Typography.Text type="secondary">
                  {t("newsSources.quality.publishConfidenceBuckets", {
                    lt04: crawlQualityStats.publishConfidenceBuckets?.lt04 ?? 0,
                    from04To06:
                      crawlQualityStats.publishConfidenceBuckets?.from04To06 ??
                      0,
                    from06To08:
                      crawlQualityStats.publishConfidenceBuckets?.from06To08 ??
                      0,
                    gte08:
                      crawlQualityStats.publishConfidenceBuckets?.gte08 ?? 0,
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("newsSources.quality.updatedAt", {
                    from: formatDateTime(crawlQualityStats.from, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                    to: formatDateTime(crawlQualityStats.to, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </Typography.Text>
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {crawlQualityLoading
                  ? t("common.loading")
                  : t("common.noData")}
              </Typography.Text>
            )}
          </Card>

          {lastUpdatedAt ? (
            <Typography.Text type="secondary">
              {t("newsSources.autoRefresh.updatedAt", {
                time: formatDateTime(lastUpdatedAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </Typography.Text>
          ) : null}

          {canManage && selectedSourceIds.length > 0 ? (
            <Card size="small">
              <Space wrap>
                <Typography.Text strong>
                  {t("newsSources.selection.count", {
                    count: selectedSourceIds.length,
                  })}
                </Typography.Text>
                <Button
                  onClick={() => openBatchSchedule(selectedSources)}
                  disabled={scheduleLoading}
                >
                  {t("newsSources.actions.schedule")}
                </Button>
                <Button
                  type="primary"
                  onClick={() => void handleBatchRunNow()}
                  loading={batchRunLoading}
                >
                  {t("newsSources.actions.runNow")}
                </Button>
                <Button
                  onClick={() => void handleBatchToggleActive(true)}
                  loading={batchToggleLoading}
                >
                  {t("common.enable")}
                </Button>
                <Button
                  onClick={() => void handleBatchToggleActive(false)}
                  loading={batchToggleLoading}
                >
                  {t("common.disable")}
                </Button>
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: "clear-group",
                        label: t("newsSources.actions.clearGroup"),
                        onClick: () => void handleBatchSetGroup(null),
                      },
                      ...uniqueGroups.map((g) => ({
                        key: g,
                        label: g,
                        onClick: () => void handleBatchSetGroup(g),
                      })),
                    ],
                  }}
                  disabled={batchGroupLoading}
                >
                  <Button loading={batchGroupLoading}>
                    {t("newsSources.actions.setGroup")}
                  </Button>
                </Dropdown>
                <Button onClick={() => setSelectedSourceIds([])}>
                  {t("common.clear")}
                </Button>
              </Space>
            </Card>
          ) : null}
          <Input
            id="news-sources-search"
            name="newsSourcesSearch"
            placeholder={t("newsSources.searchPlaceholder")}
            allowClear
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={sources}
            scroll={{ x: "max-content" }}
            rowSelection={
              canManage
                ? {
                    preserveSelectedRowKeys: true,
                    selectedRowKeys: selectedSourceIds,
                    onChange: (keys) => setSelectedSourceIds(keys as string[]),
                  }
                : undefined
            }
            pagination={{
              current: sourcePage,
              pageSize: sourcePageSize,
              total: sourceTotal,
              showTotal: (total) =>
                t("common.totalCount", {
                  count: total,
                }),
              showSizeChanger: screens.md,
              onChange: (page, pageSize) => {
                setSourcePage(page);
                setSourcePageSize(pageSize);
              },
            }}
          />
        </Space>
      </Card>

      <Form<NewsSourceFormValues>
        form={form}
        layout="vertical"
        initialValues={NEWS_SOURCE_CREATE_INITIAL_VALUES}
        onFinish={handleSubmit}
        onValuesChange={(changedValues, allValues) => {
          if (
            !Object.prototype.hasOwnProperty.call(changedValues, "seedMode")
          ) {
            return;
          }
          const previousMode = normalizeSeedMode(seedModeRef.current);
          const nextMode = normalizeSeedMode(changedValues.seedMode);
          seedModeRef.current = nextMode;

          const schedulerRuntimeSettings = resolvedSeedRuntimeSettings;
          const currentTtl = allValues.seedCacheTtlSeconds;
          const previousDefaultTtl = getDefaultSeedCacheTtlSecondsByMode(
            previousMode,
            schedulerRuntimeSettings,
          );
          if (
            typeof currentTtl === "number" &&
            Number.isFinite(currentTtl) &&
            currentTtl !== previousDefaultTtl
          ) {
            return;
          }

          form.setFieldsValue({
            seedCacheTtlSeconds: getDefaultSeedCacheTtlSecondsByMode(
              nextMode,
              schedulerRuntimeSettings,
            ),
          });
        }}
        component={false}
      >
        <Modal
          open={modalOpen}
          title={
            editingSource
              ? t("newsSources.actions.edit")
              : t("newsSources.actions.new")
          }
          onCancel={() => {
            setModalOpen(false);
            setEditingSource(null);
            seedModeRef.current = "sitemap";
            form.resetFields();
          }}
          onOk={() => form.submit()}
          okButtonProps={{ loading: saving }}
          destroyOnHidden
        >
          <Form.Item
            name="name"
            label={t("newsSources.fields.name")}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="url"
            label={t("newsSources.fields.url")}
            rules={[{ required: true, type: "url" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="siteType"
            label={t("newsSources.fields.type")}
            rules={[{ required: true }]}
          >
            <Select options={siteTypeOptions} />
          </Form.Item>
          <Form.Item
            name="language"
            label={t("newsSources.fields.language")}
          >
            <Input
              placeholder={t("newsSources.fields.languageHint")}
            />
          </Form.Item>
          {showCrawlSettings ? (
            <Form.Item
              name="crawlTemplateId"
              label={t("newsSources.fields.template")}
            >
              <Select
                showSearch
                allowClear
                options={templateOptions}
                placeholder={t("common.none")}
              />
            </Form.Item>
          ) : null}
          <Form.Item
            name="workflowId"
            label={t("newsSources.fields.workflow")}
          >
            <Select
              showSearch
              allowClear
              options={workflowOptions}
              placeholder={t("common.none")}
            />
          </Form.Item>
          <Form.Item
            name="workflowBindingMode"
            label={t("newsSources.fields.workflowMode")}
          >
            <Select
              options={[
                { label: "published", value: "published" },
                { label: "pinned", value: "pinned" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="workflowVersionId"
            label={t("newsSources.fields.workflowVersion")}
          >
            <Input placeholder="workflow-version-id" />
          </Form.Item>
          <Form.Item
            name="group"
            label={t("newsSources.fields.group")}
          >
            <Select
              showSearch
              allowClear
              mode="tags"
              maxCount={1}
              options={uniqueGroups.map((g) => ({ value: g, label: g }))}
              placeholder={t("newsSources.fields.groupPlaceholder")}
              notFoundContent={null}
              filterOption={(input, option) =>
                ((option?.label as string) ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t("newsSources.sections.schedule")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("newsSources.sections.scheduleHint")}
          </Typography.Text>

          <Form.Item
            name="scheduleMode"
            label={t("newsSources.fields.scheduleMode")}
          >
            <Select
              options={[
                {
                  value: "interval",
                  label: t("newsSources.scheduleMode.interval"),
                },
                {
                  value: "cron",
                  label: t("newsSources.scheduleMode.cron"),
                },
              ]}
            />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, nextValues) =>
              prevValues.scheduleMode !== nextValues.scheduleMode
            }
          >
            {({ getFieldValue }) => {
              const mode =
                getFieldValue("scheduleMode") === "cron" ? "cron" : "interval";
              if (mode !== "cron") {
                return null;
              }

              return (
                <>
                  <Form.Item
                    name="cronExpression"
                    label={t("newsSources.fields.cronExpression")}
                    dependencies={["scheduleMode"]}
                    rules={[
                      ({ getFieldValue: get }) => ({
                        validator: (_rule, value: string | undefined) => {
                          if (get("scheduleMode") !== "cron") {
                            return Promise.resolve();
                          }
                          if (
                            typeof value === "string" &&
                            value.trim().length > 0
                          ) {
                            return Promise.resolve();
                          }
                          return Promise.reject(
                            new Error(
                              t("newsSources.fields.cronExpressionRequired"),
                            ),
                          );
                        },
                      }),
                    ]}
                  >
                    <Input placeholder="*/15 * * * *" />
                  </Form.Item>
                  <Form.Item
                    name="cronTimezone"
                    label={t("newsSources.fields.cronTimezone")}
                    tooltip={t("newsSources.fields.cronTimezoneHint")}
                  >
                    <Input placeholder="UTC" />
                  </Form.Item>
                  <Form.Item
                    name="cronWindowDaysOfWeek"
                    label={t("newsSources.fields.cronWindowDays")}
                  >
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder={t("common.none")}
                      options={[
                        {
                          value: 1,
                          label: t("common.weekday.mon"),
                        },
                        {
                          value: 2,
                          label: t("common.weekday.tue"),
                        },
                        {
                          value: 3,
                          label: t("common.weekday.wed"),
                        },
                        {
                          value: 4,
                          label: t("common.weekday.thu"),
                        },
                        {
                          value: 5,
                          label: t("common.weekday.fri"),
                        },
                        {
                          value: 6,
                          label: t("common.weekday.sat"),
                        },
                        {
                          value: 0,
                          label: t("common.weekday.sun"),
                        },
                      ]}
                    />
                  </Form.Item>
                  <Row gutter={[12, 0]}>
                    <Col span={12}>
                      <Form.Item
                        name="cronWindowStartHour"
                        label={t("newsSources.fields.cronWindowStartHour")}
                      >
                        <InputNumber
                          min={0}
                          max={23}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name="cronWindowEndHour"
                        label={t("newsSources.fields.cronWindowEndHour")}
                      >
                        <InputNumber
                          min={1}
                          max={24}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                </>
              );
            }}
          </Form.Item>

          <Form.Item
            name="frequencySeconds"
            label={t("newsSources.fields.frequency")}
            rules={[{ required: true }]}
          >
            <InputNumber min={60} max={2_592_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="priority"
            label={t("newsSources.fields.priority")}
            rules={[{ required: true }]}
          >
            <InputNumber min={-100} max={100} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="isActive"
            label={t("newsSources.fields.active")}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="keywords"
            label={t("newsSources.fields.keywords")}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.keywordsHint")}
            />
          </Form.Item>
          <Form.Item
            name="tags"
            label={t("newsSources.fields.tags")}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.tagsHint")}
            />
          </Form.Item>
          <Form.Item
            name="summaryHints"
            label={t("newsSources.fields.summaryHints")}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.summaryHintsHint")}
            />
          </Form.Item>
          <Form.Item
            name="metadataJson"
            label={t("newsSources.fields.metadata")}
          >
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
          {showCrawlSettings ? (
            <>
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.crawl.proxyDisabledTitle")}
                description={t("newsSources.crawl.proxyDisabledDescription")}
              />

              <Typography.Title level={5} style={{ marginBottom: 0 }}>
                {t("newsSources.sections.crawlStrategy")}
              </Typography.Title>
              <Typography.Text type="secondary">
                {t("newsSources.sections.crawlStrategyHint")}
              </Typography.Text>
              <Alert
                style={{ marginBottom: 12, marginTop: 8 }}
                showIcon
                type="info"
                message={t("newsSources.hints.noLlmTitle")}
                description={t("newsSources.hints.noLlmDescription")}
              />
              <Form.Item
                name="crawlScanMode"
                label={t("newsSources.fields.crawlScanMode")}
                tooltip={t("newsSources.fields.crawlScanModeHint")}
              >
                <Select
                  options={[
                    {
                      value: "default",
                      label: t("newsSources.scanMode.default"),
                    },
                    {
                      value: "full_page",
                      label: t("newsSources.scanMode.fullPage"),
                    },
                    {
                      value: "virtual_scroll",
                      label: t("newsSources.scanMode.virtualScroll"),
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prevValues, nextValues) =>
                  prevValues.crawlScanMode !== nextValues.crawlScanMode
                }
              >
                {({ getFieldValue }) => {
                  const scanMode =
                    getFieldValue("crawlScanMode") === "full_page"
                      ? "full_page"
                      : getFieldValue("crawlScanMode") === "virtual_scroll"
                        ? "virtual_scroll"
                        : "default";

                  return (
                    <>
                      <Alert
                        style={{ marginBottom: 12 }}
                        showIcon
                        type={
                          scanMode === "full_page"
                            ? "success"
                            : scanMode === "virtual_scroll"
                              ? "warning"
                              : "info"
                        }
                        message={
                          scanMode === "full_page"
                            ? t("crawl.settings.scanModes.fullPageTitle")
                            : scanMode === "virtual_scroll"
                              ? t("crawl.settings.scanModes.virtualScrollTitle")
                              : t("crawl.settings.scanModes.defaultTitle")
                        }
                        description={
                          scanMode === "full_page"
                            ? t("crawl.settings.scanModes.fullPageDescription")
                            : scanMode === "virtual_scroll"
                              ? t(
                                  "crawl.settings.scanModes.virtualScrollDescription",
                                )
                              : t("crawl.settings.scanModes.defaultDescription")
                        }
                      />
                      {scanMode === "full_page" ? (
                        <Form.Item
                          name="crawlScrollDelayMs"
                          label={t("newsSources.fields.crawlScrollDelayMs")}
                        >
                          <InputNumber
                            min={0}
                            max={5000}
                            step={100}
                            style={{ width: "100%" }}
                          />
                        </Form.Item>
                      ) : null}
                      {scanMode === "virtual_scroll" ? (
                        <>
                          <Form.Item
                            name="crawlVirtualScrollContainerSelector"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollContainerSelector",
                            )}
                          >
                            <Input placeholder="body" />
                          </Form.Item>
                          <Form.Item
                            name="crawlVirtualScrollScrollCount"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollScrollCount",
                            )}
                          >
                            <InputNumber
                              min={1}
                              max={1000}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                          <Form.Item
                            name="crawlVirtualScrollScrollBy"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollScrollBy",
                            )}
                          >
                            <Select
                              options={[
                                {
                                  value: "page_height",
                                  label: t(
                                    "crawl.virtualScroll.scrollByOptions.pageHeight",
                                  ),
                                },
                                {
                                  value: "container_height",
                                  label: t(
                                    "crawl.virtualScroll.scrollByOptions.containerHeight",
                                  ),
                                },
                                {
                                  value: "pixels",
                                  label: t(
                                    "crawl.virtualScroll.scrollByOptions.pixels",
                                  ),
                                },
                              ]}
                            />
                          </Form.Item>
                          <Form.Item
                            noStyle
                            shouldUpdate={(prevValues, nextValues) =>
                              prevValues.crawlVirtualScrollScrollBy !==
                              nextValues.crawlVirtualScrollScrollBy
                            }
                          >
                            {({ getFieldValue: getScrollBy }) =>
                              getScrollBy("crawlVirtualScrollScrollBy") ===
                              "pixels" ? (
                                <Form.Item
                                  name="crawlVirtualScrollScrollByPixels"
                                  label={t(
                                    "newsSources.fields.crawlVirtualScrollScrollByPixels",
                                  )}
                                >
                                  <InputNumber
                                    min={1}
                                    max={20000}
                                    step={50}
                                    style={{ width: "100%" }}
                                  />
                                </Form.Item>
                              ) : null
                            }
                          </Form.Item>
                          <Form.Item
                            name="crawlVirtualScrollWaitAfterScrollMs"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollWaitAfterScrollMs",
                            )}
                          >
                            <InputNumber
                              min={0}
                              max={60000}
                              step={100}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </>
                      ) : null}
                    </>
                  );
                }}
              </Form.Item>

              <Form.Item
                name="crawlQualityProfile"
                label={t("newsSources.fields.crawlQualityProfile")}
                tooltip={t("crawl.settings.qualityProfileHint")}
              >
                <Select
                  allowClear
                  options={[
                    {
                      value: "quality_first",
                      label: t(
                        "crawl.settings.qualityProfileOptions.qualityFirst",
                      ),
                    },
                    {
                      value: "balanced",
                      label: t("crawl.settings.qualityProfileOptions.balanced"),
                    },
                    {
                      value: "speed_first",
                      label: t(
                        "crawl.settings.qualityProfileOptions.speedFirst",
                      ),
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="crawlPageTypeHint"
                label={t("newsSources.fields.crawlPageTypeHint")}
                tooltip={t("crawl.settings.pageTypeHintHint")}
              >
                <Select
                  allowClear
                  options={[
                    {
                      value: "auto",
                      label: t("crawl.settings.pageTypeHintOptions.auto"),
                    },
                    {
                      value: "list",
                      label: t("crawl.settings.pageTypeHintOptions.list"),
                    },
                    {
                      value: "detail",
                      label: t("crawl.settings.pageTypeHintOptions.detail"),
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="crawlAutoExpandDetails"
                label={t("newsSources.fields.crawlAutoExpandDetails")}
                tooltip={t("crawl.settings.autoExpandDetailsHint")}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prevValues, nextValues) =>
                  prevValues.crawlAutoExpandDetails !==
                  nextValues.crawlAutoExpandDetails
                }
              >
                {({ getFieldValue }) => {
                  if (getFieldValue("crawlAutoExpandDetails") !== true) {
                    return null;
                  }
                  return (
                    <>
                      <Form.Item
                        name="crawlDetailMaxUrls"
                        label={t("newsSources.fields.crawlDetailMaxUrls")}
                        extra={t("crawl.detailExpansion.maxDetailUrlsHint")}
                      >
                        <InputNumber
                          min={1}
                          max={30}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailMinRelevanceScore"
                        label={t(
                          "newsSources.fields.crawlDetailMinRelevanceScore",
                        )}
                        extra={t("crawl.detailExpansion.minRelevanceScoreHint")}
                      >
                        <InputNumber
                          min={0}
                          max={1}
                          step={0.01}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailRequireSameDomain"
                        label={t(
                          "newsSources.fields.crawlDetailRequireSameDomain",
                        )}
                        extra={t("crawl.detailExpansion.requireSameDomainHint")}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailAllowExternalLinks"
                        label={t(
                          "newsSources.fields.crawlDetailAllowExternalLinks",
                        )}
                        extra={t(
                          "crawl.detailExpansion.allowExternalLinksHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailMinPublishTimeConfidence"
                        label={t(
                          "newsSources.fields.crawlDetailMinPublishTimeConfidence",
                        )}
                        extra={t(
                          "crawl.detailExpansion.minPublishTimeConfidenceHint",
                        )}
                      >
                        <InputNumber
                          min={0}
                          max={1}
                          step={0.01}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailPreferFitMarkdownForQuality"
                        label={t(
                          "newsSources.fields.crawlDetailPreferFitMarkdownForQuality",
                        )}
                        extra={t(
                          "crawl.detailExpansion.preferFitMarkdownForQualityHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailExcludeUrlPatterns"
                        label={t(
                          "newsSources.fields.crawlDetailExcludeUrlPatterns",
                        )}
                        extra={t(
                          "crawl.detailExpansion.excludeUrlPatternsHint",
                        )}
                      >
                        <Select mode="tags" tokenSeparators={[","]} />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailIncludeUrlPatterns"
                        label={t(
                          "newsSources.fields.crawlDetailIncludeUrlPatterns",
                        )}
                        extra={t(
                          "crawl.detailExpansion.includeUrlPatternsHint",
                        )}
                      >
                        <Select mode="tags" tokenSeparators={[","]} />
                      </Form.Item>
                    </>
                  );
                }}
              </Form.Item>

              <Typography.Title level={5} style={{ marginBottom: 0 }}>
                {t("newsSources.sections.crawlMarkdown")}
              </Typography.Title>
              <Typography.Text type="secondary">
                {t("newsSources.sections.crawlMarkdownHint")}
              </Typography.Text>
              <Alert
                style={{ marginBottom: 12, marginTop: 8 }}
                showIcon
                type="success"
                message={t("newsSources.hints.ragReadyTitle")}
                description={t("newsSources.hints.ragReadyDescription")}
              />
              <Form.Item
                name="crawlMarkdownContentSource"
                label={t("newsSources.fields.crawlMarkdownContentSource")}
              >
                <Select
                  options={[
                    {
                      value: "cleaned_html",
                      label: t("crawl.markdown.sourceOptions.cleaned"),
                    },
                    {
                      value: "raw_html",
                      label: t("crawl.markdown.sourceOptions.raw"),
                    },
                    {
                      value: "fit_html",
                      label: t("crawl.markdown.sourceOptions.fit"),
                    },
                  ]}
                />
              </Form.Item>
              <Row gutter={[12, 0]}>
                <Col span={12}>
                  <Form.Item
                    name="crawlMarkdownEscapeHtmlMode"
                    label={t("newsSources.fields.crawlMarkdownEscapeHtmlMode")}
                  >
                    <Select
                      options={[
                        {
                          value: "auto",
                          label: t("newsSources.crawlTriState.auto"),
                        },
                        {
                          value: "enable",
                          label: t("newsSources.crawlTriState.enable"),
                        },
                        {
                          value: "disable",
                          label: t("newsSources.crawlTriState.disable"),
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="crawlMarkdownCitationsMode"
                    label={t("newsSources.fields.crawlMarkdownCitationsMode")}
                  >
                    <Select
                      options={[
                        {
                          value: "auto",
                          label: t("newsSources.crawlTriState.auto"),
                        },
                        {
                          value: "enable",
                          label: t("newsSources.crawlTriState.enable"),
                        },
                        {
                          value: "disable",
                          label: t("newsSources.crawlTriState.disable"),
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item noStyle shouldUpdate>
                {({ getFieldsValue }) => {
                  const values = getFieldsValue(true) as NewsSourceFormValues;
                  const previewValues: NewsSourceFormValues = {
                    ...values,
                    metadataJson: undefined,
                    keywords: undefined,
                    tags: undefined,
                    summaryHints: undefined,
                  };

                  let crawlOptionsPreview = "{}";
                  let previewError: string | null = null;

                  try {
                    const previewConfig = buildConfig(previewValues);
                    const previewOptions =
                      previewConfig && isPlainObject(previewConfig.crawlOptions)
                        ? (previewConfig.crawlOptions as Record<
                            string,
                            unknown
                          >)
                        : null;
                    crawlOptionsPreview = previewOptions
                      ? JSON.stringify(previewOptions, null, 2)
                      : "{}";
                  } catch (error) {
                    previewError =
                      error instanceof Error
                        ? error.message
                        : t("newsSources.hints.crawlOptionsPreviewError");
                  }

                  return (
                    <Card
                      size="small"
                      title={t("newsSources.sections.crawlOptionsPreview")}
                      style={{ marginBottom: 12 }}
                    >
                      <Typography.Paragraph
                        type="secondary"
                        style={{ marginTop: 0 }}
                      >
                        {t("newsSources.sections.crawlOptionsPreviewHint")}
                      </Typography.Paragraph>
                      {previewError ? (
                        <Alert
                          type="warning"
                          showIcon
                          message={previewError}
                          style={{ marginBottom: 8 }}
                        />
                      ) : null}
                      <Input.TextArea
                        value={crawlOptionsPreview}
                        autoSize={{ minRows: 4, maxRows: 10 }}
                        readOnly
                      />
                    </Card>
                  );
                }}
              </Form.Item>

              <Space style={{ marginBottom: 8 }}>
                <Button
                  size="small"
                  onClick={() => {
                    try {
                      const currentRaw = form.getFieldValue(
                        "crawlOptionsJson",
                      ) as string | undefined;
                      const current =
                        parseJsonField(currentRaw, "crawlOptions") ?? {};
                      const next =
                        applyAutoBrowserHeadersToCrawlOptions(current);
                      form.setFieldsValue({
                        crawlOptionsJson: JSON.stringify(next, null, 2),
                      });
                    } catch (error) {
                      messageApi.error(
                        error instanceof Error
                          ? error.message
                          : t("common.operationFailed"),
                      );
                    }
                  }}
                >
                  {t("crawl.browser.headers.autoFillSecCh")}
                </Button>
                <Typography.Text type="secondary">
                  {t("crawl.browser.headers.autoFillSecChHint")}
                </Typography.Text>
              </Space>

              <Form.Item
                name="crawlOptionsJson"
                label={t("newsSources.fields.crawlOptions")}
                tooltip={t("newsSources.fields.crawlOptionsHint")}
                validateTrigger="onBlur"
                rules={[
                  {
                    validator: async (_rule, value) => {
                      const trimmed =
                        typeof value === "string" ? value.trim() : "";
                      if (!trimmed) {
                        return;
                      }
                      let parsed: unknown;
                      try {
                        parsed = JSON.parse(trimmed);
                      } catch (error) {
                        throw new Error(
                          error instanceof Error
                            ? error.message
                            : "crawlOptions must be a valid JSON object",
                        );
                      }
                      if (
                        !parsed ||
                        typeof parsed !== "object" ||
                        Array.isArray(parsed)
                      ) {
                        throw new Error("crawlOptions must be a JSON object");
                      }
                      const proxyIssues = findUnsupportedProxyIssues(
                        parsed,
                        "config.crawlOptions",
                      );
                      if (proxyIssues.length > 0) {
                        throw new Error(formatPolicyIssues(proxyIssues, t));
                      }
                      const blockedKeys = findDisallowedCrawl4aiLlmKeys(parsed);
                      if (blockedKeys.length === 0) {
                        return;
                      }
                      const list = blockedKeys.slice(0, 5).join(", ");
                      const suffix =
                        blockedKeys.length > 5
                          ? ` (+${blockedKeys.length - 5} more)`
                          : "";
                      throw new Error(
                        t("newsSources.errors.crawlOptionsLlmBlocked", {
                          keys: list,
                          suffix,
                        }),
                      );
                    },
                  },
                ]}
              >
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
              </Form.Item>
              <Form.Item
                name="crawlHeadlessMode"
                label={t("newsSources.fields.crawlHeadlessMode")}
                tooltip={t("newsSources.fields.crawlHeadlessModeHint")}
              >
                <Select
                  options={[
                    {
                      label: t("newsSources.crawlHeadlessMode.auto"),
                      value: "auto",
                    },
                    {
                      label: t("newsSources.crawlHeadlessMode.headless"),
                      value: "headless",
                    },
                    {
                      label: t("newsSources.crawlHeadlessMode.headed"),
                      value: "headed",
                    },
                  ]}
                />
              </Form.Item>
              <Row gutter={[12, 0]}>
                <Col span={8}>
                  <Form.Item
                    name="crawlUndetectedMode"
                    label={t("newsSources.fields.crawlUndetectedMode")}
                    tooltip={t("newsSources.fields.crawlUndetectedModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.crawlTriState.auto"),
                          value: "auto",
                        },
                        {
                          label: t("newsSources.crawlTriState.enable"),
                          value: "enable",
                        },
                        {
                          label: t("newsSources.crawlTriState.disable"),
                          value: "disable",
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    name="crawlStealthMode"
                    label={t("newsSources.fields.crawlStealthMode")}
                    tooltip={t("newsSources.fields.crawlStealthModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.crawlTriState.auto"),
                          value: "auto",
                        },
                        {
                          label: t("newsSources.crawlTriState.enable"),
                          value: "enable",
                        },
                        {
                          label: t("newsSources.crawlTriState.disable"),
                          value: "disable",
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    name="crawlAntiBotMode"
                    label={t("newsSources.fields.crawlAntiBotMode")}
                    tooltip={t("newsSources.fields.crawlAntiBotModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.crawlTriState.auto"),
                          value: "auto",
                        },
                        {
                          label: t("newsSources.crawlTriState.enable"),
                          value: "enable",
                        },
                        {
                          label: t("newsSources.crawlTriState.disable"),
                          value: "disable",
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Typography.Paragraph style={{ marginBottom: 12 }}>
                <Space wrap>
                  <Button
                    size="small"
                    onClick={() =>
                      form.setFieldsValue(
                        buildNewsSourceCloudflarePresetValues(),
                      )
                    }
                  >
                    {t("newsSources.presets.cloudflare")}
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      form.setFieldsValue(
                        buildNewsSourceReutersCfPresetValues(),
                      )
                    }
                  >
                    {t("newsSources.presets.reutersCf")}
                  </Button>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.cloudflareHint")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.reutersCfHint")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.cloudflareDefaultHint")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.cloudflareRuntimeHint")}
                  </Typography.Text>
                </Space>
              </Typography.Paragraph>
              <Form.Item
                name="forceRefresh"
                label={t("newsSources.fields.forceRefresh")}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
            </>
          ) : null}

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t("newsSources.sections.seed")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("newsSources.sections.seedHint")}
          </Typography.Text>

          <Form.Item
            name="seedEnabled"
            label={t("newsSources.fields.seedEnabled")}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, nextValues) =>
              prevValues.seedEnabled !== nextValues.seedEnabled ||
              prevValues.seedMode !== nextValues.seedMode ||
              prevValues.seedCacheTtlSeconds !== nextValues.seedCacheTtlSeconds
            }
          >
            {({ getFieldValue }) => {
              const seedEnabled = getFieldValue("seedEnabled") === true;
              const seedMode = normalizeSeedMode(getFieldValue("seedMode"));
              const currentSeedCacheTtlSeconds = getFieldValue(
                "seedCacheTtlSeconds",
              );
              const resolvedSeedCachePolicy = resolveSeedCacheTtlPolicy(
                seedMode,
                currentSeedCacheTtlSeconds,
                resolvedSeedRuntimeSettings,
              );
              const seedCacheTtlInputDisabled =
                resolvedSeedCachePolicy.isGlobalForced;
              const schedulerSitemapRssTtl =
                resolvedSeedRuntimeSettings.seedCacheTtlSecondsSitemapRss;
              const schedulerListDeepTtl =
                resolvedSeedRuntimeSettings.seedCacheTtlSecondsListDeep;

              return (
                <div style={{ display: seedEnabled ? "block" : "none" }}>
                  <Form.Item
                    name="seedMode"
                    label={t("newsSources.fields.seedMode")}
                    tooltip={t("newsSources.fields.seedModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.seedMode.sitemap"),
                          value: "sitemap",
                        },
                        {
                          label: t("newsSources.seedMode.rss"),
                          value: "rss",
                        },
                        {
                          label: t("newsSources.seedMode.list"),
                          value: "list",
                        },
                        {
                          label: t("newsSources.seedMode.deep"),
                          value: "deep",
                        },
                      ]}
                    />
                  </Form.Item>

                  {seedMode === "rss" ? (
                    <>
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message={t("newsSources.seed.rssDirectTitle")}
                        description={t(
                          "newsSources.seed.rssDirectDescription",
                        )}
                      />
                      <Form.Item
                        name="seedFeedUrl"
                        label={t("newsSources.fields.seedFeedUrl")}
                        tooltip={t("newsSources.fields.seedFeedUrlHint")}
                      >
                        <Input placeholder="https://example.com/rss.xml" />
                      </Form.Item>
                      <Form.Item
                        name="seedRssAdaptiveEnabled"
                        label={t("newsSources.fields.seedRssAdaptiveEnabled")}
                        tooltip={t(
                          "newsSources.fields.seedRssAdaptiveEnabledHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="seedRssAdvancedEnabled"
                        label={t("newsSources.fields.seedRssAdvancedEnabled")}
                        tooltip={t(
                          "newsSources.fields.seedRssAdvancedEnabledHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        noStyle
                        shouldUpdate={(prevValues, nextValues) =>
                          prevValues.seedRssAdvancedEnabled !==
                          nextValues.seedRssAdvancedEnabled
                        }
                      >
                        {({ getFieldValue }) =>
                          getFieldValue("seedRssAdvancedEnabled") === true ? (
                            <>
                              <Form.Item
                                name="seedRssRequestTimeoutMs"
                                label={t(
                                  "newsSources.fields.seedRssRequestTimeoutMs",
                                )}
                                tooltip={t(
                                  "newsSources.fields.seedRssRequestTimeoutMsHint",
                                )}
                              >
                                <InputNumber
                                  min={1000}
                                  max={120000}
                                  step={1000}
                                  style={{ width: "100%" }}
                                />
                              </Form.Item>
                              <Form.Item
                                name="seedRssBodySourceStrategy"
                                label={t(
                                  "newsSources.fields.seedRssBodySourceStrategy",
                                )}
                                tooltip={t(
                                  "newsSources.fields.seedRssBodySourceStrategyHint",
                                )}
                              >
                                <Select
                                  options={[
                                    {
                                      value: "content_first",
                                      label: t(
                                        "newsSources.seedRss.bodySource.contentFirst",
                                      ),
                                    },
                                    {
                                      value: "content_only",
                                      label: t(
                                        "newsSources.seedRss.bodySource.contentOnly",
                                      ),
                                    },
                                    {
                                      value: "summary_only",
                                      label: t(
                                        "newsSources.seedRss.bodySource.summaryOnly",
                                      ),
                                    },
                                  ]}
                                />
                              </Form.Item>
                              <Form.Item
                                name="seedRssNoBodyPolicy"
                                label={t(
                                  "newsSources.fields.seedRssNoBodyPolicy",
                                )}
                                tooltip={t(
                                  "newsSources.fields.seedRssNoBodyPolicyHint",
                                )}
                              >
                                <Select
                                  options={[
                                    {
                                      value: "skip",
                                      label: t(
                                        "newsSources.seedRss.noBody.skip",
                                      ),
                                    },
                                    {
                                      value: "title_description_stub",
                                      label: t(
                                        "newsSources.seedRss.noBody.stub",
                                      ),
                                    },
                                  ]}
                                />
                              </Form.Item>
                              <Form.Item
                                noStyle
                                shouldUpdate={(prevValues, nextValues) =>
                                  prevValues.seedRssNoBodyPolicy !==
                                  nextValues.seedRssNoBodyPolicy
                                }
                              >
                                {({ getFieldValue }) =>
                                  getFieldValue("seedRssNoBodyPolicy") ===
                                  "title_description_stub" ? (
                                    <Alert
                                      type="warning"
                                      showIcon
                                      style={{ marginBottom: 12 }}
                                      message={t(
                                        "newsSources.seed.rssStubWarningTitle",
                                      )}
                                      description={t(
                                        "newsSources.seed.rssStubWarningDescription",
                                      )}
                                    />
                                  ) : null
                                }
                              </Form.Item>
                            </>
                          ) : null
                        }
                      </Form.Item>
                    </>
                  ) : (
                    <>
                      <Form.Item
                        name="seedDomain"
                        label={t("newsSources.fields.seedDomain")}
                        tooltip={t("newsSources.fields.seedDomainHint")}
                      >
                        <Input placeholder="https://example.com" />
                      </Form.Item>
                      <Form.Item
                        name="seedPattern"
                        label={
                          seedMode === "list"
                            ? t("newsSources.fields.seedPatternList")
                            : t("newsSources.fields.seedPattern")
                        }
                        tooltip={t("newsSources.fields.seedPatternHint")}
                      >
                        <Input placeholder="*news*" />
                      </Form.Item>
                    </>
                  )}
                  <Form.Item
                    name="seedQuery"
                    label={t("newsSources.fields.seedQuery")}
                    tooltip={t("newsSources.fields.seedQueryHint")}
                  >
                    <Input
                      placeholder={t(
                        "newsSources.fields.seedQueryPlaceholder",
                      )}
                    />
                  </Form.Item>
                  <Form.Item
                    name="seedMaxUrls"
                    label={t("newsSources.fields.seedMaxUrls")}
                  >
                    <InputNumber min={1} max={2000} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="seedMaxNewUrlsPerRun"
                    label={t("newsSources.fields.seedMaxNewUrlsPerRun")}
                  >
                    <InputNumber min={1} max={500} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="seedScoreThreshold"
                    label={t("newsSources.fields.seedScoreThreshold")}
                    tooltip={t("newsSources.fields.seedScoreThresholdHint")}
                  >
                    <InputNumber
                      min={0}
                      max={1}
                      step={0.05}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item
                    name="seedDedupeWindowHours"
                    label={t("newsSources.fields.seedDedupeWindowHours")}
                  >
                    <InputNumber min={0} max={720} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="seedQueryParamAllowlist"
                    label={t("newsSources.fields.seedQueryParamAllowlist")}
                    tooltip={t(
                      "newsSources.fields.seedQueryParamAllowlistHint",
                    )}
                  >
                    <Select
                      mode="tags"
                      tokenSeparators={[",", " ", "\n", "\t"]}
                      options={resolvedSeedRuntimeSettings.seedUrlQueryParamAllowlist.map(
                        (entry) => ({
                          label: entry,
                          value: entry,
                        }),
                      )}
                      placeholder={t(
                        "newsSources.fields.seedQueryParamAllowlistPlaceholder",
                      )}
                    />
                  </Form.Item>
                  <Space wrap size={[8, 8]} style={{ marginBottom: 8 }}>
                    <Tag color={seedCacheTtlInputDisabled ? "gold" : "blue"}>
                      {seedCacheTtlInputDisabled
                        ? t("newsSources.seedCachePolicy.globalForcedTag")
                        : t("newsSources.seedCachePolicy.sourceAwareTag")}
                    </Tag>
                    <Tag>
                      {t("newsSources.seedCachePolicy.sitemapRssTag", {
                        ttl: schedulerSitemapRssTtl,
                      })}
                    </Tag>
                    <Tag>
                      {t("newsSources.seedCachePolicy.listDeepTag", {
                        ttl: schedulerListDeepTtl,
                      })}
                    </Tag>
                  </Space>
                  {seedSchedulerSettingsLoadFailed ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={t(
                        "newsSources.seedCachePolicy.loadFailedTitle",
                      )}
                      description={t(
                        "newsSources.seedCachePolicy.loadFailedDescription",
                      )}
                    />
                  ) : seedCacheTtlInputDisabled ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={t(
                        "newsSources.seedCachePolicy.globalForcedTitle",
                      )}
                      description={t(
                        "newsSources.seedCachePolicy.globalForcedDescription",
                        {
                          sitemapRss: schedulerSitemapRssTtl,
                          listDeep: schedulerListDeepTtl,
                        },
                      )}
                    />
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={t(
                        "newsSources.seedCachePolicy.sourceAwareTitle",
                      )}
                      description={t(
                        "newsSources.seedCachePolicy.sourceAwareDescription",
                        {
                          sitemapRss: schedulerSitemapRssTtl,
                          listDeep: schedulerListDeepTtl,
                        },
                      )}
                    />
                  )}
                  <Form.Item
                    name="seedCacheTtlSeconds"
                    label={t("newsSources.fields.seedCacheTtlSeconds")}
                    tooltip={t("newsSources.fields.seedCacheTtlSecondsHint")}
                    extra={t("newsSources.seedCachePolicy.effectiveTtlHint", {
                      ttl: resolvedSeedCachePolicy.effectiveCacheTtlSeconds,
                    })}
                  >
                    <InputNumber
                      min={10}
                      max={3600}
                      style={{ width: "100%" }}
                      disabled={seedCacheTtlInputDisabled}
                    />
                  </Form.Item>
                  <Form.Item
                    name="seedConcurrency"
                    label={t("newsSources.fields.seedConcurrency")}
                    tooltip={t("newsSources.fields.seedConcurrencyHint")}
                  >
                    <InputNumber min={1} max={10} style={{ width: "100%" }} />
                  </Form.Item>
                  {seedMode === "list" ? (
                    <>
                      <Form.Item
                        name="seedListMaxPages"
                        label={t("newsSources.fields.seedListMaxPages")}
                        tooltip={t("newsSources.fields.seedListMaxPagesHint")}
                      >
                        <InputNumber
                          min={1}
                          max={20}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="seedListPageConcurrency"
                        label={t("newsSources.fields.seedListPageConcurrency")}
                        tooltip={t(
                          "newsSources.fields.seedListPageConcurrencyHint",
                        )}
                      >
                        <InputNumber
                          min={1}
                          max={5}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="seedFollowPagination"
                        label={t("newsSources.fields.seedFollowPagination")}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedFollowPaginationHint",
                        )}
                      >
                        <Switch />
                      </Form.Item>
                    </>
                  ) : null}
                  {seedMode === "deep" ? (
                    <>
                      <Typography.Text type="secondary">
                        {t("newsSources.fields.seedDeepHint")}
                      </Typography.Text>
                      <Row gutter={[12, 0]}>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepMaxPages"
                            label={t("newsSources.fields.seedDeepMaxPages")}
                            tooltip={t(
                              "newsSources.fields.seedDeepMaxPagesHint",
                            )}
                          >
                            <InputNumber
                              min={5}
                              max={300}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepMaxDepth"
                            label={t("newsSources.fields.seedDeepMaxDepth")}
                            tooltip={t(
                              "newsSources.fields.seedDeepMaxDepthHint",
                            )}
                          >
                            <InputNumber
                              min={1}
                              max={4}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepTimeBudgetSeconds"
                            label={t(
                              "newsSources.fields.seedDeepTimeBudgetSeconds",
                            )}
                          >
                            <InputNumber
                              min={10}
                              max={180}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={[12, 0]}>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepPageConcurrency"
                            label={t(
                              "newsSources.fields.seedDeepPageConcurrency",
                            )}
                          >
                            <InputNumber
                              min={1}
                              max={6}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepScoreThreshold"
                            label={t(
                              "newsSources.fields.seedDeepScoreThreshold",
                            )}
                            tooltip={t(
                              "newsSources.fields.seedDeepScoreThresholdHint",
                            )}
                          >
                            <InputNumber
                              min={0}
                              max={1}
                              step={0.05}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepCandidatePoolSize"
                            label={t(
                              "newsSources.fields.seedDeepCandidatePoolSize",
                            )}
                          >
                            <InputNumber
                              min={20}
                              max={400}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item
                        name="seedDeepHeadFetchTopK"
                        label={t("newsSources.fields.seedDeepHeadFetchTopK")}
                        tooltip={t(
                          "newsSources.fields.seedDeepHeadFetchTopKHint",
                        )}
                      >
                        <InputNumber
                          min={10}
                          max={120}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="seedDeepPreferPathDate"
                        label={t("newsSources.fields.seedDeepPreferPathDate")}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedDeepPreferPathDateHint",
                        )}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="seedDeepEnableSecondaryHubs"
                        label={t(
                          "newsSources.fields.seedDeepEnableSecondaryHubs",
                        )}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedDeepEnableSecondaryHubsHint",
                        )}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="seedDeepIgnoreRobotsTxt"
                        label={t("newsSources.fields.seedDeepIgnoreRobotsTxt")}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedDeepIgnoreRobotsTxtHint",
                        )}
                      >
                        <Switch disabled />
                      </Form.Item>
                    </>
                  ) : null}
                </div>
              );
            }}
          </Form.Item>
        </Modal>
      </Form>

      <Modal
        open={opmlModalOpen}
        title={t("newsSources.opml.title")}
        width={screens.md ? 1120 : "100%"}
        onCancel={() => {
          setOpmlModalOpen(false);
          setOpmlImportReport(null);
          setOpmlPreview(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setOpmlModalOpen(false);
                setOpmlImportReport(null);
                setOpmlPreview(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handlePreviewOpml()}
              loading={opmlPreviewing}
              disabled={
                opmlMode === "preset"
                  ? opmlPresetId.trim().length === 0
                  : opmlContent.trim().length === 0
              }
            >
              {t("newsSources.opml.actions.preview")}
            </Button>
            <Button
              type="primary"
              onClick={() => void handleImportOpml()}
              loading={opmlImporting}
              disabled={
                !opmlPreview ||
                opmlPreview.entries.filter((entry) => entry.enabled).length ===
                  0
              }
            >
              {t("newsSources.opml.actions.import")}
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message={t("newsSources.opml.hint.title")}
            description={t("newsSources.opml.hint.description")}
          />

          <Row gutter={[12, 12]}>
            <Col xs={24} md={8}>
              <Typography.Text strong>
                {t("newsSources.opml.fields.mode")}
              </Typography.Text>
              <Select<NewsSourceOpmlMode>
                style={{ width: "100%", marginTop: 6 }}
                value={opmlMode}
                onChange={handleOpmlModeChange}
                options={[
                  {
                    label: t("newsSources.opml.mode.preset"),
                    value: "preset",
                  },
                  {
                    label: t("newsSources.opml.mode.upload"),
                    value: "upload",
                  },
                ]}
              />
            </Col>
            <Col xs={24} md={16}>
              {opmlMode === "preset" ? (
                <>
                  <Typography.Text strong>
                    {t("newsSources.opml.fields.preset")}
                  </Typography.Text>
                  <Select
                    style={{ width: "100%", marginTop: 6 }}
                    loading={opmlLoadingPresets}
                    value={opmlPresetId}
                    onChange={(value) => {
                      setOpmlPresetId(value);
                      const preset = opmlPresets.find(
                        (item) => item.id === value,
                      );
                      if (preset?.defaultLanguage) {
                        setOpmlDefaultLanguage(preset.defaultLanguage);
                      }
                      setOpmlPreview(null);
                      setOpmlImportReport(null);
                    }}
                    options={opmlPresets.map((preset) => ({
                      label: `${preset.name} (${preset.entryCount})`,
                      value: preset.id,
                    }))}
                  />
                </>
              ) : (
                <>
                  <Typography.Text strong>
                    {t("newsSources.opml.fields.file")}
                  </Typography.Text>
                  <Input
                    style={{ marginTop: 6 }}
                    type="file"
                    accept=".opml,.xml,text/xml,application/xml"
                    onChange={(event) => void handleOpmlFileChange(event)}
                  />
                  {opmlFileName ? (
                    <Typography.Text type="secondary">
                      {t("newsSources.opml.fields.fileLoaded", {
                        name: opmlFileName,
                      })}
                    </Typography.Text>
                  ) : null}
                </>
              )}
            </Col>
          </Row>

          <Space wrap>
            <Input
              style={{ width: 220 }}
              value={opmlDefaultLanguage}
              onChange={(event) =>
                setOpmlDefaultLanguage(event.target.value.trim())
              }
              placeholder={t("newsSources.opml.fields.language")}
            />
            <Button onClick={handleApplyOpmlDefaultLanguage}>
              {t("newsSources.opml.actions.applyLanguage")}
            </Button>
          </Space>

          {opmlPreview ? (
            <Card size="small">
              <Space wrap>
                <Tag color="blue">
                  {t("newsSources.opml.summary.total", {
                    count: opmlPreview.summary.total,
                  })}
                </Tag>
                <Tag color="green">
                  {t("newsSources.opml.summary.valid", {
                    count: opmlPreview.summary.valid,
                  })}
                </Tag>
                <Tag color="gold">
                  {t("newsSources.opml.summary.duplicates", {
                    count: opmlPreview.summary.duplicates,
                  })}
                </Tag>
                <Tag color="purple">
                  {t("newsSources.opml.summary.enabled", {
                    count: opmlPreview.entries.filter((entry) => entry.enabled)
                      .length,
                  })}
                </Tag>
                {opmlPreview.title ? (
                  <Typography.Text type="secondary">
                    {t("newsSources.opml.summary.title", {
                      title: opmlPreview.title,
                    })}
                  </Typography.Text>
                ) : null}
              </Space>
            </Card>
          ) : null}

          {opmlImportReport ? (
            <Alert
              type={opmlImportReport.summary.failed > 0 ? "warning" : "success"}
              showIcon
              message={t("newsSources.opml.report.title")}
              description={t("newsSources.opml.report.summary", {
                created: opmlImportReport.summary.created,
                skipped: opmlImportReport.summary.skipped,
                failed: opmlImportReport.summary.failed,
              })}
            />
          ) : null}

          {opmlPreview ? (
            <Table
              rowKey={(record, index) =>
                `${record.url}-${record.feedUrl}-${index}`
              }
              size="small"
              pagination={{ pageSize: screens.md ? 12 : 6 }}
              dataSource={opmlPreview.entries}
              columns={[
                {
                  title: t("newsSources.opml.columns.import"),
                  width: 80,
                  render: (_value, record, index) => (
                    <Checkbox
                      checked={record.enabled}
                      disabled={!record.valid || record.alreadyExists}
                      onChange={(event) =>
                        updateOpmlPreviewEntry(index, {
                          enabled: event.target.checked,
                        })
                      }
                    />
                  ),
                },
                {
                  title: t("newsSources.opml.columns.name"),
                  dataIndex: "name",
                  width: 220,
                },
                {
                  title: t("newsSources.opml.columns.siteUrl"),
                  dataIndex: "url",
                  ellipsis: true,
                },
                {
                  title: t("newsSources.opml.columns.feedUrl"),
                  dataIndex: "feedUrl",
                  ellipsis: true,
                },
                {
                  title: t("newsSources.opml.columns.language"),
                  width: 130,
                  render: (_value, record, index) => (
                    <Input
                      value={record.language}
                      disabled={!record.enabled}
                      onChange={(event) =>
                        updateOpmlPreviewEntry(index, {
                          language: event.target.value.trim(),
                        })
                      }
                    />
                  ),
                },
                {
                  title: t("newsSources.opml.columns.group"),
                  dataIndex: "group",
                  width: 130,
                  render: (group: string | null) =>
                    group ? <Tag>{group}</Tag> : null,
                },
                {
                  title: t("newsSources.opml.columns.status"),
                  width: 260,
                  render: (_value, record) => {
                    if (record.alreadyExists) {
                      return (
                        <Tag color="gold">
                          {t("newsSources.opml.status.duplicate")}
                        </Tag>
                      );
                    }
                    if (!record.valid) {
                      return (
                        <Typography.Text type="danger">
                          {record.errors.join("; ")}
                        </Typography.Text>
                      );
                    }
                    if (record.errors.length > 0) {
                      return (
                        <Typography.Text type="secondary">
                          {record.errors.join("; ")}
                        </Typography.Text>
                      );
                    }
                    return (
                      <Tag color="green">
                        {t("newsSources.opml.status.ready")}
                      </Tag>
                    );
                  },
                },
              ]}
            />
          ) : (
            <Typography.Text type="secondary">
              {t("newsSources.opml.empty")}
            </Typography.Text>
          )}
        </Space>
      </Modal>

      {canManage ? (
        <CreateCrawlTaskDrawer
          form={createDrawerForm}
          open={createDrawerOpen}
          loading={creatingFromTaskDrawer}
          canWriteItems={canWriteItems}
          title={t("newsSources.actions.new")}
          submitLabel={t("common.create")}
          defaultTemplateKey="news"
          onClose={closeCreateDrawer}
          onSubmit={handleCreateFromTaskDrawer}
        />
      ) : null}

      <Form<NewsSourceScheduleValues>
        form={scheduleForm}
        layout="vertical"
        onFinish={handleSchedule}
        component={false}
      >
        <Modal
          open={scheduleOpen}
          title={t("newsSources.schedule.title")}
          onCancel={closeSchedule}
          onOk={() => scheduleForm.submit()}
          okText={
            scheduleTargets.length > 1
              ? t("newsSources.actions.scheduleBatch", {
                  count: scheduleTargets.length,
                })
              : scheduleTargets[0]?.nextRunAt
                ? t("newsSources.actions.reschedule")
                : t("newsSources.actions.schedule")
          }
          okButtonProps={{ loading: scheduleLoading }}
          destroyOnHidden
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t(
              scheduleDeliveryMode === "rss"
                ? "newsSources.schedule.hintTitleRss"
                : scheduleDeliveryMode === "mixed"
                  ? "newsSources.schedule.hintTitleMixed"
                  : "newsSources.schedule.hintTitleCrawl4ai",
              {
                defaultValue:
                  scheduleDeliveryMode === "rss"
                    ? "Queued directly to pipeline"
                    : scheduleDeliveryMode === "mixed"
                      ? "Mixed scheduling modes"
                      : "Queued via crawl4ai",
              },
            )}
            description={t(
              scheduleDeliveryMode === "rss"
                ? "newsSources.schedule.descriptionRss"
                : scheduleDeliveryMode === "mixed"
                  ? "newsSources.schedule.descriptionMixed"
                  : "newsSources.schedule.descriptionCrawl4ai",
              {
                defaultValue:
                  scheduleDeliveryMode === "rss"
                    ? "Sets the next run time. The scheduler checks every 30 seconds, prefetches RSS feed entries, and queues pipeline jobs directly without creating Crawl4AI tasks."
                    : scheduleDeliveryMode === "mixed"
                      ? "Sets the next run time. RSS sources queue pipeline jobs directly, while other sources create CrawlTask jobs and run through Crawl4AI."
                      : "Sets the next run time. The scheduler checks every 30 seconds and enqueues a CrawlTask; crawl4ai limits concurrency to avoid blocking.",
              },
            )}
          />
          {scheduleTargets.some((target) => !target.isActive) ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={t("newsSources.schedule.enablesSource", {
                count: scheduleTargets.filter((target) => !target.isActive)
                  .length,
              })}
            />
          ) : null}
          <Form.Item
            name="nextRunAt"
            label={t("newsSources.fields.nextRunAt")}
            rules={[
              { required: true },
              {
                validator: (_rule, value: Dayjs | undefined) => {
                  if (!value || !value.isValid()) {
                    return Promise.reject(
                      new Error(
                        t("newsSources.schedule.validation.invalid"),
                      ),
                    );
                  }
                  if (value.isBefore(dayjs())) {
                    return Promise.reject(
                      new Error(
                        t("newsSources.schedule.validation.future"),
                      ),
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <DatePicker
              showTime
              allowClear={false}
              style={{ width: "100%" }}
              disabledDate={(current) =>
                Boolean(current && current.isBefore(dayjs().startOf("day")))
              }
            />
          </Form.Item>
          <Space wrap size={8} style={{ marginBottom: 8 }}>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(5, "minute"),
                })
              }
            >
              {t("newsSources.schedule.presets.in5m")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(30, "minute"),
                })
              }
            >
              {t("newsSources.schedule.presets.in30m")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(1, "hour"),
                })
              }
            >
              {t("newsSources.schedule.presets.in1h")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(1, "hour").startOf("hour"),
                })
              }
            >
              {t("newsSources.schedule.presets.nextHour")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(1, "day").startOf("day").hour(9),
                })
              }
            >
              {t("newsSources.schedule.presets.tomorrow9")}
            </Button>
            {scheduleTargets.length === 1 ? (
              <Button
                size="small"
                onClick={() =>
                  scheduleForm.setFieldsValue({
                    nextRunAt: dayjs().add(
                      scheduleTargets[0]!.frequencySeconds,
                      "second",
                    ),
                  })
                }
              >
                {t("newsSources.schedule.presets.nextInterval")}
              </Button>
            ) : null}
          </Space>
          {scheduleTargets.length > 1 ? (
            <Typography.Text type="secondary">
              {t("newsSources.schedule.selectedCount", {
                count: scheduleTargets.length,
              })}
            </Typography.Text>
          ) : scheduleTargets.length === 1 ? (
            <Typography.Text type="secondary">
              {t("newsSources.schedule.frequencyHint", {
                seconds: scheduleTargets[0]!.frequencySeconds,
              })}
            </Typography.Text>
          ) : null}
        </Modal>
      </Form>

      <Modal
        open={previewOpen}
        title={t("newsSources.preview.title")}
        width={screens.md ? 980 : "100%"}
        onCancel={() => {
          setPreviewOpen(false);
          setPreviewSource(null);
          setPreviewData(null);
        }}
        footer={
          <Space>
            {canManage ? (
              <Button
                onClick={() => handleScheduleFromPreview()}
                disabled={!previewSource}
              >
                {previewSource?.nextRunAt
                  ? t("newsSources.actions.reschedule")
                  : t("newsSources.actions.schedule")}
              </Button>
            ) : null}
            {canManage ? (
              <Button
                type="primary"
                onClick={() => void handleRunNowFromPreview()}
                loading={previewRunNowLoading}
                disabled={!previewSource}
              >
                {t("newsSources.actions.runNow")}
              </Button>
            ) : null}
            <Button
              onClick={() => void reloadPreview()}
              loading={previewLoading}
              disabled={!previewSource}
            >
              {t("common.refresh")}
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setPreviewOpen(false);
                setPreviewSource(null);
                setPreviewData(null);
              }}
            >
              {t("common.close")}
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        {previewData ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {previewSource
              ? (() => {
                  const strategyTags = getCrawlStrategyTags(
                    previewSource.config,
                    t,
                  );
                  if (!strategyTags.length) {
                    return null;
                  }
                  return (
                    <Space wrap>
                      <Typography.Text type="secondary">
                        {t("newsSources.preview.strategy")}
                        :
                      </Typography.Text>
                      {strategyTags.map((tag) => (
                        <Tag key={"preview-" + tag.key} color={tag.color}>
                          {tag.label}
                        </Tag>
                      ))}
                    </Space>
                  );
                })()
              : null}
            <Space wrap>
              <Tag
                color={
                  previewData.mode === "sitemap"
                    ? "purple"
                    : previewData.mode === "rss"
                      ? "blue"
                      : previewData.mode === "list"
                        ? "gold"
                        : previewData.mode === "deep"
                          ? "geekblue"
                          : "default"
                }
              >
                {previewData.mode === "sitemap"
                  ? t("newsSources.preview.modeSitemap")
                  : previewData.mode === "rss"
                    ? t("newsSources.preview.modeRss")
                    : previewData.mode === "list"
                      ? t("newsSources.preview.modeList")
                      : previewData.mode === "deep"
                        ? t("newsSources.preview.modeDeep")
                        : t("newsSources.preview.modeSingle")}
              </Tag>
              <Typography.Text>
                {t("newsSources.preview.scheduleCount", {
                  count: previewData.scheduleCount,
                })}
              </Typography.Text>
              {typeof previewData.availableToSchedule === "number" ? (
                <Typography.Text type="secondary">
                  {t("newsSources.preview.availableToSchedule", {
                    count: previewData.availableToSchedule,
                  })}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {t("newsSources.preview.skippedCount", {
                  count: previewData.skippedCount,
                })}
              </Typography.Text>
              {typeof previewData.inFlightCount === "number" &&
              typeof previewData.inFlightLimit === "number" ? (
                <Typography.Text type="secondary">
                  {t("newsSources.preview.inFlightCount", {
                    count: previewData.inFlightCount,
                    limit: previewData.inFlightLimit,
                  })}
                </Typography.Text>
              ) : null}
            </Space>

            {previewData.mode === "deep" &&
            (previewData.deepPreviewError || previewData.deepFailureStats) ? (
              <Card
                size="small"
                title={t("newsSources.preview.deepFailure.title")}
              >
                {previewData.deepPreviewError ? (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={`${previewData.deepPreviewError.code}: ${previewData.deepPreviewError.message}`}
                    description={previewData.deepPreviewError.detail}
                  />
                ) : null}
                <Row gutter={[12, 12]}>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("newsSources.preview.deepFailure.total24h")}
                      value={previewData.deepFailureStats?.total24h ?? 0}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("newsSources.preview.deepFailure.streak")}
                      value={previewData.deepFailureStats?.streak ?? 0}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("newsSources.preview.deepFailure.nextRetryAt")}
                      value={
                        previewData.deepFailureStats?.nextRetryAt
                          ? formatDateTime(
                              previewData.deepFailureStats.nextRetryAt,
                              locale,
                              {
                                dateStyle: "medium",
                                timeStyle: "short",
                              },
                            )
                          : "-"
                      }
                    />
                  </Col>
                </Row>
                {previewData.deepFailureStats?.byCode?.length ? (
                  <Space wrap style={{ marginTop: 12 }}>
                    {previewData.deepFailureStats.byCode.map((entry) => (
                      <Tag color="red" key={`deep-failure-code-${entry.code}`}>
                        {entry.code}: {entry.count}
                      </Tag>
                    ))}
                  </Space>
                ) : null}
                {previewData.deepFailureStats?.lastFailureAt ? (
                  <Typography.Text
                    type="secondary"
                    style={{ display: "block", marginTop: 8 }}
                  >
                    {t("newsSources.preview.deepFailure.lastFailureAt", {
                      time: formatDateTime(
                        previewData.deepFailureStats.lastFailureAt,
                        locale,
                        {
                          dateStyle: "medium",
                          timeStyle: "short",
                        },
                      ),
                    })}
                  </Typography.Text>
                ) : null}
              </Card>
            ) : null}

            <Table
              rowKey="url"
              size="small"
              loading={previewLoading}
              columns={previewColumns}
              dataSource={previewData.candidates}
              pagination={{ pageSize: screens.md ? 10 : 5 }}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {previewLoading
              ? t("newsSources.preview.loading")
              : t("newsSources.preview.empty")}
          </Typography.Text>
        )}
      </Modal>
    </>
  );
}
