"use client";

import { SearchOutlined } from "@ant-design/icons";
import { gql, type FetchResult, useMutation } from "@apollo/client";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Input,
  List,
  Modal,
  Select,
  Space,
  Switch,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import {
  useIngestCrawlTaskResultsToItemsMutation,
  useRetryCrawlTaskMutation,
  useUpdateCrawlTaskIngestToItemsMutation,
  type IngestCrawlTaskResultsToItemsMutation,
  type CrawlTaskStatus,
} from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { findUnsupportedProxyIssues } from "@/lib/crawl-config-policy";
import { classifyHeadedIssue } from "@/lib/crawl-runtime";
import {
  parseExpansionHeadSignalSummary,
  resolveHeadSignalFallbackHint,
  type ExpansionHeadSignalSummary,
} from "@/lib/crawl-task-head-signal";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import { useCrawlTaskDetailQuery } from "./hooks/use-crawl-task-detail-query";
import { useCrawlTaskLogs } from "./hooks/use-crawl-task-logs";
import { useCrawlTaskOpsLive } from "./hooks/use-crawl-task-ops-live";
import {
  BACKFILL_BATCH_TIMEOUT_MS,
  formatPolicyIssues,
  markdownPreviewStyle,
  safeParseJson,
  shortenScript,
  withTimeout,
} from "./task-detail-formatters";
import { MediaSection } from "./task-detail-media-section";
import { StoredMediaSection } from "./task-detail-stored-media-section";
import { TablesSection } from "./task-detail-tables-section";
import type {
  BackfillNotice,
  CrawlMediaCollection,
  CrawlResultTable,
  CrawlStoredMediaAsset,
  TaskLogRecord,
  TaskLogStatus,
} from "./task-detail-types";

const statusColors: Record<CrawlTaskStatus, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple",
};

const itemStatusColors: Record<string, string> = {
  draft: "default",
  pending: "gold",
  processing: "blue",
  completed: "green",
  failed: "red",
  duplicate: "purple",
};

