"use client";

import { ArrowLeftOutlined, CalendarOutlined } from "@ant-design/icons";
import { gql, useQuery } from "@apollo/client";
import {
  Alert,
  Breadcrumb,
  Button,
  Card,
  Divider,
  Drawer,
  Empty,
  List,
  Skeleton,
  Space,
  Tag,
  Tabs,
  Tooltip,
  Typography,
} from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArticlePublishedTime } from "@/components/article-published-time";
import { AnnotationPanel } from "@/components/analysis/annotation-panel";
import { MarkdownViewer } from "@/components/markdown-viewer";
import {
  useNewsEventBriefQuery,
  useProcessedItemByIdQuery,
} from "@/graphql/generated";
import { useTheme } from "@/hooks/use-theme";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import {
  formatDateTime,
  formatRelativeTime,
  formatTimeZoneOffsetLabel,
  getDefaultTimeZone,
  resolveLocale,
} from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import { trackUserNewsBehavior } from "@/lib/user-news-behavior";

import { EventSignalCard } from "../components/event-signal-card";
import { resolveFutureEventHintStyle } from "../components/event-visuals";
import {
  isFutureEventTimestamp,
  toCredibilityPercent,
  toHeatPercent,
} from "../events-list-helpers";
import { pickRepresentativeProcessedItemId } from "../utils";

interface EventItem {
  id: string;
  eventId: string;
  processedArticleId: string;
  itemMetaId?: string | null;
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
  categoryPath?: string | null;
  categoryConfidence?: number | null;
  tentative?: boolean | null;
  anchor?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

interface NewsEventSourceEvidence {
  uniqueSourceCount: number;
  authoritativeSourceCount: number;
  blogSourceCount: number;
  corroborated: boolean;
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
  heatScore: number;
  credibilityScore: number;
  sourceType: "all" | "authoritative" | "mixed" | "blog" | "unknown";
  sourceEvidence?: NewsEventSourceEvidence | null;
  representativeProcessedItemId?: string | null;
  categoryDistribution?: unknown;
  topicDriftWarning?: boolean | null;
  topicDriftSummary?: string | null;
  timelinePhases?: unknown;
  subEvents?: unknown;
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
      heatScore
      credibilityScore
      sourceType
      sourceEvidence {
        uniqueSourceCount
        authoritativeSourceCount
        blogSourceCount
        corroborated
      }
      representativeProcessedItemId
      categoryDistribution
      topicDriftWarning
      topicDriftSummary
      timelinePhases
      subEvents
      items {
        id
        eventId
        processedArticleId
        itemMetaId
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
        categoryPath
        categoryConfidence
        tentative
        anchor
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
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
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
    .filter(
      (name): name is string =>
        typeof name === "string" && name.trim().length > 0,
    );
};

function getResultObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

interface CategoryDistributionEntry {
  categoryPath: string;
  count: number;
  share: number;
}

interface TimelinePhaseSummary {
  phase: number;
  label: string;
  categoryPrefix: string;
  startAt: string;
  endAt: string;
  itemCount: number;
  bucketCount: number;
  summary: string;
}

function normalizeCategoryDistribution(
  value: unknown,
): CategoryDistributionEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const categoryPath =
        typeof record.categoryPath === "string"
          ? record.categoryPath.trim()
          : "";
      const count =
        typeof record.count === "number" && Number.isFinite(record.count)
          ? record.count
          : 0;
      const share =
        typeof record.share === "number" && Number.isFinite(record.share)
          ? record.share
          : 0;
      if (!categoryPath || count <= 0) {
        return null;
      }
      return {
        categoryPath,
        count,
        share: Math.max(0, Math.min(1, share)),
      };
    })
    .filter((entry): entry is CategoryDistributionEntry => Boolean(entry));
}

function normalizeTimelinePhases(value: unknown): TimelinePhaseSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const phase =
        typeof record.phase === "number" && Number.isFinite(record.phase)
          ? record.phase
          : 0;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const categoryPrefix =
        typeof record.categoryPrefix === "string"
          ? record.categoryPrefix.trim()
          : "";
      const startAt = typeof record.startAt === "string" ? record.startAt : "";
      const endAt = typeof record.endAt === "string" ? record.endAt : "";
      const itemCount =
        typeof record.itemCount === "number" &&
        Number.isFinite(record.itemCount)
          ? record.itemCount
          : 0;
      const bucketCount =
        typeof record.bucketCount === "number" &&
        Number.isFinite(record.bucketCount)
          ? record.bucketCount
          : 0;
      const summary =
        typeof record.summary === "string" ? record.summary.trim() : "";
      if (!label || !categoryPrefix || !startAt || !endAt) {
        return null;
      }
      return {
        phase,
        label,
        categoryPrefix,
        startAt,
        endAt,
        itemCount,
        bucketCount,
        summary,
      };
    })
    .filter((entry): entry is TimelinePhaseSummary => Boolean(entry));
}

function formatConfidencePercent(
  value: number | null | undefined,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, value));
  return `${Math.round(clamped * 100)}%`;
}

