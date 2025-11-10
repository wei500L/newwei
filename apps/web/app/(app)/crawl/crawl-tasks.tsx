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
  jsCode?: string[];
  jsOnly?: boolean;
  waitForSelector?: string;
  waitForScript?: string;
  waitForTimeoutMs?: number;
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
  scoreLinks?: boolean;
  linkPreview?: {
    includeInternal?: boolean;
    includeExternal?: boolean;
    includeSocial?: boolean;
    maxLinks?: number;
    concurrency?: number;
    timeoutSeconds?: number;
    query?: string;
    scoreThreshold?: number;
    verbose?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
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
    jsCode?: string[];
    jsOnly?: boolean;
    waitForSelector?: string;
    waitForScript?: string;
    waitForTimeoutMs?: number;
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
  const scoreLinksValue = Form.useWatch("scoreLinks", form);
  const linkPreviewDisabled = !scoreLinksValue;
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

  const sanitizeJsCodeList = (list?: string[]) => {
    const sanitized = sanitizeStringList(list);
    return sanitized && sanitized.length ? sanitized.slice(0, 10) : undefined;
  };

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
    const jsCode = sanitizeJsCodeList(options.jsCode);
    if (jsCode) {
      cleaned.jsCode = jsCode;
    }
    if (typeof options.jsOnly === "boolean") {
      cleaned.jsOnly = options.jsOnly;
    }
    const waitForSelector = options.waitForSelector?.trim();
    if (waitForSelector) {
      cleaned.waitForSelector = waitForSelector;
    }
    const waitForScript = options.waitForScript?.trim();
    if (waitForScript) {
      cleaned.waitForScript = waitForScript;
    }
    if (typeof options.waitForTimeoutMs === "number") {
      cleaned.waitForTimeoutMs = options.waitForTimeoutMs;
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

  const sanitizeLinkPreview = (preview?: CreateCrawlTaskFormValues["linkPreview"]) => {
    if (!preview) {
      return undefined;
    }
    const payload: Record<string, unknown> = {};
    if (typeof preview.includeInternal === "boolean") {
      payload.includeInternal = preview.includeInternal;
    }
    if (typeof preview.includeExternal === "boolean") {
      payload.includeExternal = preview.includeExternal;
    }
    if (typeof preview.includeSocial === "boolean") {
      payload.includeSocial = preview.includeSocial;
    }
    if (typeof preview.maxLinks === "number") {
      payload.maxLinks = preview.maxLinks;
    }
    if (typeof preview.concurrency === "number") {
      payload.concurrency = preview.concurrency;
    }
    if (typeof preview.timeoutSeconds === "number") {
      payload.timeoutSeconds = preview.timeoutSeconds;
    }
    if (typeof preview.query === "string" && preview.query.trim().length > 0) {
      payload.query = preview.query.trim();
    }
    if (typeof preview.scoreThreshold === "number") {
      payload.scoreThreshold = preview.scoreThreshold;
    }
    if (typeof preview.verbose === "boolean") {
      payload.verbose = preview.verbose;
    }
    const includePatterns = sanitizeStringList(preview.includePatterns);
    if (includePatterns?.length) {
      payload.includePatterns = includePatterns;
    }
    const excludePatterns = sanitizeStringList(preview.excludePatterns);
    if (excludePatterns?.length) {
      payload.excludePatterns = excludePatterns;
    }
    return Object.keys(payload).length ? payload : undefined;
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
    const linkPreview = sanitizeLinkPreview(values.linkPreview);
    const jsCode = sanitizeJsCodeList(values.jsCode);
    const waitForSelector = values.waitForSelector?.trim();
    const waitForScript = values.waitForScript?.trim();
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
              jsCode: jsCode ?? undefined,
              jsOnly: typeof values.jsOnly === "boolean" ? values.jsOnly : undefined,
              waitForSelector: waitForSelector ? waitForSelector : undefined,
              waitForScript: waitForScript ? waitForScript : undefined,
              waitForTimeoutMs: values.waitForTimeoutMs ?? undefined,
              proxyUrl: proxyUrl ? proxyUrl : undefined,
              proxyConfig: proxyConfig ?? undefined,
              additionalUrls: additionalUrls && additionalUrls.length ? additionalUrls : undefined,
              multiUrlConfigs,
              markdownOptions: markdownOptions ?? undefined,
              markdownFilter: markdownFilter ?? undefined,
              scoreLinks: typeof values.scoreLinks === "boolean" ? values.scoreLinks : undefined,
              linkPreview: linkPreview ?? undefined
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
          <Card
            title="Dynamic crawling (JS + wait)"
            size="small"
            style={{ marginBottom: 16 }}
            extra={
              <Typography.Link
                href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/session-management.md"
                target="_blank"
                rel="noreferrer"
              >
                Docs
              </Typography.Link>
            }
          >
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              Inject custom JavaScript (e.g., click & scroll) and block until a selector or async JS condition
              resolves before Crawl4AI captures the HTML snapshot.
            </Typography.Paragraph>
            <Form.List name="jsCode">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: "100%" }}>
                  {fields.map((field, index) => (
                    <Space key={field.key} align="start">
                      <Form.Item
                        {...field}
                        label={`JS step ${index + 1}`}
                        style={{ flex: 1 }}
                        rules={[{ required: true, message: "Provide a JS snippet" }]}
                      >
                        <Input.TextArea
                          rows={3}
                          placeholder="document.querySelector('.load-more')?.click();"
                        />
                      </Form.Item>
                      <Button
                        type="link"
                        danger
                        icon={<MinusCircleOutlined />}
                        onClick={() => remove(field.name)}
                      />
                    </Space>
                  ))}
                  <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} block>
                    Add JS step
                  </Button>
                </Space>
              )}
            </Form.List>
            <Form.Item
              label="JS-only navigation"
              name="jsOnly"
              valuePropName="checked"
              extra="Use when only JS mutations (no fresh navigation) are required."
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label="Wait for selector"
              name="waitForSelector"
              extra="Automatically prefixed with css: when sent to Crawl4AI."
            >
              <Input placeholder=".article-list .item:nth-child(10)" />
            </Form.Item>
            <Form.Item
              label="Wait for JS expression"
              name="waitForScript"
              extra="Provide the body of an async () => boolean function; we add js: for you."
            >
              <Input.TextArea rows={3} placeholder="() => window.dataLoaded === true" />
            </Form.Item>
            <Form.Item
              label="Wait timeout (ms)"
              name="waitForTimeoutMs"
              extra="Defaults to Crawl4AI's internal timeout if left blank."
            >
              <InputNumber min={500} max={60000} style={{ width: "100%" }} placeholder="10000" />
            </Form.Item>
          </Card>
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
          <Card size="small" title="Link analysis" style={{ marginBottom: 16 }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              Enable Crawl4AI LinkPreviewConfig to pull internal/external links with quality scores.
            </Typography.Paragraph>
            <Form.Item
              label="Score links"
              name="scoreLinks"
              valuePropName="checked"
              extra="Turns on intrinsic/contextual scoring for extracted links."
            >
              <Switch />
            </Form.Item>
            <Form.Item label="Include internal links" name={["linkPreview", "includeInternal"]} valuePropName="checked">
              <Switch disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Include external links" name={["linkPreview", "includeExternal"]} valuePropName="checked">
              <Switch disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Include social media" name={["linkPreview", "includeSocial"]} valuePropName="checked">
              <Switch disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Max links" name={["linkPreview", "maxLinks"]}>
              <InputNumber min={1} max={500} style={{ width: "100%" }} placeholder="200" disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Concurrency" name={["linkPreview", "concurrency"]}>
              <InputNumber min={1} max={50} style={{ width: "100%" }} placeholder="10" disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Timeout (s)" name={["linkPreview", "timeoutSeconds"]}>
              <InputNumber min={1} max={60} style={{ width: "100%" }} placeholder="5" disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Context query" name={["linkPreview", "query"]}>
              <Input placeholder="machine learning tutorials" disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Score threshold" name={["linkPreview", "scoreThreshold"]}>
              <InputNumber
                min={0}
                max={1}
                step={0.05}
                style={{ width: "100%" }}
                placeholder="0.3"
                disabled={linkPreviewDisabled}
              />
            </Form.Item>
            <Form.Item label="Verbose logging" name={["linkPreview", "verbose"]} valuePropName="checked">
              <Switch disabled={linkPreviewDisabled} />
            </Form.Item>
            <Form.Item label="Include patterns" name={["linkPreview", "includePatterns"]}>
              <Select
                mode="tags"
                tokenSeparators={[",", " "]}
                placeholder="*/docs/*"
                disabled={linkPreviewDisabled}
              />
            </Form.Item>
            <Form.Item label="Exclude patterns" name={["linkPreview", "excludePatterns"]}>
              <Select
                mode="tags"
                tokenSeparators={[",", " "]}
                placeholder="*/login*"
                disabled={linkPreviewDisabled}
              />
            </Form.Item>
          </Card>
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
                    <Typography.Text strong style={{ marginBottom: 8, display: "block" }}>
                      Dynamic crawling overrides
                    </Typography.Text>
                    <Form.List name={[field.name, "options", "jsCode"]}>
                      {(jsFields, { add: addJs, remove: removeJs }) => (
                        <Space direction="vertical" style={{ width: "100%" }}>
                          {jsFields.map((jsField, jsIndex) => (
                            <Space key={jsField.key} align="start">
                              <Form.Item
                                {...jsField}
                                label={`JS step ${jsIndex + 1}`}
                                style={{ flex: 1 }}
                              >
                                <Input.TextArea
                                  rows={2}
                                  placeholder="document.querySelector('.load-more')?.click();"
                                />
                              </Form.Item>
                              <Button
                                type="link"
                                danger
                                icon={<MinusCircleOutlined />}
                                onClick={() => removeJs(jsField.name)}
                              />
                            </Space>
                          ))}
                          <Button type="dashed" icon={<PlusOutlined />} onClick={() => addJs()}>
                            Add JS step
                          </Button>
                        </Space>
                      )}
                    </Form.List>
                    <Form.Item
                      label="JS-only navigation"
                      name={[field.name, "options", "jsOnly"]}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item label="Wait for selector" name={[field.name, "options", "waitForSelector"]}>
                      <Input placeholder=".feed > article:last-child" />
                    </Form.Item>
                    <Form.Item label="Wait for JS expression" name={[field.name, "options", "waitForScript"]}>
                      <Input.TextArea rows={2} placeholder="() => document.querySelectorAll(...).length > 20" />
                    </Form.Item>
                    <Form.Item label="Wait timeout (ms)" name={[field.name, "options", "waitForTimeoutMs"]}>
                      <InputNumber min={500} max={60000} style={{ width: "100%" }} placeholder="10000" />
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
