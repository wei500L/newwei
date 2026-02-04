"use client";

import { gql, useQuery } from "@apollo/client";
import { Alert, Button, Card, Divider, Drawer, Empty, List, Skeleton, Space, Tag, Tabs, Tooltip, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { MarkdownViewer } from "@/components/markdown-viewer";
import { useNewsEventBriefQuery, useProcessedItemByIdQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import { formatDateTime, formatRelativeTime, formatTimeZoneOffsetLabel, getDefaultTimeZone, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

interface EventItem {
  id: string;
  eventId: string;
  processedArticleId: string;
  processedItemId?: string | null;
  similarity?: number | null;
  assignedBy: string;
  createdAt: string;
  processedArticle: {
    id: string;
    articleId: string;
    title?: string | null;
    summary?: string | null;
    publishedAt?: string | null;
    language?: string | null;
    processedAt: string;
    article: {
      id: string;
      url: string;
      sourceLabel?: string | null;
      crawlAt: string;
    };
  };
}

interface TimelineEntry {
  id: string;
  eventId: string;
  bucketStart: string;
  title?: string | null;
  summary?: string | null;
  keyPoints?: unknown;
  referencedArticleIds?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface NewsEvent {
  id: string;
  status: "active" | "archived";
  language?: string | null;
  primaryTopic?: string | null;
  primaryEntity?: string | null;
  title?: string | null;
  summary?: string | null;
  startAt: string;
  lastAt: string;
  itemCount: number;
  items?: EventItem[];
  timeline?: TimelineEntry[];
}

const NEWS_EVENT_QUERY = gql`
  query NewsEvent($id: String!, $itemsLimit: Int, $timelineLimit: Int) {
    newsEvent(id: $id, itemsLimit: $itemsLimit, timelineLimit: $timelineLimit) {
      id
      status
      language
      primaryTopic
      primaryEntity
      title
      summary
      startAt
      lastAt
      itemCount
      items {
        id
        eventId
        processedArticleId
        processedItemId
        similarity
        assignedBy
        createdAt
        processedArticle {
          id
          articleId
          title
          summary
          publishedAt
          language
          processedAt
          article {
            id
            url
            sourceLabel
            crawlAt
          }
        }
      }
      timeline {
        id
        eventId
        bucketStart
        title
        summary
        keyPoints
        referencedArticleIds
        createdAt
        updatedAt
      }
    }
  }
`;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formatSimilarity(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
}

const toString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
};

const toEntityNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        return (entry as { name?: unknown }).name;
      }
      return undefined;
    })
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
};

function getResultObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

type CitationStats = {
  keyPoints: number;
  whyItMatters: number;
  latestUpdate: number;
  whatToWatch: number;
  consensus: number;
  divergence: number;
};

