"use client";

import { DashboardOutlined, GlobalOutlined, SearchOutlined } from "@ant-design/icons";
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
  Select,
  Space,
  Table,
  Tag,
  Typography,
  List,
  Grid,
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  CrawlMetadataInput,
  CrawlOptionsInput,
  CrawlTaskStatus,
  CrawlTasksQuery,
} from "@/graphql/generated";
import {
  CrawlWaitUntil,
  useCreateCrawlTaskMutation,
  useCrawlMetadataLazyQuery,
  useCrawlTasksLazyQuery,
  useRetryCrawlTaskMutation,
} from "@/graphql/generated";
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

function toCrawlWaitUntilInput(value?: string | null): CrawlWaitUntil | undefined {
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

function toGraphqlCrawlOptionsInput(options: ReturnType<typeof sanitizeCrawlOptions>): CrawlOptionsInput {
  return {
    ...options,
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

type CrawlTaskQualityProfile = "quality_first" | "balanced" | "speed_first";
type CrawlTaskPageTypeHint = "auto" | "list" | "detail";

interface CrawlTaskConfigSummary {
  ingestToItems: boolean;
  scanFullPage: boolean;
  hasVirtualScroll: boolean;
  qualityProfile: CrawlTaskQualityProfile | null;
  pageTypeHint: CrawlTaskPageTypeHint | null;
  autoExpandDetails: boolean;
}

function parseCrawlTaskConfigSummary(rawConfig?: string | null): CrawlTaskConfigSummary | null {
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
  const canView = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const canWriteItems = permissions.includes("items.write");
  const screens = Grid.useBreakpoint();
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const appliedSourceFilterRef = useRef<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CrawlTaskStatus | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateCrawlTaskFormValues>();
  const [metadataForm] = Form.useForm<MetadataFormValues>();
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 10,
  });

  const pageSize = pagination.pageSize ?? 10;
  const current = pagination.current ?? 1;

  type CrawlTaskEdge = CrawlTasksQuery["crawlTasks"]["edges"][number];
  type CrawlTaskNode = CrawlTaskEdge["node"];

  const [fetchTasks] = useCrawlTasksLazyQuery({
    fetchPolicy: "network-only",
  });

  const [taskEdges, setTaskEdges] = useState<CrawlTaskEdge[]>([]);
  const taskEdgesRef = useRef<CrawlTaskEdge[]>([]);
  const [pageInfo, setPageInfo] = useState<{ hasNextPage: boolean; endCursor: string | null }>({
    hasNextPage: true,
    endCursor: null,
  });
  const pageInfoRef = useRef(pageInfo);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const ensureLoadingRef = useRef(false);

  const [createTask, { loading: creating }] = useCreateCrawlTaskMutation();
  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();
  const [fetchMetadata, { loading: metadataLoading, data: metadataData }] =
    useCrawlMetadataLazyQuery();
  const metadataResults = metadataData?.crawlMetadata ?? [];

  const tableData = useMemo(() => {
    const start = (current - 1) * pageSize;
    return taskEdges.map((edge) => edge.node).slice(start, start + pageSize);
  }, [current, pageSize, taskEdges]);

  const queryKey = useMemo(
    () => JSON.stringify({ search, statusFilter, pageSize }),
    [pageSize, search, statusFilter],
  );

  useEffect(() => {
    taskEdgesRef.current = taskEdges;
  }, [taskEdges]);

  useEffect(() => {
    pageInfoRef.current = pageInfo;
  }, [pageInfo]);

  const resetTaskCache = useCallback(() => {
    taskEdgesRef.current = [];
    pageInfoRef.current = { hasNextPage: true, endCursor: null };
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
    async (targetPage: number) => {
      if (!canView) {
        return;
      }

      const required = Math.max(1, targetPage) * pageSize;
      if (taskEdgesRef.current.length >= required) {
        return;
      }

      // If we already know there is no next page and we have at least one page loaded, stop.
      if (taskEdgesRef.current.length > 0 && !pageInfoRef.current.hasNextPage) {
        return;
      }

      if (ensureLoadingRef.current) {
        return;
      }

      ensureLoadingRef.current = true;
      setTasksLoading(true);
      setTasksError(null);
      try {
        let nextEdges = taskEdgesRef.current;
        let after = pageInfoRef.current.endCursor;
        let hasNext = pageInfoRef.current.hasNextPage;
        let nextTotal = totalCount;

        if (nextEdges.length === 0) {
          // First page always starts from the beginning (after=null).
          after = null;
          hasNext = true;
        }

        while (nextEdges.length < required && (nextEdges.length === 0 || hasNext)) {
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
          const incomingEdges = connection.edges.filter((edge) => !existingIds.has(edge.node.id));
          nextEdges = nextEdges.concat(incomingEdges);

          after = connection.pageInfo.endCursor ?? null;
          hasNext = Boolean(connection.pageInfo.hasNextPage);
          nextTotal = connection.totalCount ?? nextTotal;

          if (!after && hasNext) {
            // Shouldn't happen, but avoid infinite loops if the server sends an inconsistent pageInfo.
            break;
          }
        }

        taskEdgesRef.current = nextEdges;
        pageInfoRef.current = { hasNextPage: hasNext, endCursor: after ?? null };

        setTaskEdges(nextEdges);
        setPageInfo(pageInfoRef.current);
        setTotalCount(nextTotal);
      } catch (error: unknown) {
        setTasksError(
          (error as Error).message ?? t("common.failed", { defaultValue: "Failed" }),
        );
      } finally {
        ensureLoadingRef.current = false;
        setTasksLoading(false);
      }
    },
    [canView, fetchTasks, pageSize, search, statusFilter, t, totalCount],
  );

  useEffect(() => {
    void ensureTasksLoaded(current);
  }, [current, ensureTasksLoaded]);

  const reloadTasks = useCallback(async () => {
    resetTaskCache();
    setPagination((prev) => ({ ...prev, current: 1 }));
    await ensureTasksLoaded(1);
  }, [ensureTasksLoaded, resetTaskCache]);

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
          {t("crawl.settings.ingestToItems", { defaultValue: "Auto send to Items" })}
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
      render: (_: unknown, record) => {
        const configTags = buildTaskConfigTags(record);
        return (
          <div>
            <div style={{ fontWeight: 600 }}>{record.displayName ?? record.targetUrl}</div>
            {configTags.length ? <Space wrap size={[4, 4]} style={{ marginTop: 4 }}>{configTags}</Space> : null}
            <Typography.Link
              href={record.targetUrl}
              target="_blank"
              rel="noreferrer"
            >
              {record.targetUrl}
            </Typography.Link>
          </div>
        );
      },
    },
    {
      title: t("crawl.columns.status"),
      dataIndex: "status",
      key: "status",
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
      render: (value?: number | null) =>
        value != null ? value.toFixed(0) : t("common.emptyValue"),
    },
    {
      title: t("crawl.columns.lastActivity"),
      dataIndex: "lastRunAt",
      key: "lastRunAt",
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
      render: (_, record) => (
        <Space>
          <Link href={`/admin/ops/crawl-tasks/${record.id}`}>{t("common.view")}</Link>
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
  const handleCreate = async (values: CreateCrawlTaskFormValues) => {
    const [from, to] = values.timeRange ?? [];
    let options: CrawlOptionsInput;
    try {
      const sanitizedOptions = sanitizeCrawlOptions(values);
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
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Typography.Text type="secondary">{t("common.loading", { defaultValue: "Loading..." })}</Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("crawl.title", { defaultValue: "Crawl Tasks" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="content-card">
      {sourceIdFilter ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("crawl.filter.sourceId", {
            defaultValue: "Filtered by NewsSource {{id}}",
            id: sourceIdFilter
          })}
          action={
            <Button size="small" onClick={() => router.push("/admin/ops/crawl-tasks")}>
              {t("common.clear", { defaultValue: "Clear" })}
            </Button>
          }
        />
      ) : null}
      {tasksError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("common.failed", { defaultValue: "Failed" })}
          description={tasksError}
        />
      ) : null}
      <Space style={{ marginBottom: 16 }} wrap>
        <Space.Compact style={{ width: 260 }}>
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
          style={{ width: 160 }}
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
        <Button icon={<DashboardOutlined />} onClick={() => router.push("/admin/ops/crawl-monitor")}>
          {t("crawl.monitor.open", { defaultValue: "Monitor" })}
        </Button>
        <Button icon={<GlobalOutlined />} onClick={() => router.push("/admin/ops/news-sources")}>
          {t("newsSources.title", { defaultValue: "News Sources" })}
        </Button>
        {canManage ? (
          <Button type="primary" onClick={() => setDrawerOpen(true)}>
            {t("crawl.createTask")}
          </Button>
        ) : null}
      </Space>

      <Crawl4aiHealthCard onOpenMonitor={() => router.push("/admin/ops/crawl-monitor")} />

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
            return (
            <List.Item
              actions={[
                <Link key="view" href={`/admin/ops/crawl-tasks/${record.id}`}>
                  {t("common.view")}
                </Link>,
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
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {record.displayName ?? record.targetUrl}
                    </div>
                    <Typography.Link
                      href={record.targetUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-gray-400 break-all"
                    >
                      {record.targetUrl}
                    </Typography.Link>
                  </div>
                }
                description={
                  <Space className="mt-2" wrap>
                    <Tag color={statusColors[record.status]}>
                      {t(`crawl.status.${record.status}`, {
                        defaultValue: record.status,
                      })}
                    </Tag>
                    {configTags}
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
          onChange={(pager) => setPagination(pager)}
        />
      )}
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
