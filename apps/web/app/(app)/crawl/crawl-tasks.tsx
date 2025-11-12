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
  CrawlMetadataInput,
  CrawlMetadataQuery,
  CrawlTaskStatus,
  useCreateCrawlTaskMutation,
  useCrawlMetadataLazyQuery,
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
  storeMedia?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
  enableUndetectedBrowser?: boolean;
  enableStealthMode?: boolean;
  useManagedBrowser?: boolean;
  userDataDir?: string;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  sessionId?: string;
  storageState?: string;
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
    thresholdType?: "fixed" | "dynamic";
    minWordThreshold?: number;
  };
  cleanMarkdown?: {
    cssSelector?: string;
    targetElements?: string[];
    excludedTags?: string[];
    removeOverlayElements?: boolean;
    wordCountThreshold?: number;
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
  browserHeaders?: BrowserHeaderFormValue[];
  browserCookies?: BrowserCookieFormValue[];
  userAgent?: string;
  userAgentMode?: "random";
  userAgentGenerator?: UserAgentGeneratorFormValue;
  locale?: string;
  timezoneId?: string;
  geolocation?: GeolocationFormValue;
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
    adjustViewportToContent?: boolean;
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

interface BrowserHeaderFormValue {
  name?: string;
  value?: string;
}

interface BrowserCookieFormValue {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
}

interface UserAgentGeneratorFormValue {
  platform?: string;
  browser?: string;
  deviceType?: string;
  locale?: string;
}

interface GeolocationFormValue {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

interface MetadataFormValues {
  source: "sitemap" | "urls";
  domain?: string;
  pattern?: string;
  maxUrls?: number;
  query?: string;
  scoreThreshold?: number;
  urls?: string;
}

type MetadataResultRow = CrawlMetadataQuery["crawlMetadata"][number];

export function CrawlTasksView() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CrawlTaskStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateCrawlTaskFormValues>();
  const [metadataForm] = Form.useForm<MetadataFormValues>();
  const scanFullPage = Form.useWatch("scanFullPage", form);
  const proxyUrlValue = Form.useWatch("proxyUrl", form);
  const proxyConfigValue = Form.useWatch("proxyConfig", form);
  const proxyUrlActive = Boolean(proxyUrlValue?.trim().length);
  const proxyObjectActive = Boolean(proxyConfigValue?.server?.trim().length);
  const markdownFilterType = Form.useWatch(["markdownFilter", "type"], form);
  const scoreLinksValue = Form.useWatch("scoreLinks", form);
  const userAgentModeValue = Form.useWatch("userAgentMode", form);
  const useManagedBrowserValue = Form.useWatch("useManagedBrowser", form);
  const metadataSource = Form.useWatch("source", metadataForm) ?? "sitemap";
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
  const [fetchMetadata, { loading: metadataLoading, data: metadataData }] = useCrawlMetadataLazyQuery();
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

  const metadataColumns: ColumnsType<MetadataResultRow> = useMemo(
    () => [
      {
        title: "URL",
        dataIndex: "url",
        key: "url",
        render: (_: unknown, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Link href={record.url} target="_blank">
              {record.url}
            </Typography.Link>
            {record.fetchedAt ? (
              <Typography.Text type="secondary">
                {dayjs(record.fetchedAt).format("MMM D, HH:mm")}
              </Typography.Text>
            ) : null}
          </Space>
        )
      },
      {
        title: "Status",
        dataIndex: "status",
        key: "status",
        width: 120,
        render: (_: unknown, record) => (
          <Tag color={record.status === "success" ? "green" : "red"}>{record.status.toUpperCase()}</Tag>
        )
      },
      {
        title: "HTTP",
        dataIndex: "httpStatus",
        key: "httpStatus",
        width: 90,
        render: (value: number | undefined) => value ?? "—"
      },
      {
        title: "Score",
        dataIndex: "relevanceScore",
        key: "relevanceScore",
        width: 100,
        render: (value: number | undefined | null) => (value !== null && value !== undefined ? value.toFixed(2) : "—")
      },
      {
        title: "Summary",
        key: "summary",
        render: (_: unknown, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{record.title ?? "Untitled page"}</Typography.Text>
            <Typography.Text type="secondary">
              {record.description ?? "No meta description provided"}
            </Typography.Text>
          </Space>
        )
      },
      {
        title: "Keywords",
        dataIndex: "keywords",
        key: "keywords",
        render: (_: unknown, record) =>
          record.keywords && record.keywords.length > 0 ? (
            <Space wrap>
              {record.keywords.slice(0, 4).map((keyword) => (
                <Tag key={`${record.url}-kw-${keyword}`}>{keyword}</Tag>
              ))}
            </Space>
          ) : (
            "—"
          )
      },
      {
        title: "Metadata",
        key: "metadata",
        render: (_: unknown, record) => {
          const primaryMeta = record.metaTags.slice(0, 2);
          const primaryOg = record.openGraph.slice(0, 2);
          return (
            <Space direction="vertical" size={4}>
              {primaryMeta.length > 0 ? (
                <Space wrap>
                  {primaryMeta.map((tag) => (
                    <Tag key={`${record.url}-meta-${tag.name}`} color="blue">
                      {tag.name}: {tag.value}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">No standard meta tags</Typography.Text>
              )}
              {primaryOg.length > 0 ? (
                <Space wrap>
                  {primaryOg.map((tag) => (
                    <Tag key={`${record.url}-og-${tag.name}`} color="purple">
                      {tag.name}: {tag.value}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">No Open Graph tags</Typography.Text>
              )}
              {record.jsonLd.length > 0 ? (
                <Tag color="geekblue">{record.jsonLd.length} JSON-LD block(s)</Tag>
              ) : (
                <Typography.Text type="secondary">No JSON-LD</Typography.Text>
              )}
            </Space>
          );
        }
      },
      {
        title: "Error",
        dataIndex: "error",
        key: "error",
        render: (value: string | undefined | null) => value ?? "—"
      }
    ],
    []
  );

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
        concurrency: 5
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
          input
        }
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
    if (typeof options.adjustViewportToContent === "boolean") {
      cleaned.adjustViewportToContent = options.adjustViewportToContent;
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
    if (filter.thresholdType === "fixed" || filter.thresholdType === "dynamic") {
      payload.thresholdType = filter.thresholdType;
    }
    if (typeof filter.minWordThreshold === "number") {
      payload.minWordThreshold = filter.minWordThreshold;
    }
    return payload;
  };

  const sanitizeCleanMarkdown = (options?: CreateCrawlTaskFormValues["cleanMarkdown"]) => {
    if (!options) {
      return undefined;
    }
    const payload: Record<string, unknown> = {};
    if (typeof options.cssSelector === "string" && options.cssSelector.trim().length) {
      payload.cssSelector = options.cssSelector.trim();
    }
    const targetElements = sanitizeStringList(options.targetElements)?.slice(0, 10);
    if (targetElements?.length) {
      payload.targetElements = targetElements;
    }
    const excludedTags = sanitizeStringList(options.excludedTags)?.slice(0, 10);
    if (excludedTags?.length) {
      payload.excludedTags = excludedTags;
    }
    if (typeof options.removeOverlayElements === "boolean") {
      payload.removeOverlayElements = options.removeOverlayElements;
    }
    if (typeof options.wordCountThreshold === "number") {
      payload.wordCountThreshold = options.wordCountThreshold;
    }
    return Object.keys(payload).length ? payload : undefined;
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

  const sanitizeBrowserHeaders = (headers?: BrowserHeaderFormValue[]) => {
    if (!headers || headers.length === 0) {
      return undefined;
    }
    const normalized = headers
      .map((header) => ({
        name: header?.name?.trim() ?? "",
        value: header?.value?.trim() ?? ""
      }))
      .filter((entry) => entry.name.length && entry.value.length)
      .slice(0, 20);
    return normalized.length ? normalized : undefined;
  };

  const sanitizeBrowserCookies = (cookies?: BrowserCookieFormValue[]) => {
    if (!cookies || cookies.length === 0) {
      return undefined;
    }
    const normalized = cookies
      .map((cookie) => ({
        name: cookie?.name?.trim() ?? "",
        value: cookie?.value?.trim() ?? "",
        domain: cookie?.domain?.trim() ?? "",
        path: cookie?.path?.trim() || undefined
      }))
      .filter((entry) => entry.name.length && entry.value.length && entry.domain.length)
      .slice(0, 20);
    return normalized.length ? normalized : undefined;
  };

  const sanitizeUserAgentGenerator = (generator?: UserAgentGeneratorFormValue) => {
    if (!generator) {
      return undefined;
    }
    const normalized: UserAgentGeneratorFormValue = {};
    const platforms = ["windows", "macos", "linux", "android", "ios"];
    const browsers = ["chrome", "firefox", "safari", "edge"];
    const deviceTypes = ["desktop", "mobile", "tablet"];
    if (generator.platform && platforms.includes(generator.platform)) {
      normalized.platform = generator.platform;
    }
    if (generator.browser && browsers.includes(generator.browser)) {
      normalized.browser = generator.browser;
    }
    if (generator.deviceType && deviceTypes.includes(generator.deviceType)) {
      normalized.deviceType = generator.deviceType;
    }
    if (generator.locale) {
      const trimmed = generator.locale.trim();
      if (trimmed.length) {
        normalized.locale = trimmed.slice(0, 16);
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
  };

  const sanitizeGeolocation = (geo?: GeolocationFormValue) => {
    if (!geo) {
      return undefined;
    }
    const latitude = typeof geo.latitude === "number" ? geo.latitude : undefined;
    const longitude = typeof geo.longitude === "number" ? geo.longitude : undefined;
    if (latitude == null || longitude == null) {
      return undefined;
    }
    const normalized: GeolocationFormValue = {
      latitude: Math.max(-90, Math.min(90, Number(latitude.toFixed(6)))),
      longitude: Math.max(-180, Math.min(180, Number(longitude.toFixed(6))))
    };
    if (typeof geo.accuracy === "number" && !Number.isNaN(geo.accuracy)) {
      normalized.accuracy = Math.max(1, Math.min(5000, Math.round(geo.accuracy)));
    }
    return normalized;
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
    const cleanMarkdown = sanitizeCleanMarkdown(values.cleanMarkdown);
    const linkPreview = sanitizeLinkPreview(values.linkPreview);
    const jsCode = sanitizeJsCodeList(values.jsCode);
    const waitForSelector = values.waitForSelector?.trim();
    const waitForScript = values.waitForScript?.trim();
    const sessionId = values.sessionId?.trim();
    const storageState = values.storageState?.trim();
    const userDataDir = values.userDataDir?.trim();
    const browserHeaders = sanitizeBrowserHeaders(values.browserHeaders);
    const browserCookies = sanitizeBrowserCookies(values.browserCookies);
    const userAgent = values.userAgent?.trim();
    const userAgentMode = values.userAgentMode === "random" ? "random" : undefined;
    const userAgentGenerator = sanitizeUserAgentGenerator(values.userAgentGenerator);
    const locale = values.locale?.trim();
    const timezoneId = values.timezoneId?.trim();
    const geolocation = sanitizeGeolocation(values.geolocation);
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
              storeMedia: typeof values.storeMedia === "boolean" ? values.storeMedia : undefined,
              onlyMainContent: values.onlyMainContent ?? undefined,
              extractLinks: values.extractLinks ?? undefined,
              scanFullPage: values.scanFullPage ?? undefined,
              adjustViewportToContent:
                typeof values.adjustViewportToContent === "boolean"
                  ? values.adjustViewportToContent
                  : undefined,
              scrollDelayMs: values.scrollDelayMs ?? undefined,
              enableUndetectedBrowser: values.enableUndetectedBrowser ?? undefined,
              enableStealthMode: values.enableStealthMode ?? undefined,
              useManagedBrowser:
                typeof values.useManagedBrowser === "boolean" ? values.useManagedBrowser : undefined,
              userDataDir: userDataDir && userDataDir.length ? userDataDir : undefined,
              simulateUser: values.simulateUser ?? undefined,
              overrideNavigator: values.overrideNavigator ?? undefined,
              jsCode: jsCode ?? undefined,
              jsOnly: typeof values.jsOnly === "boolean" ? values.jsOnly : undefined,
              waitForSelector: waitForSelector ? waitForSelector : undefined,
              waitForScript: waitForScript ? waitForScript : undefined,
              waitForTimeoutMs: values.waitForTimeoutMs ?? undefined,
              sessionId: sessionId ? sessionId : undefined,
              storageState: storageState && storageState.length ? storageState : undefined,
              proxyUrl: proxyUrl ? proxyUrl : undefined,
              proxyConfig: proxyConfig ?? undefined,
              additionalUrls: additionalUrls && additionalUrls.length ? additionalUrls : undefined,
              multiUrlConfigs,
              markdownOptions: markdownOptions ?? undefined,
              markdownFilter: markdownFilter ?? undefined,
              cleanMarkdown: cleanMarkdown ?? undefined,
              scoreLinks: typeof values.scoreLinks === "boolean" ? values.scoreLinks : undefined,
              linkPreview: linkPreview ?? undefined,
              browserHeaders: browserHeaders ?? undefined,
              browserCookies: browserCookies ?? undefined,
              userAgent: userAgent?.length ? userAgent : undefined,
              userAgentMode: userAgentMode ?? undefined,
              userAgentGenerator: userAgentGenerator ?? undefined,
              locale: locale?.length ? locale : undefined,
              timezoneId: timezoneId?.length ? timezoneId : undefined,
              geolocation: geolocation ?? undefined
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
      <Card title="Metadata extraction" style={{ marginTop: 24 }}>
        <Typography.Paragraph type="secondary">
          Preview head metadata via sitemap seeding before creating a crawl task. Powered by{" "}
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/url-seeding.md"
            target="_blank"
            rel="noreferrer"
          >
            crawl4ai&apos;s metadata extraction guidance
          </Typography.Link>
          .
        </Typography.Paragraph>
        <Form
          layout="vertical"
          form={metadataForm}
          onFinish={handleMetadataSubmit}
          initialValues={{ source: "sitemap", maxUrls: 10 }}
          style={{ marginTop: 16 }}
        >
          <Space align="end" wrap>
            <Form.Item
              label="Source"
              name="source"
              style={{ minWidth: 200 }}
              rules={[{ required: true, message: "请选择来源" }]}
            >
              <Select
                options={[
                  { label: "Sitemap seeding", value: "sitemap" },
                  { label: "Manual URLs", value: "urls" }
                ]}
              />
            </Form.Item>
            {metadataSource === "sitemap" ? (
              <>
                <Form.Item
                  label="Domain"
                  name="domain"
                  style={{ minWidth: 220 }}
                  rules={[{ required: true, message: "请输入域名" }]}
                >
                  <Input placeholder="news.example.com" />
                </Form.Item>
                <Form.Item label="Pattern" name="pattern" style={{ minWidth: 200 }}>
                  <Input placeholder="*/blog/*" />
                </Form.Item>
                <Form.Item label="Max URLs" name="maxUrls">
                  <InputNumber min={1} max={200} style={{ width: 120 }} />
                </Form.Item>
              </>
            ) : (
              <Form.Item
                label="URLs"
                name="urls"
                style={{ minWidth: 320 }}
                rules={[{ required: true, message: "请输入 URL 列表" }]}
              >
                <Input.TextArea rows={4} placeholder="https://example.com/post-1" />
              </Form.Item>
            )}
            <Form.Item label="Query" name="query" style={{ minWidth: 220 }}>
              <Input placeholder="e.g. API reference" />
            </Form.Item>
            <Form.Item label="Score threshold" name="scoreThreshold">
              <InputNumber min={0} max={1} step={0.1} style={{ width: 140 }} placeholder="0.3" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={metadataLoading}>
                Extract metadata
              </Button>
            </Form.Item>
          </Space>
        </Form>
        <Table<MetadataResultRow>
          style={{ marginTop: 24 }}
          rowKey={(record) => `${record.url}-${record.fetchedAt ?? record.status}`}
          columns={metadataColumns}
          dataSource={metadataResults}
          loading={metadataLoading}
          pagination={false}
          locale={{ emptyText: "填写上方表单以预览 metadata" }}
        />
      </Card>
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
          <Form.Item
            label="Store media assets"
            name="storeMedia"
            valuePropName="checked"
            extra="When enabled, Crawl4AI's result.media payload (images/audio/video/srcset) is persisted for later review."
          >
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
            label="Dynamic viewport adjustment"
            name="adjustViewportToContent"
            valuePropName="checked"
            extra={
              <span>
                Auto-resize the browser viewport to fit responsive layouts per{" "}
                <Typography.Link
                  href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/blog/releases/0.4.1.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  Crawl4AI 0.4.1
                </Typography.Link>
                .
              </span>
            }
          >
            <Switch />
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
            label="Managed browser"
            name="useManagedBrowser"
            valuePropName="checked"
            extra={
              <span>
                Reuse your own browser session per
                <Typography.Link
                  href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/identity-based-crawling.md"
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginLeft: 4 }}
                >
                  Crawl4AI managed browser docs
                </Typography.Link>
                .
              </span>
            }
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="User data directory"
            name="userDataDir"
            extra="Absolute path to your Chrome/Edge profile (e.g. ~/.config/chrome-profile)."
          >
            <Input placeholder="/home/me/.crawl4ai/profiles/news" disabled={!useManagedBrowserValue} />
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
          <Card
            title="Browser identity"
            size="small"
            style={{ marginBottom: 16 }}
            extra={
              <Typography.Link
                href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/browser-crawler-config.md"
                target="_blank"
                rel="noreferrer"
              >
                Docs
              </Typography.Link>
            }
          >
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              Override Crawl4AI&apos;s BrowserConfig to send first-party cookies, custom headers, and rotating user
              agents for harder-to-detect crawls.
            </Typography.Paragraph>
            <Form.Item
              label="Custom user agent"
              name="userAgent"
              extra="Leave blank to reuse Crawl4AI defaults."
            >
              <Input placeholder="Mozilla/5.0 ..." maxLength={768} />
            </Form.Item>
            <Form.Item
              label="User agent mode"
              name="userAgentMode"
              extra="Enable Crawl4AI's random generator for every navigation."
            >
              <Select
                allowClear
                placeholder="Default (static)"
                options={[{ value: "random", label: "Random rotation" }]}
              />
            </Form.Item>
            <Form.Item label="Generator platform" name={["userAgentGenerator", "platform"]}>
              <Select
                allowClear
                placeholder="windows / macos / linux / android / ios"
                disabled={userAgentModeValue !== "random"}
                options={[
                  { value: "windows", label: "Windows" },
                  { value: "macos", label: "macOS" },
                  { value: "linux", label: "Linux" },
                  { value: "android", label: "Android" },
                  { value: "ios", label: "iOS" }
                ]}
              />
            </Form.Item>
            <Form.Item label="Generator browser" name={["userAgentGenerator", "browser"]}>
              <Select
                allowClear
                placeholder="chrome / firefox / safari / edge"
                disabled={userAgentModeValue !== "random"}
                options={[
                  { value: "chrome", label: "Chrome" },
                  { value: "firefox", label: "Firefox" },
                  { value: "safari", label: "Safari" },
                  { value: "edge", label: "Edge" }
                ]}
              />
            </Form.Item>
            <Form.Item label="Generator device" name={["userAgentGenerator", "deviceType"]}>
              <Select
                allowClear
                placeholder="desktop / mobile / tablet"
                disabled={userAgentModeValue !== "random"}
                options={[
                  { value: "desktop", label: "Desktop" },
                  { value: "mobile", label: "Mobile" },
                  { value: "tablet", label: "Tablet" }
                ]}
              />
            </Form.Item>
            <Form.Item
              label="Generator locale"
              name={["userAgentGenerator", "locale"]}
              extra="Overrides Accept-Language inside the rotating agent."
            >
              <Input placeholder="en-US" maxLength={16} disabled={userAgentModeValue !== "random"} />
            </Form.Item>
            <Form.Item
              label="Browser locale"
              name="locale"
              extra="Sets navigator.language and Accept-Language headers."
            >
              <Input placeholder="en-US" maxLength={16} />
            </Form.Item>
            <Form.Item
              label="Timezone ID"
              name="timezoneId"
              extra="IANA timezone applied to the Playwright context."
            >
              <Input placeholder="America/New_York" maxLength={64} />
            </Form.Item>
            <Form.Item
              label="Geolocation"
              extra="Latitude / longitude (optional accuracy in meters) forwarded to the browser context."
            >
              <Space wrap>
                <Form.Item name={["geolocation", "latitude"]} noStyle>
                  <InputNumber placeholder="Latitude" min={-90} max={90} step={0.1} style={{ width: 140 }} />
                </Form.Item>
                <Form.Item name={["geolocation", "longitude"]} noStyle>
                  <InputNumber placeholder="Longitude" min={-180} max={180} step={0.1} style={{ width: 140 }} />
                </Form.Item>
                <Form.Item name={["geolocation", "accuracy"]} noStyle>
                  <InputNumber placeholder="Accuracy" min={1} max={5000} step={1} style={{ width: 140 }} />
                </Form.Item>
              </Space>
            </Form.Item>
            <Typography.Title level={5} style={{ marginTop: 16 }}>
              Custom headers
            </Typography.Title>
            <Form.List name="browserHeaders">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: "100%" }}>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" style={{ width: "100%" }}>
                      <Form.Item name={[field.name, "name"]} style={{ flex: 1 }}>
                        <Input placeholder="Header name" />
                      </Form.Item>
                      <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                        <Input placeholder="Header value" />
                      </Form.Item>
                      <Button
                        type="text"
                        icon={<MinusCircleOutlined />}
                        danger
                        onClick={() => remove(field.name)}
                      />
                    </Space>
                  ))}
                  <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} block>
                    Add header
                  </Button>
                </Space>
              )}
            </Form.List>
            <Typography.Title level={5} style={{ marginTop: 24 }}>
              Cookies
            </Typography.Title>
            <Form.List name="browserCookies">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: "100%" }}>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" style={{ width: "100%" }}>
                      <Form.Item name={[field.name, "name"]} style={{ flex: 1 }}>
                        <Input placeholder="Name" />
                      </Form.Item>
                      <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                        <Input placeholder="Value" />
                      </Form.Item>
                      <Form.Item name={[field.name, "domain"]} style={{ flex: 1.3 }}>
                        <Input placeholder="example.com" />
                      </Form.Item>
                      <Form.Item name={[field.name, "path"]} style={{ flex: 1 }}>
                        <Input placeholder="/" />
                      </Form.Item>
                      <Button
                        type="text"
                        icon={<MinusCircleOutlined />}
                        danger
                        onClick={() => remove(field.name)}
                      />
                    </Space>
                  ))}
                  <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} block>
                    Add cookie
                  </Button>
                </Space>
              )}
            </Form.List>
          </Card>
          <Card
            title="Session management"
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
              Provide a Crawl4AI session identifier to reuse the same browser tab across multiple requests,
              and optionally preload cookies/localStorage via a storage_state JSON blob (or a path on the Crawl4AI host).
            </Typography.Paragraph>
            <Form.Item
              label="Session ID"
              name="sessionId"
              extra="Add a human-friendly ID (letters, numbers, hyphen) to reuse this browser state later."
            >
              <Input placeholder="e.g. newsroom-auth-session" maxLength={160} />
            </Form.Item>
            <Form.Item
              label="Storage state (JSON or path)"
              name="storageState"
              extra="Paste Crawl4AI storage_state JSON (cookies/localStorage) or provide an absolute path accessible to the crawler."
            >
              <Input.TextArea rows={4} placeholder="{ &quot;cookies&quot;: [...] }" maxLength={12000} />
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
            label="Threshold mode"
            name={["markdownFilter", "thresholdType"]}
            hidden={markdownFilterType !== "pruning"}
            extra="Choose between fixed or dynamic heuristics per Crawl4AI Fit Markdown guide."
          >
            <Select
              allowClear
              placeholder="dynamic"
              options={[
                { value: "dynamic", label: "Dynamic (auto adjusts per page)" },
                { value: "fixed", label: "Fixed (use provided score)" }
              ]}
            />
          </Form.Item>
          <Form.Item
            label="Min words per block"
            name={["markdownFilter", "minWordThreshold"]}
            hidden={markdownFilterType !== "pruning"}
            extra="Ignore nodes shorter than this count before scoring (Fit Markdown heuristic)."
          >
            <InputNumber min={0} max={500} step={1} style={{ width: "100%" }} placeholder="5" />
          </Form.Item>
          <Card
            size="small"
            title="Clean Markdown"
            style={{ marginBottom: 16 }}
            extra={
              <Typography.Link
                href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/content-selection.md"
                target="_blank"
                rel="noreferrer"
              >
                crawl4ai docs
              </Typography.Link>
            }
          >
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Mirror Crawl4AI&apos;s Clean Markdown recipe to strip nav/footer blocks, remove overlays, and drop short
              fragments for accurately formatted Markdown output (per the{" "}
              <Typography.Link
                href="https://github.com/unclecode/crawl4ai/blob/main/docs/examples/quickstart.ipynb"
                target="_blank"
                rel="noreferrer"
              >
                official quickstart
              </Typography.Link>
              ).
            </Typography.Paragraph>
            <Form.Item
              label="Scoped CSS selector"
              name={["cleanMarkdown", "cssSelector"]}
              extra="Limit Markdown to a single region (e.g. #main-content)."
            >
              <Input placeholder="#main-content" maxLength={512} />
            </Form.Item>
            <Form.Item
              label="Target elements"
              name={["cleanMarkdown", "targetElements"]}
              extra="Provide multiple selectors for multi-column layouts."
            >
              <Select
                mode="tags"
                tokenSeparators={[",", " "]}
                placeholder=".article, .sidebar"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label="Excluded tags"
              name={["cleanMarkdown", "excludedTags"]}
              extra="Drop repeating chrome such as nav, footer, form, aside."
            >
              <Select
                mode="tags"
                tokenSeparators={[",", " "]}
                placeholder="nav, footer, aside"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label="Remove overlay elements"
              name={["cleanMarkdown", "removeOverlayElements"]}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label="Word count threshold"
              name={["cleanMarkdown", "wordCountThreshold"]}
              extra="Ignore fragments below this number of words."
            >
              <InputNumber min={0} max={2000} placeholder="10" style={{ width: "100%" }} />
            </Form.Item>
          </Card>
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
                      label="Dynamic viewport adjustment"
                      name={[field.name, "options", "adjustViewportToContent"]}
                      valuePropName="checked"
                    >
                      <Switch />
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
