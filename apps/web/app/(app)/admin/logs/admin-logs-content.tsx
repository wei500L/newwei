"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  buildAdminLogsTabSelectionHref,
  resolveAdminLogsTabId,
  type AdminLogsTabId,
} from "@/lib/admin-logs";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs, { toUtcIsoString } from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

const { RangePicker } = DatePicker;

type DateRangeValue = [Dayjs, Dayjs] | null;
type TaskLogStatus = "pending" | "processing" | "completed" | "failed";
type ErrorKind = "http" | "graphql" | "unknown";
type ErrorKindFilter = ErrorKind | "all";

interface TaskLogRecord {
  id: string;
  queue: string;
  jobId: string;
  orgId: string;
  stage: string;
  status: TaskLogStatus;
  message?: string | null;
  data?: unknown;
  error?: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

interface TaskLogsSummary {
  totals: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  byStage: { stage: string; count: number }[];
  topErrors: {
    queue: string;
    stage: string;
    errorName: string;
    sampleMessage: string | null;
    count: number;
  }[];
}

interface ExceptionEvent {
  id: string;
  kind: ErrorKind;
  traceId: string;
  timestamp: string;
  statusCode?: number;
  message: string;
  path?: string;
  method?: string;
  operation?: string;
  operationName?: string;
  errorName?: string;
  stack?: string;
}

interface ExceptionEventStats {
  total: number;
  byKind: { kind: ErrorKind; count: number }[];
  byDay: { date: string; count: number }[];
}

interface AuditLogEntry {
  id: string;
  orgId: string;
  actorId?: string | null;
  resource: string;
  action: string;
  metadata?: unknown;
  ipAddress?: string | null;
  createdAt: string;
}

interface PaginatedResponse<TItem> {
  page: number;
  pageSize: number;
  total: number;
  items: TItem[];
}

interface TaskQueryState {
  queue: string;
  jobId: string;
  stage: string;
  status: TaskLogStatus | "all";
  dateRange: DateRangeValue;
  page: number;
  pageSize: number;
}

interface ErrorsQueryState {
  kind: ErrorKindFilter;
  operationName: string;
  messageContains: string;
  dateRange: DateRangeValue;
  page: number;
  pageSize: number;
}

interface AuditQueryState {
  search: string;
  resource: string;
  action: string;
  dateRange: DateRangeValue;
  page: number;
  pageSize: number;
}

type DetailState =
  | { tab: "task"; record: TaskLogRecord }
  | { tab: "errors"; record: ExceptionEvent }
  | { tab: "audit"; record: AuditLogEntry };

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = ["20", "50", "100"];
const TASK_QUERY_KEYS = [
  "taskQueue",
  "taskJobId",
  "taskStage",
  "taskStatus",
  "taskStart",
  "taskEnd",
  "taskPage",
  "taskPageSize",
] as const;
const ERROR_QUERY_KEYS = [
  "errorKind",
  "errorOperationName",
  "errorMessageContains",
  "errorStart",
  "errorEnd",
  "errorPage",
  "errorPageSize",
] as const;
const AUDIT_QUERY_KEYS = [
  "auditSearch",
  "auditResource",
  "auditAction",
  "auditStart",
  "auditEnd",
  "auditPage",
  "auditPageSize",
] as const;

function clampPositiveInt(value: string | null, fallback: number, max = 100): number {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, Math.floor(parsed));
}

function parseDateRange(startRaw: string | null, endRaw: string | null): DateRangeValue {
  if (!startRaw || !endRaw) {
    return null;
  }

  const start = dayjs(startRaw);
  const end = dayjs(endRaw);
  if (!start.isValid() || !end.isValid()) {
    return null;
  }

  return [start, end];
}

function serializeDateRange(
  prefix: string,
  range: DateRangeValue,
): Record<string, string | undefined> {
  if (!range) {
    return {
      [`${prefix}Start`]: undefined,
      [`${prefix}End`]: undefined,
    };
  }

  const [start, end] = range;
  return {
    [`${prefix}Start`]: toUtcIsoString(dayjs(start).startOf("day")),
    [`${prefix}End`]: toUtcIsoString(dayjs(end).endOf("day")),
  };
}

function parseTaskQueryState(searchParams: Pick<URLSearchParams, "get">): TaskQueryState {
  const status = searchParams.get("taskStatus");
  return {
    queue: searchParams.get("taskQueue") ?? "",
    jobId: searchParams.get("taskJobId") ?? "",
    stage: searchParams.get("taskStage") ?? "",
    status:
      status === "pending" || status === "processing" || status === "completed" || status === "failed"
        ? status
        : "all",
    dateRange: parseDateRange(searchParams.get("taskStart"), searchParams.get("taskEnd")),
    page: clampPositiveInt(searchParams.get("taskPage"), DEFAULT_PAGE),
    pageSize: clampPositiveInt(searchParams.get("taskPageSize"), DEFAULT_PAGE_SIZE),
  };
}

function parseErrorsQueryState(searchParams: Pick<URLSearchParams, "get">): ErrorsQueryState {
  const kind = searchParams.get("errorKind");
  return {
    kind: kind === "http" || kind === "graphql" || kind === "unknown" ? kind : "all",
    operationName: searchParams.get("errorOperationName") ?? "",
    messageContains: searchParams.get("errorMessageContains") ?? "",
    dateRange: parseDateRange(searchParams.get("errorStart"), searchParams.get("errorEnd")),
    page: clampPositiveInt(searchParams.get("errorPage"), DEFAULT_PAGE),
    pageSize: clampPositiveInt(searchParams.get("errorPageSize"), DEFAULT_PAGE_SIZE),
  };
}

