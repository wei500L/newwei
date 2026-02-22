"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

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

interface LlmUsageSummaryResponse {
  totals: LlmUsageSummaryTotals;
  byModel: LlmUsageSummaryByModelRow[];
  byDay: LlmUsageSummaryByDayRow[];
}

type LlmRequestLogSettingsSource = "default" | "db";

interface LlmRequestLogSettingsResponse {
  source: LlmRequestLogSettingsSource;
  retentionDays: number;
  metadataAllowedTopLevelKeys: string[];
  metadataAllowedTopLevelPrefixes: string[];
}

interface LlmRequestLogSettingsFormValues {
  retentionDays: number;
  metadataAllowedTopLevelKeys: string[];
  metadataAllowedTopLevelPrefixes: string[];
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS = 100;
const MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES = 20;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_PREFIX_LENGTH = 24;
const METADATA_TOKEN_PATTERN = /^[a-z0-9_:\-.]+$/;

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

const EMPTY_SUMMARY: LlmUsageSummaryResponse = {
  totals: EMPTY_TOTALS,
  byModel: [],
  byDay: [],
};

const EMPTY_SETTINGS: LlmRequestLogSettingsResponse = {
  source: "default",
  retentionDays: DEFAULT_RETENTION_DAYS,
  metadataAllowedTopLevelKeys: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_KEYS,
  metadataAllowedTopLevelPrefixes: DEFAULT_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
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
  const allowedTopLevelKeys = Array.isArray(settings.metadataAllowedTopLevelKeys)
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
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [settingsForm] = Form.useForm<LlmRequestLogSettingsFormValues>();

  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsResetting, setSettingsResetting] = useState(false);
  const [settingsMetadataResetting, setSettingsMetadataResetting] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [settings, setSettings] = useState<LlmRequestLogSettingsResponse>(EMPTY_SETTINGS);
  const [logs, setLogs] = useState<LlmRequestLogListResponse>(EMPTY_LOGS);
  const [summary, setSummary] = useState<LlmUsageSummaryResponse>(EMPTY_SUMMARY);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [modelFilter, setModelFilter] = useState("");
  const [requestTypeFilter, setRequestTypeFilter] = useState<"all" | LlmRequestType>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | LlmRequestStatus>("all");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [appliedModelFilter, setAppliedModelFilter] = useState("");
  const [appliedRequestTypeFilter, setAppliedRequestTypeFilter] = useState<"all" | LlmRequestType>("all");
  const [appliedStatusFilter, setAppliedStatusFilter] = useState<"all" | LlmRequestStatus>("all");
  const [appliedDateRange, setAppliedDateRange] = useState<[Dayjs, Dayjs] | null>(null);

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

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsErrorMessage(null);
    try {
      const response = await apiClient.get<LlmRequestLogSettingsResponse>(
        "system-settings/llm-request-logs",
      );
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      setLogs((previous) => ({
        ...previous,
        metadataPolicy: buildMetadataPolicyFromSettings(data),
      }));
      settingsForm.setFieldsValue({
        retentionDays: data.retentionDays,
        metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
        metadataAllowedTopLevelPrefixes: data.metadataAllowedTopLevelPrefixes,
      });
    } catch (error) {
      captureClientError("Failed to load LLM request log retention settings", error);
      const messageText =
        extractApiError(error).message ||
        t("systemSettings.llmRequestLogs.errors.settingsLoadFailed", {
          defaultValue: "Failed to load log retention settings.",
        });
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
      };
      const normalizedModel = appliedModelFilter.trim();
      if (normalizedModel.length > 0) {
        params.model = normalizedModel;
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

      const response = await apiClient.get<LlmRequestLogListResponse>("llm-logs", {
        params,
      });
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
      const messageText =
        extractApiError(error).message ||
        t("systemSettings.llmRequestLogs.errors.loadFailed", {
          defaultValue: "Failed to load LLM request logs.",
        });
      setErrorMessage(messageText);
      messageApi.error(messageText);
    } finally {
      setLogsLoading(false);
    }
  }, [
    apiClient,
    appliedModelFilter,
    appliedRequestTypeFilter,
    appliedStatusFilter,
    refreshNonce,
    messageApi,
    page,
    pageSize,
    sharedDateParams.end,
    sharedDateParams.start,
    t,
  ]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const params: Record<string, string> = {};
      if (typeof sharedDateParams.start === "string") {
        params.start = sharedDateParams.start;
      }
      if (typeof sharedDateParams.end === "string") {
        params.end = sharedDateParams.end;
      }
      const response = await apiClient.get<LlmUsageSummaryResponse>("llm-logs/summary", {
        params,
      });
      setSummary(response.data ?? EMPTY_SUMMARY);
    } catch (error) {
      captureClientError("Failed to load LLM request log summary", error);
      const messageText =
        extractApiError(error).message ||
        t("systemSettings.llmRequestLogs.errors.summaryFailed", {
          defaultValue: "Failed to load usage summary.",
        });
      messageApi.error(messageText);
    } finally {
      setSummaryLoading(false);
    }
  }, [
    apiClient,
    messageApi,
    refreshNonce,
    sharedDateParams.end,
    sharedDateParams.start,
    t,
  ]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleSearch = () => {
    setPage(1);
    setAppliedModelFilter(modelFilter.trim());
    setAppliedRequestTypeFilter(requestTypeFilter);
    setAppliedStatusFilter(statusFilter);
    setAppliedDateRange(dateRange);
    setRefreshNonce((value) => value + 1);
  };

  const handleReset = () => {
    setModelFilter("");
    setRequestTypeFilter("all");
    setStatusFilter("all");
    setDateRange(null);
    setAppliedModelFilter("");
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
        },
      );
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      setLogs((previous) => ({
        ...previous,
        metadataPolicy: buildMetadataPolicyFromSettings(data),
      }));
      settingsForm.setFieldsValue({
        retentionDays: data.retentionDays,
        metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
        metadataAllowedTopLevelPrefixes: data.metadataAllowedTopLevelPrefixes,
      });
      messageApi.success(
        t("systemSettings.llmRequestLogs.messages.settingsSaved", {
          defaultValue: "Log retention settings saved.",
        }),
      );
    } catch (error) {
      captureClientError("Failed to save LLM request log retention settings", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(
          extractApiError(error).message ||
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
        defaultValue: "Reset LLM request log retention settings to system defaults?",
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
          const response = await apiClient.delete<LlmRequestLogSettingsResponse>(
            "system-settings/llm-request-logs",
          );
          const data = response.data ?? EMPTY_SETTINGS;
          setSettings(data);
          setLogs((previous) => ({
            ...previous,
            metadataPolicy: buildMetadataPolicyFromSettings(data),
          }));
          settingsForm.setFieldsValue({
            retentionDays: data.retentionDays,
            metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
            metadataAllowedTopLevelPrefixes: data.metadataAllowedTopLevelPrefixes,
          });
          messageApi.success(
            t("systemSettings.llmRequestLogs.messages.settingsReset", {
              defaultValue: "Log retention settings reset to defaults.",
            }),
          );
        } catch (error) {
          captureClientError("Failed to reset LLM request log retention settings", error);
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
      title: t("systemSettings.llmRequestLogs.retention.modal.resetMetadataTitle", {
        defaultValue: "Reset metadata allowlist",
      }),
      content: t("systemSettings.llmRequestLogs.retention.modal.resetMetadataContent", {
        defaultValue:
          "Reset metadata key/prefix allowlist to recommended defaults without changing retention days?",
      }),
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
          const data = response.data ?? EMPTY_SETTINGS;
          setSettings(data);
          setLogs((previous) => ({
            ...previous,
            metadataPolicy: buildMetadataPolicyFromSettings(data),
          }));
          settingsForm.setFieldsValue({
            retentionDays: data.retentionDays,
            metadataAllowedTopLevelKeys: data.metadataAllowedTopLevelKeys,
            metadataAllowedTopLevelPrefixes: data.metadataAllowedTopLevelPrefixes,
          });
          messageApi.success(
            t("systemSettings.llmRequestLogs.messages.metadataPolicyReset", {
              defaultValue: "Metadata allowlist reset to recommended defaults.",
            }),
          );
        } catch (error) {
          captureClientError("Failed to reset LLM request log metadata policy", error);
          messageApi.error(
            t("systemSettings.llmRequestLogs.errors.metadataPolicyResetFailed", {
              defaultValue: "Failed to reset metadata allowlist.",
            }),
          );
        } finally {
          setSettingsMetadataResetting(false);
        }
      },
    });
  };

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

  const isLoading = logsLoading || summaryLoading;

  if ((settingsLoading || isLoading) && logs.items.length === 0) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
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
  const effectiveMetadataPolicy = logs.metadataPolicy ?? EMPTY_LOGS.metadataPolicy;
  const metadataPolicySourceLabel =
    effectiveMetadataPolicy.source === "db"
      ? t("systemSettings.llmRequestLogs.retention.status.db", {
          defaultValue: "Database",
        })
      : t("systemSettings.llmRequestLogs.retention.status.default", {
          defaultValue: "Default",
        });
  const metadataPreviewKeys = effectiveMetadataPolicy.allowedTopLevelKeys.slice(0, 12);
  const metadataPreviewRemainingCount = Math.max(
    0,
    effectiveMetadataPolicy.keyCount - metadataPreviewKeys.length,
  );

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
        <Typography.Paragraph type="secondary" style={{ marginBottom: "0.75rem" }}>
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
            {t("systemSettings.llmRequestLogs.retention.status.currentKeyCount", {
              defaultValue: "Keys: {{count}}",
              count: settings.metadataAllowedTopLevelKeys.length,
            })}
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
        </Space>
        <Form
          layout="vertical"
          form={settingsForm}
          onFinish={handleSaveRetentionSettings}
        >
          <Form.Item
            label={t("systemSettings.llmRequestLogs.retention.fields.retentionDays", {
              defaultValue: "Retention days",
            })}
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
            extra={t("systemSettings.llmRequestLogs.retention.hints.retentionDays", {
              defaultValue:
                "Applied to MongoDB TTL index immediately after save and on server startup.",
            })}
            style={{ maxWidth: 320 }}
          >
            <InputNumber min={1} max={3_650} step={1} style={{ width: "100%" }} />
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
              {t("systemSettings.llmRequestLogs.retention.actions.resetMetadata", {
                defaultValue: "Reset metadata allowlist",
              })}
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
        <Typography.Paragraph type="secondary" style={{ marginBottom: "0.75rem" }}>
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
          <Tag color={effectiveMetadataPolicy.source === "db" ? "green" : "default"}>
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
        <Space wrap style={{ display: "flex", marginTop: "0.5rem", marginBottom: "0.75rem" }}>
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
      </Space>

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
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
        </Row>
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
                emptyText: t("systemSettings.llmRequestLogs.summary.byModel.empty", {
                  defaultValue: "No model summary.",
                }),
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
                emptyText: t("systemSettings.llmRequestLogs.summary.byDay.empty", {
                  defaultValue: "No daily summary.",
                }),
              }}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
