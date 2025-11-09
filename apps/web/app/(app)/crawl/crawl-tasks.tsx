"use client";

import {
  Button,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  message,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import {
  CrawlTaskStatus,
  useCreateCrawlTaskMutation,
  useCrawlTasksQuery,
  useRetryCrawlTaskMutation
} from "@/graphql/generated";

const statusColors: Record<CrawlTaskStatus, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple"
};

interface CreateCrawlTaskFormValues {
  url: string;
  displayName?: string;
  keywords?: string[];
  timeRange?: Dayjs[];
  concurrency?: number;
  includeImages?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
}

export function CrawlTasksView() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CrawlTaskStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateCrawlTaskFormValues>();
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 10
  });

  const pageSize = pagination.pageSize ?? 10;
  const current = pagination.current ?? 1;

  const { data, loading, refetch } = useCrawlTasksQuery({
    variables: {
      first: pageSize * current,
      after: null,
      search: search ? search : null,
      status: statusFilter ?? null
    },
    fetchPolicy: "network-only"
  });

  const [createTask, { loading: creating }] = useCreateCrawlTaskMutation();
  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();

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
          <div style={{ fontWeight: 600 }}>{record.displayName ?? record.targetUrl}</div>
          <Typography.Link href={record.targetUrl} target="_blank" rel="noreferrer">
            {record.targetUrl}
          </Typography.Link>
        </div>
      )
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (value: CrawlTaskStatus) => <Tag color={statusColors[value]}>{value}</Tag>
    },
    {
      title: "Runs",
      dataIndex: "runCount",
      key: "runCount",
      render: (_, record) => `${record.runCount} • results: ${record.resultCount}`
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
      }
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
      )
    }
  ];

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
                    to: to ? to.toISOString() : null
                  }
                : null,
            options: {
              includeImages: values.includeImages ?? undefined,
              onlyMainContent: values.onlyMainContent ?? undefined,
              extractLinks: values.extractLinks ?? undefined
            }
          }
        }
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
            { value: "paused", label: "Paused" }
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
          showSizeChanger: true
        }}
        onChange={(pager) => setPagination(pager)}
      />
      <Drawer
        title="New Crawl Task"
        placement="right"
        width={420}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
      >
        <Form layout="vertical" form={form} onFinish={handleCreate}>
          <Form.Item
            label="Display name"
            name="displayName"
            rules={[{ max: 80, message: "Keep name under 80 characters" }]}
          >
            <Input placeholder="e.g. HN Headlines" />
          </Form.Item>
          <Form.Item
            label="Target URL"
            name="url"
            rules={[{ required: true, message: "Please provide a URL" }]}
          >
            <Input placeholder="https://news.example.com" />
          </Form.Item>
          <Form.Item label="Keywords" name="keywords">
            <Select mode="tags" placeholder="Add keywords" />
          </Form.Item>
          <Form.Item label="Time range" name="timeRange">
            <DatePicker.RangePicker
              allowClear
              showTime
              style={{ width: "100%" }}
              disabledDate={(date) => date && date > dayjs()}
            />
          </Form.Item>
          <Form.Item label="Concurrency" name="concurrency">
            <InputNumber min={1} max={10} style={{ width: "100%" }} placeholder="Default: 3" />
          </Form.Item>
          <Form.Item label="Include images" name="includeImages" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="Only main content" name="onlyMainContent" valuePropName="checked">
            <Switch defaultChecked />
          </Form.Item>
          <Form.Item label="Extract links" name="extractLinks" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Space style={{ width: "100%", justifyContent: "flex-end" }}>
            <Button onClick={() => setDrawerOpen(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={creating}>
              Queue Task
            </Button>
          </Space>
        </Form>
      </Drawer>
    </div>
  );
}