function parseAuditQueryState(searchParams: Pick<URLSearchParams, "get">): AuditQueryState {
  return {
    search: searchParams.get("auditSearch") ?? "",
    resource: searchParams.get("auditResource") ?? "",
    action: searchParams.get("auditAction") ?? "",
    dateRange: parseDateRange(searchParams.get("auditStart"), searchParams.get("auditEnd")),
    page: clampPositiveInt(searchParams.get("auditPage"), DEFAULT_PAGE),
    pageSize: clampPositiveInt(searchParams.get("auditPageSize"), DEFAULT_PAGE_SIZE),
  };
}

function getLocation(record: ExceptionEvent, emptyLabel: string) {
  if (record.kind === "http") {
    const method = record.method ?? "";
    const path = record.path ?? "";
    return `${method} ${path}`.trim() || emptyLabel;
  }

  if (record.kind === "graphql") {
    const operation = record.operation ?? "";
    const operationName = record.operationName ? ` (${record.operationName})` : "";
    return `${operation}${operationName}`.trim() || emptyLabel;
  }

  return emptyLabel;
}

function formatJson(value: unknown, fallback: string) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function renderKind(kind: ErrorKind, t: (key: string, options?: Record<string, unknown>) => string) {
  if (kind === "http") {
    return <Tag color="blue">{t("errors.kinds.http", { defaultValue: "HTTP" })}</Tag>;
  }
  if (kind === "graphql") {
    return <Tag color="purple">{t("errors.kinds.graphql", { defaultValue: "GraphQL" })}</Tag>;
  }
  return <Tag>{t("errors.kinds.unknown", { defaultValue: "Unknown" })}</Tag>;
}

