"use client";

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
import { sanitizeCrawlOptions } from "@modular/utils";
import {
  CrawlMetadataInput,
  CrawlTaskStatus,
  useCreateCrawlTaskMutation,
  useCrawlMetadataLazyQuery,
  useCrawlTasksQuery,
  useRetryCrawlTaskMutation,
} from "@/graphql/generated";
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
  const [search, setSearch] = useState("");
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
  const allNodes = data?.crawlTasks.edges.map((edge) => edge.node) ?? [];
  const tableData = useMemo(() => {
    const start = (current - 1) * pageSize;
    return allNodes.slice(start, start + pageSize);
  }, [allNodes, current, pageSize]);

  const columns: ColumnsType<(typeof tableData)[number]> = [
    {
      title: "Task",
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
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (value: CrawlTaskStatus) => (
        <Tag color={statusColors[value]}>{value}</Tag>
      ),
    },
    {
      title: "Runs",
      dataIndex: "runCount",
      key: "runCount",
      render: (_, record) =>
        `${record.runCount} • results: ${record.resultCount}`,
    },
    {
      title: "Peak Mem (MB)",
      dataIndex: "lastPeakMemoryMb",
      key: "lastPeakMemoryMb",
      render: (value?: number | null) =>
        value != null ? value.toFixed(0) : "—",
    },
    {
      title: "Last Activity",
      dataIndex: "lastRunAt",
      key: "lastRunAt",
      render: (_, record) => {
        if (!record.lastRunAt && !record.createdAt) {
          return "—";
        }
        const timestamp = record.lastRunAt ?? record.createdAt;
        return new Date(timestamp).toLocaleString();
      },
    },
    {
      title: "Actions",
      key: "actions",
      render: (_, record) => (
        <Space>
          <Link href={`/crawl/${record.id}`}>View</Link>
          <Button
            size="small"
            type="link"
            onClick={() => handleRetry(record.id)}
            loading={retrying}
          >
            Retry
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
          message.error("请输入至少一个 URL");
          return;
        }
        input.urls = urls;
      }
      await fetchMetadata({
        variables: {
          input,
        },
      });
      message.success("Metadata extraction completed");
    } catch (error: any) {
      if (error?.errorFields) {
        return;
      }
      message.error("无法提取 metadata，请稍后重试");
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await retryTask({ variables: { id } });
      message.success("Task re-queued");
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? "Failed to retry task");
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
      message.success("Crawl task queued");
      form.resetFields();
      setDrawerOpen(false);
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? "Failed to create crawl task");
    }
  };

  return (
    <div className="content-card">
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="Search by name or URL"
          allowClear
          onSearch={(value) => {
            setPagination((prev) => ({ ...prev, current: 1 }));
            setSearch(value);
          }}
          onChange={(event) => {
            if (!event.target.value) {
              setSearch("");
              setPagination((prev) => ({ ...prev, current: 1 }));
            }
          }}
          style={{ width: 260 }}
        />
        <Select<CrawlTaskStatus | null>
          placeholder="Status"
          allowClear
          style={{ width: 160 }}
          value={statusFilter}
          options={[
            { value: "pending", label: "Pending" },
            { value: "queued", label: "Queued" },
            { value: "running", label: "Running" },
            { value: "completed", label: "Completed" },
            { value: "failed", label: "Failed" },
            { value: "paused", label: "Paused" },
          ]}
          onChange={(value) => {
            setStatusFilter(value ?? null);
            setPagination((prev) => ({ ...prev, current: 1 }));
          }}
        />
        <Button type="primary" onClick={() => setDrawerOpen(true)}>
          Create Task
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
