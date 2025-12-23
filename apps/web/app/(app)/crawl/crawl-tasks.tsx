"use client";

import { sanitizeCrawlOptions } from "@modular/utils";
import { SearchOutlined } from "@ant-design/icons";
import {
  Button,
  Form,
  Input,
  message,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CrawlMetadataInput, CrawlTaskStatus } from "@/graphql/generated";
import {
  useCreateCrawlTaskMutation,
  useCrawlMetadataLazyQuery,
  useCrawlTasksQuery,
  useRetryCrawlTaskMutation,
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

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
          <Link href={`/crawl/${record.id}`}>{t("common.view")}</Link>
          <Button
            size="small"
            type="link"
            onClick={() => handleRetry(record.id)}
            loading={retrying}
          >
            {t("common.retry")}
          </Button>
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
        <Button type="primary" onClick={() => setDrawerOpen(true)}>
          {t("crawl.createTask")}
        </Button>
      </Space>
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
    </div>
  );
}