interface ExpansionQualitySummary {
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

const taskLogStatusColors: Record<TaskLogStatus, string> = {
  pending: "gold",
  processing: "blue",
  completed: "green",
  failed: "red",
};

const limitOptions = [
  {
    value: 10,
    labelKey: "crawl.detail.results.latest10",
    defaultValue: "Latest 10",
  },
  {
    value: 20,
    labelKey: "crawl.detail.results.latest20",
    defaultValue: "Latest 20",
  },
  {
    value: 50,
    labelKey: "crawl.detail.results.latest50",
    defaultValue: "Latest 50",
  },
];

const CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION = gql`
  mutation CreateItemFromCrawlResult($resultId: String!) {
    createItemFromCrawlResult(resultId: $resultId) {
      id
      title
      status
    }
  }
`;

export function CrawlTaskDetail({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const canViewTaskLogs = permissions.includes("settings.manage");
  const canCreateItem = canView && permissions.includes("items.write");
  const canViewItems =
    permissions.includes("items.read") || permissions.includes("items.write");
  const {
    task,
    loading,
    refetch,
    startPolling,
    stopPolling,
    limit: resultLimit,
    searchInput: resultSearchInput,
    setLimit: setResultLimit,
    changeSearchInput,
    submitSearchInput,
  } = useCrawlTaskDetailQuery({ taskId, canView });

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const {
    logs: taskLogs,
    loading: taskLogsLoading,
    error: taskLogsError,
    expandedKeys: expandedTaskLogKeys,
    reload: loadTaskLogs,
    onExpandedRowsChange,
  } = useCrawlTaskLogs({
    apiClient,
    canView,
    canViewTaskLogs,
    authenticated: status === "authenticated",
    taskId,
    message,
  });

  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();
  const [updateIngestToItems, { loading: updatingIngest }] =
    useUpdateCrawlTaskIngestToItemsMutation();
  const [ingestCrawlTaskResultsToItems] =
    useIngestCrawlTaskResultsToItemsMutation();
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillNotice, setBackfillNotice] = useState<BackfillNotice | null>(
    null,
  );
  const [ingestingResultId, setIngestingResultId] = useState<string | null>(
    null,
  );
  const [createItemFromCrawlResult, { loading: ingesting }] = useMutation<{
    createItemFromCrawlResult: { id: string; title: string; status: string };
  }>(CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION);

  const currentTaskStatus = task?.status;
  const shouldTrackInFlightTask =
    currentTaskStatus === "pending" ||
    currentTaskStatus === "queued" ||
    currentTaskStatus === "running";

  const config = useMemo(() => {
    if (!task?.config) {
      return null;
    }
    try {
      return JSON.parse(task.config) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [task?.config]);
  const proxyIssues = useMemo(
    () => findUnsupportedProxyIssues(config, "task.config"),
    [config],
  );
  const hasUnsupportedLegacyProxy = proxyIssues.length > 0;
  const unsupportedProxyActionHint = useMemo(
    () =>
      hasUnsupportedLegacyProxy
        ? t("crawl.policy.actionBlockedByUnsupportedProxy")
        : undefined,
    [hasUnsupportedLegacyProxy, t],
  );
  const isHeadedTask = useMemo(() => config?.headless === false, [config]);
  const lastErrorHeadedIssue = useMemo(
    () => classifyHeadedIssue(task?.lastError ?? undefined),
    [task?.lastError],
  );
  const pipelineJobId = useMemo(() => {
    if (!config) {
      return null;
    }
    const value = config.pipelineJobId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }, [config]);

  const { status: opsLiveStatus, error: opsLiveError } = useCrawlTaskOpsLive({
    canView,
    accessToken: session?.accessToken,
    taskId,
    pipelineJobId,
    shouldTrackInFlightTask,
    refetch,
    startPolling,
    stopPolling,
  });

  const virtualScrollSummary = useMemo(() => {
    if (
      !config ||
      typeof config.virtualScroll !== "object" ||
      !config.virtualScroll
    ) {
      return null;
    }
    const value = config.virtualScroll as Record<string, unknown>;
    const containerSelector =
      typeof value.containerSelector === "string" &&
      value.containerSelector.trim().length > 0
        ? value.containerSelector.trim()
        : "body";
    const scrollCount =
      typeof value.scrollCount === "number" &&
      Number.isFinite(value.scrollCount)
        ? value.scrollCount
        : null;
    const waitAfterScrollMs =
      typeof value.waitAfterScrollMs === "number" &&
      Number.isFinite(value.waitAfterScrollMs)
        ? value.waitAfterScrollMs
        : null;
    const scrollByRaw = value.scrollBy;
    const scrollBy =
      typeof scrollByRaw === "number"
        ? scrollByRaw
        : typeof scrollByRaw === "string"
          ? scrollByRaw === "viewport"
            ? "page_height"
            : scrollByRaw
          : null;
    return {
      containerSelector,
      scrollCount,
      waitAfterScrollMs,
      scrollBy,
    };
  }, [config]);

  const qualityProfileValue = useMemo(() => {
    if (!config || typeof config.qualityProfile !== "string") {
      return null;
    }
    const normalized = config.qualityProfile.trim().toLowerCase();
    if (
      normalized === "quality_first" ||
      normalized === "balanced" ||
      normalized === "speed_first"
    ) {
      return normalized;
    }
    return null;
  }, [config]);

  const qualityProfileSummary = useMemo(() => {
    if (!qualityProfileValue) {
      return null;
    }
    if (qualityProfileValue === "quality_first") {
      return t("crawl.settings.qualityProfileOptions.qualityFirst");
    }
    if (qualityProfileValue === "speed_first") {
      return t("crawl.settings.qualityProfileOptions.speedFirst");
    }
    return t("crawl.settings.qualityProfileOptions.balanced");
  }, [qualityProfileValue, t]);

  const pageTypeHintValue = useMemo(() => {
    if (!config || typeof config.pageTypeHint !== "string") {
      return null;
    }
    const normalized = config.pageTypeHint.trim().toLowerCase();
    if (
      normalized === "auto" ||
      normalized === "list" ||
      normalized === "detail"
    ) {
      return normalized;
    }
    return null;
  }, [config]);

  const pageTypeHintSummary = useMemo(() => {
    if (!pageTypeHintValue) {
      return null;
    }
    if (pageTypeHintValue === "list") {
      return t("crawl.settings.pageTypeHintOptions.list");
    }
    if (pageTypeHintValue === "detail") {
      return t("crawl.settings.pageTypeHintOptions.detail");
    }
    return t("crawl.settings.pageTypeHintOptions.auto");
  }, [pageTypeHintValue, t]);

  const autoExpandDetailsValue =
    typeof config?.autoExpandDetails === "boolean"
      ? config.autoExpandDetails
      : null;

  const detailExpansionSummary = useMemo(() => {
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
    const includeUrlPatterns = Array.isArray(value.includeUrlPatterns)
      ? value.includeUrlPatterns
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const excludeUrlPatterns = Array.isArray(value.excludeUrlPatterns)
      ? value.excludeUrlPatterns
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
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
  }, [config]);

  const crawlStrategyTags = useMemo(() => {
    const tags: ReactNode[] = [];
    if (config?.scanFullPage) {
      tags.push(
        <Tag key="scanFullPage" color="blue">
          {t("crawl.settings.scanFullPage")}
        </Tag>,
      );
    }
    if (virtualScrollSummary) {
      tags.push(
        <Tag key="virtualScroll" color="cyan">
          {t("crawl.virtualScroll.title")}
        </Tag>,
      );
    }
    if (qualityProfileSummary) {
      tags.push(
        <Tag key="qualityProfile" color="purple">
          {qualityProfileSummary}
        </Tag>,
      );
    }
    if (pageTypeHintSummary) {
      tags.push(
        <Tag key="pageTypeHint" color="magenta">
          {pageTypeHintSummary}
        </Tag>,
      );
    }
    if (autoExpandDetailsValue) {
      tags.push(
        <Tag key="autoExpandDetails" color="green">
          {t("crawl.settings.autoExpandDetails")}
        </Tag>,
      );
    }
    return tags;
  }, [
    autoExpandDetailsValue,
    config?.scanFullPage,
    pageTypeHintSummary,
    qualityProfileSummary,
    t,
    virtualScrollSummary,
  ]);

  const taskLogColumns = useMemo(
    () => [
      {
        title: t("quality.taskLogs.columns.time"),
        dataIndex: "createdAt",
        key: "createdAt",
        width: 170,
        render: (value: string) =>
          formatDateTime(value, locale, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
      },
      {
        title: t("quality.taskLogs.columns.stage"),
        dataIndex: "stage",
        key: "stage",
        width: 140,
        render: (value: string) => (
          <Typography.Text style={{ fontFamily: "monospace" }}>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: t("quality.taskLogs.columns.status"),
        dataIndex: "status",
        key: "status",
        width: 120,
        render: (value: TaskLogStatus) => (
          <Tag color={taskLogStatusColors[value] ?? "default"}>
            {t(`quality.taskLogs.status.${value}`, { defaultValue: value })}
          </Tag>
        ),
      },
      {
        title: t("quality.taskLogs.columns.message"),
        dataIndex: "message",
        key: "message",
        render: (value: string | null | undefined, record: TaskLogRecord) => {
          const errorMessage =
            record.error &&
            typeof record.error === "object" &&
            !Array.isArray(record.error)
              ? (() => {
                  const messageValue = (record.error as { message?: unknown })
                    .message;
                  return typeof messageValue === "string" &&
                    messageValue.trim().length > 0
                    ? messageValue.trim()
                    : null;
                })()
              : null;
          return (
            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
              {value ?? errorMessage ?? t("common.emptyValue")}
            </Typography.Text>
          );
        },
      },
    ],
    [locale, t],
  );

  const expansionSummary = useMemo<ExpansionQualitySummary | null>(() => {
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
  }, [taskLogs]);

  const expansionHeadSignalSummary = useMemo<ExpansionHeadSignalSummary | null>(
    () => parseExpansionHeadSignalSummary(taskLogs),
    [taskLogs],
  );

  const expansionHeadSignalSoftFailureDetails = useMemo(() => {
    if (
      !expansionHeadSignalSummary ||
      expansionHeadSignalSummary.softFailureCount <= 0
    ) {
      return "";
    }
    const parts: string[] = [];
    if (expansionHeadSignalSummary.softFailures.httpStatus > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.httpStatus", {
          count: expansionHeadSignalSummary.softFailures.httpStatus,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.nonHtml > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.nonHtml", {
          count: expansionHeadSignalSummary.softFailures.nonHtml,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.emptyHtml > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.emptyHtml", {
          count: expansionHeadSignalSummary.softFailures.emptyHtml,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.networkOrTimeout > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.networkOrTimeout", {
          count: expansionHeadSignalSummary.softFailures.networkOrTimeout,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.noPublishSignal > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.noPublishSignal", {
          count: expansionHeadSignalSummary.softFailures.noPublishSignal,
        }),
      );
    }
    return parts.join(" · ");
  }, [expansionHeadSignalSummary, t]);

  const expansionHeadSignalFallbackHint = useMemo(() => {
    return resolveHeadSignalFallbackHint(expansionHeadSignalSummary);
  }, [expansionHeadSignalSummary]);

  const proxySummary: ReactNode = useMemo(() => {
    if (!config) {
      return t("crawl.detail.proxy.direct");
    }
    const proxyUrl =
      typeof config.proxyUrl === "string" && config.proxyUrl.length > 0
        ? config.proxyUrl
        : null;
    const proxyConfig = config.proxyConfig as
      | { server?: string; username?: string; password?: string }
      | undefined;
    if (proxyConfig?.server) {
      return t("crawl.detail.proxy.unsupportedLegacy", {
        value: proxyConfig.server,
      });
    }
    if (proxyUrl) {
      return t("crawl.detail.proxy.unsupportedLegacy", {
        value: proxyUrl,
      });
    }
    return t("crawl.detail.proxy.direct");
  }, [config, t]);

  const markdownOptions = useMemo(() => {
    if (!config || typeof config.markdownOptions !== "object") {
      return null;
    }
    return config.markdownOptions as Record<string, unknown>;
  }, [config]);

  const markdownFilter = useMemo(() => {
    if (!config || typeof config.markdownFilter !== "object") {
      return null;
    }
    return config.markdownFilter as Record<string, unknown>;
  }, [config]);

  const markdownStrategy = useMemo(() => {
    if (
      !config ||
      typeof config.markdownStrategy !== "object" ||
      !config.markdownStrategy
    ) {
      return null;
    }
    return config.markdownStrategy as Record<string, unknown>;
  }, [config]);

  const cleanMarkdownOptions = useMemo(() => {
    if (
      !config ||
      typeof config.cleanMarkdown !== "object" ||
      !config.cleanMarkdown
    ) {
      return null;
    }
    return config.cleanMarkdown as Record<string, unknown>;
  }, [config]);

  const markdownSummary = useMemo(() => {
    if (!markdownOptions) {
      return t("crawl.detail.markdown.default");
    }
    const parts: string[] = [];
    if (typeof markdownOptions.contentSource === "string") {
      parts.push(
        t("crawl.detail.markdown.source", {
          source: markdownOptions.contentSource,
        }),
      );
    }
    if (typeof markdownOptions.ignoreLinks === "boolean") {
      parts.push(
        markdownOptions.ignoreLinks
          ? t("crawl.detail.markdown.ignoreLinks")
          : t("crawl.detail.markdown.keepLinks"),
      );
    }
    if (typeof markdownOptions.escapeHtml === "boolean") {
      parts.push(
        markdownOptions.escapeHtml
          ? t("crawl.detail.markdown.escapeHtml")
          : t("crawl.detail.markdown.renderHtml"),
      );
    }
    if (typeof markdownOptions.citations === "boolean") {
      parts.push(
        markdownOptions.citations
          ? t("crawl.detail.markdown.citationsEnabled")
          : t("crawl.detail.markdown.citationsDisabled"),
      );
    }
    if (typeof markdownOptions.bodyWidth === "number") {
      parts.push(
        t("crawl.detail.markdown.wrap", { width: markdownOptions.bodyWidth }),
      );
    }
    return parts.length
      ? parts.join(" • ")
      : t("crawl.detail.markdown.default");
  }, [markdownOptions, t]);

  const markdownFilterSummary = useMemo(() => {
    if (!markdownFilter || typeof markdownFilter.type !== "string") {
      return t("common.disabled");
    }
    const parts = [markdownFilter.type];
    if (markdownFilter.type === "bm25") {
      const queryValue =
        typeof markdownFilter.userQuery === "string"
          ? markdownFilter.userQuery
          : typeof markdownFilter.user_query === "string"
            ? (markdownFilter.user_query as string)
            : undefined;
      if (queryValue && queryValue.trim().length > 0) {
        parts.push(
          t("crawl.detail.markdownFilter.query", { query: queryValue }),
        );
      }
      const bm25ThresholdValue =
        typeof markdownFilter.bm25Threshold === "number"
          ? markdownFilter.bm25Threshold
          : typeof markdownFilter.bm25_threshold === "number"
            ? (markdownFilter.bm25_threshold as number)
            : undefined;
      if (typeof bm25ThresholdValue === "number") {
        parts.push(
          t("crawl.detail.markdownFilter.bm25Threshold", {
            value: bm25ThresholdValue,
          }),
        );
      }
      const languageValue =
        typeof markdownFilter.language === "string"
          ? markdownFilter.language
          : typeof markdownFilter.lang === "string"
            ? (markdownFilter.lang as string)
            : undefined;
      if (languageValue && languageValue.trim().length > 0) {
        parts.push(
          t("crawl.detail.markdownFilter.language", {
            language: languageValue,
          }),
        );
      }
      return parts.join(" • ");
    }
    if (typeof markdownFilter.threshold === "number") {
      parts.push(
        t("crawl.detail.markdownFilter.threshold", {
          value: markdownFilter.threshold,
        }),
      );
    }
    const thresholdTypeValue =
      typeof markdownFilter.thresholdType === "string"
        ? markdownFilter.thresholdType
        : typeof markdownFilter.threshold_type === "string"
          ? (markdownFilter.threshold_type as string)
          : undefined;
    if (thresholdTypeValue) {
      parts.push(
        t("crawl.detail.markdownFilter.mode", { mode: thresholdTypeValue }),
      );
    }
    const minWordValue =
      typeof markdownFilter.minWordThreshold === "number"
        ? markdownFilter.minWordThreshold
        : typeof markdownFilter.min_word_threshold === "number"
          ? (markdownFilter.min_word_threshold as number)
          : undefined;
    if (typeof minWordValue === "number") {
      parts.push(
        t("crawl.detail.markdownFilter.minWords", { count: minWordValue }),
      );
    }
    return parts.join(" • ");
  }, [markdownFilter, t]);

  const markdownStrategySummary = useMemo(() => {
    if (!markdownStrategy || typeof markdownStrategy.type !== "string") {
      return t("crawl.detail.markdownStrategy.default");
    }
    const type = markdownStrategy.type;
    const params =
      markdownStrategy.params && typeof markdownStrategy.params === "object"
        ? (markdownStrategy.params as Record<string, unknown>)
        : undefined;
    if (!params) {
      return type;
    }
    const json = JSON.stringify(params);
    const snippet = json.length > 80 ? `${json.slice(0, 80)}...` : json;
    return t("crawl.detail.markdownStrategy.withParams", { type, snippet });
  }, [markdownStrategy, t]);

  const cleanMarkdownSummary = useMemo(() => {
    if (!cleanMarkdownOptions) {
      return t("common.disabled");
    }
    const parts: string[] = [];
    if (
      typeof cleanMarkdownOptions.cssSelector === "string" &&
      cleanMarkdownOptions.cssSelector.trim().length
    ) {
      parts.push(
        t("crawl.detail.cleanMarkdown.scope", {
          selector: cleanMarkdownOptions.cssSelector,
        }),
      );
    }
    if (
      Array.isArray(cleanMarkdownOptions.targetElements) &&
      cleanMarkdownOptions.targetElements.length
    ) {
      parts.push(
        t("crawl.detail.cleanMarkdown.targets", {
          targets: cleanMarkdownOptions.targetElements.join(", "),
        }),
      );
    }
    if (
      Array.isArray(cleanMarkdownOptions.excludedTags) &&
      cleanMarkdownOptions.excludedTags.length
    ) {
      parts.push(
        t("crawl.detail.cleanMarkdown.excluded", {
          tags: cleanMarkdownOptions.excludedTags.join(", "),
        }),
      );
    }
    if (typeof cleanMarkdownOptions.wordCountThreshold === "number") {
      parts.push(
        t("crawl.detail.cleanMarkdown.minWords", {
          count: cleanMarkdownOptions.wordCountThreshold,
        }),
      );
    }
    if (typeof cleanMarkdownOptions.removeOverlayElements === "boolean") {
      parts.push(
        cleanMarkdownOptions.removeOverlayElements
          ? t("crawl.detail.cleanMarkdown.removeOverlays")
          : t("crawl.detail.cleanMarkdown.keepOverlays"),
      );
    }
    return parts.length ? parts.join(" • ") : t("common.enabled");
  }, [cleanMarkdownOptions, t]);

  const browserHeaders = useMemo(() => {
    if (!Array.isArray(config?.browserHeaders)) {
      return [] as string[];
    }
    return (config?.browserHeaders as { name?: string; value?: string }[])
      .map((header) => {
        const name = typeof header?.name === "string" ? header.name : "";
        const value = typeof header?.value === "string" ? header.value : "";
        if (!name || !value) {
          return null;
        }
        return `${name}: ${value}`;
      })
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  const browserCookies = useMemo(() => {
    if (!Array.isArray(config?.browserCookies)) {
      return [] as string[];
    }
    return (
      config?.browserCookies as {
        name?: string;
        value?: string;
        domain?: string;
        path?: string;
      }[]
    )
      .map((cookie) => {
        const name = typeof cookie?.name === "string" ? cookie.name : "";
        const value = typeof cookie?.value === "string" ? cookie.value : "";
        const domain = typeof cookie?.domain === "string" ? cookie.domain : "";
        const path = typeof cookie?.path === "string" ? cookie.path : "";
        if (!name || !value || !domain) {
          return null;
        }
        const target = path ? `${domain}${path}` : domain;
        return `${name}=${value} @ ${target}`;
      })
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  const managedBrowserProfile = useMemo(() => {
    if (!config || typeof config.userDataDir !== "string") {
      return null;
    }
    const trimmed = config.userDataDir.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const userAgentValue = useMemo(() => {
    if (!config || typeof config.userAgent !== "string") {
      return null;
    }
    const trimmed = config.userAgent.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const userAgentModeSummary =
    config?.userAgentMode === "random"
      ? t("crawl.detail.userAgent.random")
      : t("crawl.detail.userAgent.default");

  const userAgentGeneratorSummary = useMemo(() => {
    if (
      !config ||
      typeof config.userAgentGenerator !== "object" ||
      !config.userAgentGenerator
    ) {
      return null;
    }
    const generator = config.userAgentGenerator as Record<string, unknown>;
    const parts: string[] = [];
    const platform =
      typeof generator.platform === "string" ? generator.platform : null;
    if (platform) {
      parts.push(
        t("crawl.detail.userAgentGenerator.platform", { value: platform }),
      );
    }
    const browser =
      typeof generator.browser === "string" ? generator.browser : null;
    if (browser) {
      parts.push(
        t("crawl.detail.userAgentGenerator.browser", { value: browser }),
      );
    }
    const deviceType =
      typeof generator.deviceType === "string" ? generator.deviceType : null;
    if (deviceType) {
      parts.push(
        t("crawl.detail.userAgentGenerator.device", { value: deviceType }),
      );
    }
    const locale =
      typeof generator.locale === "string" ? generator.locale : null;
    if (locale) {
      parts.push(
        t("crawl.detail.userAgentGenerator.locale", { value: locale }),
      );
    }
    return parts.length ? parts.join(" • ") : null;
  }, [config, t]);

  const browserLocale = useMemo(() => {
    if (!config || typeof config.locale !== "string") {
      return null;
    }
    const trimmed = config.locale.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const timezonePreference = useMemo(() => {
    if (!config || typeof config.timezoneId !== "string") {
      return null;
    }
    const trimmed = config.timezoneId.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const geolocationSummary = useMemo(() => {
    if (
      !config ||
      typeof config.geolocation !== "object" ||
      !config.geolocation
    ) {
      return null;
    }
    const geo = config.geolocation as Record<string, unknown>;
    const lat = typeof geo.latitude === "number" ? geo.latitude : null;
    const lon = typeof geo.longitude === "number" ? geo.longitude : null;
    if (lat == null || lon == null) {
      return null;
    }
    const accuracy = typeof geo.accuracy === "number" ? geo.accuracy : null;
    const location = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return accuracy != null
      ? `${location} (±${Math.round(accuracy)}m)`
      : location;
  }, [config]);

  const dynamicJsSteps = useMemo(() => {
    if (!config) {
      return [] as string[];
    }
    if (Array.isArray(config.jsCode)) {
      return (config.jsCode as string[]).filter(
        (entry) => typeof entry === "string",
      );
    }
    if (typeof config.jsCode === "string") {
      const trimmed = config.jsCode.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }, [config]);

  const waitCondition = useMemo(() => {
    if (!config) {
      return null;
    }
    if (
      typeof config.waitForScript === "string" &&
      config.waitForScript.trim().length
    ) {
      return `js:${config.waitForScript.trim()}`;
    }
    if (
      typeof config.waitForSelector === "string" &&
      config.waitForSelector.trim().length
    ) {
      return config.waitForSelector.trim();
    }
    return null;
  }, [config]);

  const waitUntilValue = useMemo(() => {
    if (!config || typeof config.waitUntil !== "string") {
      return null;
    }
    const normalized = config.waitUntil.trim().toLowerCase();
    if (
      normalized === "domcontentloaded" ||
      normalized === "load" ||
      normalized === "networkidle" ||
      normalized === "commit"
    ) {
      return normalized;
    }
    return null;
  }, [config]);
  const waitUntilSummary = useMemo(() => {
    if (!waitUntilValue) {
      return null;
    }
    if (waitUntilValue === "domcontentloaded") {
      return t("crawl.dynamic.waitUntilOptions.domcontentloaded");
    }
    if (waitUntilValue === "networkidle") {
      return t("crawl.dynamic.waitUntilOptions.networkidle");
    }
    if (waitUntilValue === "commit") {
      return t("crawl.dynamic.waitUntilOptions.commit");
    }
    return t("crawl.dynamic.waitUntilOptions.load");
  }, [t, waitUntilValue]);

  const waitTimeoutMs =
    typeof config?.waitForTimeoutMs === "number"
      ? config.waitForTimeoutMs
      : null;
  const pageTimeoutMs =
    typeof config?.pageTimeoutMs === "number" ? config.pageTimeoutMs : null;
  const delayBeforeReturnHtmlMs =
    typeof config?.delayBeforeReturnHtmlMs === "number"
      ? config.delayBeforeReturnHtmlMs
      : null;
  const meanDelayMs =
    typeof config?.meanDelayMs === "number" ? config.meanDelayMs : null;
  const maxDelayRangeMs =
    typeof config?.maxDelayRangeMs === "number" ? config.maxDelayRangeMs : null;
  const semaphoreCount =
    typeof config?.semaphoreCount === "number" ? config.semaphoreCount : null;
  const removeFormsEnabled =
    typeof config?.removeForms === "boolean" ? config.removeForms : null;
  const sessionIdentifier = useMemo(() => {
    if (!config) {
      return null;
    }
    const raw =
      typeof config.sessionId === "string" ? config.sessionId.trim() : "";
    return raw.length ? raw : null;
  }, [config]);
  const storageStatePreview = useMemo(() => {
    if (!config) {
      return null;
    }
    const raw =
      typeof config.storageState === "string" ? config.storageState.trim() : "";
    return raw.length ? shortenScript(raw) : null;
  }, [config]);
  const jsOnlyMode = Boolean(config?.jsOnly);

  const linkOverview = useMemo(() => {
    const analyses =
      task?.results
        ?.map((result) => result.linkAnalysis)
        .filter((analysis): analysis is NonNullable<typeof analysis> =>
          Boolean(analysis),
        ) ?? [];
    if (!analyses.length) {
      return null;
    }
    const totalLinks = analyses.reduce(
      (sum, analysis) => sum + analysis.stats.totalLinks,
      0,
    );
    const internalLinks = analyses.reduce(
      (sum, analysis) => sum + analysis.stats.internalLinks,
      0,
    );
    const externalLinks = analyses.reduce(
      (sum, analysis) => sum + analysis.stats.externalLinks,
      0,
    );
    const highQualityLinks = analyses.reduce(
      (sum, analysis) => sum + (analysis.stats.highQualityLinks ?? 0),
      0,
    );
    const lowQualityLinks = analyses.reduce(
      (sum, analysis) => sum + (analysis.stats.lowQualityLinks ?? 0),
      0,
    );
    const weightedIntrinsic = analyses.reduce((sum, analysis) => {
      const avg = analysis.stats.averageIntrinsicScore ?? 0;
      return sum + avg * analysis.stats.totalLinks;
    }, 0);
    const averageIntrinsic =
      totalLinks > 0
        ? Number((weightedIntrinsic / totalLinks).toFixed(2))
        : null;
    const aggregateLinks = <T,>(items: T[]) => {
      const seen = new Set<string>();
      const ordered: T[] = [];
      for (const item of items) {
        const link = item as { href?: string };
        const key = link.href ?? JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(item);
        }
      }
      return ordered;
    };
    const scoreOf = (link: {
      totalScore?: number | null;
      contextualScore?: number | null;
      intrinsicScore?: number | null;
    }) => link.totalScore ?? link.contextualScore ?? link.intrinsicScore ?? 0;
    const topLinks = aggregateLinks(
      analyses.flatMap((analysis) => analysis.topLinks ?? []),
    )
      .sort((a, b) => scoreOf(b) - scoreOf(a))
      .slice(0, 5);
    const lowLinks = aggregateLinks(
      analyses.flatMap((analysis) => analysis.lowQualityLinks ?? []),
    )
      .sort(
        (a, b) =>
          (a.intrinsicScore ?? Number.POSITIVE_INFINITY) -
          (b.intrinsicScore ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, 5);
    const bucketMap = new Map<
      string,
      {
        count: number;
        links: NonNullable<(typeof analyses)[number]["topLinks"]>;
      }
    >();
    analyses.forEach((analysis) => {
      analysis.buckets.forEach((bucket) => {
        const existing = bucketMap.get(bucket.kind);
        if (existing) {
          existing.count += bucket.links.length;
          existing.links.push(...bucket.links);
        } else {
          bucketMap.set(bucket.kind, {
            count: bucket.links.length,
            links: [...bucket.links],
          });
        }
      });
    });
    const buckets = Array.from(bucketMap.entries()).map(([kind, value]) => ({
      kind,
      count: value.count,
      samples: value.links.slice(0, 4),
    }));
    return {
      stats: {
        totalLinks,
        internalLinks,
        externalLinks,
        highQualityLinks,
        lowQualityLinks,
        averageIntrinsic,
      },
      topLinks,
      lowLinks,
      buckets,
    };
  }, [task?.results]);

  const getLinkScore = (link: {
    totalScore?: number | null;
    contextualScore?: number | null;
    intrinsicScore?: number | null;
  }) => link.totalScore ?? link.contextualScore ?? link.intrinsicScore ?? 0;

  const additionalUrls = useMemo(() => {
    if (!config || !Array.isArray(config.additionalUrls)) {
      return [];
    }
    return config.additionalUrls
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  interface MultiUrlConfigView {
    name?: string;
    matcher?: {
      matchMode?: string;
      patterns?: string[];
    };
    urls?: string[];
    options?: Record<string, unknown>;
  }

  const multiConfigs: MultiUrlConfigView[] = useMemo(() => {
    if (!config || !Array.isArray(config.multiUrlConfigs)) {
      return [];
    }
    return config.multiUrlConfigs.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
  }, [config]);

  const formatMultiUrlOverrides = useCallback(
    (options?: Record<string, unknown>) => {
      if (!options) {
        return null;
      }
      const entries = Object.entries(options).filter(
        ([, value]) => value !== undefined && value !== null,
      );
      if (!entries.length) {
        return null;
      }
      const preferredKeys = [
        "cacheMode",
        "waitUntil",
        "waitForTimeoutMs",
        "pageTimeoutMs",
        "delayBeforeReturnHtmlMs",
        "meanDelayMs",
        "maxDelayRangeMs",
        "semaphoreCount",
        "removeForms",
        "scanFullPage",
        "simulateUser",
        "overrideNavigator",
      ];
      const formatValue = (value: unknown) => {
        if (typeof value === "string") {
          return value.length > 80 ? shortenScript(value) : value;
        }
        if (typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        if (Array.isArray(value)) {
          if (value.length <= 3) {
            return value.map((entry) => String(entry)).join(", ");
          }
          return `${value
            .slice(0, 3)
            .map((entry) => String(entry))
            .join(", ")}…`;
        }
        if (value && typeof value === "object") {
          const serialized = JSON.stringify(value);
          return serialized.length > 120
            ? `${serialized.slice(0, 117)}…`
            : serialized;
        }
        return String(value);
      };
      const prioritized = preferredKeys
        .filter((key) => key in options)
        .map((key) => `${key}=${formatValue(options[key])}`);
      const preferredKeySet = new Set(preferredKeys);
      const remainingCount = entries.filter(
        ([key]) => !preferredKeySet.has(key),
      ).length;
      if (remainingCount > 0) {
        prioritized.push(
          t("crawl.detail.multiUrl.additionalOverrides", {
            count: remainingCount,
          }),
        );
      }
      return prioritized.join(" • ");
    },
    [t],
  );

  const handleRetry = async () => {
    if (!task) return;
    if (hasUnsupportedLegacyProxy) {
      message.error(formatPolicyIssues(proxyIssues, t));
      return;
    }
    try {
      await retryTask({ variables: { id: task.id } });
      message.success(t("crawl.detail.retryQueued"));
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? t("crawl.detail.retryFailed"));
    }
  };

  const handleToggleIngestToItems = async (enabled: boolean) => {
    if (!task || !canManage) {
      return;
    }
    if (enabled && !permissions.includes("items.write")) {
      message.error(
        t("crawl.settings.ingestToItemsNoPermission"),
      );
      return;
    }

    try {
      await updateIngestToItems({
        variables: {
          id: task.id,
          enabled,
        },
      });
      message.success(t("common.updated"));
      await refetch();
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed"),
      );
    }
  };

  const runBackfillToItems = async () => {
    if (!task || !canCreateItem) {
      return;
    }
    if ((task.results?.length ?? 0) === 0 && !task.lastResultAt) {
      const notice: BackfillNotice = {
        type: "info",
        message: t("crawl.detail.backfill.emptyTitle"),
        description: t("crawl.detail.backfill.emptyDescription"),
      };
      setBackfillNotice(notice);
      message.info(notice.message);
      return;
    }

    const messageKey = `crawl-backfill-${task.id}`;
    const batchLimit = 50;
    const maxBatches = 20;
    let after: string | null = null;
    let scannedTotal = 0;
    let ingestedTotal = 0;
    let skippedTotal = 0;
    let failedTotal = 0;

    setBackfillRunning(true);
    setBackfillNotice(null);
    message.loading({
      key: messageKey,
      duration: 0,
      content: t("crawl.detail.backfill.running"),
    });

    try {
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
        const response: FetchResult<IngestCrawlTaskResultsToItemsMutation> =
          await withTimeout(
            ingestCrawlTaskResultsToItems({
              variables: {
                taskId: task.id,
                after,
                limit: batchLimit,
                onlyMissing: true,
              },
            }),
            BACKFILL_BATCH_TIMEOUT_MS,
            t("crawl.detail.backfill.timeout"),
          );
        const summary:
          | IngestCrawlTaskResultsToItemsMutation["ingestCrawlTaskResultsToItems"]
          | null
          | undefined = response.data?.ingestCrawlTaskResultsToItems;
        if (!summary) {
          break;
        }

        scannedTotal += summary.scanned;
        ingestedTotal += summary.ingested;
        skippedTotal += summary.skippedExisting;
        failedTotal += summary.failed;

        message.loading({
          key: messageKey,
          duration: 0,
          content: t("crawl.detail.backfill.progress", {
            ingested: ingestedTotal,
            skipped: skippedTotal,
            failed: failedTotal,
          }),
        });

        after = summary.nextCursor ?? null;
        if (!summary.hasMore || !after) {
          break;
        }
      }

      const summaryDescription = t("crawl.detail.backfill.summary", {
        ingested: ingestedTotal,
        skipped: skippedTotal,
        failed: failedTotal,
        scanned: scannedTotal,
      });
      let notice: BackfillNotice;
      if (scannedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.emptyTitle"),
          description: t("crawl.detail.backfill.emptyDescription"),
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (ingestedTotal === 0 && failedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.noMissingTitle"),
          description: summaryDescription,
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (failedTotal > 0) {
        notice = {
          type: ingestedTotal > 0 ? "warning" : "error",
          message: t("crawl.detail.backfill.partialTitle"),
          description: summaryDescription,
        };
        if (notice.type === "error") {
          message.error({
            key: messageKey,
            content: notice.message,
          });
        } else {
          message.warning({
            key: messageKey,
            content: notice.message,
          });
        }
      } else {
        notice = {
          type: "success",
          message: t("crawl.detail.backfill.done"),
          description: summaryDescription,
        };
        message.success({
          key: messageKey,
          content: notice.message,
        });
      }
      setBackfillNotice(notice);
      await refetch();
    } catch (error) {
      const description =
        error instanceof Error
          ? error.message
          : t("common.operationFailed");
      setBackfillNotice({
        type: "error",
        message: t("crawl.detail.backfill.failedTitle"),
        description,
      });
      message.error({
        key: messageKey,
        content: description,
      });
    } finally {
      setBackfillRunning(false);
    }
  };

  const handleBackfillToItems = () => {
    if (!task || !canCreateItem) {
      return;
    }
    if ((task.results?.length ?? 0) === 0 && !task.lastResultAt) {
      void runBackfillToItems();
      return;
    }

    Modal.confirm({
      title: t("crawl.detail.backfill.confirmTitle"),
      content: t("crawl.detail.backfill.confirmDescription"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: runBackfillToItems,
    });
  };

  const handleCreateItem = async (resultId: string) => {
    if (!canCreateItem) {
      return;
    }

    const normalizedId = resultId.trim();
    if (!normalizedId) {
      message.error(
        t("common.invalidInput"),
      );
      return;
    }

    setIngestingResultId(normalizedId);
    try {
      const response = await createItemFromCrawlResult({
        variables: { resultId: normalizedId },
      });
      const createdId = response.data?.createItemFromCrawlResult?.id;
      message.success(
        t("crawl.detail.ingestQueued"),
      );
      if (createdId) {
        router.push(`/items/${createdId}`);
      }
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed"),
      );
    } finally {
      setIngestingResultId(null);
    }
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
        title={t("crawl.detail.title")}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  if (loading && !task) {
    return (
      <div className="content-card" style={{ textAlign: "center" }}>
        <Spin />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="content-card">
        <Typography.Text type="secondary">
          {t("crawl.detail.notFound")}
        </Typography.Text>
      </div>
    );
  }

  const results = task.results ?? [];
  const includeImagesEnabled = Boolean(config?.includeImages);
  const storeMediaEnabled = Boolean(config?.storeMedia);
  const ingestToItemsEnabled = Boolean(config?.ingestToItems);
  const adjustViewportEnabled = Boolean(config?.adjustViewportToContent);
  const managedBrowserEnabled = Boolean(config?.useManagedBrowser);
  const backfillUnavailable = results.length === 0 && !task.lastResultAt;

  return (
    <div className="content-card">
      <Space style={{ marginBottom: 16 }} wrap>
        <Link href="/admin/ops/crawl-tasks">
          {t("crawl.detail.backToTasks")}
        </Link>
        <Tag color={statusColors[task.status]}>
          {t(`crawl.status.${task.status}`, { defaultValue: task.status })}
        </Tag>
        <Tag
          color={
            opsLiveError
              ? "red"
              : opsLiveStatus === "connected"
                ? "green"
                : opsLiveStatus === "connecting"
                  ? "blue"
                  : undefined
          }
        >
          {opsLiveError
            ? t("crawl.liveUpdates.error")
            : opsLiveStatus === "connected"
              ? t("crawl.liveUpdates.connected")
              : opsLiveStatus === "connecting"
                ? t("crawl.liveUpdates.connecting")
                : t("crawl.liveUpdates.disconnected")}
        </Tag>
        {canManage ? (
          <Tooltip title={unsupportedProxyActionHint}>
            <span>
              <Button
                onClick={handleRetry}
                loading={retrying}
                disabled={hasUnsupportedLegacyProxy}
              >
                {t("crawl.detail.retry")}
              </Button>
            </span>
          </Tooltip>
        ) : null}
        {canCreateItem ? (
          <Button
            onClick={handleBackfillToItems}
            loading={backfillRunning}
            disabled={backfillUnavailable}
          >
            {t("crawl.detail.backfill.button")}
          </Button>
        ) : null}
        {canCreateItem && backfillUnavailable ? (
          <Typography.Text type="secondary">
            {t("crawl.detail.backfill.emptyHint")}
          </Typography.Text>
        ) : null}
        <Typography.Link href={task.targetUrl} target="_blank" rel="noreferrer">
          {t("crawl.detail.openSource")}
        </Typography.Link>
      </Space>
      {hasUnsupportedLegacyProxy ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.proxy.unsupportedLegacyTitle")}
          description={formatPolicyIssues(proxyIssues, t)}
        />
      ) : null}
      {opsLiveError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.liveUpdates.alertTitle")}
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {opsLiveError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.liveUpdates.fallbackHint")}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      {backfillNotice ? (
        <Alert
          type={backfillNotice.type}
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={backfillNotice.message}
          description={backfillNotice.description}
          onClose={() => setBackfillNotice(null)}
        />
      ) : null}
      {task.lastError ? (
        <Alert
          type={
            task.status === "failed"
              ? "error"
              : task.status === "completed"
                ? "success"
                : "warning"
          }
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.detail.latestError")}
          description={
            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
              {task.lastError}
            </Typography.Text>
          }
        />
      ) : null}
      {isHeadedTask ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.runtimeGuide.title")}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.noAutoBootstrap")}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.principleBody")}
              </Typography.Text>
              <details>
                <summary>
                  {t("crawl.runtimeGuide.stepsTitle")}
                </summary>
                <Space direction="vertical" size={2} style={{ marginTop: 6 }}>
                  <Typography.Text type="secondary">
                    {`1. ${t("crawl.runtimeGuide.step1")}`}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {`2. ${t("crawl.runtimeGuide.step2")}`}
                  </Typography.Text>
                </Space>
              </details>
            </Space>
          }
        />
      ) : null}
      {isHeadedTask && task.lastError && lastErrorHeadedIssue === "display" ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.runtimeGuide.displayIssueTitle")}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {task.lastError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.displayIssueHint")}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      {isHeadedTask && task.lastError && lastErrorHeadedIssue === "timeout" ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.runtimeGuide.timeoutIssueTitle")}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {task.lastError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.timeoutIssueHint")}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      {crawlStrategyTags.length ? (
        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={t("crawl.detail.strategy.title")}
        >
          <Space wrap size={[4, 6]}>
            {crawlStrategyTags}
          </Space>
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {t("crawl.detail.strategy.noLlmHint")}
          </Typography.Paragraph>
        </Card>
      ) : null}
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label={t("crawl.detail.fields.displayName")}>
          {task.displayName ?? task.targetUrl}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.keywords")}>
          {task.keywords.length ? (
            <Space wrap>
              {task.keywords.map((keyword) => (
                <Tag key={keyword}>{keyword}</Tag>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.concurrency")}>
          {task.concurrency}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.includeImages")}>
          {includeImagesEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.storeMedia")}>
          {storeMediaEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.ingestToItems")}
        >
          {canManage ? (
            <Space direction="vertical" size={4}>
              <Switch
                checked={ingestToItemsEnabled}
                loading={updatingIngest}
                onChange={(checked) => void handleToggleIngestToItems(checked)}
              />
              <Typography.Text type="secondary">
                {permissions.includes("items.write")
                  ? t("crawl.settings.ingestToItemsHint")
                  : t("crawl.settings.ingestToItemsNoPermission")}
              </Typography.Text>
            </Space>
          ) : ingestToItemsEnabled ? (
            t("common.enabled")
          ) : (
            t("common.disabled")
          )}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.lastRunItems")}
        >
          {task.lastRunSummary
            ? t("crawl.detail.lastRunItemsValue", {
                queued: task.lastRunSummary.itemsQueued ?? 0,
                failed: task.lastRunSummary.itemsQueueFailed ?? 0,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.lastRunResults")}
        >
          {task.lastRunSummary
            ? t("crawl.detail.lastRunResultsValue", {
                inserted: task.lastRunSummary.inserted,
                skipped: task.lastRunSummary.skipped,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.runCount")}>
          {task.runCount}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.scanFullPage")}>
          {config?.scanFullPage
            ? t("crawl.detail.scanFullPageEnabled", {
                delay: config?.scrollDelayMs ?? 200,
              })
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.virtualScroll")}>
          {virtualScrollSummary ? (
            <Space direction="vertical" size={0}>
              <Typography.Text style={{ fontFamily: "monospace" }}>
                containerSelector={virtualScrollSummary.containerSelector}
              </Typography.Text>
              {virtualScrollSummary.scrollCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  scrollCount={virtualScrollSummary.scrollCount}
                </Typography.Text>
              ) : null}
              {virtualScrollSummary.scrollBy ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  scrollBy={virtualScrollSummary.scrollBy}
                </Typography.Text>
              ) : null}
              {virtualScrollSummary.waitAfterScrollMs != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  waitAfterScrollMs={virtualScrollSummary.waitAfterScrollMs}
                </Typography.Text>
              ) : null}
            </Space>
          ) : (
            t("common.disabled")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.qualityProfile")}>
          {qualityProfileSummary ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.pageTypeHint")}>
          {pageTypeHintSummary ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.autoExpandDetails")}>
          {typeof autoExpandDetailsValue === "boolean"
            ? autoExpandDetailsValue
              ? t("common.enabled")
              : t("common.disabled")
            : t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.detailExpansion")}>
          {detailExpansionSummary ? (
            <Space direction="vertical" size={0}>
              {detailExpansionSummary.maxDetailUrls != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  maxDetailUrls={detailExpansionSummary.maxDetailUrls}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.minRelevanceScore != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  minRelevanceScore={detailExpansionSummary.minRelevanceScore}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.requireSameDomain != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  requireSameDomain=
                  {detailExpansionSummary.requireSameDomain ? "true" : "false"}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.allowExternalLinks != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  allowExternalLinks=
                  {detailExpansionSummary.allowExternalLinks ? "true" : "false"}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.minPublishTimeConfidence != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  minPublishTimeConfidence=
                  {detailExpansionSummary.minPublishTimeConfidence}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.preferFitMarkdownForQuality != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  preferFitMarkdownForQuality=
                  {detailExpansionSummary.preferFitMarkdownForQuality
                    ? "true"
                    : "false"}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.excludeUrlPatterns.length > 0 ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  excludeUrlPatterns=
                  {detailExpansionSummary.excludeUrlPatterns.join(", ")}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.includeUrlPatterns.length > 0 ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  includeUrlPatterns=
                  {detailExpansionSummary.includeUrlPatterns.join(", ")}
                </Typography.Text>
              ) : null}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.expansionMetrics")}
        >
          {expansionSummary || expansionHeadSignalSummary ? (
            <Space direction="vertical" size={0}>
              {expansionSummary ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  candidateCount={expansionSummary.candidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  batchCount={expansionSummary.batchCount}
                </Typography.Text>
              ) : null}
              {expansionSummary ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  improvedSuccesses={expansionSummary.improvedSuccesses}
                </Typography.Text>
              ) : null}
              {expansionSummary?.primaryCandidatePool != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  primaryCandidatePool={expansionSummary.primaryCandidatePool}
                </Typography.Text>
              ) : null}
              {expansionSummary?.fallbackCandidatePool != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  fallbackCandidatePool={expansionSummary.fallbackCandidatePool}
                </Typography.Text>
              ) : null}
              {expansionSummary?.minimumCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  minimumCandidateCount={expansionSummary.minimumCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary?.strictCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  strictCandidateCount={expansionSummary.strictCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary?.relaxedCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  relaxedCandidateCount={expansionSummary.relaxedCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary?.linkFallbackCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  linkFallbackCandidateCount=
                  {expansionSummary.linkFallbackCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionHeadSignalSummary ? (
                <>
                  {expansionHeadSignalSummary.attempted != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalAttempted={expansionHeadSignalSummary.attempted}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.succeeded != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalSucceeded={expansionHeadSignalSummary.succeeded}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.failed != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalFailed={expansionHeadSignalSummary.failed}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.topK != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalTopK={expansionHeadSignalSummary.topK}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.configuredTimeoutMs != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      configuredTimeoutMs=
                      {expansionHeadSignalSummary.configuredTimeoutMs}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.configuredConcurrency != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      configuredConcurrency=
                      {expansionHeadSignalSummary.configuredConcurrency}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.configuredMaxReadBytes != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      configuredMaxReadBytes=
                      {expansionHeadSignalSummary.configuredMaxReadBytes}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.effectiveTimeoutMs != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      effectiveTimeoutMs=
                      {expansionHeadSignalSummary.effectiveTimeoutMs}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.effectiveConcurrency != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      effectiveConcurrency=
                      {expansionHeadSignalSummary.effectiveConcurrency}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.maxReadBytes != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      maxReadBytes={expansionHeadSignalSummary.maxReadBytes}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.truncatedResponses != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      truncatedResponses=
                      {expansionHeadSignalSummary.truncatedResponses}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.earlyStoppedResponses != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      earlyStoppedResponses=
                      {expansionHeadSignalSummary.earlyStoppedResponses}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.skipped != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalSkipped=
                      {expansionHeadSignalSummary.skipped ? "true" : "false"}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.softFailureCount > 0 ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 8 }}
                      message={t("crawl.detail.expansion.softFailureMessage", {
                        count: expansionHeadSignalSummary.softFailureCount,
                      })}
                      description={t(
                        "crawl.detail.expansion.softFailureDescription",
                        {
                          details: expansionHeadSignalSoftFailureDetails,
                        },
                      )}
                    />
                  ) : null}
                  {expansionHeadSignalFallbackHint ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 8 }}
                      message={t(
                        "crawl.detail.expansion.urlPathFallbackMessage",
                        {
                          count: expansionHeadSignalFallbackHint.fallbackCount,
                          total:
                            expansionHeadSignalFallbackHint.totalCandidates,
                        },
                      )}
                      description={t(
                        "crawl.detail.expansion.urlPathFallbackDescription",
                        {
                          ratio: Number(
                            (
                              expansionHeadSignalFallbackHint.fallbackRatio *
                              100
                            ).toFixed(1),
                          ),
                        },
                      )}
                    />
                  ) : null}
                </>
              ) : null}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.adjustViewport")}>
          {adjustViewportEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.headless")}
        >
          {typeof config?.headless === "boolean"
            ? config.headless
              ? t("crawl.detail.headless.headless")
              : t("crawl.detail.headless.headed")
            : t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.undetectedBrowser")}>
          {config?.enableUndetectedBrowser
            ? t("common.enabled")
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.stealthMode")}>
          {config?.enableStealthMode
            ? t("common.enabled")
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.antiBotMode")}
        >
          {config?.antiBotMode === "enabled"
            ? t("crawl.detail.antiBotMode.enabled")
            : config?.antiBotMode === "disabled"
              ? t("crawl.detail.antiBotMode.disabled")
              : t("crawl.detail.antiBotMode.auto")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.managedBrowser")}>
          {managedBrowserEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.userDataDir")}>
          {managedBrowserProfile ?? t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.simulateUser")}>
          {config?.simulateUser ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.overrideNavigator")}>
          {config?.overrideNavigator
            ? t("common.enabled")
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.userAgent")}>
          {userAgentValue ?? t("crawl.detail.userAgent.default")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.userAgentMode")}>
          {userAgentModeSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.uaGenerator")}>
          {userAgentGeneratorSummary ??
            t("crawl.detail.userAgent.notConfigured")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.browserLocale")}>
          {browserLocale ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.timezone")}>
          {timezonePreference ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.geolocation")}>
          {geolocationSummary ?? t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.customHeaders")}>
          {browserHeaders.length ? (
            <Space direction="vertical" size={0}>
              {browserHeaders.map((header) => (
                <Typography.Text
                  key={header}
                  style={{ fontFamily: "monospace" }}
                >
                  {header}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.cookies")}>
          {browserCookies.length ? (
            <Space direction="vertical" size={0}>
              {browserCookies.map((cookie) => (
                <Typography.Text
                  key={cookie}
                  style={{ fontFamily: "monospace" }}
                >
                  {cookie}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.sessionId")}>
          {sessionIdentifier ?? t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.storageState")}>
          {storageStatePreview ? (
            <Typography.Text code>{storageStatePreview}</Typography.Text>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.jsOnly")}>
          {jsOnlyMode ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.jsSteps")}>
          {dynamicJsSteps.length ? (
            <Space direction="vertical" size={0}>
              {dynamicJsSteps.map((snippet, index) => (
                <Typography.Text
                  key={`js-${index}`}
                  style={{ fontFamily: "monospace" }}
                >
                  {shortenScript(snippet)}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.waitCondition")}>
          {waitCondition
            ? shortenScript(waitCondition)
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.waitTimeout")}>
          {waitTimeoutMs
            ? t("crawl.detail.waitTimeoutValue", { value: waitTimeoutMs })
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.waitUntil")}
        >
          {waitUntilSummary ?? t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.pageTimeout")}
        >
          {pageTimeoutMs != null
            ? `${Math.round(pageTimeoutMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.delayBeforeReturnHtml")}
        >
          {delayBeforeReturnHtmlMs != null
            ? `${Math.round(delayBeforeReturnHtmlMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.meanDelay")}
        >
          {meanDelayMs != null
            ? `${Math.round(meanDelayMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.maxDelayRange")}
        >
          {maxDelayRangeMs != null
            ? `${Math.round(maxDelayRangeMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.semaphoreCount")}
        >
          {semaphoreCount != null ? semaphoreCount : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.robotsPolicy")}
        >
          {t("crawl.detail.robotsPolicy.ignore")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.removeForms")}
        >
          {removeFormsEnabled == null
            ? t("crawl.detail.default")
            : removeFormsEnabled
              ? t("common.enabled")
              : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.proxyRoute")}>
          {proxySummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.additionalUrls")}>
          {additionalUrls.length ? (
            <Space wrap>
              {additionalUrls.map((url) => (
                <Typography.Link
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {url}
                </Typography.Link>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.markdownGenerator")}>
          {markdownSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.markdownStrategy")}>
          {markdownStrategySummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.markdownFilter")}>
          {markdownFilterSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.cleanMarkdown")}>
          {cleanMarkdownSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastServerMemory")}>
          {task.lastServerMemoryMb != null
            ? t("crawl.detail.memoryValue", { value: task.lastServerMemoryMb })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastPeakMemory")}>
          {task.lastPeakMemoryMb != null
            ? t("crawl.detail.memoryValue", { value: task.lastPeakMemoryMb })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.lastMemoryEfficiency")}
        >
          {task.lastMemoryEfficiency != null
            ? t("crawl.detail.percentValue", {
                value: task.lastMemoryEfficiency,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.serverMemory")}>
          {task.memoryStats?.serverMemoryMb != null
            ? t("crawl.detail.memoryValue", {
                value: task.memoryStats.serverMemoryMb,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.peakMemory")}>
          {task.memoryStats?.peakMemoryMb != null
            ? t("crawl.detail.memoryValue", {
                value: task.memoryStats.peakMemoryMb,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.efficiency")}>
          {task.memoryStats?.efficiencyPercent != null
            ? t("crawl.detail.percentValue", {
                value: task.memoryStats.efficiencyPercent,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastSuccess")}>
          {task.lastSuccessAt
            ? formatDateTime(task.lastSuccessAt, locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : t("common.never")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastError")}>
          {task.lastError ?? t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.configuration")}>
          {config ? (
            <pre className="markdown-preview" style={markdownPreviewStyle}>
              {JSON.stringify(config, null, 2)}
            </pre>
          ) : (
            t("crawl.detail.default")
          )}
        </Descriptions.Item>
      </Descriptions>

      {canViewTaskLogs ? (
        <Card
          title={t("quality.taskLogs.title")}
          size="small"
          style={{ marginTop: 24 }}
          extra={
            <Button
              size="small"
              onClick={() => void loadTaskLogs()}
              loading={taskLogsLoading}
            >
              {t("common.refresh")}
            </Button>
          }
        >
          {taskLogsError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={t("common.error.unexpected")}
              description={
                <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                  {taskLogsError}
                </Typography.Text>
              }
            />
          ) : null}
          <Table
            size="small"
            rowKey={(record) => record.id}
            columns={taskLogColumns}
            dataSource={taskLogs}
            pagination={false}
            loading={taskLogsLoading}
            locale={{ emptyText: t("common.empty") }}
            expandable={{
              expandedRowKeys: expandedTaskLogKeys,
              onExpandedRowsChange,
              expandRowByClick: true,
              rowExpandable: (record) => Boolean(record.data || record.error),
              expandedRowRender: (record) => (
                <pre
                  className="markdown-preview"
                  style={{ ...markdownPreviewStyle, margin: 0 }}
                >
                  {JSON.stringify(
                    { data: record.data ?? null, error: record.error ?? null },
                    null,
                    2,
                  )}
                </pre>
              ),
            }}
          />
        </Card>
      ) : null}

      {multiConfigs.length ? (
        <Card title={t("crawl.multiUrl.title")} style={{ marginTop: 24 }}>
          <List
            dataSource={multiConfigs}
            renderItem={(item, index) => {
              const matcher = item?.matcher;
              const urls = Array.isArray(item?.urls) ? item.urls : [];
              const options = item?.options ?? {};
              const overridesSummary = formatMultiUrlOverrides(options);
              return (
                <List.Item key={item?.name ?? `strategy-${index}`}>
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>
                      {item?.name ??
                        t("crawl.multiUrl.strategyTitle", { index: index + 1 })}
                    </Typography.Text>
                    {matcher?.patterns?.length ? (
                      <Typography.Text type="secondary">
                        {t("crawl.detail.multiUrl.patterns", {
                          mode: matcher.matchMode ?? "glob",
                          patterns: matcher.patterns.join(", "),
                        })}
                      </Typography.Text>
                    ) : null}
                    {urls.length ? (
                      <Space wrap>
                        {urls.map((url) => (
                          <Typography.Link
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {url}
                          </Typography.Link>
                        ))}
                      </Space>
                    ) : null}
                    {Object.keys(options).length && overridesSummary ? (
                      <Typography.Text>
                        {t("crawl.detail.multiUrl.overrides", {
                          overrides: overridesSummary,
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
      ) : null}

      {linkOverview ? (
        <Card title={t("crawl.links.title")} style={{ marginTop: 24 }}>
          <Space size="large" wrap>
            {[
              {
                label: t("crawl.links.stats.total"),
                value: linkOverview.stats.totalLinks,
              },
              {
                label: t("crawl.links.stats.internal"),
                value: linkOverview.stats.internalLinks,
              },
              {
                label: t("crawl.links.stats.external"),
                value: linkOverview.stats.externalLinks,
              },
              {
                label: t("crawl.links.stats.highQuality"),
                value: linkOverview.stats.highQualityLinks,
              },
              {
                label: t("crawl.links.stats.needsReview"),
                value: linkOverview.stats.lowQualityLinks,
              },
              {
                label: t("crawl.links.stats.avgIntrinsic"),
                value:
                  linkOverview.stats.averageIntrinsic !== null &&
                  linkOverview.stats.averageIntrinsic !== undefined
                    ? linkOverview.stats.averageIntrinsic.toFixed(2)
                    : t("common.emptyValue"),
              },
            ].map((item) => (
              <Space key={item.label} direction="vertical" size={0}>
                <Typography.Text type="secondary">{item.label}</Typography.Text>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {item.value}
                </Typography.Title>
              </Space>
            ))}
          </Space>
          {linkOverview.buckets.length ? (
            <>
              <Typography.Text
                strong
                style={{ display: "block", marginTop: 16 }}
              >
                {t("crawl.links.buckets")}
              </Typography.Text>
              <Space wrap>
                {linkOverview.buckets.map((bucket) => (
                  <Tag key={bucket.kind}>
                    {t("crawl.links.bucketItem", {
                      kind: bucket.kind,
                      count: bucket.count,
                    })}
                  </Tag>
                ))}
              </Space>
            </>
          ) : null}
          <Space align="start" size="large" style={{ marginTop: 16 }} wrap>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>
                {t("crawl.links.topLinks")}
              </Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.topLinks}
                locale={{ emptyText: t("crawl.links.emptyScored") }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {t("crawl.links.linkScore", {
                          domain: (link.baseDomain ?? "link").toString(),
                          score: getLinkScore(link).toFixed(2),
                        })}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>
                {t("crawl.links.lowQuality")}
              </Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.lowLinks}
                locale={{ emptyText: t("crawl.links.emptyLowQuality") }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {t("crawl.links.intrinsicScore", {
                          domain: (link.baseDomain ?? "link").toString(),
                          score: (link.intrinsicScore ?? 0).toFixed(2),
                        })}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          </Space>
        </Card>
      ) : null}

      <Card
        title={t("crawl.detail.results.title")}
        style={{ marginTop: 24 }}
        extra={
          <Space>
            <Space.Compact style={{ width: 260 }}>
              <Input
                id="crawl-task-result-search"
                name="crawlTaskResultSearch"
                placeholder={t("crawl.detail.results.searchPlaceholder")}
                allowClear
                value={resultSearchInput}
                onChange={(event) => changeSearchInput(event.target.value)}
                onPressEnter={() => submitSearchInput()}
              />
              <Button
                icon={<SearchOutlined />}
                aria-label={t("crawl.detail.results.searchPlaceholder")}
                onClick={() => submitSearchInput()}
              />
            </Space.Compact>
            <Select
              value={resultLimit}
              style={{ width: 140 }}
              onChange={setResultLimit}
              options={limitOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey, {
                  defaultValue: option.defaultValue,
                }),
              }))}
            />
          </Space>
        }
      >
        {loading && results.length === 0 ? (
          <Spin />
        ) : (
          <List
            dataSource={results}
            locale={{ emptyText: t("crawl.detail.results.empty") }}
            renderItem={(result) => {
              const metadata = result.metadata;
              const mediaPayload = safeParseJson<CrawlMediaCollection>(
                result.media,
              );
              const storedAssets = safeParseJson<CrawlStoredMediaAsset[]>(
                result.mediaAssets,
              );
              const tablesPayload = (result.tables ?? null) as
                | CrawlResultTable[]
                | null;
              const itemStatus =
                result.itemStatus?.toLowerCase?.() ?? result.itemStatus ?? null;
              const itemTagColor =
                itemStatus && typeof itemStatus === "string"
                  ? (itemStatusColors[itemStatus] ?? "default")
                  : "default";
              const variantEntries = [
                {
                  key: "raw",
                  label: t("crawl.detail.results.variants.raw"),
                  content: result.markdown,
                },
                {
                  key: "citations",
                  label: t("crawl.detail.results.variants.citations"),
                  content: result.markdownWithCitations,
                },
                {
                  key: "references",
                  label: t("crawl.detail.results.variants.references"),
                  content: result.referencesMarkdown,
                },
                {
                  key: "fit",
                  label: t("crawl.detail.results.variants.cleanFit"),
                  content: result.fitMarkdown,
                },
              ].filter((entry) => entry.content && entry.content.length > 0);
              const defaultContent = (
                <pre
                  className="markdown-preview"
                  style={{ ...markdownPreviewStyle, marginTop: 8 }}
                >
                  {result.markdown}
                </pre>
              );
              const tabs =
                variantEntries.length > 1 ? (
                  <Tabs
                    size="small"
                    style={{ marginTop: 8 }}
                    items={variantEntries.map((entry) => ({
                      key: entry.key,
                      label: entry.label,
                      children: (
                        <pre
                          className="markdown-preview"
                          style={{ ...markdownPreviewStyle, marginTop: 8 }}
                        >
                          {entry.content}
                        </pre>
                      ),
                    }))}
                  />
                ) : (
                  defaultContent
                );
              return (
                <List.Item key={result.id}>
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Typography.Link
                          href={result.sourceUrl}
                          target="_blank"
                        >
                          {result.sourceUrl}
                        </Typography.Link>
                        <Typography.Text type="secondary">
                          {formatDateTime(result.fetchedAt, locale, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Typography.Text>
                        {result.itemId ? (
                          <>
                            {itemStatus ? (
                              <Tag color={itemTagColor}>
                                {t(`items.status.${itemStatus}`, {
                                  defaultValue: itemStatus,
                                })}
                              </Tag>
                            ) : null}
                            {canViewItems ? (
                              <Button
                                size="small"
                                onClick={() =>
                                  router.push(`/items/${result.itemId}`)
                                }
                              >
                                {t("crawl.detail.openItem")}
                              </Button>
                            ) : null}
                          </>
                        ) : canCreateItem ? (
                          <Button
                            size="small"
                            loading={
                              ingesting && ingestingResultId === result.id
                            }
                            onClick={() => handleCreateItem(result.id)}
                          >
                            {t("crawl.detail.ingestToItems")}
                          </Button>
                        ) : null}
                      </Space>
                    }
                    description={
                      <>
                        {metadata && (
                          <Typography.Text type="secondary">
                            {metadata}
                          </Typography.Text>
                        )}
                        {tabs}
                        <MediaSection media={mediaPayload} />
                        <StoredMediaSection assets={storedAssets} />
                        <TablesSection tables={tablesPayload} />
                      </>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>
    </div>
  );
}
