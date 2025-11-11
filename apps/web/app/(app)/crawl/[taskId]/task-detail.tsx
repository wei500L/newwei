"use client";

import {
  Button,
  Card,
  Descriptions,
  Input,
  List,
  message,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography
} from "antd";
import Link from "next/link";
import { useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  CrawlTaskStatus,
  useCrawlTaskQuery,
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

const limitOptions = [
  { value: 10, label: "Latest 10" },
  { value: 20, label: "Latest 20" },
  { value: 50, label: "Latest 50" }
];

type CrawlMediaSource = {
  src?: string;
  srcset?: string;
  type?: string;
  media?: string;
  sizes?: string;
};

type CrawlMediaItem = {
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
};

type CrawlMediaCollection = Record<string, CrawlMediaItem[]>;

const mediaDocsUrl =
  "https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/link-media.md";

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
      title="Media assets"
      style={{ marginTop: 12 }}
      extra={
        <Typography.Link href={mediaDocsUrl} target="_blank" rel="noreferrer">
          Crawl4AI doc
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
                      {renderMediaPreview(kind, item)}
                      <Space direction="vertical" size={4}>
                        <Typography.Link href={item.src} target="_blank">
                          {item.src ?? "View asset"}
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
                          {[item.type, item.format, formatDimensions(item), formatScore(item)]
                            .filter(Boolean)
                            .join(" • ")}
                        </Typography.Text>
                        {item.srcset ? renderSrcset(item.srcset) : null}
                        {renderSourceList("picture", item.pictureSources)}
                        {renderSourceList("responsive", item.responsiveSources)}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
              {remaining > 0 ? (
                <Typography.Text type="secondary">
                  +{remaining} more {kind} kept in the result payload
                </Typography.Text>
              ) : null}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

function renderMediaPreview(kind: string, item: CrawlMediaItem) {
  if (!item.src) {
    return null;
  }
  const normalized = kind.toLowerCase();
  if (normalized.includes("image")) {
    return (
      <img
        src={item.src}
        alt={item.alt || item.title || "Media thumbnail"}
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

function formatDimensions(item: CrawlMediaItem) {
  if (item.width && item.height) {
    return `${item.width}×${item.height}px`;
  }
  return undefined;
}

function formatScore(item: CrawlMediaItem) {
  if (typeof item.score === "number") {
    return `score ${item.score.toFixed(2)}`;
  }
  return undefined;
}

function renderSrcset(srcset: string[]) {
  return (
    <div>
      <Typography.Text type="secondary">srcset variants</Typography.Text>
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

function renderSourceList(label: string, sources?: CrawlMediaSource[]) {
  if (!sources || sources.length === 0) {
    return null;
  }
  return (
    <div>
      <Typography.Text type="secondary">
        {label} sources ({sources.length})
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
  const [resultLimit, setResultLimit] = useState(20);
  const [resultSearch, setResultSearch] = useState<string>();
  const { data, loading, refetch } = useCrawlTaskQuery({
    variables: {
      id: taskId,
      resultLimit,
      resultSearch: resultSearch ?? null
    },
    fetchPolicy: "network-only"
  });

  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();

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
      return "Direct (no proxy)";
    }
    const proxyUrl =
      typeof config.proxyUrl === "string" && config.proxyUrl.length > 0 ? config.proxyUrl : null;
    const proxyConfig = config.proxyConfig as
      | { server?: string; username?: string; password?: string }
      | undefined;
    if (proxyConfig?.server) {
      const creds = proxyConfig.username ? ` • user ${proxyConfig.username}` : "";
      return `Dict: ${proxyConfig.server}${creds}`;
    }
    if (proxyUrl) {
      return proxyUrl;
    }
    return "Direct (no proxy)";
  }, [config]);

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

  const markdownSummary = useMemo(() => {
    if (!markdownOptions) {
      return "Default (cleaned_html)";
    }
    const parts: string[] = [];
    if (typeof markdownOptions.contentSource === "string") {
      parts.push(`source ${markdownOptions.contentSource}`);
    }
    if (typeof markdownOptions.ignoreLinks === "boolean") {
      parts.push(markdownOptions.ignoreLinks ? "ignore links" : "keep links");
    }
    if (typeof markdownOptions.escapeHtml === "boolean") {
      parts.push(markdownOptions.escapeHtml ? "escape HTML" : "render HTML");
    }
    if (typeof markdownOptions.bodyWidth === "number") {
      parts.push(`wrap ${markdownOptions.bodyWidth}`);
    }
    return parts.length ? parts.join(" • ") : "Default (cleaned_html)";
  }, [markdownOptions]);

  const markdownFilterSummary = useMemo(() => {
    if (!markdownFilter || typeof markdownFilter.type !== "string") {
      return "Disabled";
    }
    const threshold =
      typeof markdownFilter.threshold === "number" ? ` (threshold ${markdownFilter.threshold})` : "";
    return `${markdownFilter.type}${threshold}`;
  }, [markdownFilter]);

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
  const jsOnlyMode = Boolean(config?.jsOnly);
  const shortenScript = (value: string) => (value.length > 160 ? `${value.slice(0, 157)}…` : value);

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
    if (!config || !Array.isArray((config as any).additionalUrls)) {
      return [];
    }
    return ((config as any).additionalUrls as unknown[])
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  const multiConfigs = useMemo(() => {
    if (!config || !Array.isArray((config as any).multiUrlConfigs)) {
      return [];
    }
    return ((config as any).multiUrlConfigs as Record<string, unknown>[]) ?? [];
  }, [config]);

  const handleRetry = async () => {
    if (!task) return;
    try {
      await retryTask({ variables: { id: task.id } });
      message.success("Task queued for retry");
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? "Failed to retry task");
    }
  };

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
        <Typography.Text type="secondary">Task not found.</Typography.Text>
      </div>
    );
  }

  const results = task.results ?? [];

  return (
    <div className="content-card">
      <Space style={{ marginBottom: 16 }} wrap>
        <Link href="/crawl">← Back to tasks</Link>
        <Tag color={statusColors[task.status]}>{task.status}</Tag>
        <Button onClick={handleRetry} loading={retrying}>
          Retry crawl
        </Button>
        <Typography.Link href={task.targetUrl} target="_blank" rel="noreferrer">
          Open source site
        </Typography.Link>
      </Space>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="Display name">
          {task.displayName ?? task.targetUrl}
        </Descriptions.Item>
        <Descriptions.Item label="Keywords">
          {task.keywords.length ? (
            <Space wrap>
              {task.keywords.map((keyword) => (
                <Tag key={keyword}>{keyword}</Tag>
              ))}
            </Space>
          ) : (
            "—"
          )}
        </Descriptions.Item>
        <Descriptions.Item label="Concurrency">{task.concurrency}</Descriptions.Item>
      <Descriptions.Item label="Run count">{task.runCount}</Descriptions.Item>
      <Descriptions.Item label="Full-page scanning">
        {config?.scanFullPage
          ? `Enabled (scroll delay ${config?.scrollDelayMs ?? 200} ms)`
          : "Disabled"}
      </Descriptions.Item>
      <Descriptions.Item label="Undetected browser">
        {config?.enableUndetectedBrowser ? "Enabled" : "Disabled"}
      </Descriptions.Item>
      <Descriptions.Item label="Stealth mode">
        {config?.enableStealthMode ? "Enabled" : "Disabled"}
      </Descriptions.Item>
      <Descriptions.Item label="User simulation">
        {config?.simulateUser ? "Enabled" : "Disabled"}
      </Descriptions.Item>
      <Descriptions.Item label="Override navigator">
        {config?.overrideNavigator ? "Enabled" : "Disabled"}
      </Descriptions.Item>
      <Descriptions.Item label="JS-only mode">{jsOnlyMode ? "Enabled" : "Disabled"}</Descriptions.Item>
      <Descriptions.Item label="JS steps">
        {dynamicJsSteps.length ? (
          <Space direction="vertical" size={0}>
            {dynamicJsSteps.map((snippet, index) => (
              <Typography.Text key={`js-${index}`} style={{ fontFamily: "monospace" }}>
                {shortenScript(snippet)}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          "—"
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Wait condition">
        {waitCondition ? shortenScript(waitCondition) : "—"}
      </Descriptions.Item>
      <Descriptions.Item label="Wait timeout">
        {waitTimeoutMs ? `${waitTimeoutMs} ms` : "Default"}
      </Descriptions.Item>
      <Descriptions.Item label="Proxy route">{proxySummary}</Descriptions.Item>
      <Descriptions.Item label="Additional URLs">
        {additionalUrls.length ? (
          <Space wrap>
            {additionalUrls.map((url) => (
              <Typography.Link key={url} href={url} target="_blank" rel="noreferrer">
                {url}
              </Typography.Link>
            ))}
          </Space>
        ) : (
          "—"
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Markdown generator">{markdownSummary}</Descriptions.Item>
      <Descriptions.Item label="Markdown filter">{markdownFilterSummary}</Descriptions.Item>
      <Descriptions.Item label="Last server memory">
        {task.lastServerMemoryMb != null ? `${task.lastServerMemoryMb} MB` : "—"}
      </Descriptions.Item>
      <Descriptions.Item label="Last peak memory">
        {task.lastPeakMemoryMb != null ? `${task.lastPeakMemoryMb} MB` : "—"}
      </Descriptions.Item>
      <Descriptions.Item label="Last memory efficiency">
        {task.lastMemoryEfficiency != null ? `${task.lastMemoryEfficiency}%` : "—"}
      </Descriptions.Item>
      <Descriptions.Item label="Server memory">
        {task.memoryStats?.serverMemoryMb != null ? `${task.memoryStats.serverMemoryMb} MB` : "—"}
      </Descriptions.Item>
      <Descriptions.Item label="Peak memory">
        {task.memoryStats?.peakMemoryMb != null ? `${task.memoryStats.peakMemoryMb} MB` : "—"}
      </Descriptions.Item>
      <Descriptions.Item label="Efficiency">
        {task.memoryStats?.efficiencyPercent != null ? `${task.memoryStats.efficiencyPercent}%` : "—"}
      </Descriptions.Item>
        <Descriptions.Item label="Last success">
          {task.lastSuccessAt ? dayjs(task.lastSuccessAt).format("MMM D, HH:mm") : "Never"}
        </Descriptions.Item>
        <Descriptions.Item label="Last error">{task.lastError ?? "—"}</Descriptions.Item>
        <Descriptions.Item label="Configuration">
          {config ? (
            <pre className="markdown-preview">{JSON.stringify(config, null, 2)}</pre>
          ) : (
            "Default"
          )}
        </Descriptions.Item>
      </Descriptions>

      {multiConfigs.length ? (
        <Card title="Multi-URL strategies" style={{ marginTop: 24 }}>
          <List
            dataSource={multiConfigs}
            renderItem={(item, index) => {
              const matcher = item?.matcher as { matchMode?: string; patterns?: string[] } | undefined;
              const urls = Array.isArray(item?.urls) ? (item?.urls as string[]) : [];
              const options = (item?.options ?? {}) as Record<string, unknown>;
              return (
                <List.Item key={item?.name ?? `strategy-${index}`}>
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>{item?.name ?? `Strategy #${index + 1}`}</Typography.Text>
                    {matcher?.patterns?.length ? (
                      <Typography.Text type="secondary">
                        Patterns ({matcher.matchMode ?? "glob"}): {matcher.patterns.join(", ")}
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
                        Overrides:{" "}
                        {Object.entries(options)
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(", ")}
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
        <Card title="Link analysis" style={{ marginTop: 24 }}>
          <Space size="large" wrap>
            {[
              { label: "Total links", value: linkOverview.stats.totalLinks },
              { label: "Internal", value: linkOverview.stats.internalLinks },
              { label: "External", value: linkOverview.stats.externalLinks },
              { label: "High quality", value: linkOverview.stats.highQualityLinks },
              { label: "Needs review", value: linkOverview.stats.lowQualityLinks },
              {
                label: "Avg intrinsic",
                value:
                  linkOverview.stats.averageIntrinsic !== null &&
                  linkOverview.stats.averageIntrinsic !== undefined
                    ? linkOverview.stats.averageIntrinsic.toFixed(2)
                    : "—"
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
                Buckets
              </Typography.Text>
              <Space wrap>
                {linkOverview.buckets.map((bucket) => (
                  <Tag key={bucket.kind}>
                    {bucket.kind}: {bucket.count}
                  </Tag>
                ))}
              </Space>
            </>
          ) : null}
          <Space align="start" size="large" style={{ marginTop: 16 }} wrap>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>Top links</Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.topLinks}
                locale={{ emptyText: "No scored links yet." }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {(link.baseDomain ?? link.type ?? "link").toString()} • Score{" "}
                        {getLinkScore(link).toFixed(2)}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>Links to revisit</Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.lowLinks}
                locale={{ emptyText: "No low quality links yet." }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {(link.baseDomain ?? link.type ?? "link").toString()} • Intrinsic{" "}
                        {(link.intrinsicScore ?? 0).toFixed(2)}
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
        title="Results"
        style={{ marginTop: 24 }}
        extra={
          <Space>
            <Input.Search
              placeholder="Filter by URL or metadata"
              allowClear
              onSearch={(value) => setResultSearch(value || undefined)}
              onChange={(event) => {
                if (!event.target.value) {
                  setResultSearch(undefined);
                }
              }}
              style={{ width: 260 }}
            />
            <Select
              value={resultLimit}
              style={{ width: 140 }}
              onChange={setResultLimit}
              options={limitOptions}
            />
          </Space>
        }
      >
        {loading ? (
          <Spin />
        ) : (
          <List
            dataSource={results}
            locale={{ emptyText: "No crawl results yet." }}
            renderItem={(result) => {
              const metadata = result.metadata;
              const mediaPayload = safeParseJson<CrawlMediaCollection>(result.media);
              const variantEntries = [
                { key: "raw", label: "Raw", content: result.markdown },
                { key: "citations", label: "Citations", content: result.markdownWithCitations },
                { key: "references", label: "References", content: result.referencesMarkdown },
                { key: "fit", label: "Fit", content: result.fitMarkdown }
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
                      <Space>
                        <Typography.Link href={result.sourceUrl} target="_blank">
                          {result.sourceUrl}
                        </Typography.Link>
                        <Typography.Text type="secondary">
                          {dayjs(result.fetchedAt).format("MMM D, HH:mm")}
                        </Typography.Text>
                      </Space>
                    }
                    description={
                      <>
                        {metadata && (
                          <Typography.Text type="secondary">{metadata}</Typography.Text>
                        )}
                        {tabs}
                        <MediaSection media={mediaPayload} />
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
