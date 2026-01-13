"use client";

import { SearchOutlined } from "@ant-design/icons";
import { gql, useMutation } from "@apollo/client";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  List,
  message,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  Grid
} from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  useCrawlTaskQuery,
  useRetryCrawlTaskMutation,
  type CrawlTaskStatus
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

const statusColors: Record<CrawlTaskStatus, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple"
};

const limitOptions = [
  { value: 10, labelKey: "crawl.detail.results.latest10" },
  { value: 20, labelKey: "crawl.detail.results.latest20" },
  { value: 50, labelKey: "crawl.detail.results.latest50" }
];

interface CrawlMediaSource {
  src?: string;
  srcset?: string;
  type?: string;
  media?: string;
  sizes?: string;
}

interface CrawlMediaItem {
  src?: string;
  alt?: string;
  title?: string;
  desc?: string;
  type?: string;
  format?: string;
  width?: number;
  height?: number;
  score?: number;
  poster?: string;
  sizes?: string;
  srcset?: string[];
  pictureSources?: CrawlMediaSource[];
  responsiveSources?: CrawlMediaSource[];
}

type CrawlMediaCollection = Record<string, CrawlMediaItem[]>;

interface CrawlStoredMediaAsset {
  id: string;
  kind: string;
  sourceUrl: string;
  bytes: number;
  contentType?: string;
  dataUri?: string;
  width?: number;
  height?: number;
  alt?: string;
  title?: string;
  desc?: string;
  poster?: string;
  format?: string;
}

type CrawlResultTableRecord = Record<string, string | number | boolean | null>;
type CrawlResultTablePreviewRow = CrawlResultTableRecord & { key: string };

interface CrawlResultTable {
  id: string;
  caption?: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  columnCount: number;
  source?: string;
  metadata?: Record<string, unknown>;
  dataFrame?: {
    columns: string[];
    rows: CrawlResultTableRecord[];
  };
}

const mediaDocsUrl =
  "https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/link-media.md";
const tableDocsUrl =
  "https://github.com/unclecode/crawl4ai/blob/main/docs/blog/release-v0.7.3.md";
const shortenScript = (value: string) => (value.length > 160 ? `${value.slice(0, 157)}…` : value);

const CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION = gql`
  mutation CreateItemFromCrawlResult($resultId: String!) {
    createItemFromCrawlResult(resultId: $resultId) {
      id
      title
      status
    }
  }
`;

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

