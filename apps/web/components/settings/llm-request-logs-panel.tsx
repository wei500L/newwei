"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { useCsvExport } from "@/hooks/use-csv-export";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateForFilename } from "@/lib/data-export";

type LlmRequestType =
  | "completion"
  | "embedding"
  | "rerank"
  | "stream"
  | "responses";
type LlmRequestStatus = "success" | "error";

interface LlmRequestLogRow {
  id: string;
  orgId: string;
  requestType: LlmRequestType;
  model: string;
  status: LlmRequestStatus;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  feature: string | null;
  latencyMs: number;
  error: string | null;
  metadata: unknown;
  apiSurface: "chat_completions" | "responses" | "embeddings" | null;
  createdAt: string;
  updatedAt: string;
}

interface LlmRequestLogListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: LlmRequestLogRow[];
  metadataPolicy: LlmRequestLogMetadataPolicySummary;
}

interface LlmRequestLogMetadataPolicySummary {
  source: LlmRequestLogSettingsSource;
  allowedTopLevelKeys: string[];
  allowedTopLevelPrefixes: string[];
  keyCount: number;
  prefixCount: number;
}

interface LlmUsageSummaryTotals {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

interface LlmUsageSummaryByModelRow extends LlmUsageSummaryTotals {
  model: string;
}

interface LlmUsageSummaryByDayRow extends LlmUsageSummaryTotals {
  date: string;
}

interface LlmUsageSummaryStatusBreakdown {
  success: number;
  error: number;
  successRate: number;
  errorRate: number;
}

interface LlmUsageSummaryLatency {
  avgMs: number;
  p95Ms: number | null;
}

interface LlmUsageSummaryTopError {
  message: string;
  count: number;
}

interface LlmUsageSummaryResponse {
  totals: LlmUsageSummaryTotals;
  statusBreakdown: LlmUsageSummaryStatusBreakdown;
  latency: LlmUsageSummaryLatency;
  topErrors: LlmUsageSummaryTopError[];
  byModel: LlmUsageSummaryByModelRow[];
  byDay: LlmUsageSummaryByDayRow[];
}

type LlmRequestLogSettingsSource = "default" | "db";

interface LlmRequestLogSettingsResponse {
  source: LlmRequestLogSettingsSource;
  retentionDays: number;
  metadataAllowedTopLevelKeys: string[];
  metadataAllowedTopLevelPrefixes: string[];
  briefErrorRateThreshold: number;
  briefInvalidJsonRatioThreshold: number;
  briefConsecutiveDaysThreshold: number;
}

interface LlmRequestLogSettingsFormValues {
  retentionDays: number;
  metadataAllowedTopLevelKeys: string[];
  metadataAllowedTopLevelPrefixes: string[];
  briefErrorRateThreshold: number;
  briefInvalidJsonRatioThreshold: number;
  briefConsecutiveDaysThreshold: number;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS = 100;
const MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES = 20;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_PREFIX_LENGTH = 24;
const METADATA_TOKEN_PATTERN = /^[a-z0-9_:\-.]+$/;
const DEFAULT_BRIEF_ERROR_RATE_THRESHOLD = 0.1;
const DEFAULT_BRIEF_INVALID_JSON_RATIO_THRESHOLD = 0.3;
const DEFAULT_BRIEF_CONSECUTIVE_DAYS_THRESHOLD = 3;

const DEFAULT_METADATA_ALLOWED_TOP_LEVEL_KEYS = [
  "attempt",
  "batchid",
  "category",
  "channel",
  "correlationid",
  "env",
  "feature",
  "flowid",
  "jobid",
  "language",
  "locale",
  "model",
  "module",
  "operation",
  "pipeline",
  "profile",
  "provider",
  "requestid",
  "retry",
  "runid",
  "scenario",
  "sessionid",
  "source",
  "stage",
  "tags",
  "taskid",
  "tenantid",
  "traceid",
  "userid",
  "version",
];

const DEFAULT_METADATA_ALLOWED_TOP_LEVEL_PREFIXES = ["x_", "meta_", "ctx_"];

const EMPTY_LOGS: LlmRequestLogListResponse = {
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  items: [],
  metadataPolicy: {
    source: "default",
    allowedTopLevelKeys: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_KEYS,
    allowedTopLevelPrefixes: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
    keyCount: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_KEYS.length,
    prefixCount: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_PREFIXES.length,
  },
};

const EMPTY_TOTALS: LlmUsageSummaryTotals = {
  requestCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  avgLatencyMs: 0,
};

const EMPTY_STATUS_BREAKDOWN: LlmUsageSummaryStatusBreakdown = {
  success: 0,
  error: 0,
  successRate: 0,
  errorRate: 0,
};

const EMPTY_LATENCY: LlmUsageSummaryLatency = {
  avgMs: 0,
  p95Ms: null,
};

const EMPTY_SUMMARY: LlmUsageSummaryResponse = {
  totals: EMPTY_TOTALS,
  statusBreakdown: EMPTY_STATUS_BREAKDOWN,
  latency: EMPTY_LATENCY,
  topErrors: [],
  byModel: [],
  byDay: [],
};

interface ExceptionStatsResponse {
  total: number;
  byDay?: ExceptionStatsByDayRow[];
}

interface ExceptionStatsByDayRow {
  date: string;
  count: number;
}

interface BriefErrorTrendRow {
  date: string;
  graphqlErrorCount: number;
  invalidJsonErrorCount: number;
}

function normalizeSummaryResponse(
  payload: LlmUsageSummaryResponse | null | undefined,
): LlmUsageSummaryResponse {
  if (!payload) {
    return EMPTY_SUMMARY;
  }
  return {
    totals: { ...EMPTY_TOTALS, ...(payload.totals ?? {}) },
    statusBreakdown: {
      ...EMPTY_STATUS_BREAKDOWN,
      ...(payload.statusBreakdown ?? {}),
    },
    latency: { ...EMPTY_LATENCY, ...(payload.latency ?? {}) },
    topErrors: Array.isArray(payload.topErrors) ? payload.topErrors : [],
    byModel: Array.isArray(payload.byModel) ? payload.byModel : [],
    byDay: Array.isArray(payload.byDay) ? payload.byDay : [],
  };
}

function normalizeExceptionStatsByDay(
  rows: ExceptionStatsByDayRow[] | null | undefined,
): ExceptionStatsByDayRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      const date = typeof row.date === "string" ? row.date.trim() : "";
      if (!date) {
        return null;
      }
      const count =
        typeof row.count === "number" && Number.isFinite(row.count)
          ? Math.max(0, Math.trunc(row.count))
          : 0;
      return {
        date,
        count,
      };
    })
    .filter((row): row is ExceptionStatsByDayRow => row !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function mergeBriefErrorTrendRows(
  graphqlRows: ExceptionStatsByDayRow[],
  invalidJsonRows: ExceptionStatsByDayRow[],
): BriefErrorTrendRow[] {
  const byDate = new Map<string, BriefErrorTrendRow>();
  for (const row of graphqlRows) {
    byDate.set(row.date, {
      date: row.date,
      graphqlErrorCount: row.count,
      invalidJsonErrorCount: 0,
    });
  }
  for (const row of invalidJsonRows) {
    const existing = byDate.get(row.date);
    if (existing) {
      existing.invalidJsonErrorCount = row.count;
      continue;
    }
    byDate.set(row.date, {
      date: row.date,
      graphqlErrorCount: 0,
      invalidJsonErrorCount: row.count,
    });
  }
  return Array.from(byDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

function normalizeSettingsResponse(
  payload: LlmRequestLogSettingsResponse | null | undefined,
): LlmRequestLogSettingsResponse {
  if (!payload) {
    return EMPTY_SETTINGS;
  }
  const briefErrorRateThreshold =
    typeof payload.briefErrorRateThreshold === "number" &&
    Number.isFinite(payload.briefErrorRateThreshold)
      ? Math.min(1, Math.max(0, payload.briefErrorRateThreshold))
      : DEFAULT_BRIEF_ERROR_RATE_THRESHOLD;
  const briefInvalidJsonRatioThreshold =
    typeof payload.briefInvalidJsonRatioThreshold === "number" &&
    Number.isFinite(payload.briefInvalidJsonRatioThreshold)
      ? Math.min(1, Math.max(0, payload.briefInvalidJsonRatioThreshold))
      : DEFAULT_BRIEF_INVALID_JSON_RATIO_THRESHOLD;
  const briefConsecutiveDaysThreshold =
    typeof payload.briefConsecutiveDaysThreshold === "number" &&
    Number.isInteger(payload.briefConsecutiveDaysThreshold) &&
    payload.briefConsecutiveDaysThreshold >= 1 &&
    payload.briefConsecutiveDaysThreshold <= 30
      ? payload.briefConsecutiveDaysThreshold
      : DEFAULT_BRIEF_CONSECUTIVE_DAYS_THRESHOLD;
  return {
    source: payload.source === "db" ? "db" : "default",
    retentionDays:
      typeof payload.retentionDays === "number" &&
      Number.isFinite(payload.retentionDays)
        ? Math.max(1, Math.trunc(payload.retentionDays))
        : DEFAULT_RETENTION_DAYS,
    metadataAllowedTopLevelKeys: Array.isArray(
      payload.metadataAllowedTopLevelKeys,
    )
      ? payload.metadataAllowedTopLevelKeys
      : DEFAULT_METADATA_ALLOWED_TOP_LEVEL_KEYS,
    metadataAllowedTopLevelPrefixes: Array.isArray(
      payload.metadataAllowedTopLevelPrefixes,
    )
      ? payload.metadataAllowedTopLevelPrefixes
      : DEFAULT_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
    briefErrorRateThreshold,
    briefInvalidJsonRatioThreshold,
    briefConsecutiveDaysThreshold,
  };
}

const EMPTY_SETTINGS: LlmRequestLogSettingsResponse = {
  source: "default",
  retentionDays: DEFAULT_RETENTION_DAYS,
  metadataAllowedTopLevelKeys: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_KEYS,
  metadataAllowedTopLevelPrefixes: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
  briefErrorRateThreshold: DEFAULT_BRIEF_ERROR_RATE_THRESHOLD,
  briefInvalidJsonRatioThreshold: DEFAULT_BRIEF_INVALID_JSON_RATIO_THRESHOLD,
  briefConsecutiveDaysThreshold: DEFAULT_BRIEF_CONSECUTIVE_DAYS_THRESHOLD,
};

function formatDateTime(raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return parsed.toLocaleString();
}

function formatTokens(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return value.toLocaleString();
}

function formatCurrency(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `$${value.toFixed(6)}`;
}

function formatLatency(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${Math.round(value)} ms`;
}

function normalizeMetadataTokenList(
  tokens: string[] | undefined,
  maxItems: number,
): string[] {
  if (!Array.isArray(tokens)) {
    return [];
  }

  const normalized = tokens
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  return Array.from(new Set(normalized)).slice(0, maxItems);
}

function buildMetadataPolicyFromSettings(
  settings: LlmRequestLogSettingsResponse,
): LlmRequestLogMetadataPolicySummary {
  const allowedTopLevelKeys = Array.isArray(
    settings.metadataAllowedTopLevelKeys,
  )
    ? settings.metadataAllowedTopLevelKeys
    : [];
  const allowedTopLevelPrefixes = Array.isArray(
    settings.metadataAllowedTopLevelPrefixes,
  )
    ? settings.metadataAllowedTopLevelPrefixes
    : [];
  return {
    source: settings.source,
    allowedTopLevelKeys,
    allowedTopLevelPrefixes,
    keyCount: allowedTopLevelKeys.length,
    prefixCount: allowedTopLevelPrefixes.length,
  };
}

export function LlmRequestLogsPanel() {
  const { t } = useTranslation();
  const { echartsTheme, colors } = useChartTheme();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const { exporting: exportLogsLoading, exportCsvBlob } = useCsvExport();
  const [settingsForm] = Form.useForm<LlmRequestLogSettingsFormValues>();

  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsResetting, setSettingsResetting] = useState(false);
  const [settingsMetadataResetting, setSettingsMetadataResetting] =
    useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [briefMetricsLoading, setBriefMetricsLoading] = useState(false);
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<
    string | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [briefMetricsErrorMessage, setBriefMetricsErrorMessage] = useState<
    string | null
  >(null);

  const [settings, setSettings] =
    useState<LlmRequestLogSettingsResponse>(EMPTY_SETTINGS);
  const [logs, setLogs] = useState<LlmRequestLogListResponse>(EMPTY_LOGS);
  const [summary, setSummary] =
    useState<LlmUsageSummaryResponse>(EMPTY_SUMMARY);
  const [briefGraphqlErrorTotal, setBriefGraphqlErrorTotal] = useState(0);
  const [briefInvalidJsonTotal, setBriefInvalidJsonTotal] = useState(0);
  const [briefErrorTrendRows, setBriefErrorTrendRows] = useState<
    BriefErrorTrendRow[]
  >([]);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [modelFilter, setModelFilter] = useState("");
  const [featureFilter, setFeatureFilter] = useState("");
  const [requestTypeFilter, setRequestTypeFilter] = useState<
    "all" | LlmRequestType
  >("all");
  const [statusFilter, setStatusFilter] = useState<"all" | LlmRequestStatus>(
    "all",
  );
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [appliedModelFilter, setAppliedModelFilter] = useState("");
  const [appliedFeatureFilter, setAppliedFeatureFilter] = useState("");
  const [appliedRequestTypeFilter, setAppliedRequestTypeFilter] = useState<
    "all" | LlmRequestType
  >("all");
  const [appliedStatusFilter, setAppliedStatusFilter] = useState<
    "all" | LlmRequestStatus
  >("all");
  const [appliedDateRange, setAppliedDateRange] = useState<
    [Dayjs, Dayjs] | null
  >(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const sharedDateParams = useMemo(() => {
    if (!appliedDateRange) {
      return {};
    }
    return {
      start: appliedDateRange[0].startOf("day").toISOString(),
      end: appliedDateRange[1].endOf("day").toISOString(),
    };
  }, [appliedDateRange]);

  const appliedFilterParams = useMemo(() => {
    const params: Record<string, string> = {};
    const normalizedModel = appliedModelFilter.trim();
    if (normalizedModel.length > 0) {
      params.model = normalizedModel;
    }
    const normalizedFeature = appliedFeatureFilter.trim().toLowerCase();
    if (normalizedFeature.length > 0) {
      params.feature = normalizedFeature;
    }
    if (appliedRequestTypeFilter !== "all") {
      params.requestType = appliedRequestTypeFilter;
    }
    if (appliedStatusFilter !== "all") {
      params.status = appliedStatusFilter;
    }
    if (typeof sharedDateParams.start === "string") {
      params.start = sharedDateParams.start;
    }
    if (typeof sharedDateParams.end === "string") {
      params.end = sharedDateParams.end;
    }
    return params;
  }, [
    appliedModelFilter,
    appliedFeatureFilter,
    appliedRequestTypeFilter,
    appliedStatusFilter,
    sharedDateParams.end,
    sharedDateParams.start,
  ]);

  const summaryFilterParams = useMemo(() => {
    const params: Record<string, string> = {};
    const normalizedFeature = appliedFeatureFilter.trim().toLowerCase();
    if (normalizedFeature.length > 0) {
      params.feature = normalizedFeature;
    }
    if (typeof sharedDateParams.start === "string") {
      params.start = sharedDateParams.start;
    }
    if (typeof sharedDateParams.end === "string") {
      params.end = sharedDateParams.end;
    }
    return params;
  }, [appliedFeatureFilter, sharedDateParams.end, sharedDateParams.start]);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsErrorMessage(null);
    try {
      const response = await apiClient.get<LlmRequestLogSettingsResponse>(
        "system-settings/llm-request-logs",
      );
      const data = normalizeSettingsResponse(response.data);
      setSettings(data);
      setLogs((previous) => ({
        ...previous,
        metadataPolicy: buildMetadataPolicyFromSettings(data),
      }));
      settingsForm.setFieldsValue({
        retentionDays: data.retentionDays,
        metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
        metadataAllowedTopLevelPrefixes: data.metadataAllowedTopLevelPrefixes,
        briefErrorRateThreshold: data.briefErrorRateThreshold,
        briefInvalidJsonRatioThreshold: data.briefInvalidJsonRatioThreshold,
        briefConsecutiveDaysThreshold: data.briefConsecutiveDaysThreshold,
      });
    } catch (error) {
      captureClientError(
        "Failed to load LLM request log retention settings",
        error,
      );
      const messageText = t(
        "systemSettings.llmRequestLogs.errors.settingsLoadFailed",
        {
          defaultValue: "Failed to load log retention settings.",
        },
      );
      setSettingsErrorMessage(messageText);
      messageApi.error(messageText);
    } finally {
      setSettingsLoading(false);
    }
  }, [apiClient, messageApi, settingsForm, t]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    setErrorMessage(null);
    try {
      const params: Record<string, string | number> = {
        page,
        pageSize,
        ...appliedFilterParams,
      };

      const response = await apiClient.get<LlmRequestLogListResponse>(
        "llm-logs",
        {
          params,
        },
      );
      const data = response.data ?? EMPTY_LOGS;
      setLogs({
        page: data.page ?? EMPTY_LOGS.page,
        pageSize: data.pageSize ?? EMPTY_LOGS.pageSize,
        total: data.total ?? EMPTY_LOGS.total,
        items: Array.isArray(data.items) ? data.items : [],
        metadataPolicy: data.metadataPolicy ?? EMPTY_LOGS.metadataPolicy,
      });
    } catch (error) {
      captureClientError("Failed to load LLM request logs", error);
      const messageText = t("systemSettings.llmRequestLogs.errors.loadFailed", {
        defaultValue: "Failed to load LLM request logs.",
      });
      setErrorMessage(messageText);
      messageApi.error(messageText);
    } finally {
      setLogsLoading(false);
    }
  }, [
    apiClient,
    appliedFilterParams,
    refreshNonce,
    messageApi,
    page,
    pageSize,
    t,
  ]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const response = await apiClient.get<LlmUsageSummaryResponse>(
        "llm-logs/summary",
        {
          params: summaryFilterParams,
        },
      );
      setSummary(normalizeSummaryResponse(response.data));
    } catch (error) {
      captureClientError("Failed to load LLM request log summary", error);
      const messageText = t(
        "systemSettings.llmRequestLogs.errors.summaryFailed",
        {
          defaultValue: "Failed to load usage summary.",
        },
      );
      messageApi.error(messageText);
    } finally {
      setSummaryLoading(false);
    }
  }, [apiClient, messageApi, refreshNonce, summaryFilterParams, t]);

  const loadBriefMetrics = useCallback(async () => {
    if (appliedFeatureFilter.trim().toLowerCase() !== "news_event_brief") {
      setBriefMetricsErrorMessage(null);
      setBriefGraphqlErrorTotal(0);
      setBriefInvalidJsonTotal(0);
      setBriefErrorTrendRows([]);
      return;
    }

    setBriefMetricsLoading(true);
    setBriefMetricsErrorMessage(null);
    try {
      const [graphqlStatsResponse, invalidJsonStatsResponse] =
        await Promise.all([
          apiClient.get<ExceptionStatsResponse>("admin/errors/stats", {
            params: {
              kind: "graphql",
              operationName: "newsEventBrief",
              ...sharedDateParams,
            },
          }),
          apiClient.get<ExceptionStatsResponse>("admin/errors/stats", {
            params: {
              kind: "graphql",
              operationName: "newsEventBrief",
              messageContains: "invalid JSON for news event brief",
              ...sharedDateParams,
            },
          }),
        ]);

      setBriefGraphqlErrorTotal(
        typeof graphqlStatsResponse.data?.total === "number"
          ? graphqlStatsResponse.data.total
          : 0,
      );
      setBriefInvalidJsonTotal(
        typeof invalidJsonStatsResponse.data?.total === "number"
          ? invalidJsonStatsResponse.data.total
          : 0,
      );
      const graphqlByDay = normalizeExceptionStatsByDay(
        graphqlStatsResponse.data?.byDay,
      );
      const invalidJsonByDay = normalizeExceptionStatsByDay(
        invalidJsonStatsResponse.data?.byDay,
      );
      setBriefErrorTrendRows(
        mergeBriefErrorTrendRows(graphqlByDay, invalidJsonByDay),
      );
    } catch (error) {
      captureClientError(
        "Failed to load event detailed summary admin metrics",
        error,
      );
      setBriefMetricsErrorMessage(
        t("systemSettings.llmRequestLogs.errors.briefMetricsFailed", {
          defaultValue: "Failed to load event detailed summary metrics.",
        }),
      );
      setBriefGraphqlErrorTotal(0);
      setBriefInvalidJsonTotal(0);
      setBriefErrorTrendRows([]);
    } finally {
      setBriefMetricsLoading(false);
    }
  }, [apiClient, appliedFeatureFilter, sharedDateParams, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadBriefMetrics();
  }, [loadBriefMetrics]);

  const handleSearch = () => {
    setPage(1);
    setAppliedModelFilter(modelFilter.trim());
    setAppliedFeatureFilter(featureFilter);
    setAppliedRequestTypeFilter(requestTypeFilter);
    setAppliedStatusFilter(statusFilter);
    setAppliedDateRange(dateRange);
    setRefreshNonce((value) => value + 1);
  };

  const handleReset = () => {
    setModelFilter("");
    setFeatureFilter("");
    setRequestTypeFilter("all");
    setStatusFilter("all");
    setDateRange(null);
    setAppliedModelFilter("");
    setAppliedFeatureFilter("");
    setAppliedRequestTypeFilter("all");
    setAppliedStatusFilter("all");
    setAppliedDateRange(null);
    setPage(1);
    setPageSize(DEFAULT_PAGE_SIZE);
    setRefreshNonce((value) => value + 1);
  };

  const handleSaveRetentionSettings = async (
    values: LlmRequestLogSettingsFormValues,
  ) => {
    setSettingsSaving(true);
    setSettingsErrorMessage(null);
    try {
      const metadataAllowedTopLevelKeys = normalizeMetadataTokenList(
        values.metadataAllowedTopLevelKeys,
        MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS,
      );
      const metadataAllowedTopLevelPrefixes = normalizeMetadataTokenList(
        values.metadataAllowedTopLevelPrefixes,
        MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
      );
      const response = await apiClient.put<LlmRequestLogSettingsResponse>(
        "system-settings/llm-request-logs",
        {
          retentionDays: values.retentionDays,
          metadataAllowedTopLevelKeys,
          metadataAllowedTopLevelPrefixes,
          briefErrorRateThreshold: values.briefErrorRateThreshold,
          briefInvalidJsonRatioThreshold: values.briefInvalidJsonRatioThreshold,
          briefConsecutiveDaysThreshold: values.briefConsecutiveDaysThreshold,
        },
      );
      const data = normalizeSettingsResponse(response.data);
      setSettings(data);
      setLogs((previous) => ({
        ...previous,
        metadataPolicy: buildMetadataPolicyFromSettings(data),
      }));
      settingsForm.setFieldsValue({
        retentionDays: data.retentionDays,
        metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
        metadataAllowedTopLevelPrefixes: data.metadataAllowedTopLevelPrefixes,
        briefErrorRateThreshold: data.briefErrorRateThreshold,
        briefInvalidJsonRatioThreshold: data.briefInvalidJsonRatioThreshold,
        briefConsecutiveDaysThreshold: data.briefConsecutiveDaysThreshold,
      });
      messageApi.success(
        t("systemSettings.llmRequestLogs.messages.settingsSaved", {
          defaultValue: "Log retention settings saved.",
        }),
      );
    } catch (error) {
      captureClientError(
        "Failed to save LLM request log retention settings",
        error,
      );
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(
          t("systemSettings.llmRequestLogs.errors.settingsBadRequest", {
            defaultValue:
              "Retention days or metadata allowlist settings are invalid.",
          }),
        );
      } else {
        messageApi.error(
          t("systemSettings.llmRequestLogs.errors.settingsSaveFailed", {
            defaultValue: "Failed to save log retention settings.",
          }),
        );
      }
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleResetRetentionSettings = () => {
    Modal.confirm({
      title: t("systemSettings.llmRequestLogs.retention.modal.resetTitle", {
        defaultValue: "Reset retention settings",
      }),
      content: t("systemSettings.llmRequestLogs.retention.modal.resetContent", {
        defaultValue:
          "Reset LLM request log retention settings to system defaults?",
      }),
      okText: t("systemSettings.llmRequestLogs.retention.modal.confirm", {
        defaultValue: "Reset",
      }),
      cancelText: t("systemSettings.llmRequestLogs.retention.modal.cancel", {
        defaultValue: "Cancel",
      }),
      okButtonProps: { danger: true },
      onOk: async () => {
        setSettingsResetting(true);
        setSettingsErrorMessage(null);
        try {
          const response =
            await apiClient.delete<LlmRequestLogSettingsResponse>(
              "system-settings/llm-request-logs",
            );
          const data = normalizeSettingsResponse(response.data);
          setSettings(data);
          setLogs((previous) => ({
            ...previous,
            metadataPolicy: buildMetadataPolicyFromSettings(data),
          }));
          settingsForm.setFieldsValue({
            retentionDays: data.retentionDays,
            metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
            metadataAllowedTopLevelPrefixes:
              data.metadataAllowedTopLevelPrefixes,
            briefErrorRateThreshold: data.briefErrorRateThreshold,
            briefInvalidJsonRatioThreshold: data.briefInvalidJsonRatioThreshold,
            briefConsecutiveDaysThreshold: data.briefConsecutiveDaysThreshold,
          });
          messageApi.success(
            t("systemSettings.llmRequestLogs.messages.settingsReset", {
              defaultValue: "Log retention settings reset to defaults.",
            }),
          );
        } catch (error) {
          captureClientError(
            "Failed to reset LLM request log retention settings",
            error,
          );
          messageApi.error(
            t("systemSettings.llmRequestLogs.errors.settingsResetFailed", {
              defaultValue: "Failed to reset log retention settings.",
            }),
          );
        } finally {
          setSettingsResetting(false);
        }
      },
    });
  };

  const handleResetMetadataPolicy = () => {
    Modal.confirm({
      title: t(
        "systemSettings.llmRequestLogs.retention.modal.resetMetadataTitle",
        {
          defaultValue: "Reset metadata allowlist",
        },
      ),
      content: t(
        "systemSettings.llmRequestLogs.retention.modal.resetMetadataContent",
        {
          defaultValue:
            "Reset metadata key/prefix allowlist to recommended defaults without changing retention days?",
        },
      ),
      okText: t("systemSettings.llmRequestLogs.retention.modal.confirm", {
        defaultValue: "Reset",
      }),
      cancelText: t("systemSettings.llmRequestLogs.retention.modal.cancel", {
        defaultValue: "Cancel",
      }),
      onOk: async () => {
        setSettingsMetadataResetting(true);
        setSettingsErrorMessage(null);
        try {
          const response = await apiClient.post<LlmRequestLogSettingsResponse>(
            "system-settings/llm-request-logs/metadata-policy/reset",
          );
          const data = normalizeSettingsResponse(response.data);
          setSettings(data);
          setLogs((previous) => ({
            ...previous,
            metadataPolicy: buildMetadataPolicyFromSettings(data),
          }));
          settingsForm.setFieldsValue({
            retentionDays: data.retentionDays,
            metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
            metadataAllowedTopLevelPrefixes:
              data.metadataAllowedTopLevelPrefixes,
            briefErrorRateThreshold: data.briefErrorRateThreshold,
            briefInvalidJsonRatioThreshold: data.briefInvalidJsonRatioThreshold,
            briefConsecutiveDaysThreshold: data.briefConsecutiveDaysThreshold,
          });
          messageApi.success(
            t("systemSettings.llmRequestLogs.messages.metadataPolicyReset", {
              defaultValue: "Metadata allowlist reset to recommended defaults.",
            }),
          );
        } catch (error) {
          captureClientError(
            "Failed to reset LLM request log metadata policy",
            error,
          );
          messageApi.error(
            t(
              "systemSettings.llmRequestLogs.errors.metadataPolicyResetFailed",
              {
                defaultValue: "Failed to reset metadata allowlist.",
              },
            ),
          );
        } finally {
          setSettingsMetadataResetting(false);
        }
      },
    });
  };

  const handleExportLogs = useCallback(async () => {
    const filename = `llm-logs-${formatDateForFilename(new Date())}.csv`;
    await exportCsvBlob({
      filename,
      fetchBlob: async () => {
        const response = await apiClient.get<Blob>("llm-logs/export", {
          params: appliedFilterParams,
          responseType: "blob",
        });
        const rawContentType = response.headers?.["content-type"];
        const normalizedContentType = (
          Array.isArray(rawContentType)
            ? rawContentType.join(",")
            : (rawContentType ?? response.data?.type ?? "")
        ).toLowerCase();
        if (!normalizedContentType.includes("text/csv")) {
          throw new Error("Unexpected export response content type");
        }
        return response.data;
      },
      successMessage: t("systemSettings.llmRequestLogs.export.success", {
        defaultValue: "LLM request logs exported.",
      }),
      errorMessage: t("systemSettings.llmRequestLogs.export.failed", {
        defaultValue: "Failed to export LLM request logs.",
      }),
    });
  }, [apiClient, appliedFilterParams, exportCsvBlob, t]);

  const columns = useMemo<ColumnsType<LlmRequestLogRow>>(
    () => [
      {
        title: t("systemSettings.llmRequestLogs.table.time", {
          defaultValue: "Time",
        }),
        dataIndex: "createdAt",
        key: "createdAt",
        width: 190,
        render: (value: string) => formatDateTime(value),
      },
      {
        title: t("systemSettings.llmRequestLogs.table.model", {
          defaultValue: "Model",
        }),
        dataIndex: "model",
        key: "model",
        width: 220,
      },
      {
        title: t("systemSettings.llmRequestLogs.table.feature", {
          defaultValue: "Feature",
        }),
        dataIndex: "feature",
        key: "feature",
        width: 180,
        render: (value: string | null) =>
          value ? <Tag color="blue">{value}</Tag> : "-",
      },
      {
        title: t("systemSettings.llmRequestLogs.table.requestType", {
          defaultValue: "Type",
        }),
        dataIndex: "requestType",
        key: "requestType",
        width: 120,
        render: (value: LlmRequestType) => <Tag>{value}</Tag>,
      },
      {
        title: t("systemSettings.llmRequestLogs.table.status", {
          defaultValue: "Status",
        }),
        dataIndex: "status",
        key: "status",
        width: 120,
        render: (value: LlmRequestStatus) =>
          value === "success" ? (
            <Tag color="green">
              {t("systemSettings.llmRequestLogs.status.success", {
                defaultValue: "Success",
              })}
            </Tag>
          ) : (
            <Tag color="red">
              {t("systemSettings.llmRequestLogs.status.error", {
                defaultValue: "Error",
              })}
            </Tag>
          ),
      },
      {
        title: t("systemSettings.llmRequestLogs.table.tokens", {
          defaultValue: "Tokens",
        }),
        key: "tokens",
        width: 180,
        render: (_, row) => (
          <Space direction="vertical" size={0}>
            <Typography.Text>
              {t("systemSettings.llmRequestLogs.table.totalTokens", {
                defaultValue: "Total: {{value}}",
                value: formatTokens(row.totalTokens),
              })}
            </Typography.Text>
            <Typography.Text type="secondary">
              {t("systemSettings.llmRequestLogs.table.promptCompletionTokens", {
                defaultValue: "P/C: {{prompt}} / {{completion}}",
                prompt: formatTokens(row.promptTokens),
                completion: formatTokens(row.completionTokens),
              })}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: t("systemSettings.llmRequestLogs.table.cost", {
          defaultValue: "Cost",
        }),
        dataIndex: "costUsd",
        key: "costUsd",
        width: 120,
        render: (value: number | null) => formatCurrency(value),
      },
      {
        title: t("systemSettings.llmRequestLogs.table.latency", {
          defaultValue: "Latency",
        }),
        dataIndex: "latencyMs",
        key: "latencyMs",
        width: 120,
        render: (value: number | null) => formatLatency(value),
      },
      {
        title: t("systemSettings.llmRequestLogs.table.error", {
          defaultValue: "Error",
        }),
        dataIndex: "error",
        key: "error",
        ellipsis: true,
        render: (value: string | null) => value ?? "-",
      },
    ],
    [t],
  );

  const byModelColumns = useMemo<ColumnsType<LlmUsageSummaryByModelRow>>(
    () => [
      {
        title: t("systemSettings.llmRequestLogs.summary.byModel.model", {
          defaultValue: "Model",
        }),
        dataIndex: "model",
        key: "model",
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byModel.requests", {
          defaultValue: "Requests",
        }),
        dataIndex: "requestCount",
        key: "requestCount",
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byModel.tokens", {
          defaultValue: "Tokens",
        }),
        dataIndex: "totalTokens",
        key: "totalTokens",
        render: (value: number) => formatTokens(value),
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byModel.cost", {
          defaultValue: "Cost (USD)",
        }),
        dataIndex: "costUsd",
        key: "costUsd",
        render: (value: number) => formatCurrency(value),
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byModel.avgLatency", {
          defaultValue: "Avg latency",
        }),
        dataIndex: "avgLatencyMs",
        key: "avgLatencyMs",
        render: (value: number) => formatLatency(value),
      },
    ],
    [t],
  );

  const byDayColumns = useMemo<ColumnsType<LlmUsageSummaryByDayRow>>(
    () => [
      {
        title: t("systemSettings.llmRequestLogs.summary.byDay.date", {
          defaultValue: "Date (UTC)",
        }),
        dataIndex: "date",
        key: "date",
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byDay.requests", {
          defaultValue: "Requests",
        }),
        dataIndex: "requestCount",
        key: "requestCount",
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byDay.tokens", {
          defaultValue: "Tokens",
        }),
        dataIndex: "totalTokens",
        key: "totalTokens",
        render: (value: number) => formatTokens(value),
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byDay.cost", {
          defaultValue: "Cost (USD)",
        }),
        dataIndex: "costUsd",
        key: "costUsd",
        render: (value: number) => formatCurrency(value),
      },
      {
        title: t("systemSettings.llmRequestLogs.summary.byDay.avgLatency", {
          defaultValue: "Avg latency",
        }),
        dataIndex: "avgLatencyMs",
        key: "avgLatencyMs",
        render: (value: number) => formatLatency(value),
      },
    ],
    [t],
  );

  const showBriefMetrics = appliedFeatureFilter === "news_event_brief";
  const effectiveBriefErrorRateThreshold = useMemo(() => {
    if (
      typeof settings.briefErrorRateThreshold === "number" &&
      Number.isFinite(settings.briefErrorRateThreshold)
    ) {
      return Math.min(1, Math.max(0, settings.briefErrorRateThreshold));
    }
    return DEFAULT_BRIEF_ERROR_RATE_THRESHOLD;
  }, [settings.briefErrorRateThreshold]);
  const effectiveBriefInvalidJsonRatioThreshold = useMemo(() => {
    if (
      typeof settings.briefInvalidJsonRatioThreshold === "number" &&
      Number.isFinite(settings.briefInvalidJsonRatioThreshold)
    ) {
      return Math.min(1, Math.max(0, settings.briefInvalidJsonRatioThreshold));
    }
    return DEFAULT_BRIEF_INVALID_JSON_RATIO_THRESHOLD;
  }, [settings.briefInvalidJsonRatioThreshold]);
  const effectiveBriefConsecutiveDaysThreshold = useMemo(() => {
    if (
      typeof settings.briefConsecutiveDaysThreshold === "number" &&
      Number.isInteger(settings.briefConsecutiveDaysThreshold) &&
      settings.briefConsecutiveDaysThreshold >= 1 &&
      settings.briefConsecutiveDaysThreshold <= 30
    ) {
      return settings.briefConsecutiveDaysThreshold;
    }
    return DEFAULT_BRIEF_CONSECUTIVE_DAYS_THRESHOLD;
  }, [settings.briefConsecutiveDaysThreshold]);
  const briefInvalidJsonRatio = useMemo(() => {
    if (briefGraphqlErrorTotal <= 0) {
      return 0;
    }
    return briefInvalidJsonTotal / briefGraphqlErrorTotal;
  }, [briefGraphqlErrorTotal, briefInvalidJsonTotal]);
  const briefDailyThresholdSeries = useMemo(() => {
    const byDate = new Map<
      string,
      {
        date: string;
        requestCount: number;
        graphqlErrorCount: number;
        invalidJsonErrorCount: number;
      }
    >();

    for (const row of summary.byDay) {
      const date = typeof row.date === "string" ? row.date.trim() : "";
      if (!date) {
        continue;
      }
      const requestCount =
        typeof row.requestCount === "number" &&
        Number.isFinite(row.requestCount)
          ? Math.max(0, Math.trunc(row.requestCount))
          : 0;
      byDate.set(date, {
        date,
        requestCount,
        graphqlErrorCount: 0,
        invalidJsonErrorCount: 0,
      });
    }

    for (const row of briefErrorTrendRows) {
      const current = byDate.get(row.date);
      if (current) {
        current.graphqlErrorCount = row.graphqlErrorCount;
        current.invalidJsonErrorCount = row.invalidJsonErrorCount;
        continue;
      }
      byDate.set(row.date, {
        date: row.date,
        requestCount: 0,
        graphqlErrorCount: row.graphqlErrorCount,
        invalidJsonErrorCount: row.invalidJsonErrorCount,
      });
    }

    return Array.from(byDate.values()).sort((left, right) =>
      left.date.localeCompare(right.date),
    );
  }, [briefErrorTrendRows, summary.byDay]);
  const maxConsecutiveBriefThresholdBreachDays = useMemo(() => {
    let running = 0;
    let maxRunning = 0;
    let previousDateMs: number | null = null;
    for (const row of briefDailyThresholdSeries) {
      const dateMs = Date.parse(`${row.date}T00:00:00.000Z`);
      if (
        previousDateMs !== null &&
        Number.isFinite(dateMs) &&
        dateMs - previousDateMs > 24 * 60 * 60 * 1000
      ) {
        running = 0;
      }
      const dailyErrorRate =
        row.requestCount > 0 ? row.graphqlErrorCount / row.requestCount : 0;
      const dailyInvalidJsonRatio =
        row.graphqlErrorCount > 0
          ? row.invalidJsonErrorCount / row.graphqlErrorCount
          : 0;
      const breach =
        (row.requestCount > 0 &&
          dailyErrorRate >= effectiveBriefErrorRateThreshold) ||
        (row.graphqlErrorCount > 0 &&
          dailyInvalidJsonRatio >= effectiveBriefInvalidJsonRatioThreshold);
      if (breach) {
        running += 1;
        if (running > maxRunning) {
          maxRunning = running;
        }
        previousDateMs = Number.isFinite(dateMs) ? dateMs : previousDateMs;
        continue;
      }
      running = 0;
      previousDateMs = Number.isFinite(dateMs) ? dateMs : previousDateMs;
    }
    return maxRunning;
  }, [
    briefDailyThresholdSeries,
    effectiveBriefErrorRateThreshold,
    effectiveBriefInvalidJsonRatioThreshold,
  ]);
  const briefThresholdWarnings = useMemo(() => {
    if (!showBriefMetrics) {
      return [];
    }
    const warnings: string[] = [];
    const hasRequests = summary.totals.requestCount > 0;
    if (
      hasRequests &&
      summary.statusBreakdown.errorRate >= effectiveBriefErrorRateThreshold
    ) {
      warnings.push(
        t(
          "systemSettings.llmRequestLogs.summary.thresholdAlerts.errorRateExceeded",
          {
            defaultValue:
              "LLM error rate {{value}}% exceeds threshold {{threshold}}%.",
            value: (summary.statusBreakdown.errorRate * 100).toFixed(2),
            threshold: (effectiveBriefErrorRateThreshold * 100).toFixed(2),
          },
        ),
      );
    }
    if (
      briefGraphqlErrorTotal > 0 &&
      briefInvalidJsonRatio >= effectiveBriefInvalidJsonRatioThreshold
    ) {
      warnings.push(
        t(
          "systemSettings.llmRequestLogs.summary.thresholdAlerts.invalidJsonRatioExceeded",
          {
            defaultValue:
              "Invalid JSON ratio {{value}}% exceeds threshold {{threshold}}%.",
            value: (briefInvalidJsonRatio * 100).toFixed(2),
            threshold: (effectiveBriefInvalidJsonRatioThreshold * 100).toFixed(
              2,
            ),
          },
        ),
      );
    }
    if (
      maxConsecutiveBriefThresholdBreachDays >=
      effectiveBriefConsecutiveDaysThreshold
    ) {
      warnings.push(
        t(
          "systemSettings.llmRequestLogs.summary.thresholdAlerts.consecutiveDaysExceeded",
          {
            defaultValue:
              "Threshold has been exceeded for {{maxDays}} consecutive days (configured threshold: {{threshold}} days).",
            maxDays: maxConsecutiveBriefThresholdBreachDays,
            threshold: effectiveBriefConsecutiveDaysThreshold,
          },
        ),
      );
    }
    return warnings;
  }, [
    effectiveBriefConsecutiveDaysThreshold,
    effectiveBriefErrorRateThreshold,
    effectiveBriefInvalidJsonRatioThreshold,
    briefGraphqlErrorTotal,
    briefInvalidJsonRatio,
    maxConsecutiveBriefThresholdBreachDays,
    showBriefMetrics,
    summary.statusBreakdown.errorRate,
    summary.totals.requestCount,
    t,
  ]);
  const briefErrorTrendChartOption = useMemo<EChartsOption | null>(() => {
    if (!showBriefMetrics || briefErrorTrendRows.length === 0) {
      return null;
    }

    return {
      tooltip: { trigger: "axis" },
      legend: {
        data: [
          t(
            "systemSettings.llmRequestLogs.summary.briefErrorTrend.seriesGraphqlErrors",
            {
              defaultValue: "GraphQL errors",
            },
          ),
          t(
            "systemSettings.llmRequestLogs.summary.briefErrorTrend.seriesInvalidJsonErrors",
            {
              defaultValue: "Invalid JSON errors",
            },
          ),
        ],
      },
      grid: { top: 42, left: 24, right: 24, bottom: 24, containLabel: true },
      xAxis: {
        type: "category",
        data: briefErrorTrendRows.map((item) => item.date),
        axisLabel: { color: colors.foreground },
      },
      yAxis: {
        type: "value",
        min: 0,
        minInterval: 1,
        splitLine: {
          lineStyle: {
            color: colors.grid,
            type: "dashed",
          },
        },
      },
      series: [
        {
          type: "line",
          smooth: true,
          name: t(
            "systemSettings.llmRequestLogs.summary.briefErrorTrend.seriesGraphqlErrors",
            {
              defaultValue: "GraphQL errors",
            },
          ),
          data: briefErrorTrendRows.map((item) => item.graphqlErrorCount),
          itemStyle: { color: colors.destructive },
        },
        {
          type: "line",
          smooth: true,
          name: t(
            "systemSettings.llmRequestLogs.summary.briefErrorTrend.seriesInvalidJsonErrors",
            {
              defaultValue: "Invalid JSON errors",
            },
          ),
          data: briefErrorTrendRows.map((item) => item.invalidJsonErrorCount),
          itemStyle: { color: colors.bearish },
        },
      ],
    };
  }, [
    briefErrorTrendRows,
    colors.bearish,
    colors.destructive,
    colors.foreground,
    colors.grid,
    showBriefMetrics,
    t,
  ]);
  const isLoading =
    logsLoading || summaryLoading || (showBriefMetrics && briefMetricsLoading);

  if ((settingsLoading || isLoading) && logs.items.length === 0) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  const sourceColor = settings.source === "db" ? "green" : "default";
  const sourceLabel =
    settings.source === "db"
      ? t("systemSettings.llmRequestLogs.retention.status.db", {
          defaultValue: "Database",
        })
      : t("systemSettings.llmRequestLogs.retention.status.default", {
          defaultValue: "Default",
        });
  const effectiveMetadataPolicy =
    logs.metadataPolicy ?? EMPTY_LOGS.metadataPolicy;
  const metadataPolicySourceLabel =
    effectiveMetadataPolicy.source === "db"
      ? t("systemSettings.llmRequestLogs.retention.status.db", {
          defaultValue: "Database",
        })
      : t("systemSettings.llmRequestLogs.retention.status.default", {
          defaultValue: "Default",
        });
  const metadataPreviewKeys = effectiveMetadataPolicy.allowedTopLevelKeys.slice(
    0,
    12,
  );
  const metadataPreviewRemainingCount = Math.max(
    0,
    effectiveMetadataPolicy.keyCount - metadataPreviewKeys.length,
  );
  const canExportLogs = logs.total > 0;

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.llmRequestLogs.description", {
          defaultValue:
            "View centralized LLM gateway request logs for cost tracking, debugging, and usage analysis.",
        })}
      </Typography.Paragraph>

      {settingsErrorMessage ? (
        <Alert
          type="error"
          showIcon
          message={settingsErrorMessage}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Card
        size="small"
        title={t("systemSettings.llmRequestLogs.retention.title", {
          defaultValue: "Log retention settings",
        })}
        style={{ marginBottom: "1rem" }}
      >
        <Typography.Paragraph
          type="secondary"
          style={{ marginBottom: "0.75rem" }}
        >
          {t("systemSettings.llmRequestLogs.retention.description", {
            defaultValue:
              "Configure how many days LLM request logs are retained in MongoDB before automatic cleanup.",
          })}
        </Typography.Paragraph>
        <Space wrap style={{ marginBottom: "0.75rem" }}>
          <Typography.Text>
            {t("systemSettings.llmRequestLogs.retention.status.label", {
              defaultValue: "Source",
            })}
          </Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag color="geekblue">
            {t("systemSettings.llmRequestLogs.retention.status.currentDays", {
              defaultValue: "Current: {{days}} days",
              days: settings.retentionDays,
            })}
          </Tag>
          <Tag color="cyan">
            {t(
              "systemSettings.llmRequestLogs.retention.status.currentKeyCount",
              {
                defaultValue: "Keys: {{count}}",
                count: settings.metadataAllowedTopLevelKeys.length,
              },
            )}
          </Tag>
          <Tag color="purple">
            {t(
              "systemSettings.llmRequestLogs.retention.status.currentPrefixCount",
              {
                defaultValue: "Prefixes: {{count}}",
                count: settings.metadataAllowedTopLevelPrefixes.length,
              },
            )}
          </Tag>
          <Tag color="gold">
            {t(
              "systemSettings.llmRequestLogs.retention.status.currentBriefErrorRateThreshold",
              {
                defaultValue: "Error rate threshold: {{value}}%",
                value: (effectiveBriefErrorRateThreshold * 100).toFixed(2),
              },
            )}
          </Tag>
          <Tag color="orange">
            {t(
              "systemSettings.llmRequestLogs.retention.status.currentBriefInvalidJsonRatioThreshold",
              {
                defaultValue: "Invalid JSON threshold: {{value}}%",
                value: (effectiveBriefInvalidJsonRatioThreshold * 100).toFixed(
                  2,
                ),
              },
            )}
          </Tag>
          <Tag color="red">
            {t(
              "systemSettings.llmRequestLogs.retention.status.currentBriefConsecutiveDaysThreshold",
              {
                defaultValue: "Consecutive days threshold: {{days}}",
                days: effectiveBriefConsecutiveDaysThreshold,
              },
            )}
          </Tag>
        </Space>
        <Form
          layout="vertical"
          form={settingsForm}
          onFinish={handleSaveRetentionSettings}
        >
          <Form.Item
            label={t(
              "systemSettings.llmRequestLogs.retention.fields.retentionDays",
              {
                defaultValue: "Retention days",
              },
            )}
            name="retentionDays"
            rules={[
              {
                required: true,
                message: t(
                  "systemSettings.llmRequestLogs.retention.validation.retentionRequired",
                  {
                    defaultValue: "Retention days is required.",
                  },
                ),
              },
              {
                type: "number",
                min: 1,
                max: 3_650,
                message: t(
                  "systemSettings.llmRequestLogs.retention.validation.retentionRange",
                  {
                    defaultValue: "Retention must be between 1 and 3650 days.",
                  },
                ),
              },
            ]}
            extra={t(
              "systemSettings.llmRequestLogs.retention.hints.retentionDays",
              {
                defaultValue:
                  "Applied to MongoDB TTL index immediately after save and on server startup.",
              },
            )}
            style={{ maxWidth: 320 }}
          >
            <InputNumber
              min={1}
              max={3_650}
              step={1}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.llmRequestLogs.retention.fields.metadataAllowedTopLevelKeys",
              {
                defaultValue: "Metadata top-level key allowlist",
              },
            )}
            name="metadataAllowedTopLevelKeys"
            rules={[
              {
                validator: (_, value: unknown) => {
                  if (value === undefined || value === null) {
                    return Promise.resolve();
                  }
                  if (!Array.isArray(value)) {
                    return Promise.reject(
                      new Error(
                        t(
                          "systemSettings.llmRequestLogs.retention.validation.metadataKeysInvalid",
                          {
                            defaultValue: "Metadata keys must be an array.",
                          },
                        ),
                      ),
                    );
                  }
                  if (value.length > MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS) {
                    return Promise.reject(
                      new Error(
                        t(
                          "systemSettings.llmRequestLogs.retention.validation.metadataKeysMaxCount",
                          {
                            defaultValue: "At most {{count}} keys are allowed.",
                            count: MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS,
                          },
                        ),
                      ),
                    );
                  }
                  const invalidToken = value.find((token) => {
                    if (typeof token !== "string") {
                      return true;
                    }
                    const normalized = token.trim().toLowerCase();
                    if (!normalized) {
                      return true;
                    }
                    return (
                      normalized.length > MAX_METADATA_KEY_LENGTH ||
                      !METADATA_TOKEN_PATTERN.test(normalized)
                    );
                  });
                  if (invalidToken !== undefined) {
                    return Promise.reject(
                      new Error(
                        t(
                          "systemSettings.llmRequestLogs.retention.validation.metadataKeysPattern",
                          {
                            defaultValue:
                              "Use lowercase tokens with [a-z0-9_:. -], max {{max}} chars.",
                            max: MAX_METADATA_KEY_LENGTH,
                          },
                        ),
                      ),
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
            extra={t(
              "systemSettings.llmRequestLogs.retention.hints.metadataAllowedTopLevelKeys",
              {
                defaultValue:
                  "Only these top-level metadata keys are retained. Values are normalized to lowercase and deduplicated.",
              },
            )}
          >
            <Select
              mode="tags"
              tokenSeparators={[","]}
              placeholder={t(
                "systemSettings.llmRequestLogs.retention.placeholders.metadataAllowedTopLevelKeys",
                {
                  defaultValue: "Add keys and press Enter",
                },
              )}
            />
          </Form.Item>
          <Form.Item
            label={t(
              "systemSettings.llmRequestLogs.retention.fields.metadataAllowedTopLevelPrefixes",
              {
                defaultValue: "Metadata top-level prefix allowlist",
              },
            )}
            name="metadataAllowedTopLevelPrefixes"
            rules={[
              {
                validator: (_, value: unknown) => {
                  if (value === undefined || value === null) {
                    return Promise.resolve();
                  }
                  if (!Array.isArray(value)) {
                    return Promise.reject(
                      new Error(
                        t(
                          "systemSettings.llmRequestLogs.retention.validation.metadataPrefixesInvalid",
                          {
                            defaultValue: "Metadata prefixes must be an array.",
                          },
                        ),
                      ),
                    );
                  }
                  if (value.length > MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES) {
                    return Promise.reject(
                      new Error(
                        t(
                          "systemSettings.llmRequestLogs.retention.validation.metadataPrefixesMaxCount",
                          {
                            defaultValue:
                              "At most {{count}} prefixes are allowed.",
                            count: MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
                          },
                        ),
                      ),
                    );
                  }
                  const invalidToken = value.find((token) => {
                    if (typeof token !== "string") {
                      return true;
                    }
                    const normalized = token.trim().toLowerCase();
                    if (!normalized) {
                      return true;
                    }
                    return (
                      normalized.length > MAX_METADATA_PREFIX_LENGTH ||
                      !METADATA_TOKEN_PATTERN.test(normalized)
                    );
                  });
                  if (invalidToken !== undefined) {
                    return Promise.reject(
                      new Error(
                        t(
                          "systemSettings.llmRequestLogs.retention.validation.metadataPrefixesPattern",
                          {
                            defaultValue:
                              "Use lowercase prefixes with [a-z0-9_:. -], max {{max}} chars.",
                            max: MAX_METADATA_PREFIX_LENGTH,
                          },
                        ),
                      ),
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
            extra={t(
              "systemSettings.llmRequestLogs.retention.hints.metadataAllowedTopLevelPrefixes",
              {
                defaultValue:
                  "Top-level metadata keys with these prefixes are retained (for example: x_, meta_, ctx_).",
              },
            )}
          >
            <Select
              mode="tags"
              tokenSeparators={[","]}
              placeholder={t(
                "systemSettings.llmRequestLogs.retention.placeholders.metadataAllowedTopLevelPrefixes",
                {
                  defaultValue: "Add prefixes and press Enter",
                },
              )}
            />
          </Form.Item>
          <Row gutter={[16, 0]}>
            <Col xs={24} md={8}>
              <Form.Item
                label={t(
                  "systemSettings.llmRequestLogs.retention.fields.briefErrorRateThreshold",
                  {
                    defaultValue: "Brief error rate threshold",
                  },
                )}
                name="briefErrorRateThreshold"
                rules={[
                  {
                    required: true,
                    message: t(
                      "systemSettings.llmRequestLogs.retention.validation.briefErrorRateThresholdRequired",
                      {
                        defaultValue: "Brief error rate threshold is required.",
                      },
                    ),
                  },
                  {
                    type: "number",
                    min: 0,
                    max: 1,
                    message: t(
                      "systemSettings.llmRequestLogs.retention.validation.briefErrorRateThresholdRange",
                      {
                        defaultValue: "Use a value between 0 and 1.",
                      },
                    ),
                  },
                ]}
                extra={t(
                  "systemSettings.llmRequestLogs.retention.hints.briefErrorRateThreshold",
                  {
                    defaultValue:
                      "Alert triggers when brief error rate reaches this threshold (0-1).",
                  },
                )}
              >
                <InputNumber
                  min={0}
                  max={1}
                  step={0.01}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                label={t(
                  "systemSettings.llmRequestLogs.retention.fields.briefInvalidJsonRatioThreshold",
                  {
                    defaultValue: "Brief invalid JSON ratio threshold",
                  },
                )}
                name="briefInvalidJsonRatioThreshold"
                rules={[
                  {
                    required: true,
                    message: t(
                      "systemSettings.llmRequestLogs.retention.validation.briefInvalidJsonRatioThresholdRequired",
                      {
                        defaultValue:
                          "Brief invalid JSON ratio threshold is required.",
                      },
                    ),
                  },
                  {
                    type: "number",
                    min: 0,
                    max: 1,
                    message: t(
                      "systemSettings.llmRequestLogs.retention.validation.briefInvalidJsonRatioThresholdRange",
                      {
                        defaultValue: "Use a value between 0 and 1.",
                      },
                    ),
                  },
                ]}
                extra={t(
                  "systemSettings.llmRequestLogs.retention.hints.briefInvalidJsonRatioThreshold",
                  {
                    defaultValue:
                      "Alert triggers when invalid JSON ratio reaches this threshold (0-1).",
                  },
                )}
              >
                <InputNumber
                  min={0}
                  max={1}
                  step={0.01}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                label={t(
                  "systemSettings.llmRequestLogs.retention.fields.briefConsecutiveDaysThreshold",
                  {
                    defaultValue: "Brief consecutive days threshold",
                  },
                )}
                name="briefConsecutiveDaysThreshold"
                rules={[
                  {
                    required: true,
                    message: t(
                      "systemSettings.llmRequestLogs.retention.validation.briefConsecutiveDaysThresholdRequired",
                      {
                        defaultValue: "Consecutive days threshold is required.",
                      },
                    ),
                  },
                  {
                    type: "number",
                    min: 1,
                    max: 30,
                    message: t(
                      "systemSettings.llmRequestLogs.retention.validation.briefConsecutiveDaysThresholdRange",
                      {
                        defaultValue: "Use an integer between 1 and 30.",
                      },
                    ),
                  },
                ]}
                extra={t(
                  "systemSettings.llmRequestLogs.retention.hints.briefConsecutiveDaysThreshold",
                  {
                    defaultValue:
                      "Alert triggers when any threshold is exceeded for this many consecutive days.",
                  },
                )}
              >
                <InputNumber
                  min={1}
                  max={30}
                  step={1}
                  precision={0}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
          </Row>
          <Space wrap>
            <Button
              type="primary"
              htmlType="submit"
              loading={settingsSaving}
              disabled={settingsResetting || settingsMetadataResetting}
            >
              {t("common.saveChanges", { defaultValue: "Save changes" })}
            </Button>
            <Button
              onClick={handleResetMetadataPolicy}
              loading={settingsMetadataResetting}
              disabled={settingsSaving || settingsResetting}
            >
              {t(
                "systemSettings.llmRequestLogs.retention.actions.resetMetadata",
                {
                  defaultValue: "Reset metadata allowlist",
                },
              )}
            </Button>
            <Button
              danger
              onClick={handleResetRetentionSettings}
              loading={settingsResetting}
              disabled={settingsSaving || settingsMetadataResetting}
            >
              {t("systemSettings.llmRequestLogs.retention.actions.reset", {
                defaultValue: "Reset to default",
              })}
            </Button>
          </Space>
        </Form>
      </Card>

      <Card
        size="small"
        title={t("systemSettings.llmRequestLogs.metadataPolicy.title", {
          defaultValue: "Effective metadata policy",
        })}
        style={{ marginBottom: "1rem" }}
      >
        <Typography.Paragraph
          type="secondary"
          style={{ marginBottom: "0.75rem" }}
        >
          {t("systemSettings.llmRequestLogs.metadataPolicy.description", {
            defaultValue:
              "This policy is returned by /api/llm-logs and determines which top-level metadata keys are persisted.",
          })}
        </Typography.Paragraph>
        <Space wrap style={{ marginBottom: "0.75rem" }}>
          <Typography.Text>
            {t("systemSettings.llmRequestLogs.metadataPolicy.source", {
              defaultValue: "Source",
            })}
          </Typography.Text>
          <Tag
            color={
              effectiveMetadataPolicy.source === "db" ? "green" : "default"
            }
          >
            {metadataPolicySourceLabel}
          </Tag>
          <Tag color="cyan">
            {t("systemSettings.llmRequestLogs.metadataPolicy.keysCount", {
              defaultValue: "Keys: {{count}}",
              count: effectiveMetadataPolicy.keyCount,
            })}
          </Tag>
          <Tag color="purple">
            {t("systemSettings.llmRequestLogs.metadataPolicy.prefixesCount", {
              defaultValue: "Prefixes: {{count}}",
              count: effectiveMetadataPolicy.prefixCount,
            })}
          </Tag>
        </Space>

        <Typography.Text strong>
          {t("systemSettings.llmRequestLogs.metadataPolicy.prefixesTitle", {
            defaultValue: "Allowed prefixes",
          })}
        </Typography.Text>
        <Space
          wrap
          style={{
            display: "flex",
            marginTop: "0.5rem",
            marginBottom: "0.75rem",
          }}
        >
          {effectiveMetadataPolicy.allowedTopLevelPrefixes.length > 0 ? (
            effectiveMetadataPolicy.allowedTopLevelPrefixes.map((prefix) => (
              <Tag key={prefix}>{prefix}</Tag>
            ))
          ) : (
            <Typography.Text type="secondary">
              {t("systemSettings.llmRequestLogs.metadataPolicy.none", {
                defaultValue: "None",
              })}
            </Typography.Text>
          )}
        </Space>

        <Typography.Text strong>
          {t("systemSettings.llmRequestLogs.metadataPolicy.keysPreviewTitle", {
            defaultValue: "Allowed keys (preview)",
          })}
        </Typography.Text>
        <Space wrap style={{ display: "flex", marginTop: "0.5rem" }}>
          {metadataPreviewKeys.length > 0 ? (
            metadataPreviewKeys.map((key) => <Tag key={key}>{key}</Tag>)
          ) : (
            <Typography.Text type="secondary">
              {t("systemSettings.llmRequestLogs.metadataPolicy.none", {
                defaultValue: "None",
              })}
            </Typography.Text>
          )}
        </Space>
        {metadataPreviewRemainingCount > 0 ? (
          <Typography.Text type="secondary">
            {t("systemSettings.llmRequestLogs.metadataPolicy.keysMore", {
              defaultValue: "+{{count}} more",
              count: metadataPreviewRemainingCount,
            })}
          </Typography.Text>
        ) : null}
      </Card>

      <Space
        wrap
        style={{
          display: "flex",
          marginBottom: "1rem",
          alignItems: "flex-end",
        }}
      >
        <Input
          allowClear
          value={modelFilter}
          onChange={(event) => setModelFilter(event.target.value)}
          placeholder={t("systemSettings.llmRequestLogs.filters.model", {
            defaultValue: "Model",
          })}
          style={{ minWidth: 220 }}
        />
        <Input
          allowClear
          value={featureFilter}
          onChange={(event) => setFeatureFilter(event.target.value)}
          placeholder={t("systemSettings.llmRequestLogs.filters.feature", {
            defaultValue: "Feature",
          })}
          style={{ minWidth: 220 }}
        />
        <Select<"all" | LlmRequestType>
          value={requestTypeFilter}
          onChange={setRequestTypeFilter}
          style={{ minWidth: 180 }}
          options={[
            {
              value: "all",
              label: t("systemSettings.llmRequestLogs.filters.requestTypeAll", {
                defaultValue: "All request types",
              }),
            },
            { value: "completion", label: "completion" },
            { value: "embedding", label: "embedding" },
            { value: "rerank", label: "rerank" },
            { value: "stream", label: "stream" },
            { value: "responses", label: "responses" },
          ]}
        />
        <Select<"all" | LlmRequestStatus>
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ minWidth: 160 }}
          options={[
            {
              value: "all",
              label: t("systemSettings.llmRequestLogs.filters.statusAll", {
                defaultValue: "All statuses",
              }),
            },
            {
              value: "success",
              label: t("systemSettings.llmRequestLogs.status.success", {
                defaultValue: "Success",
              }),
            },
            {
              value: "error",
              label: t("systemSettings.llmRequestLogs.status.error", {
                defaultValue: "Error",
              }),
            },
          ]}
        />
        <DatePicker.RangePicker
          value={dateRange}
          onChange={(value) => {
            if (!value || value.length !== 2 || !value[0] || !value[1]) {
              setDateRange(null);
              return;
            }
            setDateRange([value[0], value[1]]);
          }}
          allowClear
          style={{ minWidth: 280 }}
        />
        <Button type="primary" onClick={handleSearch} loading={isLoading}>
          {t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
        <Button
          onClick={() => {
            handleReset();
          }}
        >
          {t("common.reset", { defaultValue: "Reset" })}
        </Button>
        <Tooltip
          title={
            !canExportLogs
              ? t("systemSettings.llmRequestLogs.export.noData", {
                  defaultValue: "No data to export for current filters.",
                })
              : undefined
          }
        >
          <span>
            <Button
              onClick={() => {
                void handleExportLogs();
              }}
              loading={exportLogsLoading}
              disabled={logsLoading || !canExportLogs}
            >
              {exportLogsLoading
                ? t("systemSettings.llmRequestLogs.export.exporting", {
                    defaultValue: "Exporting...",
                  })
                : t("systemSettings.llmRequestLogs.export.button", {
                    defaultValue: "Export CSV",
                  })}
            </Button>
          </span>
        </Tooltip>
      </Space>

      {errorMessage ? (
        <Alert
          type="error"
          showIcon
          message={errorMessage}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Card
        size="small"
        title={t("systemSettings.llmRequestLogs.summary.title", {
          defaultValue: "Usage Summary",
        })}
        style={{ marginBottom: "1rem" }}
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.totalRequests", {
                defaultValue: "Total requests",
              })}
              value={summary.totals.requestCount}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.totalTokens", {
                defaultValue: "Total tokens",
              })}
              value={summary.totals.totalTokens}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.totalCost", {
                defaultValue: "Total cost (USD)",
              })}
              value={summary.totals.costUsd}
              precision={6}
              prefix="$"
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.avgLatency", {
                defaultValue: "Avg latency",
              })}
              value={Math.round(summary.totals.avgLatencyMs)}
              suffix="ms"
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.successRate", {
                defaultValue: "Success rate",
              })}
              value={Number(
                (summary.statusBreakdown.successRate * 100).toFixed(2),
              )}
              suffix="%"
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.errorRate", {
                defaultValue: "Error rate",
              })}
              value={Number(
                (summary.statusBreakdown.errorRate * 100).toFixed(2),
              )}
              suffix="%"
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.successCount", {
                defaultValue: "Success count",
              })}
              value={summary.statusBreakdown.success}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title={t("systemSettings.llmRequestLogs.summary.p95Latency", {
                defaultValue: "P95 latency",
              })}
              value={
                typeof summary.latency.p95Ms === "number"
                  ? Math.round(summary.latency.p95Ms)
                  : "-"
              }
              suffix={
                typeof summary.latency.p95Ms === "number" ? "ms" : undefined
              }
            />
          </Col>
          {showBriefMetrics ? (
            <>
              <Col xs={24} sm={12} md={6}>
                <Statistic
                  title={t(
                    "systemSettings.llmRequestLogs.summary.briefGraphqlErrors",
                    {
                      defaultValue: "Brief GraphQL errors",
                    },
                  )}
                  value={briefGraphqlErrorTotal}
                />
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Statistic
                  title={t(
                    "systemSettings.llmRequestLogs.summary.briefInvalidJsonErrors",
                    {
                      defaultValue: "Brief invalid JSON",
                    },
                  )}
                  value={briefInvalidJsonTotal}
                />
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Statistic
                  title={t(
                    "systemSettings.llmRequestLogs.summary.briefInvalidJsonRatio",
                    {
                      defaultValue: "Brief invalid JSON ratio",
                    },
                  )}
                  value={Number((briefInvalidJsonRatio * 100).toFixed(2))}
                  suffix="%"
                />
              </Col>
            </>
          ) : null}
        </Row>
        {briefMetricsErrorMessage ? (
          <Alert
            type="warning"
            showIcon
            message={briefMetricsErrorMessage}
            style={{ marginTop: "0.75rem" }}
          />
        ) : null}
        {showBriefMetrics && briefThresholdWarnings.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={t(
              "systemSettings.llmRequestLogs.summary.thresholdAlerts.title",
              {
                defaultValue: "newsEventBrief threshold alerts",
              },
            )}
            description={
              <Space direction="vertical" size={2}>
                {briefThresholdWarnings.map((warning) => (
                  <Typography.Text key={warning}>{warning}</Typography.Text>
                ))}
              </Space>
            }
            style={{ marginTop: "0.75rem" }}
          />
        ) : null}
        {showBriefMetrics ? (
          <Card
            size="small"
            style={{ marginTop: "0.75rem" }}
            title={t(
              "systemSettings.llmRequestLogs.summary.briefErrorTrend.title",
              {
                defaultValue: "Brief GraphQL error trend (by day)",
              },
            )}
          >
            {briefErrorTrendChartOption ? (
              <DashboardChart
                option={briefErrorTrendChartOption}
                theme={echartsTheme}
                height={260}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t(
                  "systemSettings.llmRequestLogs.summary.briefErrorTrend.empty",
                  {
                    defaultValue: "No brief GraphQL errors in selected range.",
                  },
                )}
              />
            )}
          </Card>
        ) : null}
        <div style={{ marginTop: "0.75rem" }}>
          <Typography.Text strong>
            {t("systemSettings.llmRequestLogs.summary.topErrors.title", {
              defaultValue: "Top errors",
            })}
          </Typography.Text>
          {summary.topErrors.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("systemSettings.llmRequestLogs.summary.topErrors.empty", {
                defaultValue: "No error summary.",
              })}
            </Typography.Paragraph>
          ) : (
            <List
              size="small"
              dataSource={summary.topErrors}
              renderItem={(item) => (
                <List.Item>
                  <Space
                    style={{ width: "100%", justifyContent: "space-between" }}
                  >
                    <Typography.Text
                      ellipsis={{ tooltip: item.message }}
                      style={{ maxWidth: "75%" }}
                    >
                      {item.message}
                    </Typography.Text>
                    <Tag>{item.count}</Tag>
                  </Space>
                </List.Item>
              )}
            />
          )}
        </div>
      </Card>

      <Table<LlmRequestLogRow>
        rowKey={(row) => row.id}
        loading={logsLoading}
        columns={columns}
        dataSource={Array.isArray(logs.items) ? logs.items : []}
        scroll={{ x: 1280 }}
        pagination={{
          current: page,
          pageSize,
          total: logs.total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          },
        }}
        locale={{
          emptyText: t("systemSettings.llmRequestLogs.table.empty", {
            defaultValue: "No logs found.",
          }),
        }}
      />

      <Row gutter={[16, 16]} style={{ marginTop: "1rem" }}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={t("systemSettings.llmRequestLogs.summary.byModel.title", {
              defaultValue: "By model",
            })}
          >
            <Table<LlmUsageSummaryByModelRow>
              rowKey={(row) => row.model}
              size="small"
              columns={byModelColumns}
              dataSource={summary.byModel}
              pagination={false}
              locale={{
                emptyText: t(
                  "systemSettings.llmRequestLogs.summary.byModel.empty",
                  {
                    defaultValue: "No model summary.",
                  },
                ),
              }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={t("systemSettings.llmRequestLogs.summary.byDay.title", {
              defaultValue: "By day (UTC)",
            })}
          >
            <Table<LlmUsageSummaryByDayRow>
              rowKey={(row) => row.date}
              size="small"
              columns={byDayColumns}
              dataSource={summary.byDay}
              pagination={false}
              locale={{
                emptyText: t(
                  "systemSettings.llmRequestLogs.summary.byDay.empty",
                  {
                    defaultValue: "No daily summary.",
                  },
                ),
              }}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
