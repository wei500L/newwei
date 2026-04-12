"use client";

import {
  DashboardOutlined,
  GlobalOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  CRAWL4AI_LLM_OPTION_GUARD_MESSAGE,
  assertNoCrawl4aiLlmOptions,
  sanitizeCrawlOptions,
} from "@modular/utils";
import {
  App,
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
  Space,
  Table,
  Tag,
  Typography,
  List,
  Grid,
  Row,
  Col,
  Switch,
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import type {
  CrawlMetadataInput,
  CrawlOptionsInput,
  CrawlTaskStatus,
  CrawlTasksQuery,
  UpdateCrawlClientSettingsMutationVariables,
} from "@/graphql/generated";
import {
  CrawlAntiBotMode,
  CrawlWaitUntil,
  useCreateCrawlTaskMutation,
  useCrawlClientSettingsQuery,
  useCrawlMetadataLazyQuery,
  useCrawlTasksLazyQuery,
  useRetryCrawlTaskMutation,
  useUpdateCrawlClientSettingsMutation,
} from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { normalizeHeadlessModeFormValues } from "@/lib/crawl-headless-mode";
import { getCrawlTasksOpsRefreshDecision } from "@/lib/crawl-ops-refresh";
import { findUnsupportedProxyIssues } from "@/lib/crawl-config-policy";
import { env } from "@/lib/env";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import { Crawl4aiHealthCard } from "./components/Crawl4aiHealthCard";
import { CreateCrawlTaskDrawer } from "./components/CreateCrawlTaskDrawer";
import { MetadataExtractionCard } from "./components/MetadataExtractionCard";
import type { CreateCrawlTaskFormValues, MetadataFormValues } from "./types";

const statusColors: Record<CrawlTaskStatus, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple",
};
const MIN_CRAWL_REQUEST_TIMEOUT_MS = 5_000;
const MAX_CRAWL_REQUEST_TIMEOUT_MS = 900_000;
const MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS = 500;
const MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS = 10_000;
const MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY = 1;
const MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY = 8;
const MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES = 1_048_576;
const MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES = 64_000_000;