export function AdminLogsContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("settings.manage");

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const activeTab = resolveAdminLogsTabId(searchParams.get("tab"));
  const taskQuery = useMemo(() => parseTaskQueryState(searchParams), [searchParams]);
  const errorsQuery = useMemo(() => parseErrorsQueryState(searchParams), [searchParams]);
  const auditQuery = useMemo(() => parseAuditQueryState(searchParams), [searchParams]);

  const [taskFilters, setTaskFilters] = useState<TaskQueryState>(taskQuery);
  const [errorsFilters, setErrorsFilters] = useState<ErrorsQueryState>(errorsQuery);
  const [auditFilters, setAuditFilters] = useState<AuditQueryState>(auditQuery);
  const [taskRows, setTaskRows] = useState<PaginatedResponse<TaskLogRecord>>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
    items: [],
  });
  const [taskSummary, setTaskSummary] = useState<TaskLogsSummary | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskErrorMessage, setTaskErrorMessage] = useState<string | null>(null);
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0);
  const [errorRows, setErrorRows] = useState<PaginatedResponse<ExceptionEvent>>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
    items: [],
  });
  const [errorSummary, setErrorSummary] = useState<ExceptionEventStats | null>(null);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [errorsErrorMessage, setErrorsErrorMessage] = useState<string | null>(null);
  const [errorsRefreshNonce, setErrorsRefreshNonce] = useState(0);
  const [auditRows, setAuditRows] = useState<PaginatedResponse<AuditLogEntry>>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
    items: [],
  });
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditErrorMessage, setAuditErrorMessage] = useState<string | null>(null);
  const [auditRefreshNonce, setAuditRefreshNonce] = useState(0);
  const [detailState, setDetailState] = useState<DetailState | null>(null);

  useEffect(() => {
    setTaskFilters(taskQuery);
  }, [taskQuery]);

  useEffect(() => {
    setErrorsFilters(errorsQuery);
  }, [errorsQuery]);

  useEffect(() => {
    setAuditFilters(auditQuery);
  }, [auditQuery]);

  useEffect(() => {
    setDetailState(null);
  }, [activeTab]);

  const replaceTabQuery = useCallback(
    (
      tab: AdminLogsTabId,
      clearKeys: readonly string[],
      nextQuery: Record<string, string | number | undefined>,
    ) => {
      const nextSearchParams = new URLSearchParams(searchParams.toString());
      nextSearchParams.set("tab", tab);
      for (const key of clearKeys) {
        nextSearchParams.delete(key);
      }

      for (const [key, value] of Object.entries(nextQuery)) {
        if (value === undefined || value === "") {
          continue;
        }
        nextSearchParams.set(key, String(value));
      }

      const search = nextSearchParams.toString();
      router.replace(search.length > 0 ? `${pathname ?? "/admin/logs"}?${search}` : pathname ?? "/admin/logs");
    },
    [pathname, router, searchParams],
  );

  const taskApiParams = useMemo(() => {
    const params: Record<string, string | number> = {
      page: taskQuery.page,
      pageSize: taskQuery.pageSize,
    };

    if (taskQuery.queue.trim()) {
      params.queue = taskQuery.queue.trim();
    }
    if (taskQuery.jobId.trim()) {
      params.jobId = taskQuery.jobId.trim();
    }
    if (taskQuery.stage.trim()) {
      params.stage = taskQuery.stage.trim();
    }
    if (taskQuery.status !== "all") {
      params.status = taskQuery.status;
    }
    if (taskQuery.dateRange) {
      params.start = toUtcIsoString(dayjs(taskQuery.dateRange[0]).startOf("day"));
      params.end = toUtcIsoString(dayjs(taskQuery.dateRange[1]).endOf("day"));
    }

    return params;
  }, [taskQuery]);

  const errorApiParams = useMemo(() => {
    const params: Record<string, string | number> = {
      page: errorsQuery.page,
      pageSize: errorsQuery.pageSize,
    };

    if (errorsQuery.kind !== "all") {
      params.kind = errorsQuery.kind;
    }
    if (errorsQuery.operationName.trim()) {
      params.operationName = errorsQuery.operationName.trim();
    }
    if (errorsQuery.messageContains.trim()) {
      params.messageContains = errorsQuery.messageContains.trim();
    }
    if (errorsQuery.dateRange) {
      params.start = toUtcIsoString(dayjs(errorsQuery.dateRange[0]).startOf("day"));
      params.end = toUtcIsoString(dayjs(errorsQuery.dateRange[1]).endOf("day"));
    }

    return params;
  }, [errorsQuery]);

  const auditApiParams = useMemo(() => {
    const params: Record<string, string | number> = {
      page: auditQuery.page,
      pageSize: auditQuery.pageSize,
    };

    if (auditQuery.search.trim()) {
      params.search = auditQuery.search.trim();
    }
    if (auditQuery.resource.trim()) {
      params.resource = auditQuery.resource.trim();
    }
    if (auditQuery.action.trim()) {
      params.action = auditQuery.action.trim();
    }
    if (auditQuery.dateRange) {
      params.start = toUtcIsoString(dayjs(auditQuery.dateRange[0]).startOf("day"));
      params.end = toUtcIsoString(dayjs(auditQuery.dateRange[1]).endOf("day"));
    }

    return params;
  }, [auditQuery]);

  const loadTaskData = useCallback(async () => {
    setTaskLoading(true);
    setTaskErrorMessage(null);
    try {
      const summaryParams = { ...taskApiParams };
      delete summaryParams.page;
      delete summaryParams.pageSize;

      const [listResponse, summaryResponse] = await Promise.all([
        apiClient.get<PaginatedResponse<TaskLogRecord>>("admin/logs/task", {
          params: taskApiParams,
        }),
        apiClient.get<TaskLogsSummary>("admin/logs/task/summary", {
          params: summaryParams,
        }),
      ]);

      setTaskRows(listResponse.data ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0, items: [] });
      setTaskSummary(summaryResponse.data ?? null);
    } catch (error) {
      captureClientError("Failed to load unified task logs", error);
      setTaskErrorMessage(
        t("adminLogs.task.errors.loadFailed", {
          defaultValue: "Failed to load task logs.",
        }),
      );
      setTaskSummary(null);
    } finally {
      setTaskLoading(false);
    }
  }, [apiClient, taskApiParams, t]);

  const loadErrorsData = useCallback(async () => {
    setErrorsLoading(true);
    setErrorsErrorMessage(null);
    try {
      const summaryParams = { ...errorApiParams };
      delete summaryParams.page;
      delete summaryParams.pageSize;

      const [listResponse, summaryResponse] = await Promise.all([
        apiClient.get<PaginatedResponse<ExceptionEvent>>("admin/logs/errors", {
          params: errorApiParams,
        }),
        apiClient.get<ExceptionEventStats>("admin/logs/errors/summary", {
          params: summaryParams,
        }),
      ]);

      setErrorRows(listResponse.data ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0, items: [] });
      setErrorSummary(summaryResponse.data ?? null);
    } catch (error) {
      captureClientError("Failed to load unified error logs", error);
      setErrorsErrorMessage(
        t("adminLogs.errors.loadFailed", {
          defaultValue: "Failed to load error events.",
        }),
      );
      setErrorSummary(null);
    } finally {
      setErrorsLoading(false);
    }
  }, [apiClient, errorApiParams, t]);

  const loadAuditData = useCallback(async () => {
    setAuditLoading(true);
    setAuditErrorMessage(null);
    try {
      const response = await apiClient.get<PaginatedResponse<AuditLogEntry>>("admin/logs/audit", {
        params: auditApiParams,
      });
      setAuditRows(response.data ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0, items: [] });
    } catch (error) {
      captureClientError("Failed to load unified audit logs", error);
      setAuditErrorMessage(
        t("adminLogs.audit.loadFailed", {
          defaultValue: "Failed to load audit logs.",
        }),
      );
    } finally {
      setAuditLoading(false);
    }
  }, [apiClient, auditApiParams, t]);

  useEffect(() => {
    if (canView && activeTab === "task") {
      void loadTaskData();
    }
  }, [activeTab, canView, loadTaskData, taskRefreshNonce]);

  useEffect(() => {
    if (canView && activeTab === "errors") {
      void loadErrorsData();
    }
  }, [activeTab, canView, errorsRefreshNonce, loadErrorsData]);

  useEffect(() => {
    if (canView && activeTab === "audit") {
      void loadAuditData();
    }
  }, [activeTab, auditRefreshNonce, canView, loadAuditData]);

  const taskStatusColors: Record<TaskLogStatus, string> = {
    pending: "gold",
    processing: "blue",
    completed: "green",
    failed: "red",
  };

  const errorCountsByKind = useMemo(() => {
    const map = new Map(errorSummary?.byKind?.map((item) => [item.kind, item.count]));
    return {
      total: errorSummary?.total ?? 0,
      http: map.get("http") ?? 0,
      graphql: map.get("graphql") ?? 0,
      unknown: map.get("unknown") ?? 0,
    };
  }, [errorSummary]);

  const taskColumns = useMemo<ColumnsType<TaskLogRecord>>(
    () => [
      {
        title: t("quality.taskLogs.columns.time", { defaultValue: "Time" }),
        dataIndex: "createdAt",
        key: "createdAt",
        width: 190,
        render: (value: string | null) =>
          value
            ? formatDateTime(value, locale, {
                dateStyle: "medium",
                timeStyle: "medium",
              })
            : t("common.emptyValue"),
      },
      {
        title: t("quality.taskLogs.columns.queue", { defaultValue: "Queue" }),
        dataIndex: "queue",
        key: "queue",
        width: 140,
        render: (value: string) => <Tag>{value}</Tag>,
      },
      {
        title: t("quality.taskLogs.columns.stage", { defaultValue: "Stage" }),
        dataIndex: "stage",
        key: "stage",
        width: 140,
        render: (value: string) => <Tag>{value}</Tag>,
      },
      {
        title: t("quality.taskLogs.columns.status", { defaultValue: "Status" }),
        dataIndex: "status",
        key: "status",
        width: 120,
        render: (value: TaskLogStatus) => <Tag color={taskStatusColors[value]}>{value}</Tag>,
      },
      {
        title: t("quality.taskLogs.columns.message", { defaultValue: "Message" }),
        dataIndex: "message",
        key: "message",
        render: (value: string | null | undefined) => (
          <Typography.Text ellipsis={{ tooltip: value ?? "-" }}>{value ?? "-"}</Typography.Text>
        ),
      },
      {
        title: t("quality.taskLogs.columns.jobId", { defaultValue: "Job" }),
        dataIndex: "jobId",
        key: "jobId",
        width: 220,
        render: (value: string) => (
          <Typography.Text code copyable ellipsis={{ tooltip: value }}>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: t("common.actions", { defaultValue: "Actions" }),
        key: "actions",
        width: 100,
        render: (_, record) => (
          <Button type="link" onClick={() => setDetailState({ tab: "task", record })}>
            {t("common.view", { defaultValue: "View" })}
          </Button>
        ),
      },
    ],
    [locale, t],
  );

  const errorColumns = useMemo<ColumnsType<ExceptionEvent>>(
    () => [
      {
        title: t("errors.columns.time", { defaultValue: "Time" }),
        dataIndex: "timestamp",
        key: "timestamp",
        width: 190,
        render: (value: string) =>
          value
            ? formatDateTime(value, locale, {
                dateStyle: "medium",
                timeStyle: "medium",
              })
            : t("common.emptyValue"),
      },
      {
        title: t("errors.columns.kind", { defaultValue: "Kind" }),
        dataIndex: "kind",
        key: "kind",
        width: 120,
        render: (value: ErrorKind) => renderKind(value, t),
      },
      {
        title: t("errors.columns.status", { defaultValue: "Status" }),
        dataIndex: "statusCode",
        key: "statusCode",
        width: 100,
        render: (value?: number) => (typeof value === "number" ? String(value) : t("common.emptyValue")),
      },
      {
        title: t("errors.columns.traceId", { defaultValue: "Trace ID" }),
        dataIndex: "traceId",
        key: "traceId",
        width: 240,
        render: (value: string) =>
          value ? (
            <Typography.Text code copyable ellipsis={{ tooltip: value }}>
              {value}
            </Typography.Text>
          ) : (
            t("common.emptyValue")
          ),
      },
      {
        title: t("errors.columns.location", { defaultValue: "Location" }),
        key: "location",
        render: (_, record) => <Typography.Text>{getLocation(record, t("common.emptyValue"))}</Typography.Text>,
      },
      {
        title: t("errors.columns.message", { defaultValue: "Message" }),
        dataIndex: "message",
        key: "message",
        render: (value: string) => (
          <Typography.Text ellipsis={{ tooltip: value || t("common.emptyValue") }}>
            {value || t("common.emptyValue")}
          </Typography.Text>
        ),
      },
      {
        title: t("common.actions", { defaultValue: "Actions" }),
        key: "actions",
        width: 100,
        render: (_, record) => (
          <Button type="link" onClick={() => setDetailState({ tab: "errors", record })}>
            {t("common.view", { defaultValue: "View" })}
          </Button>
        ),
      },
    ],
    [locale, t],
  );

  const auditColumns = useMemo<ColumnsType<AuditLogEntry>>(
    () => [
      {
        title: t("auditLogs.columns.time", { defaultValue: "Time" }),
        dataIndex: "createdAt",
        key: "createdAt",
        width: 190,
        render: (value: string) =>
          formatDateTime(value, locale, {
            dateStyle: "medium",
            timeStyle: "medium",
          }),
      },
      {
        title: t("auditLogs.columns.actor", { defaultValue: "Actor" }),
        dataIndex: "actorId",
        key: "actorId",
        width: 200,
        render: (value: string | null | undefined) => (
          <Typography.Text code>{value ?? t("auditLogs.systemActor", { defaultValue: "System" })}</Typography.Text>
        ),
      },
      {
        title: t("auditLogs.columns.resource", { defaultValue: "Resource" }),
        dataIndex: "resource",
        key: "resource",
        width: 160,
        render: (value: string) => <Tag>{value}</Tag>,
      },
      {
        title: t("auditLogs.columns.action", { defaultValue: "Action" }),
        dataIndex: "action",
        key: "action",
        width: 160,
        render: (value: string) => <Tag color="blue">{value}</Tag>,
      },
      {
        title: t("auditLogs.columns.ipAddress", { defaultValue: "IP Address" }),
        dataIndex: "ipAddress",
        key: "ipAddress",
        width: 160,
        render: (value: string | null | undefined) => value ?? t("common.emptyValue"),
      },
      {
        title: t("auditLogs.columns.metadata", { defaultValue: "Metadata" }),
        dataIndex: "metadata",
        key: "metadata",
        render: (value: unknown) => (
          <Typography.Text ellipsis={{ tooltip: formatJson(value, t("common.emptyValue")) }}>
            {formatJson(value, t("common.emptyValue"))}
          </Typography.Text>
        ),
      },
      {
        title: t("common.actions", { defaultValue: "Actions" }),
        key: "actions",
        width: 100,
        render: (_, record) => (
          <Button type="link" onClick={() => setDetailState({ tab: "audit", record })}>
            {t("common.view", { defaultValue: "View" })}
          </Button>
        ),
      },
    ],
    [locale, t],
  );

  const applyTaskFilters = () => {
    replaceTabQuery("task", TASK_QUERY_KEYS, {
      taskQueue: taskFilters.queue.trim() || undefined,
      taskJobId: taskFilters.jobId.trim() || undefined,
      taskStage: taskFilters.stage.trim() || undefined,
      taskStatus: taskFilters.status !== "all" ? taskFilters.status : undefined,
      ...serializeDateRange("task", taskFilters.dateRange),
      taskPage: DEFAULT_PAGE,
      taskPageSize: taskFilters.pageSize,
    });
  };

  const resetTaskFilters = () => {
    setTaskFilters({
      queue: "",
      jobId: "",
      stage: "",
      status: "all",
      dateRange: null,
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    replaceTabQuery("task", TASK_QUERY_KEYS, {});
  };

  const applyErrorsFilters = () => {
    replaceTabQuery("errors", ERROR_QUERY_KEYS, {
      errorKind: errorsFilters.kind !== "all" ? errorsFilters.kind : undefined,
      errorOperationName: errorsFilters.operationName.trim() || undefined,
      errorMessageContains: errorsFilters.messageContains.trim() || undefined,
      ...serializeDateRange("error", errorsFilters.dateRange),
      errorPage: DEFAULT_PAGE,
      errorPageSize: errorsFilters.pageSize,
    });
  };

  const resetErrorsFilters = () => {
    setErrorsFilters({
      kind: "all",
      operationName: "",
      messageContains: "",
      dateRange: null,
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    replaceTabQuery("errors", ERROR_QUERY_KEYS, {});
  };

  const applyAuditFilters = () => {
    replaceTabQuery("audit", AUDIT_QUERY_KEYS, {
      auditSearch: auditFilters.search.trim() || undefined,
      auditResource: auditFilters.resource.trim() || undefined,
      auditAction: auditFilters.action.trim() || undefined,
      ...serializeDateRange("audit", auditFilters.dateRange),
      auditPage: DEFAULT_PAGE,
      auditPageSize: auditFilters.pageSize,
    });
  };

  const resetAuditFilters = () => {
    setAuditFilters({
      search: "",
      resource: "",
      action: "",
      dateRange: null,
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    replaceTabQuery("audit", AUDIT_QUERY_KEYS, {});
  };

  const taskPagination = {
    current: taskRows.page,
    pageSize: taskRows.pageSize,
    total: taskRows.total,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    onChange: (page: number, pageSize: number) => {
      replaceTabQuery("task", TASK_QUERY_KEYS, {
        taskQueue: taskQuery.queue || undefined,
        taskJobId: taskQuery.jobId || undefined,
        taskStage: taskQuery.stage || undefined,
        taskStatus: taskQuery.status !== "all" ? taskQuery.status : undefined,
        ...serializeDateRange("task", taskQuery.dateRange),
        taskPage: page,
        taskPageSize: pageSize,
      });
    },
  };

  const errorsPagination = {
    current: errorRows.page,
    pageSize: errorRows.pageSize,
    total: errorRows.total,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    onChange: (page: number, pageSize: number) => {
      replaceTabQuery("errors", ERROR_QUERY_KEYS, {
        errorKind: errorsQuery.kind !== "all" ? errorsQuery.kind : undefined,
        errorOperationName: errorsQuery.operationName || undefined,
        errorMessageContains: errorsQuery.messageContains || undefined,
        ...serializeDateRange("error", errorsQuery.dateRange),
        errorPage: page,
        errorPageSize: pageSize,
      });
    },
  };

  const auditPagination = {
    current: auditRows.page,
    pageSize: auditRows.pageSize,
    total: auditRows.total,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    onChange: (page: number, pageSize: number) => {
      replaceTabQuery("audit", AUDIT_QUERY_KEYS, {
        auditSearch: auditQuery.search || undefined,
        auditResource: auditQuery.resource || undefined,
        auditAction: auditQuery.action || undefined,
        ...serializeDateRange("audit", auditQuery.dateRange),
        auditPage: page,
        auditPageSize: pageSize,
      });
    },
  };

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("adminLogs.title", { defaultValue: "Logs" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="content-card">
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t("adminLogs.title", { defaultValue: "Logs" })}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("adminLogs.description", {
              defaultValue: "Inspect task execution, application errors, and governance activity from one workspace.",
            })}
          </Typography.Paragraph>
        </Space>
      </Card>

      <Card className="content-card">
        <Tabs
          activeKey={activeTab}
          onChange={(nextTab) =>
            router.replace(
              buildAdminLogsTabSelectionHref(
                pathname,
                searchParams,
                resolveAdminLogsTabId(nextTab),
              ),
            )
          }
          items={[
            {
              key: "task",
              label: t("adminLogs.tabs.task", { defaultValue: "Task Logs" }),
              children: (
                <Space direction="vertical" size="large" style={{ width: "100%" }}>
                  <Space wrap size="middle">
                    <Input
                      value={taskFilters.queue}
                      onChange={(event) =>
                        setTaskFilters((previous) => ({ ...previous, queue: event.target.value }))
                      }
                      placeholder={t("quality.taskLogs.filters.queue", { defaultValue: "Queue (optional)" })}
                      style={{ width: 180 }}
                      allowClear
                    />
                    <Input
                      value={taskFilters.jobId}
                      onChange={(event) =>
                        setTaskFilters((previous) => ({ ...previous, jobId: event.target.value }))
                      }
                      placeholder={t("adminLogs.task.filters.jobId", { defaultValue: "Job ID (optional)" })}
                      style={{ width: 220 }}
                      allowClear
                    />
                    <Input
                      value={taskFilters.stage}
                      onChange={(event) =>
                        setTaskFilters((previous) => ({ ...previous, stage: event.target.value }))
                      }
                      placeholder={t("quality.taskLogs.filters.stage", { defaultValue: "Stage (optional)" })}
                      style={{ width: 180 }}
                      allowClear
                    />
                    <Select
                      value={taskFilters.status}
                      onChange={(value) =>
                        setTaskFilters((previous) => ({ ...previous, status: value }))
                      }
                      style={{ width: 180 }}
                      options={[
                        { value: "all", label: t("quality.taskLogs.filters.statusAll", { defaultValue: "All statuses" }) },
                        { value: "failed", label: t("quality.taskLogs.status.failed", { defaultValue: "failed" }) },
                        { value: "processing", label: t("quality.taskLogs.status.processing", { defaultValue: "processing" }) },
                        { value: "pending", label: t("quality.taskLogs.status.pending", { defaultValue: "pending" }) },
                        { value: "completed", label: t("quality.taskLogs.status.completed", { defaultValue: "completed" }) },
                      ]}
                    />
                    <RangePicker
                      value={taskFilters.dateRange}
                      onChange={(value) =>
                        setTaskFilters((previous) => ({
                          ...previous,
                          dateRange:
                            Array.isArray(value) && value[0] && value[1]
                              ? [value[0], value[1]]
                              : null,
                        }))
                      }
                      allowClear
                    />
                    <Button type="primary" onClick={applyTaskFilters}>
                      {t("common.search", { defaultValue: "Search" })}
                    </Button>
                    <Button onClick={resetTaskFilters}>{t("common.reset", { defaultValue: "Reset" })}</Button>
                    <Button onClick={() => setTaskRefreshNonce((value) => value + 1)} loading={taskLoading}>
                      {t("common.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </Space>

                  {taskSummary ? (
                    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                      <Row gutter={[16, 16]}>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.total", { defaultValue: "Total logs" })}
                            value={taskSummary.totals.total}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.pending", { defaultValue: "Pending" })}
                            value={taskSummary.totals.pending}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.processing", { defaultValue: "Processing" })}
                            value={taskSummary.totals.processing}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.completed", { defaultValue: "Completed" })}
                            value={taskSummary.totals.completed}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.failed", { defaultValue: "Failed" })}
                            value={taskSummary.totals.failed}
                            valueStyle={taskSummary.totals.failed > 0 ? { color: "#cf1322" } : undefined}
                          />
                        </Col>
                      </Row>
                      <Table
                        rowKey={(row) => `${row.queue}:${row.stage}:${row.errorName}`}
                        size="small"
                        pagination={{ pageSize: 5, showSizeChanger: false }}
                        columns={[
                          {
                            title: t("quality.taskLogs.summary.columns.queue", { defaultValue: "Queue" }),
                            dataIndex: "queue",
                            key: "queue",
                            render: (value: string) => <Tag>{value}</Tag>,
                          },
                          {
                            title: t("quality.taskLogs.summary.columns.stage", { defaultValue: "Stage" }),
                            dataIndex: "stage",
                            key: "stage",
                            render: (value: string) => <Tag>{value}</Tag>,
                          },
                          {
                            title: t("quality.taskLogs.summary.columns.error", { defaultValue: "Error" }),
                            dataIndex: "errorName",
                            key: "errorName",
                            render: (value: string) => <Tag color="red">{value}</Tag>,
                          },
                          {
                            title: t("quality.taskLogs.summary.columns.count", { defaultValue: "Count" }),
                            dataIndex: "count",
                            key: "count",
                            width: 120,
                          },
                          {
                            title: t("quality.taskLogs.summary.columns.sample", { defaultValue: "Sample" }),
                            dataIndex: "sampleMessage",
                            key: "sampleMessage",
                            render: (value: string | null) => (
                              <Typography.Text type="secondary" ellipsis={{ tooltip: value ?? "-" }}>
                                {value ?? "-"}
                              </Typography.Text>
                            ),
                          },
                        ]}
                        dataSource={taskSummary.topErrors}
                        locale={{
                          emptyText: t("adminLogs.task.summary.empty", {
                            defaultValue: "No top errors for the current filter.",
                          }),
                        }}
                      />
                    </Space>
                  ) : null}

                  {taskErrorMessage ? <Alert type="error" message={taskErrorMessage} showIcon /> : null}
                  <Table
                    rowKey="id"
                    loading={taskLoading}
                    columns={taskColumns}
                    dataSource={taskRows.items}
                    pagination={taskPagination}
                    scroll={{ x: 1200 }}
                    locale={{ emptyText: <Empty description={t("common.empty", { defaultValue: "No data" })} /> }}
                  />
                </Space>
              ),
            },
            {
              key: "errors",
              label: t("adminLogs.tabs.errors", { defaultValue: "Errors" }),
              children: (
                <Space direction="vertical" size="large" style={{ width: "100%" }}>
                  <Space wrap size="middle">
                    <Select
                      value={errorsFilters.kind}
                      onChange={(value) =>
                        setErrorsFilters((previous) => ({ ...previous, kind: value }))
                      }
                      style={{ width: 180 }}
                      options={[
                        { value: "all", label: t("errors.filters.kindAll", { defaultValue: "All kinds" }) },
                        { value: "http", label: t("errors.kinds.http", { defaultValue: "HTTP" }) },
                        { value: "graphql", label: t("errors.kinds.graphql", { defaultValue: "GraphQL" }) },
                        { value: "unknown", label: t("errors.kinds.unknown", { defaultValue: "Unknown" }) },
                      ]}
                    />
                    <Input
                      value={errorsFilters.operationName}
                      onChange={(event) =>
                        setErrorsFilters((previous) => ({ ...previous, operationName: event.target.value }))
                      }
                      placeholder={t("adminLogs.errors.filters.operationName", { defaultValue: "Operation name" })}
                      style={{ width: 220 }}
                      allowClear
                    />
                    <Input
                      value={errorsFilters.messageContains}
                      onChange={(event) =>
                        setErrorsFilters((previous) => ({ ...previous, messageContains: event.target.value }))
                      }
                      placeholder={t("adminLogs.errors.filters.message", { defaultValue: "Message contains" })}
                      style={{ width: 220 }}
                      allowClear
                    />
                    <RangePicker
                      value={errorsFilters.dateRange}
                      onChange={(value) =>
                        setErrorsFilters((previous) => ({
                          ...previous,
                          dateRange:
                            Array.isArray(value) && value[0] && value[1]
                              ? [value[0], value[1]]
                              : null,
                        }))
                      }
                      allowClear
                    />
                    <Button type="primary" onClick={applyErrorsFilters}>
                      {t("common.search", { defaultValue: "Search" })}
                    </Button>
                    <Button onClick={resetErrorsFilters}>{t("common.reset", { defaultValue: "Reset" })}</Button>
                    <Button onClick={() => setErrorsRefreshNonce((value) => value + 1)} loading={errorsLoading}>
                      {t("common.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </Space>

                  {errorSummary ? (
                    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                      <Row gutter={[16, 16]}>
                        <Col xs={12} md={6}>
                          <Statistic title={t("errors.stats.total", { defaultValue: "Total" })} value={errorCountsByKind.total} />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic title={t("errors.stats.http", { defaultValue: "HTTP" })} value={errorCountsByKind.http} />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic title={t("errors.stats.graphql", { defaultValue: "GraphQL" })} value={errorCountsByKind.graphql} />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic title={t("errors.stats.unknown", { defaultValue: "Unknown" })} value={errorCountsByKind.unknown} />
                        </Col>
                      </Row>
                      <Table
                        rowKey={(row) => row.date}
                        size="small"
                        pagination={false}
                        columns={[
                          {
                            title: t("errors.stats.date", { defaultValue: "Date" }),
                            dataIndex: "date",
                            key: "date",
                            render: (value: string) =>
                              formatDateTime(`${value}T00:00:00Z`, locale, {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                              }),
                          },
                          {
                            title: t("errors.stats.count", { defaultValue: "Count" }),
                            dataIndex: "count",
                            key: "count",
                          },
                        ]}
                        dataSource={errorSummary.byDay}
                        locale={{
                          emptyText: t("errors.stats.empty", { defaultValue: "No error statistics." }),
                        }}
                      />
                    </Space>
                  ) : null}

                  {errorsErrorMessage ? <Alert type="error" message={errorsErrorMessage} showIcon /> : null}
                  <Table
                    rowKey="id"
                    loading={errorsLoading}
                    columns={errorColumns}
                    dataSource={errorRows.items}
                    pagination={errorsPagination}
                    scroll={{ x: 1200 }}
                    locale={{ emptyText: <Empty description={t("common.empty", { defaultValue: "No data" })} /> }}
                  />
                </Space>
              ),
            },
            {
              key: "audit",
              label: t("adminLogs.tabs.audit", { defaultValue: "Audit" }),
              children: (
                <Space direction="vertical" size="large" style={{ width: "100%" }}>
                  <Space wrap size="middle">
                    <Input
                      value={auditFilters.search}
                      onChange={(event) =>
                        setAuditFilters((previous) => ({ ...previous, search: event.target.value }))
                      }
                      placeholder={t("auditLogs.searchPlaceholder", { defaultValue: "Search logs" })}
                      style={{ width: 220 }}
                      allowClear
                    />
                    <Input
                      value={auditFilters.resource}
                      onChange={(event) =>
                        setAuditFilters((previous) => ({ ...previous, resource: event.target.value }))
                      }
                      placeholder={t("adminLogs.audit.filters.resource", { defaultValue: "Resource" })}
                      style={{ width: 180 }}
                      allowClear
                    />
                    <Input
                      value={auditFilters.action}
                      onChange={(event) =>
                        setAuditFilters((previous) => ({ ...previous, action: event.target.value }))
                      }
                      placeholder={t("adminLogs.audit.filters.action", { defaultValue: "Action" })}
                      style={{ width: 180 }}
                      allowClear
                    />
                    <RangePicker
                      value={auditFilters.dateRange}
                      onChange={(value) =>
                        setAuditFilters((previous) => ({
                          ...previous,
                          dateRange:
                            Array.isArray(value) && value[0] && value[1]
                              ? [value[0], value[1]]
                              : null,
                        }))
                      }
                      allowClear
                    />
                    <Button type="primary" onClick={applyAuditFilters}>
                      {t("common.search", { defaultValue: "Search" })}
                    </Button>
                    <Button onClick={resetAuditFilters}>{t("common.reset", { defaultValue: "Reset" })}</Button>
                    <Button onClick={() => setAuditRefreshNonce((value) => value + 1)} loading={auditLoading}>
                      {t("common.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </Space>

                  {auditErrorMessage ? <Alert type="error" message={auditErrorMessage} showIcon /> : null}
                  <Table
                    rowKey="id"
                    loading={auditLoading}
                    columns={auditColumns}
                    dataSource={auditRows.items}
                    pagination={auditPagination}
                    scroll={{ x: 1200 }}
                    locale={{ emptyText: <Empty description={t("common.empty", { defaultValue: "No data" })} /> }}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        open={Boolean(detailState)}
        onClose={() => setDetailState(null)}
        width={720}
        title={
          detailState?.tab === "task"
            ? t("adminLogs.task.detail.title", { defaultValue: "Task log details" })
            : detailState?.tab === "errors"
              ? t("adminLogs.errors.detail.title", { defaultValue: "Error event details" })
              : t("adminLogs.audit.detail.title", { defaultValue: "Audit log details" })
        }
      >
        {detailState?.tab === "task" ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t("quality.taskLogs.columns.queue", { defaultValue: "Queue" })}>
                {detailState.record.queue}
              </Descriptions.Item>
              <Descriptions.Item label={t("quality.taskLogs.columns.stage", { defaultValue: "Stage" })}>
                {detailState.record.stage}
              </Descriptions.Item>
              <Descriptions.Item label={t("quality.taskLogs.columns.status", { defaultValue: "Status" })}>
                <Tag color={taskStatusColors[detailState.record.status]}>{detailState.record.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t("quality.taskLogs.columns.jobId", { defaultValue: "Job" })}>
                <Typography.Text code copyable>
                  {detailState.record.jobId}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t("quality.taskLogs.columns.time", { defaultValue: "Time" })}>
                {detailState.record.createdAt
                  ? formatDateTime(detailState.record.createdAt, locale, {
                      dateStyle: "full",
                      timeStyle: "long",
                    })
                  : t("common.emptyValue")}
              </Descriptions.Item>
              <Descriptions.Item label={t("adminLogs.task.detail.updatedAt", { defaultValue: "Updated At" })}>
                {detailState.record.updatedAt
                  ? formatDateTime(detailState.record.updatedAt, locale, {
                      dateStyle: "full",
                      timeStyle: "long",
                    })
                  : t("common.emptyValue")}
              </Descriptions.Item>
              <Descriptions.Item label={t("quality.taskLogs.columns.message", { defaultValue: "Message" })}>
                <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                  {detailState.record.message ?? t("common.emptyValue")}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            <div>
              <Typography.Title level={5}>
                {t("adminLogs.task.detail.data", { defaultValue: "Data" })}
              </Typography.Title>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {formatJson(detailState.record.data, t("common.emptyValue"))}
              </pre>
            </div>
            <div>
              <Typography.Title level={5}>
                {t("adminLogs.task.detail.error", { defaultValue: "Error" })}
              </Typography.Title>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {formatJson(detailState.record.error, t("common.emptyValue"))}
              </pre>
            </div>
          </Space>
        ) : null}

        {detailState?.tab === "errors" ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t("errors.columns.kind", { defaultValue: "Kind" })}>
                {renderKind(detailState.record.kind, t)}
              </Descriptions.Item>
              <Descriptions.Item label={t("errors.columns.time", { defaultValue: "Time" })}>
                {formatDateTime(detailState.record.timestamp, locale, {
                  dateStyle: "full",
                  timeStyle: "long",
                })}
              </Descriptions.Item>
              <Descriptions.Item label={t("errors.columns.traceId", { defaultValue: "Trace ID" })}>
                {detailState.record.traceId ? (
                  <Typography.Text code copyable>
                    {detailState.record.traceId}
                  </Typography.Text>
                ) : (
                  t("common.emptyValue")
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t("errors.columns.location", { defaultValue: "Location" })}>
                {getLocation(detailState.record, t("common.emptyValue"))}
              </Descriptions.Item>
              <Descriptions.Item label={t("errors.columns.message", { defaultValue: "Message" })}>
                <Typography.Text style={{ whiteSpace: "pre-wrap" }}>{detailState.record.message}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t("adminLogs.errors.detail.errorName", { defaultValue: "Error Name" })}>
                {detailState.record.errorName ?? t("common.emptyValue")}
              </Descriptions.Item>
            </Descriptions>
            <div>
              <Typography.Title level={5}>
                {t("adminLogs.errors.detail.stack", { defaultValue: "Stack" })}
              </Typography.Title>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {detailState.record.stack ?? t("errors.noStack", { defaultValue: "No stack trace available." })}
              </pre>
            </div>
          </Space>
        ) : null}

        {detailState?.tab === "audit" ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t("auditLogs.columns.time", { defaultValue: "Time" })}>
                {formatDateTime(detailState.record.createdAt, locale, {
                  dateStyle: "full",
                  timeStyle: "long",
                })}
              </Descriptions.Item>
              <Descriptions.Item label={t("auditLogs.columns.actor", { defaultValue: "Actor" })}>
                <Typography.Text code>
                  {detailState.record.actorId ?? t("auditLogs.systemActor", { defaultValue: "System" })}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t("auditLogs.columns.resource", { defaultValue: "Resource" })}>
                <Tag>{detailState.record.resource}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t("auditLogs.columns.action", { defaultValue: "Action" })}>
                <Tag color="blue">{detailState.record.action}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t("auditLogs.columns.ipAddress", { defaultValue: "IP Address" })}>
                {detailState.record.ipAddress ?? t("common.emptyValue")}
              </Descriptions.Item>
            </Descriptions>
            <div>
              <Typography.Title level={5}>
                {t("auditLogs.columns.metadata", { defaultValue: "Metadata" })}
              </Typography.Title>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {formatJson(detailState.record.metadata, t("common.emptyValue"))}
              </pre>
            </div>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