export function EventDetailsDrawer({ eventId }: { eventId: string }) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const timeZone = getDefaultTimeZone();
  const timeZoneLabel = useMemo(() => formatTimeZoneOffsetLabel(new Date(), timeZone), [timeZone]);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("brief");
  const [selectedProcessedItemId, setSelectedProcessedItemId] = useState<string | null>(null);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);

  const { data, loading, error } = useQuery<{ newsEvent: NewsEvent | null }>(NEWS_EVENT_QUERY, {
    variables: { id: eventId, itemsLimit: 80, timelineLimit: 400 },
    fetchPolicy: "network-only"
  });

  const event = data?.newsEvent ?? null;
  const briefLanguage = i18n.language;
  const briefMaxSources = 10;
  const briefQuery = useNewsEventBriefQuery({
    variables: { eventId, language: briefLanguage, maxSources: briefMaxSources, forceRefresh: false },
    skip: activeTab !== "brief",
    fetchPolicy: "network-only",
    notifyOnNetworkStatusChange: true
  });
  const brief = briefQuery.data?.newsEventBrief ?? null;

  const timeline = useMemo(() => {
    const entries = event?.timeline ?? [];
    return [...entries].sort((a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf());
  }, [event?.timeline]);
  const items = useMemo(() => {
    const rows = event?.items ?? [];
    return [...rows].sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
  }, [event?.items]);
  const itemByProcessedArticleId = useMemo(() => {
    const entries = items.map((item) => [item.processedArticleId, item] as const);
    return new Map(entries);
  }, [items]);
  const briefSourcesByIndex = useMemo(() => {
    const map = new Map<number, NonNullable<typeof brief>["sources"][number]>();
    for (const source of brief?.sources ?? []) {
      map.set(source.index, source);
    }
    return map;
  }, [brief?.sources]);
  const briefCitationStatsBySourceIndex = useMemo(() => {
    const stats = new Map<number, CitationStats>();
    const ensure = (index: number) => {
      let current = stats.get(index);
      if (!current) {
        current = {
          keyPoints: 0,
          whyItMatters: 0,
          latestUpdate: 0,
          whatToWatch: 0,
          consensus: 0,
          divergence: 0
        };
        stats.set(index, current);
      }
      return current;
    };

    const add = (citations: number[] | null | undefined, field: keyof CitationStats) => {
      const list = Array.isArray(citations) ? citations : [];
      for (const idx of list) {
        if (typeof idx !== "number" || !Number.isFinite(idx)) {
          continue;
        }
        const current = ensure(idx);
        current[field] += 1;
      }
    };

    const addPoints = (points: Array<{ citations: number[] }> | null | undefined, field: keyof CitationStats) => {
      for (const point of points ?? []) {
        add(point.citations, field);
      }
    };

    if (!brief) {
      return stats;
    }

    addPoints(brief.keyPoints, "keyPoints");
    addPoints(brief.whyItMatters, "whyItMatters");
    if (brief.latestUpdate) {
      add(brief.latestUpdate.citations, "latestUpdate");
    }
    addPoints(brief.whatToWatch, "whatToWatch");
    if (brief.comparison) {
      addPoints(brief.comparison.consensus, "consensus");
      addPoints(brief.comparison.divergence, "divergence");
    }

    return stats;
  }, [brief]);

  const selectedProcessedQuery = useProcessedItemByIdQuery({
    variables: { id: selectedProcessedItemId ?? "" },
    skip: !selectedProcessedItemId,
    fetchPolicy: "network-only"
  });
  const selectedProcessed = selectedProcessedQuery.data?.processedItemById ?? null;
  const selectedProcessedResult = useMemo(
    () => getResultObject(selectedProcessed?.resultJson),
    [selectedProcessed?.resultJson]
  );
  const selectedSummary = toString(selectedProcessedResult?.summary);
  const selectedKeyPoints = toStringList(selectedProcessedResult?.key_points);
  const selectedTopics = toStringList(selectedProcessedResult?.topics);
  const selectedEntities = toEntityNames(selectedProcessedResult?.entities);
  const selectedMarkdown = toString(selectedProcessedResult?.cleaned_markdown);
  const selectedMarkdownSource = toString(selectedProcessedResult?.cleaned_markdown_source);
  const selectedMarkdownFallbackUsed = selectedMarkdownSource === "crawl_fallback";

  if (loading && !event) {
    return <Skeleton active paragraph={{ rows: 10 }} />;
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={t("pages.events.drawer.loadFailed", { defaultValue: "Failed to load event." })}
        description={error.message}
      />
    );
  }

  if (!event) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t("pages.events.drawer.notFound", { defaultValue: "Event not found." })}
      />
    );
  }

  const title = event.title?.trim() ? event.title.trim() : event.primaryEntity?.trim() || event.primaryTopic?.trim() || event.id;
  const language = event.language?.trim() ?? "";
  const topic = event.primaryTopic?.trim() ?? "";
  const entity = event.primaryEntity?.trim() ?? "";
  const statusLabel = t(`pages.events.status.${event.status}`, { defaultValue: event.status });
  const startRelative = formatRelativeTime(event.startAt, locale, { timeZone });
  const lastRelative = formatRelativeTime(event.lastAt, locale, { timeZone });
  const startTooltip = formatDateTime(event.startAt, locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short"
  });
  const lastTooltip = formatDateTime(event.lastAt, locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short"
  });

  const renderCitations = (citations: number[] | null | undefined) => {
    const list = Array.isArray(citations) ? citations : [];
    if (list.length === 0) {
      return null;
    }
    return (
      <Space size={[6, 6]} wrap>
        {list.slice(0, 12).map((idx) => {
          const source = briefSourcesByIndex.get(idx);
          const url = safeHttpUrl(source?.url ?? null);
          const processedItemId = typeof source?.processedItemId === "string" ? source.processedItemId.trim() : "";
          let label = source?.sourceLabel?.trim() ?? "";
          if (!label && url) {
            try {
              label = new URL(url).hostname;
            } catch {
              // ignore
            }
          }
          label = label || `#${idx}`;

          const tag = (
            <Tag
              key={`cite-${idx}`}
              color="blue"
              style={(processedItemId || url) ? { cursor: "pointer" } : undefined}
              onClick={() => {
                if (processedItemId) {
                  setSelectedProcessedItemId(processedItemId);
                  setSelectedTitle(source?.title ?? label);
                  setSelectedUrl(url ?? null);
                  return;
                }
                if (url) {
                  window.open(url, "_blank", "noopener,noreferrer");
                }
              }}
            >
              [{idx}] {label}
            </Tag>
          );
          const tooltip = source?.title?.trim() || label;

          return (
            <Tooltip key={`cite-tip-${idx}`} title={tooltip}>
              {tag}
            </Tooltip>
          );
        })}
      </Space>
    );
  };

  const renderPointList = (points: Array<{ text: string; citations: number[] }> | null | undefined) => {
    const dataSource = points ?? [];
    if (dataSource.length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("common.notAvailable", { defaultValue: "Not available" })}
        />
      );
    }
    return (
      <List
        size="small"
        dataSource={dataSource}
        renderItem={(point, idx) => (
          <List.Item key={`${idx}-${point.text}`}>
            <div className="flex flex-col gap-1">
              <Typography.Text>{point.text}</Typography.Text>
              {renderCitations(point.citations)}
            </div>
          </List.Item>
        )}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Space direction="vertical" size={6}>
        <Typography.Title level={5} style={{ marginBottom: 0 }}>
          {title}
        </Typography.Title>
        <Space wrap size={[8, 6]}>
          <Button type="link" onClick={() => router.push(`/events/${event.id}`)}>
            {t("pages.events.actions.open", { defaultValue: "Open" })}
          </Button>
        </Space>
        <Space wrap size={[6, 6]}>
          <Tag color={event.status === "active" ? "green" : "default"}>{statusLabel}</Tag>
          <Tag>{t("pages.events.drawer.items", { defaultValue: "Items" })}: {event.itemCount}</Tag>
          {language ? <Tag color="blue">{language}</Tag> : null}
          {topic ? <Tag color="geekblue">{topic}</Tag> : null}
          {entity ? <Tag color="purple">{entity}</Tag> : null}
          <Tooltip title={`${timeZone} (${timeZoneLabel || timeZone})`}>
            <Tag>{timeZoneLabel || timeZone}</Tag>
          </Tooltip>
        </Space>
        <Space wrap size={[12, 0]}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("pages.events.fields.startAt", { defaultValue: "Start" })}:{" "}
            <Tooltip title={`${startTooltip}${startRelative ? ` (${startRelative})` : ""}`}>
              <span>{formatDateTime(event.startAt, locale, { dateStyle: "medium", timeZone })}</span>
            </Tooltip>
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("pages.events.fields.lastAt", { defaultValue: "Last" })}:{" "}
            <Tooltip title={`${lastTooltip}${lastRelative ? ` (${lastRelative})` : ""}`}>
              <span>{formatDateTime(event.lastAt, locale, { dateStyle: "medium", timeZone })}</span>
            </Tooltip>
            {lastRelative ? <span className="ml-1 opacity-80">({lastRelative})</span> : null}
          </Typography.Text>
        </Space>
        {event.summary ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {event.summary}
          </Typography.Paragraph>
        ) : null}
      </Space>

      <Divider style={{ margin: "8px 0" }} />

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key)}
        items={[
          {
            key: "brief",
            label: t("pages.events.drawer.tabs.brief", { defaultValue: "One-page brief" }),
            children: (
              <div className="flex flex-col gap-4">
                <Space wrap>
                  <Button
                    onClick={() =>
                      briefQuery.refetch({
                        eventId,
                        language: briefLanguage,
                        maxSources: briefMaxSources,
                        forceRefresh: true
                      })
                    }
                    loading={briefQuery.loading}
                  >
                    {t("pages.events.drawer.refreshBrief", { defaultValue: "Refresh brief" })}
                  </Button>
                  {brief?.generatedAt ? (
                    <Tag>
                      {t("pages.events.drawer.generatedAt", { defaultValue: "Generated" })}:{" "}
                      {formatDateTime(brief.generatedAt, locale, { dateStyle: "medium", timeStyle: "short", timeZone })}
                    </Tag>
                  ) : null}
                  {brief?.sources?.length ? (
                    <Tag>
                      {t("pages.events.drawer.briefSources", { defaultValue: "Sources" })}: {brief.sources.length}
                    </Tag>
                  ) : null}
                </Space>

                {briefQuery.error ? (
                  <Alert
                    type="error"
                    showIcon
                    message={t("pages.events.drawer.briefLoadFailed", { defaultValue: "Failed to load brief." })}
                    description={briefQuery.error.message}
                  />
                ) : briefQuery.loading && !brief ? (
                  <Skeleton active paragraph={{ rows: 10 }} />
                ) : !brief ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t("pages.events.drawer.briefEmpty", {
                      defaultValue: "Brief is not available yet. Click refresh to generate."
                    })}
                  />
                ) : (
                  <div className="flex flex-col gap-3">
                    <Card size="small" className="content-card" title={t("pages.events.drawer.tldr", { defaultValue: "TL;DR" })}>
                      <Typography.Paragraph style={{ marginBottom: 0 }}>{brief.tldr}</Typography.Paragraph>
                    </Card>

                    <Card
                      size="small"
                      className="content-card"
                      title={t("pages.events.drawer.keyPoints", { defaultValue: "Key points" })}
                    >
                      {renderPointList(brief.keyPoints)}
                    </Card>

                    <Card
                      size="small"
                      className="content-card"
                      title={t("pages.events.drawer.whyMatters", { defaultValue: "Why it matters" })}
                    >
                      {renderPointList(brief.whyItMatters)}
                    </Card>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <Card
                        size="small"
                        className="content-card"
                        title={t("pages.events.drawer.latestUpdate", { defaultValue: "Latest update" })}
                      >
                        {brief.latestUpdate ? renderPointList([brief.latestUpdate]) : renderPointList([])}
                      </Card>
                      <Card
                        size="small"
                        className="content-card"
                        title={t("pages.events.drawer.watch", { defaultValue: "What to watch" })}
                      >
                        {renderPointList(brief.whatToWatch)}
                      </Card>
                    </div>

                    {brief.comparison ? (
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        <Card
                          size="small"
                          className="content-card"
                          title={t("pages.events.drawer.consensus", { defaultValue: "Consensus" })}
                        >
                          {renderPointList(brief.comparison.consensus)}
                        </Card>
                        <Card
                          size="small"
                          className="content-card"
                          title={t("pages.events.drawer.divergence", { defaultValue: "Divergence" })}
                        >
                          {renderPointList(brief.comparison.divergence)}
                        </Card>
                      </div>
                    ) : null}

                    {brief.limitations ? (
                      <Alert
                        type="info"
                        showIcon
                        message={t("pages.events.drawer.limitations", { defaultValue: "Limitations" })}
                        description={brief.limitations}
                      />
                    ) : null}

                    <Card
                      size="small"
                      className="content-card"
                      title={t("pages.events.drawer.sourcesTitle", { defaultValue: "Sources" })}
                    >
                      <List
                        size="small"
                        dataSource={brief.sources}
                        renderItem={(source) => {
                          const url = safeHttpUrl(source.url);
                          const sourceName = source.sourceLabel?.trim()
                            ? source.sourceLabel.trim()
                            : url
                              ? new URL(url).hostname
                              : `#${source.index}`;
                          const item = source.processedArticleId
                            ? itemByProcessedArticleId.get(source.processedArticleId)
                            : undefined;
                          const summary = item?.processedArticle.summary ?? null;
                          const citationStats = briefCitationStatsBySourceIndex.get(source.index);
                          const citedParts: string[] = [];
                          if (citationStats?.keyPoints) {
                            citedParts.push(
                              `${t("pages.events.drawer.citedIn.keyPoints", { defaultValue: "Key points" })}×${citationStats.keyPoints}`
                            );
                          }
                          if (citationStats?.whyItMatters) {
                            citedParts.push(
                              `${t("pages.events.drawer.citedIn.whyItMatters", { defaultValue: "Why it matters" })}×${citationStats.whyItMatters}`
                            );
                          }
                          if (citationStats?.latestUpdate) {
                            citedParts.push(
                              `${t("pages.events.drawer.citedIn.latestUpdate", { defaultValue: "Latest update" })}×${citationStats.latestUpdate}`
                            );
                          }
                          if (citationStats?.whatToWatch) {
                            citedParts.push(
                              `${t("pages.events.drawer.citedIn.whatToWatch", { defaultValue: "What to watch" })}×${citationStats.whatToWatch}`
                            );
                          }
                          if (citationStats?.consensus) {
                            citedParts.push(
                              `${t("pages.events.drawer.citedIn.consensus", { defaultValue: "Consensus" })}×${citationStats.consensus}`
                            );
                          }
                          if (citationStats?.divergence) {
                            citedParts.push(
                              `${t("pages.events.drawer.citedIn.divergence", { defaultValue: "Divergence" })}×${citationStats.divergence}`
                            );
                          }

                          const actions: ReactNode[] = [
                            <Button
                              key="llm"
                              type="link"
                              onClick={() => {
                                if (!source.processedItemId) {
                                  return;
                                }
                                setSelectedProcessedItemId(source.processedItemId);
                                setSelectedTitle(source.title ?? sourceName);
                                setSelectedUrl(url ?? null);
                              }}
                              disabled={!source.processedItemId}
                            >
                              {t("pages.events.drawer.openLlm", { defaultValue: "LLM content" })}
                            </Button>
                          ];

                          if (url) {
                            actions.push(
                              <a key="open" href={url} target="_blank" rel="noreferrer">
                                {t("pages.events.drawer.openOriginal", { defaultValue: "Open" })}
                              </a>
                            );
                          }

                          return (
                            <List.Item key={source.index} actions={actions}>
                              <List.Item.Meta
                                title={
                                  <Space wrap size={[6, 6]}>
                                    <Tag>#{source.index}</Tag>
                                    <Typography.Text strong>{sourceName}</Typography.Text>
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                      {source.publishedAt
                                        ? formatDateTime(source.publishedAt, locale, { dateStyle: "medium", timeZone })
                                        : t("common.notAvailable")}
                                    </Typography.Text>
                                  </Space>
                                }
                                description={
                                  <div className="flex flex-col gap-1">
                                    {source.title ? <Typography.Text>{source.title}</Typography.Text> : null}
                                    {summary ? (
                                      <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                                        {summary}
                                      </Typography.Paragraph>
                                    ) : null}
                                    {citedParts.length > 0 ? (
                                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                        {t("pages.events.drawer.citedInLabel", { defaultValue: "Cited in" })}: {citedParts.join(", ")}
                                      </Typography.Text>
                                    ) : null}
                                  </div>
                                }
                              />
                            </List.Item>
                          );
                        }}
                      />
                    </Card>
                  </div>
                )}
              </div>
            )
          },
          {
            key: "timeline",
            label: t("pages.events.drawer.tabs.timeline", { defaultValue: "Timeline" }),
            children: timeline.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("pages.events.drawer.timelineEmpty", {
                  defaultValue: "No timeline entries yet. Enable timeline generation and wait for the scheduled job."
                })}
              />
            ) : (
              <List
                dataSource={timeline}
                renderItem={(entry) => {
                  const keyPoints = normalizeStringArray(entry.keyPoints);
                  const referencedIds = normalizeStringArray(entry.referencedArticleIds);
                  return (
                    <List.Item key={entry.id}>
                      <List.Item.Meta
                        title={
                          <Space wrap size={[8, 6]}>
                            <Typography.Text strong>
                              {formatDateTime(entry.bucketStart, locale, { dateStyle: "medium", timeZone })}
                            </Typography.Text>
                            {referencedIds.length > 0 ? (
                              <Tag>{t("pages.events.drawer.references", { defaultValue: "Refs" })}: {referencedIds.length}</Tag>
                            ) : null}
                          </Space>
                        }
                        description={
                          <div className="flex flex-col gap-1">
                            {entry.title ? <Typography.Text>{entry.title}</Typography.Text> : null}
                            {entry.summary ? (
                              <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                                {entry.summary}
                              </Typography.Paragraph>
                            ) : null}
                            {keyPoints.length > 0 ? (
                              <Space wrap size={[6, 6]}>
                                {keyPoints.slice(0, 10).map((point, idx) => (
                                  <Tag key={`${entry.id}-${idx}`} color="default">
                                    {point}
                                  </Tag>
                                ))}
                              </Space>
                            ) : null}
                          </div>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )
          },
          {
            key: "items",
            label: t("pages.events.drawer.tabs.articles", { defaultValue: "Articles" }),
            children: items.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("pages.events.drawer.itemsEmpty", { defaultValue: "No articles in this event yet." })}
              />
            ) : (
              <List
                dataSource={items}
                renderItem={(item) => {
                  const processed = item.processedArticle;
                  const url = safeHttpUrl(processed.article.url);
                  const similarity = formatSimilarity(item.similarity);
                  const sourceLabel = processed.article.sourceLabel?.trim() ?? "";
                  const publishedLabel = t("items.time.published", { defaultValue: "Published" });
                  const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
                  const publishedAt = processed.publishedAt ?? null;
                  const ingestedAt = processed.article.crawlAt ?? processed.processedAt ?? null;
                  const canOpenLlm = Boolean(item.processedItemId);
                  const llmButtonLabel = t("pages.events.drawer.openLlm", { defaultValue: "LLM content" });

                  const openLlm = () => {
                    const processedItemId = item.processedItemId ?? null;
                    if (!processedItemId) {
                      return;
                    }
                    setSelectedProcessedItemId(processedItemId);
                    setSelectedTitle(processed.title ?? processed.articleId);
                    setSelectedUrl(url ?? null);
                  };

                  return (
                    <List.Item
                      key={item.id}
                      extra={
                        <Space size="small">
                          <Button type="link" onClick={openLlm} disabled={!canOpenLlm}>
                            {llmButtonLabel}
                          </Button>
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              {t("pages.events.drawer.openOriginal", { defaultValue: "Open" })}
                            </a>
                          ) : null}
                        </Space>
                      }
                    >
                      <List.Item.Meta
                        title={
                          <Space wrap size={[6, 6]}>
                            <Typography.Text strong>{processed.title ?? processed.articleId}</Typography.Text>
                            <Tag color="default">{item.assignedBy}</Tag>
                            {similarity ? <Tag color="blue">{similarity}</Tag> : null}
                            {sourceLabel ? <Tag color="geekblue">{sourceLabel}</Tag> : null}
                            <Tag>
                              {publishedLabel}:{" "}
                              {publishedAt
                                ? formatDateTime(publishedAt, locale, { dateStyle: "medium", timeZone })
                                : t("common.notAvailable")}
                            </Tag>
                            <Tag>
                              {ingestedLabel}:{" "}
                              {ingestedAt
                                ? formatDateTime(ingestedAt, locale, { dateStyle: "medium", timeZone })
                                : t("common.notAvailable")}
                            </Tag>
                          </Space>
                        }
                        description={
                          processed.summary ? (
                            <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                              {processed.summary}
                            </Typography.Paragraph>
                          ) : null
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )
          }
        ]}
      />

      <Drawer
        open={selectedProcessedItemId !== null}
        width={900}
        destroyOnHidden
        onClose={() => {
          setSelectedProcessedItemId(null);
          setSelectedTitle(null);
          setSelectedUrl(null);
        }}
        title={selectedTitle ?? t("pages.events.drawer.articleDrawerTitle", { defaultValue: "LLM content" })}
      >
        {selectedProcessedQuery.error ? (
          <Alert
            type="error"
            showIcon
            message={t("pages.events.drawer.articleLoadFailed", { defaultValue: "Failed to load article." })}
            description={selectedProcessedQuery.error.message}
          />
        ) : selectedProcessedQuery.loading && selectedProcessedItemId ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : !selectedProcessed ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("pages.events.drawer.articleNotFound", { defaultValue: "Processed item not found." })}
          />
        ) : (
          <Space direction="vertical" size="middle" className="w-full">
            <Space wrap>
              {selectedProcessed.itemMetaId ? (
                <Button type="link" onClick={() => router.push(`/items/${selectedProcessed.itemMetaId}`)}>
                  {t("pages.events.drawer.openItem", { defaultValue: "Open item" })}
                </Button>
              ) : null}
              {selectedUrl ? (
                <a href={selectedUrl} target="_blank" rel="noreferrer">
                  {t("pages.events.drawer.openOriginal", { defaultValue: "Open" })}
                </a>
              ) : null}
              {selectedMarkdownFallbackUsed ? (
                <Tag color="orange">{t("pages.events.drawer.markdownFallback", { defaultValue: "Markdown fallback" })}</Tag>
              ) : null}
            </Space>

            {selectedSummary ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {selectedSummary}
              </Typography.Paragraph>
            ) : null}

            {selectedKeyPoints.length > 0 ? (
              <Space wrap size={[6, 6]}>
                {selectedKeyPoints.slice(0, 12).map((point, idx) => (
                  <Tag key={`sel-kp-${idx}`}>{point}</Tag>
                ))}
                {selectedKeyPoints.length > 12 ? <Tag>+{selectedKeyPoints.length - 12}</Tag> : null}
              </Space>
            ) : null}

            <Space wrap size={[6, 6]}>
              {selectedTopics.slice(0, 8).map((entry, idx) => (
                <Tag key={`sel-topic-${idx}`} color="geekblue">
                  {entry}
                </Tag>
              ))}
              {selectedEntities.slice(0, 8).map((entry, idx) => (
                <Tag key={`sel-entity-${idx}`} color="purple">
                  {entry}
                </Tag>
              ))}
            </Space>

            {selectedMarkdown ? (
              <div className="max-h-[70vh] overflow-auto">
                <MarkdownViewer markdown={selectedMarkdown} />
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("pages.events.drawer.articleEmpty", { defaultValue: "No LLM content available." })}
              />
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
}
