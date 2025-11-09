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
