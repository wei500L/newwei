"use client";

import {
  Button,
  Card,
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
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
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
  scanFullPage?: boolean;
  scrollDelayMs?: number;
  enableUndetectedBrowser?: boolean;
  enableStealthMode?: boolean;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  proxyUrl?: string;
  proxyConfig?: {
    server?: string;
    username?: string;
    password?: string;
  };
  additionalUrls?: string[];
  multiUrlConfigs?: MultiUrlStrategyFormValue[];
  markdownOptions?: {
    contentSource?: string;
    ignoreLinks?: boolean;
    escapeHtml?: boolean;
    bodyWidth?: number;
  };
  markdownFilter?: {
    type?: string;
    threshold?: number;
  };
}

interface MultiUrlStrategyFormValue {
  name?: string;
  matcher?: {
    matchMode?: string;
    patterns?: string[];
  };
  urls?: string[];
  options?: {
    cacheMode?: string;
    scanFullPage?: boolean;
    scrollDelayMs?: number;
    onlyMainContent?: boolean;
    extractLinks?: boolean;
    simulateUser?: boolean;
    overrideNavigator?: boolean;
  };
}

export function CrawlTasksView() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CrawlTaskStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateCrawlTaskFormValues>();
  const scanFullPage = Form.useWatch("scanFullPage", form);
  const proxyUrlValue = Form.useWatch("proxyUrl", form);
  const proxyConfigValue = Form.useWatch("proxyConfig", form);
  const proxyUrlActive = Boolean(proxyUrlValue?.trim().length);
  const proxyObjectActive = Boolean(proxyConfigValue?.server?.trim().length);
  const markdownFilterType = Form.useWatch(["markdownFilter", "type"], form);
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
      title: "Peak Mem (MB)",
      dataIndex: "lastPeakMemoryMb",
      key: "lastPeakMemoryMb",
      render: (value?: number | null) => (value != null ? value.toFixed(0) : "—")
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

  const sanitizeStringList = (list?: string[]) =>
    list
      ?.map((value) => value?.trim())
      .filter((value): value is string => Boolean(value && value.length > 0));

  const sanitizeStrategyOptions = (options?: MultiUrlStrategyFormValue["options"]) => {
    if (!options) {
      return undefined;
    }
    const cleaned: Record<string, unknown> = {};
    if (options.cacheMode) {
      cleaned.cacheMode = options.cacheMode;
    }
    if (typeof options.scanFullPage === "boolean") {
      cleaned.scanFullPage = options.scanFullPage;
    }
    if (typeof options.scrollDelayMs === "number") {
      cleaned.scrollDelayMs = options.scrollDelayMs;
    }
    if (typeof options.onlyMainContent === "boolean") {
      cleaned.onlyMainContent = options.onlyMainContent;
    }
    if (typeof options.extractLinks === "boolean") {
      cleaned.extractLinks = options.extractLinks;
    }
    if (typeof options.simulateUser === "boolean") {
      cleaned.simulateUser = options.simulateUser;
    }
    if (typeof options.overrideNavigator === "boolean") {
      cleaned.overrideNavigator = options.overrideNavigator;
    }
    return Object.keys(cleaned).length ? cleaned : undefined;
  };

  const sanitizeMultiUrlConfigs = (configs?: MultiUrlStrategyFormValue[]) => {
    if (!configs) {
      return undefined;
    }
    const normalized = configs
      .map((config) => {
        const name = config.name?.trim();
        const matcherPatterns = sanitizeStringList(config.matcher?.patterns);
        const matcher =
          matcherPatterns && matcherPatterns.length
            ? {
                matchMode: config.matcher?.matchMode || undefined,
                patterns: matcherPatterns
              }
            : undefined;
        const urls = sanitizeStringList(config.urls);
        const options = sanitizeStrategyOptions(config.options);
        if (!matcher && (!urls || urls.length === 0)) {
          return null;
        }
        return {
          name: name || undefined,
          matcher,
          urls: urls && urls.length ? urls : undefined,
          options
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return normalized.length ? normalized : undefined;
  };

  const sanitizeMarkdownOptions = (options?: CreateCrawlTaskFormValues["markdownOptions"]) => {
    if (!options) {
      return undefined;
    }
    const payload: Record<string, unknown> = {};
    if (options.contentSource) {
      payload.contentSource = options.contentSource;
    }
    if (typeof options.ignoreLinks === "boolean") {
      payload.ignoreLinks = options.ignoreLinks;
    }
    if (typeof options.escapeHtml === "boolean") {
      payload.escapeHtml = options.escapeHtml;
    }
    if (typeof options.bodyWidth === "number") {
      payload.bodyWidth = options.bodyWidth;
    }
    return Object.keys(payload).length ? payload : undefined;
  };

  const sanitizeMarkdownFilter = (filter?: CreateCrawlTaskFormValues["markdownFilter"]) => {
    if (!filter?.type) {
      return undefined;
    }
    const payload: Record<string, unknown> = { type: filter.type };
    if (typeof filter.threshold === "number") {
      payload.threshold = filter.threshold;
    }
    return payload;
  };

  const handleCreate = async (values: CreateCrawlTaskFormValues) => {
    const [from, to] = values.timeRange ?? [];
    const proxyConfigInput = values.proxyConfig;
    const proxyServer = proxyConfigInput?.server?.trim();
    const proxyConfig = proxyServer
      ? {
          server: proxyServer,
          username: proxyConfigInput?.username?.trim() || undefined,
          password: proxyConfigInput?.password?.trim() || undefined
        }
      : undefined;
    const proxyUrl = proxyConfig ? undefined : values.proxyUrl?.trim();
    const additionalUrls = sanitizeStringList(values.additionalUrls);
    const multiUrlConfigs = sanitizeMultiUrlConfigs(values.multiUrlConfigs);
    const markdownOptions = sanitizeMarkdownOptions(values.markdownOptions);
    const markdownFilter = sanitizeMarkdownFilter(values.markdownFilter);
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
              extractLinks: values.extractLinks ?? undefined,
              scanFullPage: values.scanFullPage ?? undefined,
              scrollDelayMs: values.scrollDelayMs ?? undefined,
              enableUndetectedBrowser: values.enableUndetectedBrowser ?? undefined,
              enableStealthMode: values.enableStealthMode ?? undefined,
              simulateUser: values.simulateUser ?? undefined,
              overrideNavigator: values.overrideNavigator ?? undefined,
              proxyUrl: proxyUrl ? proxyUrl : undefined,
              proxyConfig: proxyConfig ?? undefined,
              additionalUrls: additionalUrls && additionalUrls.length ? additionalUrls : undefined,
              multiUrlConfigs,
              markdownOptions: markdownOptions ?? undefined,
              markdownFilter: markdownFilter ?? undefined
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
          <Form.Item label="Full-page scanning" name="scanFullPage" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="Scroll delay (ms)" name="scrollDelayMs">
            <InputNumber
              min={0}
              max={5000}
              style={{ width: "100%" }}
              placeholder="Default: 200"
              disabled={!scanFullPage}
            />
          </Form.Item>
          <Form.Item
            label="Undetected browser"
            name="enableUndetectedBrowser"
            valuePropName="checked"
            extra="Bypasses bot detection using Crawl4AI's UndetectedAdapter"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Stealth mode"
            name="enableStealthMode"
            valuePropName="checked"
            extra="Tweaks browser fingerprints for basic evasion"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Simulate user actions"
            name="simulateUser"
            valuePropName="checked"
            extra="Adds cursor movement / delays to mimic humans"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Override navigator()"
            name="overrideNavigator"
            valuePropName="checked"
            extra="Spoofs browser navigator properties"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Additional URLs"
            name="additionalUrls"
            extra="Crawl these URLs in the same batch (uses the base strategy unless overridden below)."
          >
            <Select
              mode="tags"
              tokenSeparators={[",", " "]}
              placeholder="https://example.com/archive"
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label="Markdown source"
            name={["markdownOptions", "contentSource"]}
            extra="Choose which HTML snapshot feeds the Markdown generator."
          >
            <Select
              allowClear
              placeholder="Default: cleaned_html"
              options={[
                { value: "cleaned_html", label: "Cleaned HTML (default)" },
                { value: "raw_html", label: "Raw HTML" },
                { value: "fit_html", label: "Fit HTML (schema optimized)" }
              ]}
            />
          </Form.Item>
          <Form.Item
            label="Ignore links"
            name={["markdownOptions", "ignoreLinks"]}
            valuePropName="checked"
            extra="Drop hyperlink references from generated Markdown."
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Escape HTML"
            name={["markdownOptions", "escapeHtml"]}
            valuePropName="checked"
            extra="HTML entities remain encoded when enabled."
          >
            <Switch />
          </Form.Item>
          <Form.Item label="Body width" name={["markdownOptions", "bodyWidth"]} extra="Wrap Markdown paragraphs at a custom width.">
            <InputNumber min={40} max={200} placeholder="80" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label="Markdown filter"
            name={["markdownFilter", "type"]}
            extra="Optionally enable Crawl4AI's content filters (e.g., pruning) before Markdown output."
          >
            <Select
              allowClear
              placeholder="None"
              options={[{ value: "pruning", label: "PruningContentFilter" }]}
            />
          </Form.Item>
          <Form.Item
            label="Pruning threshold"
            name={["markdownFilter", "threshold"]}
            hidden={markdownFilterType !== "pruning"}
            extra="Keep content whose relevance score is above this threshold (0-1)."
          >
            <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} placeholder="0.6" />
          </Form.Item>
          <Form.Item
            label="Proxy URL"
            name="proxyUrl"
            extra="Send a single proxy string (e.g. http://user:pass@proxy:8080 or socks5://proxy:1080)."
          >
            <Input placeholder="http://proxy.example.com:8080" disabled={proxyObjectActive} />
          </Form.Item>
          <Form.Item
            label="Proxy server"
            name={["proxyConfig", "server"]}
            extra="Dict format from Crawl4AI v0.7.4+; fill this when the proxy requires separate auth fields."
          >
            <Input placeholder="http://proxy.example.com:8080" disabled={proxyUrlActive} />
          </Form.Item>
          <Form.Item label="Proxy username" name={["proxyConfig", "username"]}>
            <Input placeholder="Optional username" disabled={proxyUrlActive} />
          </Form.Item>
          <Form.Item label="Proxy password" name={["proxyConfig", "password"]}>
            <Input.Password placeholder="Optional password" disabled={proxyUrlActive} />
          </Form.Item>
          <Form.List name="multiUrlConfigs">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: "100%" }} size="large">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Typography.Text strong>Multi-URL strategies</Typography.Text>
                  <Button type="dashed" icon={<PlusOutlined />} onClick={() => add()} size="small">
                    Add strategy
                  </Button>
                </div>
                {fields.length === 0 ? (
                  <Typography.Text type="secondary">
                    Optional: match additional URL patterns to custom crawler settings.
                  </Typography.Text>
                ) : null}
                {fields.map((field, index) => (
                  <Card
                    key={field.key}
                    size="small"
                    title={`Strategy ${index + 1}`}
                    extra={
                      <Button
                        type="link"
                        danger
                        icon={<MinusCircleOutlined />}
                        onClick={() => remove(field.name)}
                      >
                        Remove
                      </Button>
                    }
                  >
                    <Form.Item label="Label" name={[field.name, "name"]}>
                      <Input placeholder="e.g. PDF files" />
                    </Form.Item>
                    <Form.Item
                      label="Match mode"
                      name={[field.name, "matcher", "matchMode"]}
                      extra="Controls how patterns below are interpreted."
                    >
                      <Select
                        allowClear
                        placeholder="glob (default)"
                        options={[
                          { value: "glob", label: "Glob (*.pdf)" },
                          { value: "regex", label: "Regex" },
                          { value: "substring", label: "Substring" },
                          { value: "prefix", label: "Prefix" }
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      label="URL patterns"
                      name={[field.name, "matcher", "patterns"]}
                      rules={[
                        {
                          validator: (_, value) => {
                            if (!value || value.length === 0) {
                              return Promise.resolve();
                            }
                            return Promise.resolve();
                          }
                        }
                      ]}
                    >
                      <Select
                        mode="tags"
                        tokenSeparators={[",", " "]}
                        placeholder="*.pdf"
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                    <Form.Item
                      label="Explicit URLs"
                      name={[field.name, "urls"]}
                      extra="Optional explicit URLs that should use this strategy."
                    >
                      <Select
                        mode="tags"
                        tokenSeparators={[",", " "]}
                        placeholder="https://example.com/report.pdf"
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                    <Form.Item label="Cache mode" name={[field.name, "options", "cacheMode"]}>
                      <Select
                        allowClear
                        placeholder="Default (bypass)"
                        options={[
                          { value: "bypass", label: "Bypass (fresh)" },
                          { value: "prefer_cache", label: "Prefer cache" },
                          { value: "force_cache", label: "Force cache" }
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      label="Full-page scanning"
                      name={[field.name, "options", "scanFullPage"]}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item label="Scroll delay (ms)" name={[field.name, "options", "scrollDelayMs"]}>
                      <InputNumber min={0} max={5000} style={{ width: "100%" }} placeholder="Default: 200" />
                    </Form.Item>
                    <Form.Item
                      label="Only main content"
                      name={[field.name, "options", "onlyMainContent"]}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      label="Extract links"
                      name={[field.name, "options", "extractLinks"]}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      label="Simulate user actions"
                      name={[field.name, "options", "simulateUser"]}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      label="Override navigator()"
                      name={[field.name, "options", "overrideNavigator"]}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                  </Card>
                ))}
              </Space>
            )}
          </Form.List>
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