function MediaSection({ media }: { media: CrawlMediaCollection | null }) {
  const { t } = useTranslation();
  if (!media) {
    return null;
  }
  const entries = Object.entries(media).filter(
    ([, items]) => Array.isArray(items) && items.length > 0
  );
  if (!entries.length) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.media.title")}
      style={{ marginTop: 12 }}
      extra={
        <Typography.Link href={mediaDocsUrl} target="_blank" rel="noreferrer">
          {t("common.docs")}
        </Typography.Link>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {entries.map(([kind, items]) => {
          const preview = items.slice(0, 4);
          const remaining = Math.max(0, items.length - preview.length);
          return (
            <div key={kind}>
              <Typography.Text strong style={{ textTransform: "capitalize" }}>
                {kind} ({items.length})
              </Typography.Text>
              <List
                size="small"
                split={false}
                style={{ marginTop: 8 }}
                dataSource={preview}
                renderItem={(item, index) => (
                  <List.Item key={`${kind}-${index}-${item.src ?? "media"}`}>
                <Space align="start">
                      {renderMediaPreview(kind, item, t)}
                      <Space direction="vertical" size={4}>
                        <Typography.Link href={item.src} target="_blank">
                          {item.src ?? t("crawl.detail.media.viewAsset")}
                        </Typography.Link>
                        {item.alt || item.title ? (
                          <Typography.Text strong>
                            {item.alt ?? item.title}
                          </Typography.Text>
                        ) : null}
                        {item.desc ? (
                          <Typography.Paragraph style={{ marginBottom: 4 }}>
                            {item.desc}
                          </Typography.Paragraph>
                        ) : null}
                        <Typography.Text type="secondary">
                          {[item.type, item.format, formatDimensions(item), formatScore(item, t)]
                            .filter(Boolean)
                            .join(" • ")}
                        </Typography.Text>
                        {item.srcset ? renderSrcset(item.srcset, t) : null}
                        {renderSourceList(
                          t("crawl.detail.media.sourceTypes.picture"),
                          item.pictureSources,
                          t
                        )}
                        {renderSourceList(
                          t("crawl.detail.media.sourceTypes.responsive"),
                          item.responsiveSources,
                          t
                        )}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
              {remaining > 0 ? (
                <Typography.Text type="secondary">
                  {t("crawl.detail.media.more", { count: remaining, kind })}
                </Typography.Text>
              ) : null}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

function StoredMediaSection({ assets }: { assets: CrawlStoredMediaAsset[] | null }) {
  const { t } = useTranslation();
  if (!assets || assets.length === 0) {
    return null;
  }
  return (
    <Card size="small" title={t("crawl.detail.media.storedTitle")} style={{ marginTop: 12 }}>
      <List
        size="small"
        split={false}
        dataSource={assets}
        renderItem={(asset) => (
          <List.Item key={`${asset.id}-${asset.sourceUrl}`}>
            <Space align="start">
              {renderStoredMediaPreview(asset)}
              <Space direction="vertical" size={4}>
                <Typography.Text strong>{asset.title ?? asset.alt ?? asset.kind}</Typography.Text>
                <Typography.Text type="secondary">
                  {(asset.contentType ?? t("crawl.detail.media.unknownMime")).toUpperCase()} • {formatBytes(asset.bytes)}
                </Typography.Text>
                <Typography.Paragraph style={{ marginBottom: 4 }}>
                  {asset.desc ?? asset.sourceUrl}
                </Typography.Paragraph>
                <Space size="small">
                  <Typography.Link href={asset.sourceUrl} target="_blank" rel="noreferrer">
                    {t("common.source")}
                  </Typography.Link>
                  {asset.dataUri ? (
                    <Typography.Link
                      href={asset.dataUri}
                      download={`${asset.kind}-${asset.id}`}
                      rel="noreferrer"
                    >
                      {t("common.download")}
                    </Typography.Link>
                  ) : null}
                </Space>
              </Space>
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );
}

function buildTableRecords(table: CrawlResultTable): CrawlResultTableRecord[] {
  if (table.dataFrame?.rows?.length) {
    return table.dataFrame.rows;
  }
  return table.rows.map((row) =>
    table.headers.reduce<CrawlResultTableRecord>((acc, header, index) => {
      acc[header] = row[index] ?? null;
      return acc;
    }, {})
  );
}

function TablesSection({ tables }: { tables: CrawlResultTable[] | null }) {
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  if (!tables || !tables.length) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.tables.title")}
      style={{ marginTop: 12 }}
      extra={
        <Typography.Link href={tableDocsUrl} target="_blank" rel="noreferrer">
          {t("crawl.detail.tables.releaseNotes")}
        </Typography.Link>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {tables.map((table) => {
          const columns = (table.dataFrame?.columns ?? table.headers).map((header) => ({
            title: header,
            dataIndex: header,
            key: header,
            ellipsis: true
          }));
          const records = buildTableRecords(table);
          const previewRows: CrawlResultTablePreviewRow[] = records
            .slice(0, 5)
            .map((record, index) => ({
              key: `${table.id}-${index}`,
              ...record
            }));
          const remaining = Math.max(0, table.rowCount - previewRows.length);
          return (
            <div key={table.id}>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Space wrap>
                  <Typography.Text strong>
                    {table.caption || t("crawl.detail.tables.defaultTitle", { id: table.id })}
                  </Typography.Text>
                  <Tag>
                    {table.rowCount} × {table.columnCount}
                  </Tag>
                  {table.source && (
                    <Typography.Text type="secondary">
                      {t("crawl.detail.tables.source", { source: table.source })}
                    </Typography.Text>
                  )}
                </Space>
                {table.metadata && (
                  <Typography.Text type="secondary">
                    {JSON.stringify(table.metadata)}
                  </Typography.Text>
                )}
              </Space>
              {!screens.md ? (
                <List
                  dataSource={previewRows}
                  size="small"
                  style={{ marginTop: 8 }}
                  renderItem={(item, i) => (
                    <List.Item>
                      <List.Item.Meta
                        title={`${t("common.row")} ${i + 1}`}
                        description={
                          <Space direction="vertical" size={0}>
                            {columns.slice(0, 3).map((col) => (
                              <div key={col.key}>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  {col.title}:
                                </Typography.Text>{" "}
                                <Typography.Text style={{ fontSize: 12 }}>
                                  {String(item[col.dataIndex] ?? "")}
                                </Typography.Text>
                              </div>
                            ))}
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
              ) : (
                <Table
                  columns={columns}
                  dataSource={previewRows}
                  size="small"
                  pagination={false}
                  style={{ marginTop: 8 }}
                  scroll={{ x: true }}
                />
              )}
              {remaining > 0 && (
                <Typography.Text type="secondary">
                  {t("crawl.detail.tables.remaining", {
                    preview: previewRows.length,
                    remaining
                  })}
                </Typography.Text>
              )}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

function renderMediaPreview(
  kind: string,
  item: CrawlMediaItem,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (!item.src) {
    return null;
  }
  const normalized = kind.toLowerCase();
  if (normalized.includes("image")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.src}
        alt={item.alt || item.title || t("crawl.detail.media.thumbnailAlt")}
        style={{
          width: 96,
          height: 96,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid #f0f0f0"
        }}
        loading="lazy"
      />
    );
  }
  if (normalized.includes("video")) {
    return (
      <video
        src={item.src}
        poster={item.poster}
        controls
        style={{ width: 160, borderRadius: 8 }}
      />
    );
  }
  if (normalized.includes("audio")) {
    return <audio src={item.src} controls style={{ minWidth: 160 }} />;
  }
  return null;
}

function renderStoredMediaPreview(asset: CrawlStoredMediaAsset) {
  if (asset.dataUri && asset.contentType?.startsWith("image/")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={asset.dataUri}
        alt={asset.alt ?? asset.title ?? asset.kind}
        style={{
          width: 96,
          height: 96,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid #f0f0f0"
        }}
        loading="lazy"
      />
    );
  }
  if (asset.dataUri && asset.contentType?.startsWith("video/")) {
    return (
      <video
        src={asset.dataUri}
        controls
        style={{ width: 160, borderRadius: 8 }}
        preload="metadata"
      />
    );
  }
  return (
    <div className="media-thumb" style={{ width: 80, height: 80 }}>
      {asset.kind.slice(0, 2).toUpperCase()}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDimensions(item: CrawlMediaItem) {
  if (item.width && item.height) {
    return `${item.width}×${item.height}px`;
  }
  return undefined;
}

function formatScore(
  item: CrawlMediaItem,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (typeof item.score === "number") {
    return t("crawl.detail.media.score", { score: item.score.toFixed(2) });
  }
  return undefined;
}

function renderSrcset(
  srcset: string[],
  t: (key: string, options?: Record<string, unknown>) => string
) {
  return (
    <div>
      <Typography.Text type="secondary">{t("crawl.detail.media.srcsetVariants")}</Typography.Text>
      <pre
        style={{
          background: "#fafafa",
          padding: 8,
          borderRadius: 4,
          maxWidth: 520,
          whiteSpace: "pre-wrap"
        }}
      >
        {srcset.join("\n")}
      </pre>
    </div>
  );
}

function renderSourceList(
  label: string,
  sources: CrawlMediaSource[] | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (!sources || sources.length === 0) {
    return null;
  }
  return (
    <div>
      <Typography.Text type="secondary">
        {t("crawl.detail.media.sources", { label, count: sources.length })}
      </Typography.Text>
      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
        {sources.slice(0, 4).map((source, index) => (
          <li key={`${label}-${index}`}>
            <code>{source.srcset ?? source.src}</code>
            {source.type ? ` • ${source.type}` : ""}
            {source.media ? ` • ${source.media}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CrawlTaskDetail({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const canCreateItem = canView && permissions.includes("items.write");
  const redactedLabel = t("common.redacted");
  const [resultLimit, setResultLimit] = useState(20);
  const [resultSearch, setResultSearch] = useState<string>();
  const [resultSearchInput, setResultSearchInput] = useState("");
  const { data, loading, refetch } = useCrawlTaskQuery({
    variables: {
      id: taskId,
      resultLimit,
      resultSearch: resultSearch ?? null
    },
    fetchPolicy: "network-only",
    skip: !canView
  });

  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();
  const [ingestingResultId, setIngestingResultId] = useState<string | null>(null);
  const [createItemFromCrawlResult, { loading: ingesting }] = useMutation<{
    createItemFromCrawlResult: { id: string; title: string; status: string };
  }>(CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION);

  const task = data?.crawlTask ?? null;
  const config = useMemo(() => {
    if (!task?.config) {
      return null;
    }
    try {
      return JSON.parse(task.config) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [task?.config]);

  const proxySummary = useMemo(() => {
    if (!config) {
      return t("crawl.detail.proxy.direct");
    }
    const proxyUrl =
      typeof config.proxyUrl === "string" && config.proxyUrl.length > 0 ? config.proxyUrl : null;
    const proxyConfig = config.proxyConfig as
      | { server?: string; username?: string; password?: string }
      | undefined;
    if (proxyConfig?.server) {
      return t("crawl.detail.proxy.dict", {
        server: proxyConfig.server,
        user: proxyConfig.username ?? null
      });
    }
    if (proxyUrl) {
      return proxyUrl === "[REDACTED]" ? redactedLabel : proxyUrl;
    }
    return t("crawl.detail.proxy.direct");
  }, [config, redactedLabel, t]);

  const markdownOptions = useMemo(() => {
    if (!config || typeof config.markdownOptions !== "object") {
      return null;
    }
    return config.markdownOptions as Record<string, unknown>;
  }, [config]);

  const markdownFilter = useMemo(() => {
    if (!config || typeof config.markdownFilter !== "object") {
      return null;
    }
    return config.markdownFilter as Record<string, unknown>;
  }, [config]);

  const markdownStrategy = useMemo(() => {
    if (!config || typeof config.markdownStrategy !== "object" || !config.markdownStrategy) {
      return null;
    }
    return config.markdownStrategy as Record<string, unknown>;
  }, [config]);

  const cleanMarkdownOptions = useMemo(() => {
    if (!config || typeof config.cleanMarkdown !== "object" || !config.cleanMarkdown) {
      return null;
    }
    return config.cleanMarkdown as Record<string, unknown>;
  }, [config]);

  const markdownSummary = useMemo(() => {
    if (!markdownOptions) {
      return t("crawl.detail.markdown.default");
    }
    const parts: string[] = [];
    if (typeof markdownOptions.contentSource === "string") {
      parts.push(t("crawl.detail.markdown.source", { source: markdownOptions.contentSource }));
    }
    if (typeof markdownOptions.ignoreLinks === "boolean") {
      parts.push(
        markdownOptions.ignoreLinks
          ? t("crawl.detail.markdown.ignoreLinks")
          : t("crawl.detail.markdown.keepLinks")
      );
    }
    if (typeof markdownOptions.escapeHtml === "boolean") {
      parts.push(
        markdownOptions.escapeHtml
          ? t("crawl.detail.markdown.escapeHtml")
          : t("crawl.detail.markdown.renderHtml")
      );
    }
    if (typeof markdownOptions.bodyWidth === "number") {
      parts.push(t("crawl.detail.markdown.wrap", { width: markdownOptions.bodyWidth }));
    }
    return parts.length ? parts.join(" • ") : t("crawl.detail.markdown.default");
  }, [markdownOptions, t]);

  const markdownFilterSummary = useMemo(() => {
    if (!markdownFilter || typeof markdownFilter.type !== "string") {
      return t("common.disabled");
    }
    const parts = [markdownFilter.type];
    if (typeof markdownFilter.threshold === "number") {
      parts.push(t("crawl.detail.markdownFilter.threshold", { value: markdownFilter.threshold }));
    }
    const thresholdTypeValue =
      typeof markdownFilter.thresholdType === "string"
        ? markdownFilter.thresholdType
        : typeof markdownFilter.threshold_type === "string"
          ? (markdownFilter.threshold_type as string)
          : undefined;
    if (thresholdTypeValue) {
      parts.push(t("crawl.detail.markdownFilter.mode", { mode: thresholdTypeValue }));
    }
    const minWordValue =
      typeof markdownFilter.minWordThreshold === "number"
        ? markdownFilter.minWordThreshold
        : typeof markdownFilter.min_word_threshold === "number"
          ? (markdownFilter.min_word_threshold as number)
          : undefined;
    if (typeof minWordValue === "number") {
      parts.push(t("crawl.detail.markdownFilter.minWords", { count: minWordValue }));
    }
    return parts.join(" • ");
  }, [markdownFilter, t]);

  const markdownStrategySummary = useMemo(() => {
    if (!markdownStrategy || typeof markdownStrategy.type !== "string") {
      return t("crawl.detail.markdownStrategy.default");
    }
    const type = markdownStrategy.type;
    const params =
      markdownStrategy.params && typeof markdownStrategy.params === "object"
        ? (markdownStrategy.params as Record<string, unknown>)
        : undefined;
    if (!params) {
      return type;
    }
    const json = JSON.stringify(params);
    const snippet = json.length > 80 ? `${json.slice(0, 80)}...` : json;
    return t("crawl.detail.markdownStrategy.withParams", { type, snippet });
  }, [markdownStrategy, t]);

  const cleanMarkdownSummary = useMemo(() => {
    if (!cleanMarkdownOptions) {
      return t("common.disabled");
    }
    const parts: string[] = [];
    if (typeof cleanMarkdownOptions.cssSelector === "string" && cleanMarkdownOptions.cssSelector.trim().length) {
      parts.push(t("crawl.detail.cleanMarkdown.scope", { selector: cleanMarkdownOptions.cssSelector }));
    }
    if (Array.isArray(cleanMarkdownOptions.targetElements) && cleanMarkdownOptions.targetElements.length) {
      parts.push(
        t("crawl.detail.cleanMarkdown.targets", {
          targets: cleanMarkdownOptions.targetElements.join(", ")
        })
      );
    }
    if (Array.isArray(cleanMarkdownOptions.excludedTags) && cleanMarkdownOptions.excludedTags.length) {
      parts.push(
        t("crawl.detail.cleanMarkdown.excluded", {
          tags: cleanMarkdownOptions.excludedTags.join(", ")
        })
      );
    }
    if (typeof cleanMarkdownOptions.wordCountThreshold === "number") {
      parts.push(
        t("crawl.detail.cleanMarkdown.minWords", {
          count: cleanMarkdownOptions.wordCountThreshold
        })
      );
    }
    if (typeof cleanMarkdownOptions.removeOverlayElements === "boolean") {
      parts.push(
        cleanMarkdownOptions.removeOverlayElements
          ? t("crawl.detail.cleanMarkdown.removeOverlays")
          : t("crawl.detail.cleanMarkdown.keepOverlays")
      );
    }
    return parts.length ? parts.join(" • ") : t("common.enabled");
  }, [cleanMarkdownOptions, t]);

  const browserHeaders = useMemo(() => {
    if (!Array.isArray(config?.browserHeaders)) {
      return [] as string[];
    }
    return (config?.browserHeaders as { name?: string; value?: string }[])
      .map((header) => {
        const name = typeof header?.name === "string" ? header.name : "";
        const value = typeof header?.value === "string" ? header.value : "";
        if (!name || !value) {
          return null;
        }
        return `${name}: ${value}`;
      })
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  const browserCookies = useMemo(() => {
    if (typeof config?.browserCookies === "string") {
      return config.browserCookies === "[REDACTED]" ? [redactedLabel] : [];
    }
    if (!Array.isArray(config?.browserCookies)) {
      return [] as string[];
    }
    return (config?.browserCookies as { name?: string; value?: string; domain?: string; path?: string }[])
      .map((cookie) => {
        const name = typeof cookie?.name === "string" ? cookie.name : "";
        const value = typeof cookie?.value === "string" ? cookie.value : "";
        const domain = typeof cookie?.domain === "string" ? cookie.domain : "";
        const path = typeof cookie?.path === "string" ? cookie.path : "";
        if (!name || !value || !domain) {
          return null;
        }
        const target = path ? `${domain}${path}` : domain;
        return `${name}=${value} @ ${target}`;
      })
      .filter((entry): entry is string => Boolean(entry));
  }, [config, redactedLabel]);

  const managedBrowserProfile = useMemo(() => {
    if (!config || typeof config.userDataDir !== "string") {
      return null;
    }
    const trimmed = config.userDataDir.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const userAgentValue = useMemo(() => {
    if (!config || typeof config.userAgent !== "string") {
      return null;
    }
    const trimmed = config.userAgent.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const userAgentModeSummary =
    config?.userAgentMode === "random"
      ? t("crawl.detail.userAgent.random")
      : t("crawl.detail.userAgent.default");

  const userAgentGeneratorSummary = useMemo(() => {
    if (!config || typeof config.userAgentGenerator !== "object" || !config.userAgentGenerator) {
      return null;
    }
    const generator = config.userAgentGenerator as Record<string, unknown>;
    const parts: string[] = [];
    const platform = typeof generator.platform === "string" ? generator.platform : null;
    if (platform) {
      parts.push(t("crawl.detail.userAgentGenerator.platform", { value: platform }));
    }
    const browser = typeof generator.browser === "string" ? generator.browser : null;
    if (browser) {
      parts.push(t("crawl.detail.userAgentGenerator.browser", { value: browser }));
    }
    const deviceType = typeof generator.deviceType === "string" ? generator.deviceType : null;
    if (deviceType) {
      parts.push(t("crawl.detail.userAgentGenerator.device", { value: deviceType }));
    }
    const locale = typeof generator.locale === "string" ? generator.locale : null;
    if (locale) {
      parts.push(t("crawl.detail.userAgentGenerator.locale", { value: locale }));
    }
    return parts.length ? parts.join(" • ") : null;
  }, [config, t]);

  const browserLocale = useMemo(() => {
    if (!config || typeof config.locale !== "string") {
      return null;
    }
    const trimmed = config.locale.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const timezonePreference = useMemo(() => {
    if (!config || typeof config.timezoneId !== "string") {
      return null;
    }
    const trimmed = config.timezoneId.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const geolocationSummary = useMemo(() => {
    if (!config || typeof config.geolocation !== "object" || !config.geolocation) {
      return null;
    }
    const geo = config.geolocation as Record<string, unknown>;
    const lat = typeof geo.latitude === "number" ? geo.latitude : null;
    const lon = typeof geo.longitude === "number" ? geo.longitude : null;
    if (lat == null || lon == null) {
      return null;
    }
    const accuracy = typeof geo.accuracy === "number" ? geo.accuracy : null;
    const location = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return accuracy != null ? `${location} (±${Math.round(accuracy)}m)` : location;
  }, [config]);

  const dynamicJsSteps = useMemo(() => {
    if (!config) {
      return [] as string[];
    }
    if (Array.isArray(config.jsCode)) {
      return (config.jsCode as string[]).filter((entry) => typeof entry === "string");
    }
    if (typeof config.jsCode === "string") {
      const trimmed = config.jsCode.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }, [config]);

  const waitCondition = useMemo(() => {
    if (!config) {
      return null;
    }
    if (typeof config.waitForScript === "string" && config.waitForScript.trim().length) {
      return `js:${config.waitForScript.trim()}`;
    }
    if (typeof config.waitForSelector === "string" && config.waitForSelector.trim().length) {
      return config.waitForSelector.trim();
    }
    return null;
  }, [config]);

  const waitTimeoutMs = typeof config?.waitForTimeoutMs === "number" ? config.waitForTimeoutMs : null;
  const sessionIdentifier = useMemo(() => {
    if (!config) {
      return null;
    }
    const raw = typeof config.sessionId === "string" ? config.sessionId.trim() : "";
    return raw.length ? raw : null;
  }, [config]);
  const storageStatePreview = useMemo(() => {
    if (!config) {
      return null;
    }
    const raw = typeof config.storageState === "string" ? config.storageState.trim() : "";
    if (raw === "[REDACTED]") {
      return redactedLabel;
    }
    return raw.length ? shortenScript(raw) : null;
  }, [config, redactedLabel]);
  const jsOnlyMode = Boolean(config?.jsOnly);

  const linkOverview = useMemo(() => {
    const analyses =
      task?.results
        ?.map((result) => result.linkAnalysis)
        .filter((analysis): analysis is NonNullable<typeof analysis> => Boolean(analysis)) ?? [];
    if (!analyses.length) {
      return null;
    }
    const totalLinks = analyses.reduce((sum, analysis) => sum + analysis.stats.totalLinks, 0);
    const internalLinks = analyses.reduce((sum, analysis) => sum + analysis.stats.internalLinks, 0);
    const externalLinks = analyses.reduce((sum, analysis) => sum + analysis.stats.externalLinks, 0);
    const highQualityLinks = analyses.reduce(
      (sum, analysis) => sum + (analysis.stats.highQualityLinks ?? 0),
      0
    );
    const lowQualityLinks = analyses.reduce(
      (sum, analysis) => sum + (analysis.stats.lowQualityLinks ?? 0),
      0
    );
    const weightedIntrinsic = analyses.reduce((sum, analysis) => {
      const avg = analysis.stats.averageIntrinsicScore ?? 0;
      return sum + avg * analysis.stats.totalLinks;
    }, 0);
    const averageIntrinsic =
      totalLinks > 0 ? Number((weightedIntrinsic / totalLinks).toFixed(2)) : null;
    const aggregateLinks = <T,>(items: T[]) => {
      const seen = new Set<string>();
      const ordered: T[] = [];
      for (const item of items) {
        const link = item as { href?: string };
        const key = link.href ?? JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(item);
        }
      }
      return ordered;
    };
    const scoreOf = (link: {
      totalScore?: number | null;
      contextualScore?: number | null;
      intrinsicScore?: number | null;
    }) => link.totalScore ?? link.contextualScore ?? link.intrinsicScore ?? 0;
    const topLinks = aggregateLinks(
      analyses.flatMap((analysis) => analysis.topLinks ?? [])
    )
      .sort((a, b) => scoreOf(b) - scoreOf(a))
      .slice(0, 5);
    const lowLinks = aggregateLinks(
      analyses.flatMap((analysis) => analysis.lowQualityLinks ?? [])
    )
      .sort(
        (a, b) =>
          (a.intrinsicScore ?? Number.POSITIVE_INFINITY) -
          (b.intrinsicScore ?? Number.POSITIVE_INFINITY)
      )
      .slice(0, 5);
    const bucketMap = new Map<
      string,
      { count: number; links: NonNullable<(typeof analyses)[number]["topLinks"]> }
    >();
    analyses.forEach((analysis) => {
      analysis.buckets.forEach((bucket) => {
        const existing = bucketMap.get(bucket.kind);
        if (existing) {
          existing.count += bucket.links.length;
          existing.links.push(...bucket.links);
        } else {
          bucketMap.set(bucket.kind, { count: bucket.links.length, links: [...bucket.links] });
        }
      });
    });
    const buckets = Array.from(bucketMap.entries()).map(([kind, value]) => ({
      kind,
      count: value.count,
      samples: value.links.slice(0, 4)
    }));
    return {
      stats: {
        totalLinks,
        internalLinks,
        externalLinks,
        highQualityLinks,
        lowQualityLinks,
        averageIntrinsic
      },
      topLinks,
      lowLinks,
      buckets
    };
  }, [task?.results]);

  const getLinkScore = (link: {
    totalScore?: number | null;
    contextualScore?: number | null;
    intrinsicScore?: number | null;
  }) => link.totalScore ?? link.contextualScore ?? link.intrinsicScore ?? 0;

  const additionalUrls = useMemo(() => {
    if (!config || !Array.isArray(config.additionalUrls)) {
      return [];
    }
    return config.additionalUrls
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  interface MultiUrlConfigView {
    name?: string;
    matcher?: {
      matchMode?: string;
      patterns?: string[];
    };
    urls?: string[];
    options?: Record<string, unknown>;
  }

  const multiConfigs: MultiUrlConfigView[] = useMemo(() => {
    if (!config || !Array.isArray(config.multiUrlConfigs)) {
      return [];
    }
    return config.multiUrlConfigs.filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null
    );
  }, [config]);

  const handleRetry = async () => {
    if (!task) return;
    try {
      await retryTask({ variables: { id: task.id } });
      message.success(t("crawl.detail.retryQueued"));
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? t("crawl.detail.retryFailed"));
    }
  };

  const handleCreateItem = async (resultId: string) => {
    if (!canCreateItem) {
      return;
    }

    const normalizedId = resultId.trim();
    if (!normalizedId) {
      message.error(t("common.invalidInput", { defaultValue: "Invalid input." }));
      return;
    }

    setIngestingResultId(normalizedId);
    try {
      const response = await createItemFromCrawlResult({
        variables: { resultId: normalizedId }
      });
      const createdId = response.data?.createItemFromCrawlResult?.id;
      message.success(
        t("crawl.detail.ingestQueued", {
          defaultValue: "Queued for LLM processing and added to Items."
        })
      );
      if (createdId) {
        router.push(`/items/${createdId}`);
      }
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed", { defaultValue: "Operation failed." })
      );
    } finally {
      setIngestingResultId(null);
    }
  };

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Typography.Text type="secondary">{t("common.loading", { defaultValue: "Loading..." })}</Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("crawl.detail.title", { defaultValue: "Crawl Task" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  if (loading && !task) {
    return (
      <div className="content-card" style={{ textAlign: "center" }}>
        <Spin />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="content-card">
        <Typography.Text type="secondary">{t("crawl.detail.notFound")}</Typography.Text>
      </div>
    );
  }

  const results = task.results ?? [];
  const includeImagesEnabled = Boolean(config?.includeImages);
  const storeMediaEnabled = Boolean(config?.storeMedia);
  const adjustViewportEnabled = Boolean(config?.adjustViewportToContent);
  const managedBrowserEnabled = Boolean(config?.useManagedBrowser);

  return (
    <div className="content-card">
      <Space style={{ marginBottom: 16 }} wrap>
        <Link href="/admin/ops/crawl-tasks">{t("crawl.detail.backToTasks")}</Link>
        <Tag color={statusColors[task.status]}>
          {t(`crawl.status.${task.status}`, { defaultValue: task.status })}
        </Tag>
        {canManage ? (
          <Button onClick={handleRetry} loading={retrying}>
            {t("crawl.detail.retry")}
          </Button>
        ) : null}
        <Typography.Link href={task.targetUrl} target="_blank" rel="noreferrer">
          {t("crawl.detail.openSource")}
        </Typography.Link>
      </Space>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label={t("crawl.detail.fields.displayName")}>
          {task.displayName ?? task.targetUrl}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.keywords")}>
          {task.keywords.length ? (
            <Space wrap>
              {task.keywords.map((keyword) => (
                <Tag key={keyword}>{keyword}</Tag>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.concurrency")}>
          {task.concurrency}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.includeImages")}>
          {includeImagesEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.storeMedia")}>
          {storeMediaEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.runCount")}>{task.runCount}</Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.scanFullPage")}>
        {config?.scanFullPage
          ? t("crawl.detail.scanFullPageEnabled", { delay: config?.scrollDelayMs ?? 200 })
          : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.adjustViewport")}>
        {adjustViewportEnabled ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.undetectedBrowser")}>
        {config?.enableUndetectedBrowser ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.stealthMode")}>
        {config?.enableStealthMode ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.managedBrowser")}>
        {managedBrowserEnabled ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.userDataDir")}>
        {managedBrowserProfile ?? t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.simulateUser")}>
        {config?.simulateUser ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.overrideNavigator")}>
        {config?.overrideNavigator ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.userAgent")}>
        {userAgentValue ?? t("crawl.detail.userAgent.default")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.userAgentMode")}>{userAgentModeSummary}</Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.uaGenerator")}>
        {userAgentGeneratorSummary ?? t("crawl.detail.userAgent.notConfigured")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.browserLocale")}>
        {browserLocale ?? t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.timezone")}>
        {timezonePreference ?? t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.geolocation")}>
        {geolocationSummary ?? t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.customHeaders")}>
        {browserHeaders.length ? (
          <Space direction="vertical" size={0}>
            {browserHeaders.map((header) => (
              <Typography.Text key={header} style={{ fontFamily: "monospace" }}>
                {header}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.cookies")}>
        {browserCookies.length ? (
          <Space direction="vertical" size={0}>
            {browserCookies.map((cookie) => (
              <Typography.Text key={cookie} style={{ fontFamily: "monospace" }}>
                {cookie}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.sessionId")}>
        {sessionIdentifier ?? t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.storageState")}>
        {storageStatePreview ? (
          <Typography.Text code>{storageStatePreview}</Typography.Text>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.jsOnly")}>
        {jsOnlyMode ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.jsSteps")}>
        {dynamicJsSteps.length ? (
          <Space direction="vertical" size={0}>
            {dynamicJsSteps.map((snippet, index) => (
              <Typography.Text key={`js-${index}`} style={{ fontFamily: "monospace" }}>
                {shortenScript(snippet)}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.waitCondition")}>
        {waitCondition ? shortenScript(waitCondition) : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.waitTimeout")}>
        {waitTimeoutMs ? t("crawl.detail.waitTimeoutValue", { value: waitTimeoutMs }) : t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.proxyRoute")}>{proxySummary}</Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.additionalUrls")}>
        {additionalUrls.length ? (
          <Space wrap>
            {additionalUrls.map((url) => (
              <Typography.Link key={url} href={url} target="_blank" rel="noreferrer">
                {url}
              </Typography.Link>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.markdownGenerator")}>{markdownSummary}</Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.markdownStrategy")}>{markdownStrategySummary}</Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.markdownFilter")}>{markdownFilterSummary}</Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.cleanMarkdown")}>{cleanMarkdownSummary}</Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.lastServerMemory")}>
        {task.lastServerMemoryMb != null ? t("crawl.detail.memoryValue", { value: task.lastServerMemoryMb }) : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.lastPeakMemory")}>
        {task.lastPeakMemoryMb != null ? t("crawl.detail.memoryValue", { value: task.lastPeakMemoryMb }) : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.lastMemoryEfficiency")}>
        {task.lastMemoryEfficiency != null ? t("crawl.detail.percentValue", { value: task.lastMemoryEfficiency }) : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.serverMemory")}>
        {task.memoryStats?.serverMemoryMb != null ? t("crawl.detail.memoryValue", { value: task.memoryStats.serverMemoryMb }) : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.peakMemory")}>
        {task.memoryStats?.peakMemoryMb != null ? t("crawl.detail.memoryValue", { value: task.memoryStats.peakMemoryMb }) : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.efficiency")}>
        {task.memoryStats?.efficiencyPercent != null ? t("crawl.detail.percentValue", { value: task.memoryStats.efficiencyPercent }) : t("common.emptyValue")}
      </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastSuccess")}>
          {task.lastSuccessAt
            ? formatDateTime(task.lastSuccessAt, locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
              })
            : t("common.never")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastError")}>
          {task.lastError ?? t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.configuration")}>
          {config ? (
            <pre className="markdown-preview">{JSON.stringify(config, null, 2)}</pre>
          ) : (
            t("crawl.detail.default")
          )}
        </Descriptions.Item>
      </Descriptions>

      {multiConfigs.length ? (
        <Card title={t("crawl.multiUrl.title")} style={{ marginTop: 24 }}>
          <List
            dataSource={multiConfigs}
            renderItem={(item, index) => {
              const matcher = item?.matcher;
              const urls = Array.isArray(item?.urls) ? item.urls : [];
              const options = item?.options ?? {};
              return (
                <List.Item key={item?.name ?? `strategy-${index}`}>
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>
                      {item?.name ?? t("crawl.multiUrl.strategyTitle", { index: index + 1 })}
                    </Typography.Text>
                    {matcher?.patterns?.length ? (
                      <Typography.Text type="secondary">
                        {t("crawl.detail.multiUrl.patterns", {
                          mode: matcher.matchMode ?? "glob",
                          patterns: matcher.patterns.join(", ")
                        })}
                      </Typography.Text>
                    ) : null}
                    {urls.length ? (
                      <Space wrap>
                        {urls.map((url) => (
                          <Typography.Link key={url} href={url} target="_blank" rel="noreferrer">
                            {url}
                          </Typography.Link>
                        ))}
                      </Space>
                    ) : null}
                    {Object.keys(options).length ? (
                      <Typography.Text>
                        {t("crawl.detail.multiUrl.overrides", {
                          overrides: Object.entries(options)
                            .map(([key, value]) => `${key}=${String(value)}`)
                            .join(", ")
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
      ) : null}

      {linkOverview ? (
        <Card title={t("crawl.links.title")} style={{ marginTop: 24 }}>
          <Space size="large" wrap>
            {[
              { label: t("crawl.links.stats.total"), value: linkOverview.stats.totalLinks },
              { label: t("crawl.links.stats.internal"), value: linkOverview.stats.internalLinks },
              { label: t("crawl.links.stats.external"), value: linkOverview.stats.externalLinks },
              { label: t("crawl.links.stats.highQuality"), value: linkOverview.stats.highQualityLinks },
              { label: t("crawl.links.stats.needsReview"), value: linkOverview.stats.lowQualityLinks },
              {
                label: t("crawl.links.stats.avgIntrinsic"),
                value:
                  linkOverview.stats.averageIntrinsic !== null &&
                  linkOverview.stats.averageIntrinsic !== undefined
                    ? linkOverview.stats.averageIntrinsic.toFixed(2)
                    : t("common.emptyValue")
              }
            ].map((item) => (
              <Space key={item.label} direction="vertical" size={0}>
                <Typography.Text type="secondary">{item.label}</Typography.Text>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {item.value}
                </Typography.Title>
              </Space>
            ))}
          </Space>
          {linkOverview.buckets.length ? (
            <>
              <Typography.Text strong style={{ display: "block", marginTop: 16 }}>
                {t("crawl.links.buckets")}
              </Typography.Text>
              <Space wrap>
                {linkOverview.buckets.map((bucket) => (
                  <Tag key={bucket.kind}>
                    {t("crawl.links.bucketItem", { kind: bucket.kind, count: bucket.count })}
                  </Tag>
                ))}
              </Space>
            </>
          ) : null}
          <Space align="start" size="large" style={{ marginTop: 16 }} wrap>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>{t("crawl.links.topLinks")}</Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.topLinks}
                locale={{ emptyText: t("crawl.links.emptyScored") }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {t("crawl.links.linkScore", {
                          domain: (link.baseDomain ?? "link").toString(),
                          score: getLinkScore(link).toFixed(2)
                        })}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>{t("crawl.links.lowQuality")}</Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.lowLinks}
                locale={{ emptyText: t("crawl.links.emptyLowQuality") }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {t("crawl.links.intrinsicScore", {
                          domain: (link.baseDomain ?? "link").toString(),
                          score: (link.intrinsicScore ?? 0).toFixed(2)
                        })}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          </Space>
        </Card>
      ) : null}

      <Card
        title={t("crawl.detail.results.title")}
        style={{ marginTop: 24 }}
        extra={
          <Space>
            <Space.Compact style={{ width: 260 }}>
              <Input
                placeholder={t("crawl.detail.results.searchPlaceholder")}
                allowClear
                value={resultSearchInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setResultSearchInput(value);
                  if (!value) {
                    setResultSearch(undefined);
                  }
                }}
                onPressEnter={() => {
                  const nextValue = resultSearchInput.trim();
                  setResultSearch(nextValue || undefined);
                  setResultSearchInput(nextValue);
                }}
              />
              <Button
                icon={<SearchOutlined />}
                aria-label={t("crawl.detail.results.searchPlaceholder")}
                onClick={() => {
                  const nextValue = resultSearchInput.trim();
                  setResultSearch(nextValue || undefined);
                  setResultSearchInput(nextValue);
                }}
              />
            </Space.Compact>
            <Select
              value={resultLimit}
              style={{ width: 140 }}
              onChange={setResultLimit}
              options={limitOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey)
              }))}
            />
          </Space>
        }
      >
        {loading ? (
          <Spin />
        ) : (
          <List
            dataSource={results}
            locale={{ emptyText: t("crawl.detail.results.empty") }}
            renderItem={(result) => {
              const metadata = result.metadata;
              const mediaPayload = safeParseJson<CrawlMediaCollection>(result.media);
              const storedAssets = safeParseJson<CrawlStoredMediaAsset[]>(result.mediaAssets);
              const tablesPayload = (result.tables ?? null) as CrawlResultTable[] | null;
              const variantEntries = [
                { key: "raw", label: t("crawl.detail.results.variants.raw"), content: result.markdown },
                {
                  key: "citations",
                  label: t("crawl.detail.results.variants.citations"),
                  content: result.markdownWithCitations
                },
                {
                  key: "references",
                  label: t("crawl.detail.results.variants.references"),
                  content: result.referencesMarkdown
                },
                { key: "fit", label: t("crawl.detail.results.variants.cleanFit"), content: result.fitMarkdown }
              ].filter((entry) => entry.content && entry.content.length > 0);
              const defaultContent = (
                <pre className="markdown-preview" style={{ marginTop: 8 }}>
                  {result.markdown}
                </pre>
              );
              const tabs =
                variantEntries.length > 1 ? (
                  <Tabs
                    size="small"
                    style={{ marginTop: 8 }}
                    items={variantEntries.map((entry) => ({
                      key: entry.key,
                      label: entry.label,
                      children: (
                        <pre className="markdown-preview" style={{ marginTop: 8 }}>
                          {entry.content}
                        </pre>
                      )
                    }))}
                  />
                ) : (
                  defaultContent
                );
              return (
                <List.Item key={result.id}>
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Typography.Link href={result.sourceUrl} target="_blank">
                          {result.sourceUrl}
                        </Typography.Link>
                        <Typography.Text type="secondary">
                          {formatDateTime(result.fetchedAt, locale, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit"
                          })}
                        </Typography.Text>
                        {canCreateItem ? (
                          <Button
                            size="small"
                            loading={ingesting && ingestingResultId === result.id}
                            onClick={() => handleCreateItem(result.id)}
                          >
                            {t("crawl.detail.ingestToItems", { defaultValue: "Send to Items" })}
                          </Button>
                        ) : null}
                      </Space>
                    }
                    description={
                      <>
                        {metadata && (
                          <Typography.Text type="secondary">{metadata}</Typography.Text>
                        )}
                        {tabs}
                        <MediaSection media={mediaPayload} />
                        <StoredMediaSection assets={storedAssets} />
                        <TablesSection tables={tablesPayload} />
                      </>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>
    </div>
  );
}