function safeParseJson<T>(input?: string | null): T | null {
  if (!input) {
    return null;
  }
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function toCrawlWaitUntilInput(
  value?: string | null,
): CrawlWaitUntil | undefined {
  if (value === "domcontentloaded") {
    return CrawlWaitUntil.Domcontentloaded;
  }
  if (value === "load") {
    return CrawlWaitUntil.Load;
  }
  if (value === "networkidle") {
    return CrawlWaitUntil.Networkidle;
  }
  if (value === "commit") {
    return CrawlWaitUntil.Commit;
  }
  return undefined;
}

function toCrawlAntiBotModeInput(
  value?: string | null,
): CrawlAntiBotMode | undefined {
  if (value === "auto") {
    return CrawlAntiBotMode.Auto;
  }
  if (value === "enabled") {
    return CrawlAntiBotMode.Enabled;
  }
  if (value === "disabled") {
    return CrawlAntiBotMode.Disabled;
  }
  return undefined;
}

function toGraphqlCrawlOptionsInput(
  options: ReturnType<typeof sanitizeCrawlOptions>,
): CrawlOptionsInput {
  return {
    ...options,
    antiBotMode: toCrawlAntiBotModeInput(options.antiBotMode),
    waitUntil: toCrawlWaitUntilInput(options.waitUntil),
    multiUrlConfigs: options.multiUrlConfigs?.map((config) => ({
      ...config,
      options: config.options
        ? {
            ...config.options,
            waitUntil: toCrawlWaitUntilInput(config.options.waitUntil),
          }
        : config.options,
    })),
  };
}

function normalizeCreateFormValues(
  values: CreateCrawlTaskFormValues,
): CreateCrawlTaskFormValues {
  return normalizeHeadlessModeFormValues(values);
}

type CrawlTaskQualityProfile = "quality_first" | "balanced" | "speed_first";
type CrawlTaskPageTypeHint = "auto" | "list" | "detail";
type CrawlTaskAntiBotMode = "auto" | "enabled" | "disabled";

interface CrawlTaskConfigSummary {
  ingestToItems: boolean;
  scanFullPage: boolean;
  hasVirtualScroll: boolean;
  qualityProfile: CrawlTaskQualityProfile | null;
  pageTypeHint: CrawlTaskPageTypeHint | null;
  antiBotMode: CrawlTaskAntiBotMode | null;
  autoExpandDetails: boolean;
}

interface CrawlQueueOpsStats {
  queueName: string;
  legacyQueueName?: string;
  queueMode?: string;
  queueNames?: {
    hot: string;
    normal: string;
  };
  updatedAt: string;
  pending: number;
  paused: boolean;
  counts: Record<string, number>;
  maxConcurrency: number;
  effectiveConcurrency: number;
  queues?: {
    hot?: {
      queueName: string;
      pending: number;
      paused: boolean;
      counts: Record<string, number>;
      effectiveConcurrency: number;
    };
    normal?: {
      queueName: string;
      pending: number;
      paused: boolean;
      counts: Record<string, number>;
      effectiveConcurrency: number;
    };
  };
  adaptive?: {
    enabled: boolean;
    lastDecision: string;
    currentMaxConcurrency?: number;
    lastAdjustedAt?: string | null;
    reason?: string | null;
    windowMinutes?: number;
    cooldownMinutes?: number;
    thresholds?: {
      latencyRatio: number;
      errorRate: number;
      memoryHeadroom: number;
    };
    metrics?: {
      taskCount: number;
      failedCount: number;
      errorRate: number;
      p95LatencyMs: number | null;
      memoryHeadroom: number | null;
      memorySampleCount: number;
      latencySampleCount: number;
      samplingMode: "recent_sample";
    };
  };
}

interface BatchUpdateFrequencyResponse {
  frequencySeconds: number;
  updatedCount: number;
  activeRescheduledCount: number;
  nextRunAt: string;
}

function parseCrawlTaskConfigSummary(
  rawConfig?: string | null,
): CrawlTaskConfigSummary | null {
  const config = safeParseJson<Record<string, unknown>>(rawConfig);
  if (!config) {
    return null;
  }
  const qualityProfileRaw =
    typeof config.qualityProfile === "string"
      ? config.qualityProfile.trim().toLowerCase()
      : "";
  const qualityProfile: CrawlTaskQualityProfile | null =
    qualityProfileRaw === "quality_first" ||
    qualityProfileRaw === "balanced" ||
    qualityProfileRaw === "speed_first"
      ? qualityProfileRaw
      : null;

  const pageTypeHintRaw =
    typeof config.pageTypeHint === "string"
      ? config.pageTypeHint.trim().toLowerCase()
      : "";
  const pageTypeHint: CrawlTaskPageTypeHint | null =
    pageTypeHintRaw === "auto" ||
    pageTypeHintRaw === "list" ||
    pageTypeHintRaw === "detail"
      ? pageTypeHintRaw
      : null;

  const antiBotModeRaw =
    typeof config.antiBotMode === "string"
      ? config.antiBotMode.trim().toLowerCase()
      : "";
  const antiBotMode: CrawlTaskAntiBotMode | null =
    antiBotModeRaw === "auto" ||
    antiBotModeRaw === "enabled" ||
    antiBotModeRaw === "disabled"
      ? antiBotModeRaw
      : null;

  return {
    ingestToItems: Boolean(config.ingestToItems),
    scanFullPage: Boolean(config.scanFullPage),
    hasVirtualScroll: Boolean(
      config.virtualScroll &&
        typeof config.virtualScroll === "object" &&
        !Array.isArray(config.virtualScroll),
    ),
    qualityProfile,
    pageTypeHint,
    antiBotMode,
    autoExpandDetails: Boolean(config.autoExpandDetails),
  };
}

export function CrawlTasksView() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const searchParams = useSearchParams();
  const router = useRouter();
  const sourceIdFilter = (searchParams.get("sourceId") ?? "").trim();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const canManageSettings = permissions.includes("settings.manage");
  const canManageQueueOps = canManageSettings;
  const canWriteItems = permissions.includes("items.write");
  const screens = Grid.useBreakpoint();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const appliedSourceFilterRef = useRef<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CrawlTaskStatus | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateCrawlTaskFormValues>();
  const [metadataForm] = Form.useForm<MetadataFormValues>();
  const [clientSettingsForm] =
    Form.useForm<UpdateCrawlClientSettingsMutationVariables["input"]>();
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 10,
  });
  const [queueStats, setQueueStats] = useState<CrawlQueueOpsStats | null>(null);
  const [queueStatsLoading, setQueueStatsLoading] = useState(false);
  const [queueActionLoading, setQueueActionLoading] = useState<
    "pause" | "resume" | "concurrency" | null
  >(null);
  const [maxConcurrencyInput, setMaxConcurrencyInput] = useState<number>(3);
  const [batchFrequencySeconds, setBatchFrequencySeconds] =
    useState<number>(3600);
  const [batchFrequencyLoading, setBatchFrequencyLoading] = useState(false);

  const pageSize = pagination.pageSize ?? 10;
  const current = pagination.current ?? 1;

  type CrawlTaskEdge = CrawlTasksQuery["crawlTasks"]["edges"][number];
  type CrawlTaskNode = CrawlTaskEdge["node"];

  const [fetchTasks] = useCrawlTasksLazyQuery({
    fetchPolicy: "no-cache",
  });

  const [taskEdges, setTaskEdges] = useState<CrawlTaskEdge[]>([]);
  const taskEdgesRef = useRef<CrawlTaskEdge[]>([]);
  const [pageInfo, setPageInfo] = useState<{
    hasNextPage: boolean;
    endCursor: string | null;
  }>({
    hasNextPage: true,
    endCursor: null,
  });
  const pageInfoRef = useRef(pageInfo);
  const [totalCount, setTotalCount] = useState<number>(0);
  const totalCountRef = useRef(0);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const ensureLoadingRef = useRef(false);
  const opsSocketRef = useRef<Socket | null>(null);
  const opsSocketBootstrappingRef = useRef(false);
  const opsRefreshTimerRef = useRef<number | null>(null);
  const pendingOpsRefreshRef = useRef({ tasks: false, queue: false });
  const [opsLiveStatus, setOpsLiveStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const currentPageRef = useRef(current);

  const [createTask, { loading: creating }] = useCreateCrawlTaskMutation();
  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();
  const {
    data: crawlClientSettingsData,
    loading: crawlClientSettingsLoading,
    refetch: refetchCrawlClientSettings,
  } = useCrawlClientSettingsQuery({
    fetchPolicy: "no-cache",
    skip: !canManageSettings,
  });
  const [updateCrawlClientSettings, { loading: crawlClientSettingsSaving }] =
    useUpdateCrawlClientSettingsMutation();
  const conditionalRequestEnabled =
    Form.useWatch("conditionalRequestEnabled", clientSettingsForm) ??
    crawlClientSettingsData?.crawlClientSettings?.conditionalRequestEnabled ??
    true;
  const adaptiveConcurrencyEnabled =
    Form.useWatch("adaptiveConcurrencyEnabled", clientSettingsForm) ??
    crawlClientSettingsData?.crawlClientSettings?.adaptiveConcurrencyEnabled ??
    false;
  const [fetchMetadata, { loading: metadataLoading, data: metadataData }] =
    useCrawlMetadataLazyQuery({
      fetchPolicy: "no-cache",
    });
  const metadataResults = metadataData?.crawlMetadata ?? [];

  const tableData = useMemo(() => {
    const start = (current - 1) * pageSize;
    return taskEdges.map((edge) => edge.node).slice(start, start + pageSize);
  }, [current, pageSize, taskEdges]);

  const queryKey = useMemo(
    () => JSON.stringify({ search, statusFilter, pageSize }),
    [pageSize, search, statusFilter],
  );
  const queryKeyRef = useRef(queryKey);
  const pendingEnsureRef = useRef<{
    targetPage: number;
    force: boolean;
    silent: boolean;
    queryKey: string;
  } | null>(null);

  useEffect(() => {
    taskEdgesRef.current = taskEdges;
  }, [taskEdges]);

  useEffect(() => {
    pageInfoRef.current = pageInfo;
  }, [pageInfo]);

  useEffect(() => {
    queryKeyRef.current = queryKey;
  }, [queryKey]);

  useEffect(() => {
    totalCountRef.current = totalCount;
  }, [totalCount]);

  useEffect(() => {
    currentPageRef.current = current;
  }, [current]);

  useEffect(() => {
    if (!crawlClientSettingsData?.crawlClientSettings) {
      return;
    }
    clientSettingsForm.setFieldsValue(
      crawlClientSettingsData.crawlClientSettings,
    );
  }, [clientSettingsForm, crawlClientSettingsData?.crawlClientSettings]);

  const loadQueueStats = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!canView) {
        return;
      }
      if (!options?.silent) {
        setQueueStatsLoading(true);
      }
      try {
        const response = await apiClient.get<CrawlQueueOpsStats>(
          "admin/crawl4ai/queue",
        );
        setQueueStats(response.data);
        if (
          typeof response.data.maxConcurrency === "number" &&
          Number.isFinite(response.data.maxConcurrency)
        ) {
          setMaxConcurrencyInput(response.data.maxConcurrency);
        }
      } catch (error: unknown) {
        if (!options?.silent) {
          message.error(
            (error as Error).message ??
              t("common.failed", { defaultValue: "Failed" }),
          );
        }
      } finally {
        if (!options?.silent) {
          setQueueStatsLoading(false);
        }
      }
    },
    [apiClient, canView, message, t],
  );

  useEffect(() => {
    void loadQueueStats();
  }, [loadQueueStats]);

  const resetTaskCache = useCallback(() => {
    taskEdgesRef.current = [];
    pageInfoRef.current = { hasNextPage: true, endCursor: null };
    totalCountRef.current = 0;
    pendingEnsureRef.current = null;
    setTaskEdges([]);
    setPageInfo({ hasNextPage: true, endCursor: null });
    setTotalCount(0);
    setTasksError(null);
  }, []);

  useEffect(() => {
    if (!canView) {
      return;
    }

    // Reset cursor pagination any time the query changes.
    resetTaskCache();
    setPagination((prev) => ({ ...prev, current: 1 }));
  }, [canView, queryKey, resetTaskCache]);

  const ensureTasksLoaded = useCallback(
    async (
      targetPage: number,
      options?: { force?: boolean; silent?: boolean },
    ) => {
      if (!canView) {
        return;
      }

      const requestQueryKey = queryKey;
      const required = Math.max(1, targetPage) * pageSize;
      if (!options?.force && taskEdgesRef.current.length >= required) {
        return;
      }

      // If we already know there is no next page and we have at least one page loaded, stop.
      if (
        !options?.force &&
        taskEdgesRef.current.length > 0 &&
        !pageInfoRef.current.hasNextPage
      ) {
        return;
      }

      if (ensureLoadingRef.current) {
        const pending = pendingEnsureRef.current;
        const nextRequest = {
          targetPage,
          force: Boolean(options?.force),
          silent: Boolean(options?.silent),
          queryKey: requestQueryKey,
        };
        if (!pending || pending.queryKey !== requestQueryKey) {
          pendingEnsureRef.current = nextRequest;
        } else {
          pendingEnsureRef.current = {
            targetPage: Math.max(pending.targetPage, nextRequest.targetPage),
            force: pending.force || nextRequest.force,
            silent: pending.silent && nextRequest.silent,
            queryKey: requestQueryKey,
          };
        }
        return;
      }

      ensureLoadingRef.current = true;
      if (!options?.silent) {
        setTasksLoading(true);
        setTasksError(null);
      }
      try {
        let nextEdges = options?.force ? [] : taskEdgesRef.current;
        let after = options?.force ? null : pageInfoRef.current.endCursor;
        let hasNext = options?.force ? true : pageInfoRef.current.hasNextPage;
        let nextTotal = totalCountRef.current;

        if (nextEdges.length === 0) {
          // First page always starts from the beginning (after=null).
          after = null;
          hasNext = true;
        }

        while (
          nextEdges.length < required &&
          (nextEdges.length === 0 || hasNext)
        ) {
          const result = await fetchTasks({
            variables: {
              first: pageSize,
              after,
              search: search ? search : null,
              status: statusFilter ?? null,
            },
          });

          const connection = result.data?.crawlTasks ?? null;
          if (!connection) {
            break;
          }

          // Defensive de-dupe in case of overlapping cursors or non-deterministic ordering.
          const existingIds = new Set(nextEdges.map((edge) => edge.node.id));
          const incomingEdges = connection.edges.filter(
            (edge) => !existingIds.has(edge.node.id),
          );
          nextEdges = nextEdges.concat(incomingEdges);

          after = connection.pageInfo.endCursor ?? null;
          hasNext = Boolean(connection.pageInfo.hasNextPage);
          nextTotal = connection.totalCount ?? nextTotal;

          if (!after && hasNext) {
            // Shouldn't happen, but avoid infinite loops if the server sends an inconsistent pageInfo.
            break;
          }
        }

        if (queryKeyRef.current !== requestQueryKey) {
          return;
        }

        taskEdgesRef.current = nextEdges;
        pageInfoRef.current = {
          hasNextPage: hasNext,
          endCursor: after ?? null,
        };

        setTasksError(null);
        setTaskEdges(nextEdges);
        setPageInfo(pageInfoRef.current);
        totalCountRef.current = nextTotal;
        setTotalCount(nextTotal);
      } catch (error: unknown) {
        if (!options?.silent) {
          setTasksError(
            (error as Error).message ??
              t("common.failed", { defaultValue: "Failed" }),
          );
        }
      } finally {
        ensureLoadingRef.current = false;
        if (!options?.silent) {
          setTasksLoading(false);
        }
        const pending = pendingEnsureRef.current;
        pendingEnsureRef.current = null;
        if (pending) {
          void ensureTasksLoaded(pending.targetPage, {
            force: pending.force,
            silent: pending.silent,
          });
        }
      }
    },
    [canView, fetchTasks, pageSize, queryKey, search, statusFilter, t],
  );

  useEffect(() => {
    void ensureTasksLoaded(current);
  }, [current, ensureTasksLoaded]);

  const reloadTasks = useCallback(
    async (options?: { preservePage?: boolean; silent?: boolean }) => {
      const targetPage = options?.preservePage ? currentPageRef.current : 1;
      if (!options?.preservePage) {
        setPagination((prev) => ({ ...prev, current: 1 }));
      }
      await ensureTasksLoaded(targetPage, {
        force: true,
        silent: options?.silent,
      });
      if (options?.preservePage) {
        const maxPage = Math.max(
          1,
          Math.ceil(totalCountRef.current / pageSize),
        );
        if (currentPageRef.current > maxPage) {
          setPagination((prev) => ({ ...prev, current: maxPage }));
        }
      }
    },
    [ensureTasksLoaded, pageSize],
  );

  const scheduleOpsRefresh = useCallback(
    (options?: { tasks?: boolean; queue?: boolean }) => {
      if (!canView) {
        return;
      }
      pendingOpsRefreshRef.current.tasks =
        pendingOpsRefreshRef.current.tasks || options?.tasks !== false;
      pendingOpsRefreshRef.current.queue =
        pendingOpsRefreshRef.current.queue || options?.queue !== false;
      if (opsRefreshTimerRef.current) {
        return;
      }
      opsRefreshTimerRef.current = window.setTimeout(() => {
        opsRefreshTimerRef.current = null;
        const pending = pendingOpsRefreshRef.current;
        pendingOpsRefreshRef.current = { tasks: false, queue: false };
        if (pending.tasks) {
          void reloadTasks({ preservePage: true, silent: true });
        }
        if (pending.queue) {
          void loadQueueStats({ silent: true });
        }
      }, 800);
    },
    [canView, loadQueueStats, reloadTasks],
  );

  useEffect(() => {
    if (!canView || !session?.accessToken) {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
      return;
    }

    opsSocketBootstrappingRef.current = true;
    setOpsLiveStatus("connecting");
    let hasConnectedOnce = false;
    const socket = io(`${env.apiRoot}/ops`, {
      auth: { token: session.accessToken },
      transports: ["websocket"],
    });
    opsSocketRef.current = socket;

    const handleConnect = () => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("connected");
      if (hasConnectedOnce) {
        scheduleOpsRefresh();
        return;
      }
      hasConnectedOnce = true;
    };
    const handleDisconnect = () => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
    };
    const handleConnectError = () => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
    };
    const handleEvent = (payload: unknown) => {
      const refreshDecision = getCrawlTasksOpsRefreshDecision(payload);
      if (!refreshDecision) {
        return;
      }
      scheduleOpsRefresh(refreshDecision);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("ops:event", handleEvent);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("ops:event", handleEvent);
      socket.disconnect();
      if (opsSocketRef.current === socket) {
        opsSocketRef.current = null;
      }
      opsSocketBootstrappingRef.current = false;
    };
  }, [canView, scheduleOpsRefresh, session?.accessToken]);

  useEffect(() => {
    if (
      !canView ||
      status !== "authenticated" ||
      opsSocketBootstrappingRef.current ||
      opsLiveStatus === "connected" ||
      opsLiveStatus === "connecting"
    ) {
      return;
    }
    scheduleOpsRefresh({ tasks: true, queue: true });
    const id = window.setInterval(() => {
      scheduleOpsRefresh({ tasks: true, queue: true });
    }, 30_000);
    return () => window.clearInterval(id);
  }, [canView, opsLiveStatus, scheduleOpsRefresh, status]);

  useEffect(() => {
    return () => {
      if (opsRefreshTimerRef.current) {
        window.clearTimeout(opsRefreshTimerRef.current);
        opsRefreshTimerRef.current = null;
      }
      pendingOpsRefreshRef.current = { tasks: false, queue: false };
      pendingEnsureRef.current = null;
    };
  }, []);

  const buildTaskConfigTags = (record: CrawlTaskNode): ReactNode[] => {
    const summary = parseCrawlTaskConfigSummary(record.config);
    if (!summary) {
      return [];
    }

    const qualityProfileLabel =
      summary.qualityProfile === "quality_first"
        ? t("crawl.settings.qualityProfileOptions.qualityFirst")
        : summary.qualityProfile === "speed_first"
          ? t("crawl.settings.qualityProfileOptions.speedFirst")
          : summary.qualityProfile === "balanced"
            ? t("crawl.settings.qualityProfileOptions.balanced")
            : null;

    const pageTypeHintLabel =
      summary.pageTypeHint === "list"
        ? t("crawl.settings.pageTypeHintOptions.list")
        : summary.pageTypeHint === "detail"
          ? t("crawl.settings.pageTypeHintOptions.detail")
          : summary.pageTypeHint === "auto"
            ? t("crawl.settings.pageTypeHintOptions.auto")
            : null;

    const tags: ReactNode[] = [];
    if (summary.ingestToItems) {
      tags.push(
        <Tag key="ingest" color="geekblue">
          {t("crawl.settings.ingestToItems", {
            defaultValue: "Auto send to Items",
          })}
        </Tag>,
      );
    }
    if (summary.scanFullPage) {
      tags.push(
        <Tag key="scanFullPage" color="blue">
          {t("crawl.settings.scanFullPage")}
        </Tag>,
      );
    }
    if (summary.hasVirtualScroll) {
      tags.push(
        <Tag key="virtualScroll" color="cyan">
          {t("crawl.virtualScroll.title")}
        </Tag>,
      );
    }
    if (qualityProfileLabel) {
      tags.push(
        <Tag key="qualityProfile" color="purple">
          {qualityProfileLabel}
        </Tag>,
      );
    }
    if (pageTypeHintLabel) {
      tags.push(
        <Tag key="pageTypeHint" color="magenta">
          {pageTypeHintLabel}
        </Tag>,
      );
    }
    if (summary.antiBotMode === "enabled") {
      tags.push(
        <Tag key="antiBotMode" color="volcano">
          {t("crawl.browser.antiBotModes.enabled", {
            defaultValue: "Anti-bot enabled",
          })}
        </Tag>,
      );
    } else if (summary.antiBotMode === "disabled") {
      tags.push(
        <Tag key="antiBotMode" color="default">
          {t("crawl.browser.antiBotModes.disabled", {
            defaultValue: "Anti-bot disabled",
          })}
        </Tag>,
      );
    }
    if (summary.autoExpandDetails) {
      tags.push(
        <Tag key="autoExpandDetails" color="green">
          {t("crawl.settings.autoExpandDetails")}
        </Tag>,
      );
    }

    return tags;
  };

  const columns: ColumnsType<CrawlTaskNode> = [
    {
      title: t("crawl.columns.task"),
      dataIndex: "displayName",
      key: "displayName",
      width: screens.xl ? 440 : 360,
      render: (_: unknown, record) => {
        const configTags = buildTaskConfigTags(record);
        const visibleConfigTags = configTags.slice(0, 4);
        return (
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            <Typography.Text
              strong
              style={{ display: "block", maxWidth: "100%" }}
              ellipsis
            >
              {record.displayName ?? record.targetUrl}
            </Typography.Text>
            {visibleConfigTags.length ? (
              <Space wrap size={[4, 4]}>
                {visibleConfigTags}
                {configTags.length > visibleConfigTags.length ? (
                  <Tag>{`+${configTags.length - visibleConfigTags.length}`}</Tag>
                ) : null}
              </Space>
            ) : null}
            <Typography.Link
              href={record.targetUrl}
              target="_blank"
              rel="noreferrer"
              style={{ display: "block", maxWidth: "100%", fontSize: 12 }}
              ellipsis
            >
              {record.targetUrl}
            </Typography.Link>
          </Space>
        );
      },
    },
    {
      title: t("crawl.columns.status"),
      dataIndex: "status",
      key: "status",
      width: 140,
      render: (value: CrawlTaskStatus) => (
        <Tag color={statusColors[value]}>
          {t(`crawl.status.${value}`, { defaultValue: value })}
        </Tag>
      ),
    },
    {
      title: t("crawl.columns.runs"),
      dataIndex: "runCount",
      key: "runCount",
      width: 170,
      render: (_, record) =>
        t("crawl.runsSummary", {
          runs: record.runCount,
          results: record.resultCount,
        }),
    },
    {
      title: t("crawl.columns.peakMemory"),
      dataIndex: "lastPeakMemoryMb",
      key: "lastPeakMemoryMb",
      width: 140,
      align: "right",
      render: (value?: number | null) =>
        value != null ? value.toFixed(0) : t("common.emptyValue"),
    },
    {
      title: t("crawl.columns.lastActivity"),
      dataIndex: "lastRunAt",
      key: "lastRunAt",
      width: 200,
      render: (_, record) => {
        if (!record.lastRunAt && !record.createdAt) {
          return t("common.emptyValue");
        }
        const timestamp = record.lastRunAt ?? record.createdAt;
        return formatDateTime(timestamp, locale, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      },
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 140,
      fixed: "right",
      render: (_, record) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            onClick={() => openTaskDetail(record.id)}
          >
            {t("common.view")}
          </Button>
          {canManage ? (
            <Button
              size="small"
              type="link"
              onClick={() => handleRetry(record.id)}
              loading={retrying}
            >
              {t("common.retry")}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const handleMetadataSubmit = async () => {
    try {
      const values = await metadataForm.validateFields();
      const input: CrawlMetadataInput = {
        source: values.source,
        domain: values.domain,
        pattern: values.pattern,
        maxUrls: values.maxUrls,
        query: values.query,
        scoreThreshold: values.scoreThreshold,
        concurrency: 5,
      };
      if (values.source === "urls") {
        const urls =
          values.urls
            ?.split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0) ?? [];
        if (urls.length === 0) {
          message.error(t("crawl.metadata.errors.atLeastOneUrl"));
          return;
        }
        input.urls = urls;
      }
      await fetchMetadata({
        variables: {
          input,
        },
      });
      message.success(t("crawl.metadata.completed"));
    } catch (error: unknown) {
      if (typeof error === "object" && error && "errorFields" in error) {
        return;
      }
      message.error(t("crawl.metadata.failed"));
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await retryTask({ variables: { id } });
      message.success(t("crawl.task.requeued"));
      await reloadTasks();
    } catch (error: unknown) {
      message.error((error as Error).message ?? t("crawl.task.retryFailed"));
    }
  };

  const openTaskDetail = (taskId: string) => {
    router.push(`/admin/ops/crawl-tasks/${taskId}`);
  };

  const handlePauseQueue = async () => {
    setQueueActionLoading("pause");
    try {
      const response = await apiClient.post<CrawlQueueOpsStats>(
        "admin/crawl4ai/queue/pause",
      );
      setQueueStats(response.data);
      message.success(
        t("crawl.ops.queuePaused", { defaultValue: "Crawl queue paused." }),
      );
    } catch (error: unknown) {
      message.error(
        (error as Error).message ??
          t("crawl.ops.queuePauseFailed", {
            defaultValue: "Failed to pause crawl queue.",
          }),
      );
    } finally {
      setQueueActionLoading(null);
    }
  };

  const handleResumeQueue = async () => {
    setQueueActionLoading("resume");
    try {
      const response = await apiClient.post<CrawlQueueOpsStats>(
        "admin/crawl4ai/queue/resume",
      );
      setQueueStats(response.data);
      message.success(
        t("crawl.ops.queueResumed", { defaultValue: "Crawl queue resumed." }),
      );
    } catch (error: unknown) {
      message.error(
        (error as Error).message ??
          t("crawl.ops.queueResumeFailed", {
            defaultValue: "Failed to resume crawl queue.",
          }),
      );
    } finally {
      setQueueActionLoading(null);
    }
  };

  const handleUpdateMaxConcurrency = async () => {
    const nextConcurrency = Math.round(maxConcurrencyInput);
    if (nextConcurrency < 1 || nextConcurrency > 20) {
      message.error(
        t("common.validation.numberRange", {
          defaultValue: "Value must be between {{min}} and {{max}}.",
          min: 1,
          max: 20,
        }),
      );
      return;
    }

    setQueueActionLoading("concurrency");
    try {
      await apiClient.post("admin/crawl4ai/queue/concurrency", {
        maxConcurrency: nextConcurrency,
      });
      await loadQueueStats();
      message.success(
        t("crawl.ops.concurrencySaved", {
          defaultValue: "Updated crawl concurrency limit.",
        }),
      );
    } catch (error: unknown) {
      message.error(
        (error as Error).message ??
          t("crawl.ops.concurrencySaveFailed", {
            defaultValue: "Failed to update crawl concurrency limit.",
          }),
      );
    } finally {
      setQueueActionLoading(null);
    }
  };

  const handleBatchFrequencySubmit = async () => {
    const frequencySeconds = Math.round(batchFrequencySeconds);
    if (frequencySeconds < 60 || frequencySeconds > 2_592_000) {
      message.error(
        t("common.validation.numberRange", {
          defaultValue: "Value must be between {{min}} and {{max}}.",
          min: 60,
          max: 2_592_000,
        }),
      );
      return;
    }

    Modal.confirm({
      title: t("crawl.ops.batchFrequencyConfirmTitle", {
        defaultValue: "Apply frequency to all News Sources?",
      }),
      content: t("crawl.ops.batchFrequencyConfirmDesc", {
        defaultValue:
          "This updates frequencySeconds for all News Sources in your org.",
      }),
      okText: t("common.confirm", { defaultValue: "Confirm" }),
      cancelText: t("common.cancel", { defaultValue: "Cancel" }),
      onOk: async () => {
        setBatchFrequencyLoading(true);
        try {
          const response = await apiClient.post<BatchUpdateFrequencyResponse>(
            "admin/news-sources/batch/frequency",
            { frequencySeconds },
          );
          message.success(
            t("crawl.ops.batchFrequencySaved", {
              defaultValue:
                "Updated {{count}} News Sources, active sources rescheduled: {{rescheduled}}.",
              count: response.data.updatedCount,
              rescheduled: response.data.activeRescheduledCount,
            }),
          );
        } catch (error: unknown) {
          message.error(
            (error as Error).message ??
              t("crawl.ops.batchFrequencySaveFailed", {
                defaultValue: "Failed to batch update News Source frequency.",
              }),
          );
          throw error;
        } finally {
          setBatchFrequencyLoading(false);
        }
      },
    });
  };

  const handleCrawlClientSettingsSubmit = async (
    values: UpdateCrawlClientSettingsMutationVariables["input"],
  ) => {
    try {
      await updateCrawlClientSettings({
        variables: {
          input: values,
        },
      });
      await refetchCrawlClientSettings();
      message.success(
        t("settings.crawlClient.saved", {
          defaultValue: "Crawl client settings saved.",
        }),
      );
    } catch (error) {
      message.error(
        (error as Error).message ??
          t("settings.crawlClient.saveFailed", {
            defaultValue: "Failed to save crawl client settings.",
          }),
      );
    }
  };

  const handleCreate = async (values: CreateCrawlTaskFormValues) => {
    const normalizedValues = normalizeCreateFormValues(values);
    const [from, to] = values.timeRange ?? [];
    let options: CrawlOptionsInput;
    try {
      const sanitizedOptions = sanitizeCrawlOptions(normalizedValues);
      const proxyIssues = findUnsupportedProxyIssues(sanitizedOptions, "options");
      if (proxyIssues.length > 0) {
        message.error(proxyIssues.map((issue) => issue.path).join(", "));
        return;
      }
      assertNoCrawl4aiLlmOptions(sanitizedOptions, "options");
      options = toGraphqlCrawlOptionsInput(sanitizedOptions);
    } catch (error) {
      const errorMessage = (error as Error).message ?? "";
      if (
        errorMessage.includes("crawl4ai LLM extraction settings") ||
        errorMessage.includes(CRAWL4AI_LLM_OPTION_GUARD_MESSAGE)
      ) {
        message.error(t("crawl.task.errors.llmOptionsForbidden"));
        return;
      }
      message.error(errorMessage || t("crawl.task.createFailed"));
      return;
    }
    try {
      await createTask({
        variables: {
          input: {
            url: values.url,
            displayName: values.displayName || null,
            ingestToItems: values.ingestToItems ?? null,
            keywords: values.keywords?.length ? values.keywords : null,
            concurrency: values.concurrency ?? null,
            timeRange:
              from || to
                ? {
                    from: from ? from.toISOString() : null,
                    to: to ? to.toISOString() : null,
                  }
                : null,
            options,
          },
        },
      });
      message.success(t("crawl.task.queued"));
      form.resetFields();
      setDrawerOpen(false);
      await reloadTasks();
    } catch (error: unknown) {
      const errorMessage = (error as Error).message ?? "";
      if (
        errorMessage.includes("crawl4ai LLM extraction settings") ||
        errorMessage.includes(CRAWL4AI_LLM_OPTION_GUARD_MESSAGE)
      ) {
        message.error(t("crawl.task.errors.llmOptionsForbidden"));
        return;
      }
      message.error(errorMessage || t("crawl.task.createFailed"));
    }
  };

  useEffect(() => {
    if (!canManage) {
      return;
    }
    if (searchParams.get("new") === "true") {
      setDrawerOpen(true);
    }
  }, [canManage, searchParams]);

  useEffect(() => {
    if (!canView) {
      return;
    }
    if (!sourceIdFilter) {
      if (appliedSourceFilterRef.current) {
        appliedSourceFilterRef.current = null;
        setSearchInput("");
        setSearch("");
        setPagination((prev) => ({ ...prev, current: 1 }));
      }
      return;
    }
    const prefix = `NewsSource:${sourceIdFilter}:`;
    appliedSourceFilterRef.current = sourceIdFilter;
    setSearchInput(prefix);
    setSearch(prefix);
    setPagination((prev) => ({ ...prev, current: 1 }));
  }, [canView, sourceIdFilter]);

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Typography.Text type="secondary">
          {t("common.loading", { defaultValue: "Loading..." })}
        </Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("crawl.title", { defaultValue: "Crawl Tasks" })}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        className="content-card"
        title={t("crawl.title", { defaultValue: "Crawl Tasks" })}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {sourceIdFilter ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 0 }}
              message={t("crawl.filter.sourceId", {
                defaultValue: "Filtered by NewsSource {{id}}",
                id: sourceIdFilter,
              })}
              action={
                <Button
                  size="small"
                  onClick={() => router.push("/admin/ops/crawl-tasks")}
                >
                  {t("common.clear", { defaultValue: "Clear" })}
                </Button>
              }
            />
          ) : null}
          {tasksError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 0 }}
              message={t("common.failed", { defaultValue: "Failed" })}
              description={tasksError}
            />
          ) : null}
          <div
            style={{
              display: "flex",
              flexDirection: screens.md ? "row" : "column",
              justifyContent: "space-between",
              alignItems: screens.md ? "center" : "stretch",
              gap: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                flex: 1,
                gap: 12,
              }}
            >
              <Space.Compact
                style={{
                  width: screens.md ? 320 : "100%",
                  maxWidth: "100%",
                }}
              >
                <Input
                  id="crawl-task-search"
                  name="crawlTaskSearch"
                  placeholder={t("crawl.search.placeholder")}
                  allowClear={!sourceIdFilter}
                  disabled={Boolean(sourceIdFilter)}
                  value={searchInput}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSearchInput(value);
                    if (!value) {
                      setSearch("");
                      setPagination((prev) => ({ ...prev, current: 1 }));
                    }
                  }}
                  onPressEnter={() => {
                    const nextValue = searchInput.trim();
                    setPagination((prev) => ({ ...prev, current: 1 }));
                    setSearch(nextValue);
                    setSearchInput(nextValue);
                  }}
                />
                <Button
                  icon={<SearchOutlined />}
                  aria-label={t("crawl.search.placeholder")}
                  disabled={Boolean(sourceIdFilter)}
                  onClick={() => {
                    const nextValue = searchInput.trim();
                    setPagination((prev) => ({ ...prev, current: 1 }));
                    setSearch(nextValue);
                    setSearchInput(nextValue);
                  }}
                />
              </Space.Compact>
              <Select<CrawlTaskStatus | null>
                placeholder={t("crawl.filters.status")}
                allowClear
                style={{
                  width: screens.md ? 180 : "100%",
                  maxWidth: "100%",
                }}
                value={statusFilter}
                options={[
                  { value: "pending", label: t("crawl.status.pending") },
                  { value: "queued", label: t("crawl.status.queued") },
                  { value: "running", label: t("crawl.status.running") },
                  { value: "completed", label: t("crawl.status.completed") },
                  { value: "failed", label: t("crawl.status.failed") },
                  { value: "paused", label: t("crawl.status.paused") },
                ]}
                onChange={(value) => {
                  setStatusFilter(value ?? null);
                  setPagination((prev) => ({ ...prev, current: 1 }));
                }}
              />
            </div>
            <Space
              wrap
              size={8}
              style={{
                justifyContent: screens.md ? "flex-end" : "flex-start",
                width: screens.md ? "auto" : "100%",
              }}
            >
              <Button
                icon={<DashboardOutlined />}
                onClick={() => router.push("/admin/ops/crawl-monitor")}
              >
                {t("crawl.monitor.open", { defaultValue: "Monitor" })}
              </Button>
              <Button
                icon={<GlobalOutlined />}
                onClick={() => router.push("/admin/ops/news-sources")}
              >
                {t("newsSources.title", { defaultValue: "News Sources" })}
              </Button>
              {canManage ? (
                <Button type="primary" onClick={() => setDrawerOpen(true)}>
                  {t("crawl.createTask")}
                </Button>
              ) : null}
            </Space>
          </div>
        </Space>
      </Card>

      <Crawl4aiHealthCard
        className="content-card"
        style={{ marginBottom: 0 }}
        onOpenMonitor={() => router.push("/admin/ops/crawl-monitor")}
      />

      {canManage || canManageQueueOps ? (
        <Card
          className="content-card"
          title={t("crawl.ops.title", {
            defaultValue: "Crawl Queue Ops",
          })}
          loading={queueStatsLoading}
        >
          <Row gutter={[16, 16]}>
            <Col xs={24} md={8}>
              <Space direction="vertical" size={8}>
                <Typography.Text strong>
                  {t("crawl.ops.queueStatus", { defaultValue: "Queue status" })}
                </Typography.Text>
                <Space wrap size={[8, 8]}>
                  <Tag color={queueStats?.paused ? "volcano" : "green"}>
                    {queueStats?.paused
                      ? t("crawl.ops.paused", { defaultValue: "Paused" })
                      : t("crawl.ops.running", { defaultValue: "Running" })}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("crawl.ops.pending", {
                      defaultValue: "Pending: {{count}}",
                      count: queueStats?.pending ?? 0,
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("crawl.ops.active", {
                      defaultValue: "Active: {{count}}",
                      count: queueStats?.counts.active ?? 0,
                    })}
                  </Typography.Text>
                </Space>
                <Space wrap size={8}>
                  <Button
                    onClick={handlePauseQueue}
                    loading={queueActionLoading === "pause"}
                    disabled={!canManageQueueOps || queueStats?.paused === true}
                  >
                    {t("crawl.ops.pauseQueue", { defaultValue: "Pause queue" })}
                  </Button>
                  <Button
                    onClick={handleResumeQueue}
                    loading={queueActionLoading === "resume"}
                    disabled={
                      !canManageQueueOps || queueStats?.paused === false
                    }
                  >
                    {t("crawl.ops.resumeQueue", {
                      defaultValue: "Resume queue",
                    })}
                  </Button>
                </Space>
              </Space>
            </Col>

            <Col xs={24} md={8}>
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Typography.Text strong>
                  {t("crawl.ops.maxConcurrency", {
                    defaultValue: "Global max concurrency",
                  })}
                </Typography.Text>
                <Space.Compact style={{ width: "100%" }}>
                  <InputNumber
                    min={1}
                    max={20}
                    step={1}
                    value={maxConcurrencyInput}
                    disabled={!canManageQueueOps}
                    style={{ width: "100%" }}
                    onChange={(value) =>
                      setMaxConcurrencyInput(Number(value ?? 1))
                    }
                  />
                  <Button
                    type="primary"
                    loading={queueActionLoading === "concurrency"}
                    disabled={!canManageQueueOps}
                    onClick={handleUpdateMaxConcurrency}
                  >
                    {t("common.saveChanges", { defaultValue: "Save Changes" })}
                  </Button>
                </Space.Compact>
                <Typography.Text type="secondary" style={{ display: "block" }}>
                  {t("crawl.ops.maxConcurrencyHelp", {
                    defaultValue:
                      "Controls crawl queue workers only. Crawl-result to item ingest uses a fixed internal concurrency of 8 and is not affected here.",
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("crawl.ops.effectiveConcurrency", {
                    defaultValue: "Effective",
                  })}
                  : {queueStats?.effectiveConcurrency ?? "-"}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("crawl.ops.queueSplit", {
                    defaultValue: "Hot/Normal pending",
                  })}
                  : {queueStats?.queues?.hot?.pending ?? 0}/
                  {queueStats?.queues?.normal?.pending ?? 0}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("crawl.ops.hotQueueRuntime", {
                    defaultValue: "Hot queue (A/F/E/P)",
                  })}
                  : {queueStats?.queues?.hot?.counts?.active ?? 0}/
                  {queueStats?.queues?.hot?.counts?.failed ?? 0}/
                  {queueStats?.queues?.hot?.effectiveConcurrency ?? 0}/
                  {queueStats?.queues?.hot?.paused
                    ? t("crawl.ops.paused", { defaultValue: "Paused" })
                    : t("crawl.ops.running", { defaultValue: "Running" })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("crawl.ops.normalQueueRuntime", {
                    defaultValue: "Normal queue (A/F/E/P)",
                  })}
                  : {queueStats?.queues?.normal?.counts?.active ?? 0}/
                  {queueStats?.queues?.normal?.counts?.failed ?? 0}/
                  {queueStats?.queues?.normal?.effectiveConcurrency ?? 0}/
                  {queueStats?.queues?.normal?.paused
                    ? t("crawl.ops.paused", { defaultValue: "Paused" })
                    : t("crawl.ops.running", { defaultValue: "Running" })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("crawl.ops.adaptiveStatus", {
                    defaultValue: "Adaptive",
                  })}
                  :{" "}
                  {queueStats?.adaptive?.enabled
                    ? `${queueStats?.adaptive?.lastDecision ?? "idle"}`
                    : t("common.disabled", { defaultValue: "Disabled" })}
                </Typography.Text>
                {queueStats?.adaptive?.enabled ? (
                  <>
                    <Typography.Text type="secondary">
                      {t("crawl.ops.adaptiveWindowCooldown", {
                        defaultValue: "Adaptive window/cooldown (min)",
                      })}
                      : {queueStats?.adaptive?.windowMinutes ?? "-"}/
                      {queueStats?.adaptive?.cooldownMinutes ?? "-"}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("crawl.ops.adaptiveThresholds", {
                        defaultValue: "Adaptive thresholds (L/E/M)",
                      })}
                      :{" "}
                      {typeof queueStats?.adaptive?.thresholds?.latencyRatio ===
                      "number"
                        ? `${Math.round(
                            (queueStats?.adaptive?.thresholds?.latencyRatio ??
                              0) * 100,
                          )}%`
                        : "-"}
                      /
                      {typeof queueStats?.adaptive?.thresholds?.errorRate ===
                      "number"
                        ? `${Math.round(
                            (queueStats?.adaptive?.thresholds?.errorRate ?? 0) *
                              100,
                          )}%`
                        : "-"}
                      /
                      {typeof queueStats?.adaptive?.thresholds
                        ?.memoryHeadroom === "number"
                        ? `${Math.round(
                            (queueStats?.adaptive?.thresholds?.memoryHeadroom ??
                              0) * 100,
                          )}%`
                        : "-"}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("crawl.ops.adaptiveMetrics", {
                        defaultValue:
                          "Adaptive sampled metrics p95/error/headroom",
                      })}
                      : {queueStats?.adaptive?.metrics?.p95LatencyMs ?? "-"}ms/
                      {typeof queueStats?.adaptive?.metrics?.errorRate ===
                      "number"
                        ? `${(
                            (queueStats?.adaptive?.metrics?.errorRate ?? 0) *
                            100
                          ).toFixed(1)}%`
                        : "-"}
                      /
                      {typeof queueStats?.adaptive?.metrics?.memoryHeadroom ===
                      "number"
                        ? `${(
                            (queueStats?.adaptive?.metrics?.memoryHeadroom ??
                              0) * 100
                          ).toFixed(1)}%`
                        : "-"}
                      {queueStats?.adaptive?.metrics?.samplingMode ===
                      "recent_sample"
                        ? ` (${queueStats?.adaptive?.metrics?.latencySampleCount ?? 0} latency samples, ${queueStats?.adaptive?.metrics?.memorySampleCount ?? 0} memory samples)`
                        : ""}
                    </Typography.Text>
                    {queueStats?.adaptive?.reason ? (
                      <Typography.Text type="secondary">
                        {t("crawl.ops.adaptiveReason", {
                          defaultValue: "Adaptive reason",
                        })}
                        : {queueStats?.adaptive?.reason}
                      </Typography.Text>
                    ) : null}
                  </>
                ) : null}
              </Space>
            </Col>

            {canManage ? (
              <Col xs={24} md={8}>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Typography.Text strong>
                    {t("crawl.ops.batchFrequency", {
                      defaultValue: "Batch schedule interval (seconds)",
                    })}
                  </Typography.Text>
                  <Space.Compact style={{ width: "100%" }}>
                    <InputNumber
                      min={60}
                      max={2_592_000}
                      step={60}
                      value={batchFrequencySeconds}
                      style={{ width: "100%" }}
                      onChange={(value) =>
                        setBatchFrequencySeconds(Number(value ?? 3600))
                      }
                    />
                    <Button
                      type="primary"
                      loading={batchFrequencyLoading}
                      onClick={handleBatchFrequencySubmit}
                    >
                      {t("crawl.ops.applyAll", {
                        defaultValue: "Apply to all",
                      })}
                    </Button>
                  </Space.Compact>
                  <Typography.Text type="secondary">
                    {t("crawl.ops.batchFrequencyHint", {
                      defaultValue:
                        "Updates frequencySeconds for all News Sources in this org.",
                    })}
                  </Typography.Text>
                </Space>
              </Col>
            ) : null}
          </Row>
        </Card>
      ) : null}

      {canManageSettings ? (
        <Card
          className="content-card"
          title={t("settings.tabs.crawlClient", {
            defaultValue: "Crawl Client",
          })}
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            {t("settings.crawlClient.description", {
              defaultValue:
                "Tune crawl4ai runtime parameters for health checks, request timeouts, and retry behavior.",
            })}
          </Typography.Paragraph>
          {crawlClientSettingsLoading &&
          !crawlClientSettingsData?.crawlClientSettings ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginTop: "0.5rem",
                marginBottom: "0.5rem",
              }}
            >
              <Spin />
            </div>
          ) : (
            <Form
              layout="vertical"
              form={clientSettingsForm}
              onFinish={handleCrawlClientSettingsSubmit}
            >
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t("settings.crawlClient.fields.healthCheckTtl")}
                    name="healthCheckTtlMs"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.healthCheckTtl",
                        ),
                      },
                      {
                        type: "number",
                        min: 5_000,
                        max: 900_000,
                        message: t("common.validation.numberRange", {
                          min: 5_000,
                          max: 900_000,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={5_000}
                      max={900_000}
                      step={1_000}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t("settings.crawlClient.fields.requestTimeoutHot", {
                      defaultValue: "Hot request timeout",
                    })}
                    name="requestTimeoutHotMs"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.requestTimeoutHot",
                          {
                            defaultValue: "Please enter hot request timeout.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: MIN_CRAWL_REQUEST_TIMEOUT_MS,
                        max: MAX_CRAWL_REQUEST_TIMEOUT_MS,
                        message: t("common.validation.numberRange", {
                          min: MIN_CRAWL_REQUEST_TIMEOUT_MS,
                          max: MAX_CRAWL_REQUEST_TIMEOUT_MS,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={MIN_CRAWL_REQUEST_TIMEOUT_MS}
                      max={MAX_CRAWL_REQUEST_TIMEOUT_MS}
                      step={1_000}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.requestTimeoutNormal",
                      {
                        defaultValue: "Normal request timeout",
                      },
                    )}
                    name="requestTimeoutNormalMs"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.requestTimeoutNormal",
                          {
                            defaultValue:
                              "Please enter normal request timeout.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: MIN_CRAWL_REQUEST_TIMEOUT_MS,
                        max: MAX_CRAWL_REQUEST_TIMEOUT_MS,
                        message: t("common.validation.numberRange", {
                          min: MIN_CRAWL_REQUEST_TIMEOUT_MS,
                          max: MAX_CRAWL_REQUEST_TIMEOUT_MS,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={MIN_CRAWL_REQUEST_TIMEOUT_MS}
                      max={MAX_CRAWL_REQUEST_TIMEOUT_MS}
                      step={1_000}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.conditionalRequestEnabled",
                      {
                        defaultValue: "Enable HTTP conditional requests",
                      },
                    )}
                    name="conditionalRequestEnabled"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.conditionalRequestTimeoutMs",
                      {
                        defaultValue: "Conditional request timeout",
                      },
                    )}
                    name="conditionalRequestTimeoutMs"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.conditionalRequestTimeoutMs",
                          {
                            defaultValue:
                              "Please enter conditional request timeout.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: 500,
                        max: 60_000,
                        message: t("common.validation.numberRange", {
                          min: 500,
                          max: 60_000,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={500}
                      max={60_000}
                      step={100}
                      disabled={!conditionalRequestEnabled}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.conditionalRequestMaxRetries",
                      {
                        defaultValue: "Conditional request retries",
                      },
                    )}
                    name="conditionalRequestMaxRetries"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.conditionalRequestMaxRetries",
                          {
                            defaultValue:
                              "Please enter conditional request retries.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: 0,
                        max: 5,
                        message: t("common.validation.numberRange", {
                          min: 0,
                          max: 5,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={0}
                      max={5}
                      step={1}
                      disabled={!conditionalRequestEnabled}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.detailPublishSignalHeadFetchTimeout",
                      {
                        defaultValue:
                          "Detail publish-signal head fetch timeout",
                      },
                    )}
                    name="detailPublishSignalHeadFetchTimeoutMs"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.detailPublishSignalHeadFetchTimeout",
                          {
                            defaultValue:
                              "Please enter detail publish-signal head fetch timeout.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
                        max: MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
                        message: t("common.validation.numberRange", {
                          min: MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
                          max: MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS}
                      max={MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS}
                      step={100}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.detailPublishSignalHeadFetchConcurrency",
                      {
                        defaultValue:
                          "Detail publish-signal head fetch concurrency",
                      },
                    )}
                    name="detailPublishSignalHeadFetchConcurrency"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.detailPublishSignalHeadFetchConcurrency",
                          {
                            defaultValue:
                              "Please enter detail publish-signal head fetch concurrency.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
                        max: MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
                        message: t("common.validation.numberRange", {
                          min: MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
                          max: MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY}
                      max={MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY}
                      step={1}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.detailPublishSignalHeadFetchMaxReadBytes",
                      {
                        defaultValue:
                          "Detail publish-signal head fetch max read bytes",
                      },
                    )}
                    name="detailPublishSignalHeadFetchMaxReadBytes"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.detailPublishSignalHeadFetchMaxReadBytes",
                          {
                            defaultValue:
                              "Please enter detail publish-signal head fetch max read bytes.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
                        max: MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
                        message: t("common.validation.numberRange", {
                          min: MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
                          max: MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES}
                      max={MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES}
                      step={262_144}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t("settings.crawlClient.fields.maxAttempts")}
                    name="maxRetries"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.maxAttempts",
                        ),
                      },
                      {
                        type: "number",
                        min: 1,
                        max: 10,
                        message: t("common.validation.numberRange", {
                          min: 1,
                          max: 10,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={1}
                      max={10}
                      step={1}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t("settings.crawlClient.fields.retryBackoff")}
                    name="retryBackoffMs"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.retryBackoff",
                        ),
                      },
                      {
                        type: "number",
                        min: 500,
                        max: 600_000,
                        message: t("common.validation.numberRange", {
                          min: 500,
                          max: 600_000,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={500}
                      max={600_000}
                      step={500}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.queueOverloadCooldown",
                      {
                        defaultValue: "Queue overload cooldown",
                      },
                    )}
                    name="queueOverloadCooldownMs"
                    rules={[
                      {
                        required: true,
                        message: t(
                          "settings.crawlClient.validation.queueOverloadCooldown",
                          {
                            defaultValue:
                              "Please enter queue overload cooldown.",
                          },
                        ),
                      },
                      {
                        type: "number",
                        min: 5_000,
                        max: 600_000,
                        message: t("common.validation.numberRange", {
                          min: 5_000,
                          max: 600_000,
                        }),
                      },
                    ]}
                  >
                    <InputNumber
                      min={5_000}
                      max={600_000}
                      step={1_000}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t(
                      "settings.crawlClient.fields.adaptiveConcurrency",
                      {
                        defaultValue: "Adaptive concurrency",
                      },
                    )}
                    name="adaptiveConcurrencyEnabled"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                </Col>
                <Col xs={24}>
                  <Typography.Paragraph
                    type="secondary"
                    style={{ marginTop: -8, marginBottom: 8 }}
                  >
                    {adaptiveConcurrencyEnabled
                      ? t("settings.crawlClient.hints.adaptiveEnabled", {
                          defaultValue:
                            "Adaptive mode is enabled. Window and threshold fields below are active.",
                        })
                      : t("settings.crawlClient.hints.adaptiveDisabled", {
                          defaultValue:
                            "Adaptive mode is disabled. Enable it to configure window and threshold fields.",
                        })}
                  </Typography.Paragraph>
                </Col>
                {adaptiveConcurrencyEnabled ? (
                  <>
                    <Col xs={24} md={12}>
                      <Form.Item
                        label={t(
                          "settings.crawlClient.fields.adaptiveWindowMinutes",
                          {
                            defaultValue: "Adaptive window",
                          },
                        )}
                        name="adaptiveWindowMinutes"
                        rules={[
                          {
                            required: true,
                            message: t(
                              "settings.crawlClient.validation.adaptiveWindowMinutes",
                              {
                                defaultValue:
                                  "Please enter adaptive window in minutes.",
                              },
                            ),
                          },
                          {
                            type: "number",
                            min: 1,
                            max: 180,
                            message: t("common.validation.numberRange", {
                              min: 1,
                              max: 180,
                            }),
                          },
                        ]}
                      >
                        <InputNumber
                          min={1}
                          max={180}
                          step={1}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        label={t(
                          "settings.crawlClient.fields.adaptiveCooldownMinutes",
                          {
                            defaultValue: "Adaptive cooldown",
                          },
                        )}
                        name="adaptiveCooldownMinutes"
                        rules={[
                          {
                            required: true,
                            message: t(
                              "settings.crawlClient.validation.adaptiveCooldownMinutes",
                              {
                                defaultValue:
                                  "Please enter adaptive cooldown in minutes.",
                              },
                            ),
                          },
                          {
                            type: "number",
                            min: 1,
                            max: 60,
                            message: t("common.validation.numberRange", {
                              min: 1,
                              max: 60,
                            }),
                          },
                        ]}
                      >
                        <InputNumber
                          min={1}
                          max={60}
                          step={1}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        label={t(
                          "settings.crawlClient.fields.adaptiveLatencyThresholdRatio",
                          {
                            defaultValue: "Adaptive latency threshold",
                          },
                        )}
                        name="adaptiveLatencyThresholdRatio"
                        rules={[
                          {
                            required: true,
                            message: t(
                              "settings.crawlClient.validation.adaptiveLatencyThresholdRatio",
                              {
                                defaultValue:
                                  "Please enter adaptive latency threshold ratio.",
                              },
                            ),
                          },
                          {
                            type: "number",
                            min: 0.01,
                            max: 0.99,
                            message: t("common.validation.numberRange", {
                              min: 0.01,
                              max: 0.99,
                            }),
                          },
                        ]}
                      >
                        <InputNumber
                          min={0.01}
                          max={0.99}
                          step={0.01}
                          precision={2}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        label={t(
                          "settings.crawlClient.fields.adaptiveErrorRateThreshold",
                          {
                            defaultValue: "Adaptive error-rate threshold",
                          },
                        )}
                        name="adaptiveErrorRateThreshold"
                        rules={[
                          {
                            required: true,
                            message: t(
                              "settings.crawlClient.validation.adaptiveErrorRateThreshold",
                              {
                                defaultValue:
                                  "Please enter adaptive error-rate threshold ratio.",
                              },
                            ),
                          },
                          {
                            type: "number",
                            min: 0.01,
                            max: 0.99,
                            message: t("common.validation.numberRange", {
                              min: 0.01,
                              max: 0.99,
                            }),
                          },
                        ]}
                      >
                        <InputNumber
                          min={0.01}
                          max={0.99}
                          step={0.01}
                          precision={2}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        label={t(
                          "settings.crawlClient.fields.adaptiveMemoryHeadroomThreshold",
                          {
                            defaultValue: "Adaptive memory headroom threshold",
                          },
                        )}
                        name="adaptiveMemoryHeadroomThreshold"
                        rules={[
                          {
                            required: true,
                            message: t(
                              "settings.crawlClient.validation.adaptiveMemoryHeadroomThreshold",
                              {
                                defaultValue:
                                  "Please enter adaptive memory headroom threshold ratio.",
                              },
                            ),
                          },
                          {
                            type: "number",
                            min: 0.01,
                            max: 0.99,
                            message: t("common.validation.numberRange", {
                              min: 0.01,
                              max: 0.99,
                            }),
                          },
                        ]}
                      >
                        <InputNumber
                          min={0.01}
                          max={0.99}
                          step={0.01}
                          precision={2}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                  </>
                ) : null}
              </Row>
              <Form.Item style={{ marginBottom: 0 }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={crawlClientSettingsSaving}
                >
                  {t("common.saveChanges", { defaultValue: "Save Changes" })}
                </Button>
              </Form.Item>
            </Form>
          )}
        </Card>
      ) : null}

      <Card
        className="content-card"
        title={t("crawl.taskList.title", { defaultValue: "Task List" })}
        extra={
          <Typography.Text type="secondary">
            {t("crawl.taskList.total", {
              defaultValue: "Total {{count}}",
              count: totalCount,
            })}
          </Typography.Text>
        }
      >
        {!screens.md ? (
          <List
            itemLayout="vertical"
            dataSource={tableData}
            loading={tasksLoading}
            pagination={{
              total: totalCount,
              current,
              pageSize,
              align: "center",
              onChange: (page, size) => {
                setPagination({ current: page, pageSize: size });
              },
            }}
            renderItem={(record) => {
              const configTags = buildTaskConfigTags(record);
              const visibleConfigTags = configTags.slice(0, 4);
              return (
                <List.Item
                  actions={[
                    <Button
                      key="view"
                      size="small"
                      type="link"
                      onClick={() => openTaskDetail(record.id)}
                    >
                      {t("common.view")}
                    </Button>,
                    canManage ? (
                      <Button
                        key="retry"
                        size="small"
                        type="link"
                        onClick={() => handleRetry(record.id)}
                        loading={retrying}
                      >
                        {t("common.retry")}
                      </Button>
                    ) : null,
                  ].filter(Boolean)}
                >
                  <List.Item.Meta
                    title={
                      <Space
                        direction="vertical"
                        size={2}
                        style={{ width: "100%" }}
                      >
                        <Typography.Text
                          strong
                          style={{ maxWidth: "100%" }}
                          ellipsis
                        >
                          {record.displayName ?? record.targetUrl}
                        </Typography.Text>
                        <Typography.Link
                          href={record.targetUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            maxWidth: "100%",
                            display: "block",
                            fontSize: 12,
                          }}
                          ellipsis
                        >
                          {record.targetUrl}
                        </Typography.Link>
                      </Space>
                    }
                    description={
                      <Space className="mt-2" wrap size={[4, 4]}>
                        <Tag color={statusColors[record.status]}>
                          {t(`crawl.status.${record.status}`, {
                            defaultValue: record.status,
                          })}
                        </Tag>
                        {visibleConfigTags}
                        {configTags.length > visibleConfigTags.length ? (
                          <Tag>{`+${configTags.length - visibleConfigTags.length}`}</Tag>
                        ) : null}
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
        ) : (
          <Table
            rowKey="id"
            loading={tasksLoading}
            columns={columns}
            dataSource={tableData}
            pagination={{
              total: totalCount,
              current,
              pageSize,
              showSizeChanger: true,
            }}
            scroll={{ x: 1100 }}
            onChange={(pager) => setPagination(pager)}
          />
        )}
      </Card>
      {canManage ? (
        <>
          <MetadataExtractionCard
            form={metadataForm}
            loading={metadataLoading}
            results={metadataResults}
            onSubmit={handleMetadataSubmit}
          />
          <CreateCrawlTaskDrawer
            form={form}
            open={drawerOpen}
            loading={creating}
            canWriteItems={canWriteItems}
            onClose={() => setDrawerOpen(false)}
            onSubmit={handleCreate}
          />
        </>
      ) : null}
    </div>
  );
}
