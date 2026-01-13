"use client";

import { DashboardOutlined, GlobalOutlined, SearchOutlined } from "@ant-design/icons";
import { sanitizeCrawlOptions } from "@modular/utils";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  message,
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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CrawlMetadataInput, CrawlTaskStatus } from "@/graphql/generated";
import {
  useCreateCrawlTaskMutation,
  useCrawlMetadataLazyQuery,
  useCrawlTasksQuery,
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

export function CrawlTasksView() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const screens = Grid.useBreakpoint();
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
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

  const { data, loading, refetch } = useCrawlTasksQuery({
    variables: {
      first: pageSize * current,
      after: null,
      search: search ? search : null,
      status: statusFilter ?? null,
    },
    fetchPolicy: "network-only",
    skip: !canView,
  });

  const [createTask, { loading: creating }] = useCreateCrawlTaskMutation();
  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();
  const [fetchMetadata, { loading: metadataLoading, data: metadataData }] =
    useCrawlMetadataLazyQuery();
  const metadataResults = metadataData?.crawlMetadata ?? [];

  const totalCount = data?.crawlTasks.totalCount ?? 0;
  const tableData = useMemo(() => {
    const allNodes = data?.crawlTasks.edges.map((edge) => edge.node) ?? [];
    const start = (current - 1) * pageSize;
    return allNodes.slice(start, start + pageSize);
  }, [data?.crawlTasks.edges, current, pageSize]);

  const columns: ColumnsType<(typeof tableData)[number]> = [
    {
      title: t("crawl.columns.task"),
      dataIndex: "displayName",
      key: "displayName",
      render: (_: unknown, record) => (
        <div>
          <div style={{ fontWeight: 600 }}>
            {record.displayName ?? record.targetUrl}
          </div>
          <Typography.Link
            href={record.targetUrl}
            target="_blank"
            rel="noreferrer"
          >
            {record.targetUrl}
          </Typography.Link>
        </div>
      ),
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
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? t("crawl.task.retryFailed"));
    }
  };
  const handleCreate = async (values: CreateCrawlTaskFormValues) => {
    const [from, to] = values.timeRange ?? [];
    let options;
    try {
      options = sanitizeCrawlOptions(values);
    } catch (error) {
      message.error((error as Error).message);
      return;
    }
    try {
      await createTask({
        variables: {
          input: {
            url: values.url,
            displayName: values.displayName || null,
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
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? t("crawl.task.createFailed"));
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
      <Space style={{ marginBottom: 16 }} wrap>
        <Space.Compact style={{ width: 260 }}>
          <Input
            placeholder={t("crawl.search.placeholder")}
            allowClear
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
          loading={loading}
          pagination={{
            total: totalCount,
            current,
            pageSize,
            align: "center",
            onChange: (page, size) => {
              setPagination({ current: page, pageSize: size });
            },
          }}
          renderItem={(record) => (
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
                  <Space className="mt-2">
                    <Tag color={statusColors[record.status]}>
                      {t(`crawl.status.${record.status}`, {
                        defaultValue: record.status,
                      })}
                    </Tag>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <Table
          rowKey="id"
          loading={loading}
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
            onClose={() => setDrawerOpen(false)}
            onSubmit={handleCreate}
          />
        </>
      ) : null}
    </div>
  );
}