export function EventDetail({ eventId }: { eventId: string }) {
  const { t, i18n } = useTranslation();
  const { isDark } = useTheme();
  const locale = resolveLocale(i18n.language);
  const timeZone = getDefaultTimeZone();
  const timeZoneLabel = useMemo(
    () => formatTimeZoneOffsetLabel(new Date(), timeZone),
    [timeZone],
  );
  const futureEventHintStyle = useMemo(
    () => resolveFutureEventHintStyle(isDark),
    [isDark],
  );
  const router = useRouter();

  const [selectedProcessedItemId, setSelectedProcessedItemId] = useState<
    string | null
  >(null);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [markdownExpanded, setMarkdownExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState("brief");
  const [highlightedSourceIndex, setHighlightedSourceIndex] = useState<
    number | null
  >(null);
  const sourceRowRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const { data, loading, error, refetch } = useQuery<{
    newsEvent: NewsEvent | null;
  }>(NEWS_EVENT_QUERY, {
    variables: { id: eventId, itemsLimit: 80, timelineLimit: 400 },
    fetchPolicy: "network-only",
  });

  const event = data?.newsEvent ?? null;
  const briefLanguage = i18n.language;
  const briefMaxSources = 10;
  const briefQuery = useNewsEventBriefQuery({
    variables: {
      eventId,
      language: briefLanguage,
      maxSources: briefMaxSources,
      forceRefresh: false,
    },
    skip: activeTab !== "brief",
    fetchPolicy: "network-only",
    notifyOnNetworkStatusChange: true,
  });
  const brief = briefQuery.data?.newsEventBrief ?? null;

  const timeline = useMemo(() => {
    const entries = event?.timeline ?? [];
    return [...entries].sort(
      (a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf(),
    );
  }, [event?.timeline]);
  const categoryDistribution = useMemo(
    () => normalizeCategoryDistribution(event?.categoryDistribution),
    [event?.categoryDistribution],
  );
  const timelinePhases = useMemo(
    () => normalizeTimelinePhases(event?.timelinePhases ?? event?.subEvents),
    [event?.timelinePhases, event?.subEvents],
  );

  const items = useMemo(() => {
    const rows = event?.items ?? [];
    return [...rows].sort(
      (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
    );
  }, [event?.items]);
  const itemByProcessedArticleId = useMemo(() => {
    const entries = items.map(
      (item) => [item.processedArticleId, item] as const,
    );
    return new Map(entries);
  }, [items]);
  const itemMetaIdByProcessedItemId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      const processedItemId =
        typeof item.processedItemId === "string"
          ? item.processedItemId.trim()
          : "";
      const itemMetaId =
        typeof item.itemMetaId === "string" ? item.itemMetaId.trim() : "";
      if (!processedItemId || !itemMetaId || map.has(processedItemId)) {
        continue;
      }
      map.set(processedItemId, itemMetaId);
    }
    return map;
  }, [items]);
  const resolveTrackedItemId = (processedItemId?: string | null) => {
    if (typeof processedItemId !== "string") {
      return undefined;
    }
    const normalized = processedItemId.trim();
    if (!normalized) {
      return undefined;
    }
    return itemMetaIdByProcessedItemId.get(normalized) ?? undefined;
  };
  const briefSourcesByIndex = useMemo(() => {
    const map = new Map<number, NonNullable<typeof brief>["sources"][number]>();
    for (const source of brief?.sources ?? []) {
      map.set(source.index, source);
    }
    return map;
  }, [brief?.sources]);

  const representativeProcessedItemId = useMemo(
    () => pickRepresentativeProcessedItemId(event),
    [event],
  );
  const representativeItem = useMemo(() => {
    if (!representativeProcessedItemId) {
      return null;
    }
    const rows = event?.items ?? [];
    return (
      rows.find(
        (row) =>
          (row.processedItemId ?? null) === representativeProcessedItemId,
      ) ?? null
    );
  }, [event?.items, representativeProcessedItemId]);
  const representativeUrl = safeHttpUrl(
    representativeItem?.processedArticle.article.url ?? null,
  );

  const {
    data: representativeProcessedData,
    loading: representativeProcessedLoading,
    error: representativeProcessedError,
  } = useProcessedItemByIdQuery({
    variables: { id: representativeProcessedItemId ?? "" },
    skip: !representativeProcessedItemId,
    fetchPolicy: "network-only",
  });

  const representativeProcessed =
    representativeProcessedData?.processedItemById ?? null;
  const representativeResult = useMemo(
    () => getResultObject(representativeProcessed?.resultJson),
    [representativeProcessed?.resultJson],
  );
  const representativeSummary = toString(representativeResult?.summary);
  const representativeKeyPoints = toStringList(
    representativeResult?.key_points,
  );
  const representativeTopics = toStringList(representativeResult?.topics);
  const representativeEntities = toEntityNames(representativeResult?.entities);
  const representativeMarkdown = toString(
    representativeResult?.cleaned_markdown,
  );
  const representativeMarkdownSource = toString(
    representativeResult?.cleaned_markdown_source,
  );
  const representativeMarkdownFallbackUsed =
    representativeMarkdownSource === "crawl_fallback";
  const hasRepresentativeNarrative =
    Boolean(representativeSummary) ||
    representativeKeyPoints.length > 0 ||
    Boolean(representativeMarkdown);

  const selectedProcessedQuery = useProcessedItemByIdQuery({
    variables: { id: selectedProcessedItemId ?? "" },
    skip: !selectedProcessedItemId,
    fetchPolicy: "network-only",
  });
  const selectedProcessed =
    selectedProcessedQuery.data?.processedItemById ?? null;

  useEffect(() => {
    if (!error) {
      return;
    }
    captureClientError("Failed to load event detail", error);
  }, [error]);

  useEffect(() => {
    if (!briefQuery.error) {
      return;
    }
    captureClientError(
      "Failed to load event detailed summary",
      briefQuery.error,
    );
  }, [briefQuery.error]);

  useEffect(() => {
    if (!representativeProcessedError) {
      return;
    }
    captureClientError(
      "Failed to load representative article in event detail",
      representativeProcessedError,
    );
  }, [representativeProcessedError]);

  useEffect(() => {
    if (!selectedProcessedQuery.error) {
      return;
    }
    captureClientError(
      "Failed to load selected processed article in event detail",
      selectedProcessedQuery.error,
    );
  }, [selectedProcessedQuery.error]);

  useEffect(() => {
    if (highlightedSourceIndex === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setHighlightedSourceIndex((current) =>
        current === highlightedSourceIndex ? null : current,
      );
    }, 4_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [highlightedSourceIndex]);

  useEffect(() => {
    if (activeTab !== "brief" || highlightedSourceIndex === null) {
      return;
    }
    const node = sourceRowRefs.current[highlightedSourceIndex];
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeTab, brief?.sources, highlightedSourceIndex]);
  const selectedProcessedResult = useMemo(
    () => getResultObject(selectedProcessed?.resultJson),
    [selectedProcessed?.resultJson],
  );
  const selectedSummary = toString(selectedProcessedResult?.summary);
  const selectedKeyPoints = toStringList(selectedProcessedResult?.key_points);
  const selectedTopics = toStringList(selectedProcessedResult?.topics);
  const selectedEntities = toEntityNames(selectedProcessedResult?.entities);
  const selectedMarkdown = toString(selectedProcessedResult?.cleaned_markdown);
  const selectedMarkdownSource = toString(
    selectedProcessedResult?.cleaned_markdown_source,
  );
  const selectedMarkdownFallbackUsed =
    selectedMarkdownSource === "crawl_fallback";
  const topic = event?.primaryTopic?.trim() ?? "";
  const entity = event?.primaryEntity?.trim() ?? "";

  useEffect(() => {
    if (!event?.id) {
      return;
    }
    void trackUserNewsBehavior({
      type: "view",
      eventId: event.id,
      ...(topic ? { topics: [topic] } : {}),
      ...(entity ? { entities: [entity] } : {}),
      ...(representativeUrl ? { url: representativeUrl } : {}),
    });
  }, [entity, event?.id, representativeUrl, topic]);

  if (loading && !event) {
    return (
      <Card className="content-card">
        <Skeleton active paragraph={{ rows: 10 }} />
      </Card>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={t("pages.events.detail.loadFailed")}
        description={t("common.serviceUnavailable")}
      />
    );
  }

  if (!event) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t("pages.events.detail.notFound")}
      />
    );
  }

  const title = event.title?.trim()
    ? event.title.trim()
    : entity || topic || event.id;
  const language = event.language?.trim() ?? "";
  const statusLabel = t(`pages.events.status.${event.status}`, {
    defaultValue: event.status,
  });
  const sourceEvidence: NewsEventSourceEvidence = event.sourceEvidence ?? {
    uniqueSourceCount: 0,
    authoritativeSourceCount: 0,
    blogSourceCount: 0,
    corroborated: false,
  };
  const sourceTypeLabelMap: Record<NewsEvent["sourceType"], string> = {
    all: t("pages.events.filters.sourceType.all"),
    authoritative: t("pages.events.filters.sourceType.authoritative"),
    mixed: t("pages.events.filters.sourceType.mixed"),
    blog: t("pages.events.filters.sourceType.blog"),
    unknown: t("pages.events.filters.sourceType.unknown"),
  };
  const credibilitySummary = sourceEvidence.corroborated
    ? t("pages.events.detail.credibilityStrong")
    : sourceEvidence.uniqueSourceCount <= 1
      ? t("pages.events.detail.credibilityWeak")
      : t("pages.events.detail.credibilityMedium");

  const trackEventBehavior = (input: {
    type: "view" | "click" | "open_item";
    source?: string;
    url?: string | null;
    itemId?: string;
  }) => {
    void trackUserNewsBehavior({
      type: input.type,
      eventId: event.id,
      source: input.source,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(topic ? { topics: [topic] } : {}),
      ...(entity ? { entities: [entity] } : {}),
      ...(input.url ? { url: input.url } : {}),
    });
  };

  const startRelative = formatRelativeTime(event.startAt, locale, { timeZone });
  const lastRelative = formatRelativeTime(event.lastAt, locale, { timeZone });
  const startTooltip = formatDateTime(event.startAt, locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short",
  });
  const lastTooltip = formatDateTime(event.lastAt, locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short",
  });
  const isFutureEvent = isFutureEventTimestamp(event.lastAt);
  const heatPercent = toHeatPercent(event.heatScore);
  const credibilityPercent = toCredibilityPercent(event.credibilityScore);

  const repMarkdownCollapsed = Boolean(
    representativeMarkdown && representativeMarkdown.length > 2500,
  );
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
          const processedItemId =
            typeof source?.processedItemId === "string"
              ? source.processedItemId.trim()
              : "";
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
              style={processedItemId || url ? { cursor: "pointer" } : undefined}
              onClick={() => {
                setHighlightedSourceIndex(idx);
                const trackedItemId = resolveTrackedItemId(
                  source?.processedItemId,
                );
                trackEventBehavior({
                  type: "click",
                  source: source?.sourceLabel ?? undefined,
                  url,
                  ...(trackedItemId ? { itemId: trackedItemId } : {}),
                });
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

  const renderPointList = (
    points: { text: string; citations: number[] }[] | null | undefined,
  ) => {
    const dataSource = points ?? [];
    if (dataSource.length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("common.notAvailable")}
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

  const renderDetailedSummary = (summary: string | null | undefined) => {
    const normalized = typeof summary === "string" ? summary.trim() : "";
    if (!normalized) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("common.notAvailable")}
        />
      );
    }
    return (
      <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-line" }}>
        {normalized}
      </Typography.Paragraph>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        {/* Breadcrumb Navigation */}
        <Breadcrumb
          items={[
            {
              title: (
                <Link href="/events">
                  {t("pages.events.title")}
                </Link>
              ),
            },
            { title: title },
          ]}
        />

        <Space align="center" wrap size={[8, 6]}>
          <Button
            icon={<ArrowLeftOutlined />}
            type="link"
            onClick={() => router.push("/events")}
          >
            {t("common.back")}
          </Button>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Tooltip title={`${timeZone} (${timeZoneLabel || timeZone})`}>
            <Tag>{timeZoneLabel || timeZone}</Tag>
          </Tooltip>
        </Space>

        <Space wrap size={[6, 6]}>
          <Tag color={event.status === "active" ? "green" : "default"}>
            {statusLabel}
          </Tag>
          <Tag>
            {t("pages.events.drawer.items")}:{" "}
            {event.itemCount}
          </Tag>
          {isFutureEvent ? (
            <Tag color="cyan" icon={<CalendarOutlined />}>
              {t("pages.events.fields.futureEvent")}
            </Tag>
          ) : null}
          {language ? <Tag color="blue">{language}</Tag> : null}
          {topic ? <Tag color="geekblue">{topic}</Tag> : null}
          {entity ? (
            <Tag
              color="purple"
              style={{ cursor: "pointer" }}
              onClick={() =>
                router.push(`/events?entity=${encodeURIComponent(entity)}`)
              }
            >
              {entity}
            </Tag>
          ) : null}
        </Space>

        <Space wrap size={[12, 0]}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("pages.events.fields.startAt")}:{" "}
            <Tooltip
              title={`${startTooltip}${startRelative ? ` (${startRelative})` : ""}`}
            >
              <span>
                {formatDateTime(event.startAt, locale, {
                  dateStyle: "medium",
                  timeZone,
                })}
              </span>
            </Tooltip>
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("pages.events.fields.lastAt")}:{" "}
            <Tooltip
              title={`${lastTooltip}${lastRelative ? ` (${lastRelative})` : ""}`}
            >
              <span>
                {formatDateTime(event.lastAt, locale, {
                  dateStyle: "medium",
                  timeZone,
                })}
              </span>
            </Tooltip>
            {lastRelative ? (
              <span className="ml-1 opacity-80">({lastRelative})</span>
            ) : null}
            {isFutureEvent ? (
              <span className="ml-1" style={futureEventHintStyle}>
                {t("pages.events.fields.futureEventHint")}
              </span>
            ) : null}
          </Typography.Text>
        </Space>

        {event.summary ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {event.summary}
          </Typography.Paragraph>
        ) : null}
      </Space>

      <Card size="small" className="content-card">
        <Space direction="vertical" size={8} className="w-full">
          <Typography.Text strong>
            {t("pages.events.detail.credibilityCardTitle")}
          </Typography.Text>
          <div className="flex flex-wrap gap-2">
            <EventSignalCard
              tone="heat"
              label={t("pages.events.fields.heat")}
              value={event.heatScore.toFixed(1)}
              percent={heatPercent}
              minWidth={168}
              progressSize={[150, 6]}
            />
            <EventSignalCard
              tone="credibility"
              label={t("pages.events.fields.credibility")}
              value={Math.round(event.credibilityScore)}
              percent={credibilityPercent}
              minWidth={168}
              progressSize={[150, 6]}
            />
          </div>
          <Space wrap size={[8, 8]}>
            <Tag>
              {t("pages.events.fields.sourceType")}
              : {sourceTypeLabelMap[event.sourceType] ?? event.sourceType}
            </Tag>
            <Tag>
              {t("pages.events.detail.uniqueSources")}
              : {sourceEvidence.uniqueSourceCount}
            </Tag>
            <Tag>
              {t("pages.events.detail.authoritativeSources")}
              : {sourceEvidence.authoritativeSourceCount}
            </Tag>
            <Tag>
              {t("pages.events.detail.blogSources")}:{" "}
              {sourceEvidence.blogSourceCount}
            </Tag>
            <Tag color={sourceEvidence.corroborated ? "green" : "orange"}>
              {sourceEvidence.corroborated
                ? t("pages.events.detail.corroboratedYes")
                : t("pages.events.detail.corroboratedNo")}
            </Tag>
          </Space>
          <Typography.Text type="secondary">
            {credibilitySummary}
          </Typography.Text>
        </Space>
      </Card>

      <Card className="content-card">
        <Space direction="vertical" className="w-full" size="middle">
          <Space wrap>
            <Button onClick={() => refetch()} loading={loading}>
              {t("common.refresh")}
            </Button>
            {representativeUrl ? (
              <a href={representativeUrl} target="_blank" rel="noreferrer">
                {t("pages.events.drawer.openOriginal")}
              </a>
            ) : null}
            {representativeProcessed?.itemMetaId ? (
              <Button
                type="link"
                onClick={() => {
                  trackEventBehavior({
                    type: "open_item",
                    itemId: representativeProcessed.itemMetaId ?? undefined,
                    source:
                      representativeItem?.processedArticle.article
                        .sourceLabel ?? undefined,
                    url: representativeUrl ?? null,
                  });
                  router.push(`/items/${representativeProcessed.itemMetaId}`);
                }}
              >
                {t("pages.events.detail.openItem")}
              </Button>
            ) : null}
          </Space>

          <Tabs
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key)}
            items={[
              {
                key: "brief",
                label: t("pages.events.detail.tabs.brief"),
                children: (
                  <div className="flex flex-col gap-4">
                    <Space wrap>
                      <Button
                        onClick={() =>
                          briefQuery.refetch({
                            eventId,
                            language: briefLanguage,
                            maxSources: briefMaxSources,
                            forceRefresh: true,
                          })
                        }
                        loading={briefQuery.loading && !brief}
                      >
                        {t("pages.events.detail.refreshBrief")}
                      </Button>
                      {brief?.generatedAt ? (
                        <Tag>
                          {t("pages.events.detail.generatedAt")}
                          :{" "}
                          {formatDateTime(brief.generatedAt, locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                            timeZone,
                          })}
                        </Tag>
                      ) : null}
                      {brief?.sources?.length ? (
                        <Tag>
                          {t("pages.events.detail.briefSources")}
                          : {brief.sources.length}
                        </Tag>
                      ) : null}
                    </Space>

                    {briefQuery.error ? (
                      <Alert
                        type="error"
                        showIcon
                        message={t("pages.events.detail.briefLoadFailed")}
                        description={t("common.serviceUnavailable")}
                      />
                    ) : briefQuery.loading && !brief ? (
                      <Skeleton active paragraph={{ rows: 10 }} />
                    ) : !brief ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={t("pages.events.detail.briefEmpty")}
                      />
                    ) : (
                      <div className="flex flex-col gap-4">
                        <Card
                          size="small"
                          className="content-card"
                          title={t("pages.events.detail.detailedSummary")}
                        >
                          {renderDetailedSummary(brief.detailedSummary)}
                        </Card>

                        <Card
                          size="small"
                          className="content-card"
                          title={t("pages.events.detail.tldr")}
                        >
                          <Typography.Paragraph style={{ marginBottom: 0 }}>
                            {brief.tldr}
                          </Typography.Paragraph>
                        </Card>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                          <Card
                            size="small"
                            className="content-card"
                            title={t("pages.events.detail.keyPoints")}
                          >
                            {renderPointList(brief.keyPoints)}
                          </Card>
                          <Card
                            size="small"
                            className="content-card"
                            title={t("pages.events.detail.whyMatters")}
                          >
                            {renderPointList(brief.whyItMatters)}
                          </Card>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                          <Card
                            size="small"
                            className="content-card"
                            title={t("pages.events.detail.latestUpdate")}
                          >
                            {brief.latestUpdate
                              ? renderPointList([brief.latestUpdate])
                              : renderPointList([])}
                          </Card>
                          <Card
                            size="small"
                            className="content-card"
                            title={t("pages.events.detail.watch")}
                          >
                            {renderPointList(brief.whatToWatch)}
                          </Card>
                        </div>

                        {brief.comparison ? (
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                            <Card
                              size="small"
                              className="content-card"
                              title={t("pages.events.detail.consensus")}
                            >
                              {renderPointList(brief.comparison.consensus)}
                            </Card>
                            <Card
                              size="small"
                              className="content-card"
                              title={t("pages.events.detail.divergence")}
                            >
                              {renderPointList(brief.comparison.divergence)}
                            </Card>
                          </div>
                        ) : null}

                        {brief.limitations ? (
                          <Alert
                            type="info"
                            showIcon
                            message={t("pages.events.detail.limitations")}
                            description={brief.limitations}
                          />
                        ) : null}

                        <Card
                          size="small"
                          className="content-card"
                          title={t("pages.events.detail.sourcesTitle")}
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
                                ? itemByProcessedArticleId.get(
                                    source.processedArticleId,
                                  )
                                : undefined;
                              const summary =
                                item?.processedArticle.summary ?? null;
                              const isHighlighted =
                                highlightedSourceIndex === source.index;

                              const actions: React.ReactNode[] = [
                                <Button
                                  key="llm"
                                  type="link"
                                  onClick={() => {
                                    if (!source.processedItemId) {
                                      return;
                                    }
                                    const trackedItemId = resolveTrackedItemId(
                                      source.processedItemId,
                                    );
                                    trackEventBehavior({
                                      type: "click",
                                      source: source.sourceLabel ?? undefined,
                                      url,
                                      itemId: trackedItemId,
                                    });
                                    setSelectedProcessedItemId(
                                      source.processedItemId,
                                    );
                                    setSelectedTitle(
                                      source.title ?? sourceName,
                                    );
                                    setSelectedUrl(url ?? null);
                                  }}
                                  disabled={!source.processedItemId}
                                >
                                  {t("pages.events.detail.openLlm")}
                                </Button>,
                              ];

                              if (url) {
                                actions.push(
                                  <a
                                    key="open"
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={() => {
                                      trackEventBehavior({
                                        type: "click",
                                        source: source.sourceLabel ?? undefined,
                                        url,
                                      });
                                    }}
                                  >
                                    {t("pages.events.drawer.openOriginal")}
                                  </a>,
                                );
                              }

                              return (
                                <List.Item key={source.index} actions={actions}>
                                  <div
                                    ref={(node) => {
                                      sourceRowRefs.current[source.index] =
                                        node;
                                    }}
                                    className={`w-full rounded-md p-2 transition-colors ${
                                      isHighlighted
                                        ? "bg-blue-50 ring-1 ring-blue-300"
                                        : ""
                                    }`}
                                  >
                                    <List.Item.Meta
                                      title={
                                        <Space wrap size={[6, 6]}>
                                          <Tag
                                            color={
                                              isHighlighted
                                                ? "processing"
                                                : undefined
                                            }
                                          >
                                            #{source.index}
                                          </Tag>
                                          <Typography.Text strong>
                                            {sourceName}
                                          </Typography.Text>
                                          <ArticlePublishedTime
                                            publishedAt={
                                              source.publishedAt ?? null
                                            }
                                            locale={locale}
                                            timeZone={timeZone}
                                            showLabel={false}
                                            formatOptions={{
                                              dateStyle: "medium",
                                              timeStyle: "short",
                                            }}
                                            primaryClassName="text-xs"
                                            secondaryClassName="text-[11px]"
                                            secondaryStyle={{ fontSize: 11 }}
                                          />
                                        </Space>
                                      }
                                      description={
                                        <div className="flex flex-col gap-1">
                                          {source.title ? (
                                            <Typography.Text>
                                              {source.title}
                                            </Typography.Text>
                                          ) : null}
                                          {summary ? (
                                            <Typography.Paragraph
                                              type="secondary"
                                              ellipsis={{ rows: 2 }}
                                              style={{ marginBottom: 0 }}
                                            >
                                              {summary}
                                            </Typography.Paragraph>
                                          ) : null}
                                        </div>
                                      }
                                    />
                                  </div>
                                </List.Item>
                              );
                            }}
                          />
                        </Card>
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: "narrative",
                label: t("pages.events.detail.tabs.narrative"),
                children: (
                  <div className="flex flex-col gap-4">
                    <div>
                      <Typography.Title level={5} style={{ marginBottom: 8 }}>
                        {t("pages.events.detail.representativeTitle")}
                      </Typography.Title>

                      {!representativeProcessedItemId ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={t(
                            "pages.events.detail.noRepresentative",
                          )}
                        />
                      ) : representativeProcessedError ? (
                        <Alert
                          type="error"
                          showIcon
                          message={t(
                            "pages.events.detail.representativeLoadFailed",
                          )}
                          description={t("common.serviceUnavailable")}
                        />
                      ) : representativeProcessedLoading ? (
                        <Skeleton active paragraph={{ rows: 8 }} />
                      ) : !representativeProcessed ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={t(
                            "pages.events.detail.representativeMissing",
                          )}
                        />
                      ) : !hasRepresentativeNarrative ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={t(
                            "pages.events.detail.representativeEmpty",
                          )}
                        />
                      ) : (
                        <div className="flex flex-col gap-3">
                          {representativeMarkdownFallbackUsed ? (
                            <Alert
                              type="warning"
                              showIcon
                              message={t("items.detail.markdownFallback")}
                              description={t(
                                "items.detail.markdownFallbackTooltip",
                              )}
                            />
                          ) : null}

                          {representativeSummary ? (
                            <Typography.Paragraph
                              type="secondary"
                              style={{ marginBottom: 0 }}
                            >
                              {representativeSummary}
                            </Typography.Paragraph>
                          ) : null}

                          {representativeKeyPoints.length > 0 ? (
                            <Space wrap size={[6, 6]}>
                              {representativeKeyPoints
                                .slice(0, 10)
                                .map((point, idx) => (
                                  <Tag key={`rep-kp-${idx}`}>{point}</Tag>
                                ))}
                              {representativeKeyPoints.length > 10 ? (
                                <Tag>
                                  +{representativeKeyPoints.length - 10}
                                </Tag>
                              ) : null}
                            </Space>
                          ) : null}

                          <Space wrap size={[6, 6]}>
                            {representativeTopics
                              .slice(0, 6)
                              .map((entry, idx) => (
                                <Tag key={`rep-topic-${idx}`} color="geekblue">
                                  {entry}
                                </Tag>
                              ))}
                            {representativeEntities
                              .slice(0, 6)
                              .map((entry, idx) => (
                                <Tag key={`rep-entity-${idx}`} color="purple">
                                  {entry}
                                </Tag>
                              ))}
                          </Space>

                          {representativeMarkdown ? (
                            <div className="flex flex-col gap-2">
                              {repMarkdownCollapsed ? (
                                <Button
                                  type="link"
                                  onClick={() => setMarkdownExpanded((v) => !v)}
                                >
                                  {markdownExpanded
                                    ? t("common.collapse")
                                    : t("common.expand")}
                                </Button>
                              ) : null}
                              <div
                                className={
                                  markdownExpanded
                                    ? ""
                                    : repMarkdownCollapsed
                                      ? "max-h-[60vh] overflow-auto"
                                      : ""
                                }
                              >
                                <MarkdownViewer
                                  markdown={representativeMarkdown}
                                />
                              </div>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>

                    <Divider style={{ margin: "8px 0" }} />

                    <div>
                      <Typography.Title level={5} style={{ marginBottom: 8 }}>
                        {t("pages.events.drawer.tabs.timeline")}
                      </Typography.Title>

                      {event.topicDriftWarning ? (
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message={t("pages.events.detail.topicDrift")}
                          description={
                            event.topicDriftSummary ??
                            t("pages.events.detail.topicDriftDescription")
                          }
                        />
                      ) : null}

                      {timelinePhases.length > 0 ? (
                        <Card
                          size="small"
                          style={{ marginBottom: 12 }}
                          title={t("pages.events.detail.timelinePhases")}
                        >
                          <Space
                            direction="vertical"
                            size={8}
                            className="w-full"
                          >
                            {timelinePhases.map((phase) => (
                              <div key={`${phase.phase}-${phase.startAt}`}>
                                <Space wrap size={[6, 6]}>
                                  <Tag color="processing">P{phase.phase}</Tag>
                                  <Tag>{phase.categoryPrefix}</Tag>
                                  <Typography.Text strong>
                                    {phase.label}
                                  </Typography.Text>
                                </Space>
                                <Typography.Paragraph
                                  type="secondary"
                                  style={{ margin: "4px 0 0" }}
                                >
                                  {phase.summary}
                                </Typography.Paragraph>
                              </div>
                            ))}
                          </Space>
                        </Card>
                      ) : null}

                      {categoryDistribution.length > 0 ? (
                        <Space wrap size={[6, 6]} style={{ marginBottom: 12 }}>
                          {categoryDistribution.slice(0, 8).map((entry) => (
                            <Tag key={entry.categoryPath}>
                              {entry.categoryPath} ·{" "}
                              {Math.round(entry.share * 100)}%
                            </Tag>
                          ))}
                        </Space>
                      ) : null}

                      {timeline.length === 0 ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={t("pages.events.drawer.timelineEmpty")}
                        />
                      ) : (
                        <List
                          dataSource={timeline}
                          renderItem={(entry) => {
                            const keyPoints = normalizeStringArray(
                              entry.keyPoints,
                            );
                            const referencedIds = normalizeStringArray(
                              entry.referencedArticleIds,
                            );
                            const confidence = formatConfidencePercent(
                              entry.categoryConfidence,
                            );
                            const isTentative = Boolean(entry.tentative);
                            const isAnchor = Boolean(entry.anchor);
                            return (
                              <List.Item key={entry.id}>
                                <List.Item.Meta
                                  title={
                                    <Space wrap size={[8, 6]}>
                                      <Typography.Text strong>
                                        {formatDateTime(
                                          entry.bucketStart,
                                          locale,
                                          { dateStyle: "medium", timeZone },
                                        )}
                                      </Typography.Text>
                                      {referencedIds.length > 0 ? (
                                        <Tag>
                                          {t("pages.events.drawer.references")}
                                          : {referencedIds.length}
                                        </Tag>
                                      ) : null}
                                      {entry.categoryPath ? (
                                        <Tag color="geekblue">
                                          {entry.categoryPath}
                                        </Tag>
                                      ) : null}
                                      {confidence ? (
                                        <Tag
                                          color={
                                            isTentative
                                              ? "orange"
                                              : isAnchor
                                                ? "green"
                                                : "default"
                                          }
                                        >
                                          {t("pages.events.detail.confidence")}
                                          : {confidence}
                                        </Tag>
                                      ) : null}
                                      {isAnchor ? (
                                        <Tag color="success">
                                          {t("pages.events.detail.anchor")}
                                        </Tag>
                                      ) : null}
                                      {isTentative ? (
                                        <Tag color="warning">
                                          {t("pages.events.detail.tentative")}
                                        </Tag>
                                      ) : null}
                                    </Space>
                                  }
                                  description={
                                    <div
                                      className={`flex flex-col gap-1 rounded-md ${isTentative ? "border border-dashed border-amber-300 bg-amber-50/40 p-2 opacity-80" : ""}`}
                                    >
                                      {entry.title ? (
                                        <Typography.Text>
                                          {entry.title}
                                        </Typography.Text>
                                      ) : null}
                                      {entry.summary ? (
                                        <Typography.Paragraph
                                          type="secondary"
                                          ellipsis={{ rows: 4 }}
                                          style={{ marginBottom: 0 }}
                                        >
                                          {entry.summary}
                                        </Typography.Paragraph>
                                      ) : null}
                                      {keyPoints.length > 0 ? (
                                        <Space wrap size={[6, 6]}>
                                          {keyPoints
                                            .slice(0, 10)
                                            .map((point, idx) => (
                                              <Tag
                                                key={`${entry.id}-${idx}`}
                                                color="default"
                                              >
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
                      )}
                    </div>
                  </div>
                ),
              },
              {
                key: "articles",
                label: t("pages.events.drawer.tabs.articles"),
                children:
                  items.length === 0 ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={t("pages.events.drawer.itemsEmpty")}
                    />
                  ) : (
                    <List
                      dataSource={items}
                      renderItem={(item) => {
                        const processed = item.processedArticle;
                        const url = safeHttpUrl(processed.article.url);
                        const similarity = formatSimilarity(item.similarity);
                        const sourceLabel =
                          processed.article.sourceLabel?.trim() ?? "";
                        const ingestedLabel = t("items.time.ingested");
                        const publishedAt = processed.publishedAt ?? null;
                        const ingestedAt =
                          processed.article.crawlAt ??
                          processed.processedAt ??
                          null;
                        const canOpenLlm = Boolean(item.processedItemId);
                        const llmButtonLabel = t(
                          "pages.events.detail.openLlm",
                        );

                        const openLlm = () => {
                          const processedItemId = item.processedItemId ?? null;
                          if (!processedItemId) {
                            return;
                          }
                          trackEventBehavior({
                            type: "click",
                            source: sourceLabel || undefined,
                            url,
                            itemId: item.itemMetaId ?? undefined,
                          });
                          setSelectedProcessedItemId(processedItemId);
                          setSelectedTitle(
                            processed.title ?? processed.articleId,
                          );
                          setSelectedUrl(url ?? null);
                        };

                        return (
                          <List.Item
                            key={item.id}
                            extra={
                              <Space size="small">
                                <Button
                                  type="link"
                                  onClick={openLlm}
                                  disabled={!canOpenLlm}
                                >
                                  {llmButtonLabel}
                                </Button>
                                {url ? (
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {t("pages.events.drawer.openOriginal")}
                                  </a>
                                ) : null}
                              </Space>
                            }
                          >
                            <List.Item.Meta
                              title={
                                <Space wrap size={[6, 6]}>
                                  <Typography.Text strong>
                                    {processed.title ?? processed.articleId}
                                  </Typography.Text>
                                  <Tag color="default">{item.assignedBy}</Tag>
                                  {similarity ? (
                                    <Tag color="blue">{similarity}</Tag>
                                  ) : null}
                                  {sourceLabel ? (
                                    <Tag color="geekblue">{sourceLabel}</Tag>
                                  ) : null}
                                </Space>
                              }
                              description={
                                <Space direction="vertical" size={0}>
                                  <ArticlePublishedTime
                                    publishedAt={publishedAt}
                                    locale={locale}
                                    timeZone={timeZone}
                                    formatOptions={{
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    }}
                                    primaryStrong
                                    secondaryStyle={{ fontSize: 12 }}
                                  />
                                  <Typography.Text
                                    type="secondary"
                                    style={{ fontSize: 12 }}
                                  >
                                    {ingestedLabel}:{" "}
                                    {ingestedAt
                                      ? formatDateTime(ingestedAt, locale, {
                                          dateStyle: "medium",
                                          timeZone,
                                        })
                                      : t("common.notAvailable")}
                                  </Typography.Text>
                                  {processed.summary ? (
                                    <Typography.Paragraph
                                      type="secondary"
                                      ellipsis={{ rows: 3 }}
                                      style={{ marginBottom: 0 }}
                                    >
                                      {processed.summary}
                                    </Typography.Paragraph>
                                  ) : null}
                                </Space>
                              }
                            />
                          </List.Item>
                        );
                      }}
                    />
                  ),
              },
            ]}
          />
        </Space>
      </Card>

      <Drawer
        open={selectedProcessedItemId !== null}
        width={900}
        destroyOnHidden
        onClose={() => {
          setSelectedProcessedItemId(null);
          setSelectedTitle(null);
          setSelectedUrl(null);
        }}
        title={
          selectedTitle ??
          t("pages.events.detail.articleDrawerTitle")
        }
      >
        {selectedProcessedQuery.error ? (
          <Alert
            type="error"
            showIcon
            message={t("pages.events.detail.articleLoadFailed")}
            description={t("common.serviceUnavailable")}
          />
        ) : selectedProcessedQuery.loading && selectedProcessedItemId ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : !selectedProcessed ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("pages.events.detail.articleNotFound")}
          />
        ) : (
          <Space direction="vertical" size="middle" className="w-full">
            <Space wrap>
              {selectedProcessed.itemMetaId ? (
                <Button
                  type="link"
                  onClick={() => {
                    trackEventBehavior({
                      type: "open_item",
                      itemId: selectedProcessed.itemMetaId ?? undefined,
                      url: selectedUrl,
                    });
                    router.push(`/items/${selectedProcessed.itemMetaId}`);
                  }}
                >
                  {t("pages.events.detail.openItem")}
                </Button>
              ) : null}
              {selectedUrl ? (
                <a href={selectedUrl} target="_blank" rel="noreferrer">
                  {t("pages.events.drawer.openOriginal")}
                </a>
              ) : null}
              {selectedMarkdownFallbackUsed ? (
                <Tag color="orange">
                  {t("items.detail.markdownFallback")}
                </Tag>
              ) : null}
            </Space>

            {selectedSummary ? (
              <Typography.Paragraph
                type="secondary"
                style={{ marginBottom: 0 }}
              >
                {selectedSummary}
              </Typography.Paragraph>
            ) : null}

            {selectedKeyPoints.length > 0 ? (
              <Space wrap size={[6, 6]}>
                {selectedKeyPoints.slice(0, 12).map((point, idx) => (
                  <Tag key={`sel-kp-${idx}`}>{point}</Tag>
                ))}
                {selectedKeyPoints.length > 12 ? (
                  <Tag>+{selectedKeyPoints.length - 12}</Tag>
                ) : null}
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
                description={t("pages.events.detail.articleEmpty")}
              />
            )}
          </Space>
        )}
      </Drawer>

      <AnnotationPanel subjectType="event" subjectId={eventId} />
    </div>
  );
}
