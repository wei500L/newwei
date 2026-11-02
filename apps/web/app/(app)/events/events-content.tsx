"use client";

import { gql, useQuery } from "@apollo/client";
import { Button, Card, List, Select, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import { AnalysisToolbar } from "@/components/analysis/analysis-toolbar";
import { AnnotationPanel } from "@/components/analysis/annotation-panel";
import { FilterBar } from "@/components/filter-bar";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { PageHeader } from "@/components/page-header";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { useTheme } from "@/hooks/use-theme";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, formatRelativeTime, formatTimeZoneOffsetLabel, getDefaultTimeZone, resolveLocale } from "@/lib/i18n";

import { EventSignalCard } from "./components/event-signal-card";
import { resolveEventRowSurface, resolveFutureEventHintStyle } from "./components/event-visuals";
import { isFutureEventTimestamp, normalizeEntityFilter, toCredibilityPercent, toHeatPercent } from "./events-list-helpers";

// Event details now use dedicated page at /events/[id]

export interface NewsEventListItem {
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
  breaking: boolean;
  heatScore: number;
  credibilityScore: number;
  sourceType: "all" | "authoritative" | "mixed" | "blog" | "unknown";
  sourceEvidence: {
    uniqueSourceCount: number;
    authoritativeSourceCount: number;
    blogSourceCount: number;
    corroborated: boolean;
  };
  representativeProcessedArticleId?: string | null;
  representativeProcessedItemId?: string | null;
  createdAt: string;
  updatedAt: string;
}

const NEWS_EVENTS_QUERY = gql`
  query NewsEvents(
    $limit: Int
    $windowDays: Int
    $status: NewsEventStatus
    $entity: String
    $sourceType: NewsEventSourceType
    $minHeatScore: Float
    $minCredibilityScore: Float
    $sortBy: NewsEventSortBy
  ) {
    newsEvents(
      limit: $limit
      windowDays: $windowDays
      status: $status
      entity: $entity
      sourceType: $sourceType
      minHeatScore: $minHeatScore
      minCredibilityScore: $minCredibilityScore
      sortBy: $sortBy
    ) {
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
      breaking
      heatScore
      credibilityScore
      sourceType
      sourceEvidence {
        uniqueSourceCount
        authoritativeSourceCount
        blogSourceCount
        corroborated
      }
      representativeProcessedArticleId
      representativeProcessedItemId
      createdAt
      updatedAt
    }
  }
`;

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_STATUS = "active";
const DEFAULT_SORT_BY = "latest";
const DEFAULT_SOURCE_TYPE = "all";
const DEFAULT_MIN_HEAT = 0;
const DEFAULT_MIN_CREDIBILITY = 0;

const parsePositiveInt = (value: string | null, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
};

const parseNonNegativeFloat = (value: string | null, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
};

interface EventsContentProps {
  initialData?: { newsEvents: NewsEventListItem[] } | null;
}

function resolveEventTitle(event: NewsEventListItem) {
  const title = event.title?.trim() ?? "";
  if (title) {
    return title;
  }
  const entity = event.primaryEntity?.trim() ?? "";
  if (entity) {
    return entity;
  }
  const topic = event.primaryTopic?.trim() ?? "";
  if (topic) {
    return topic;
  }
  return event.id;
}

export function EventsContent({ initialData = null }: EventsContentProps) {
  const { t, i18n } = useTranslation();
  const { isDark } = useTheme();
  const locale = resolveLocale(i18n.language);
  const timeZone = getDefaultTimeZone();
  const timeZoneLabel = useMemo(() => formatTimeZoneOffsetLabel(new Date(), timeZone), [timeZone]);
  const futureEventHintStyle = useMemo(() => resolveFutureEventHintStyle(isDark), [isDark]);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const savedViewId = useMemo(() => {
    const value = searchParams.get("savedView")?.trim();
    return value ? value : null;
  }, [searchParams]);
  // Note: Event details are now displayed on dedicated page /events/[id]
  // Drawer removed to enable URL sharing and proper back button behavior

  const windowDays = useMemo(
    () => parsePositiveInt(searchParams.get("window"), DEFAULT_WINDOW_DAYS),
    [searchParams]
  );
  const limit = useMemo(
    () => parsePositiveInt(searchParams.get("limit"), DEFAULT_LIMIT),
    [searchParams]
  );
  const status = useMemo(() => {
    const value = searchParams.get("status");
    if (!value) {
      return DEFAULT_STATUS;
    }
    return ["active", "archived", "all"].includes(value) ? value : DEFAULT_STATUS;
  }, [searchParams]);
  const sortBy = useMemo(() => {
    const value = (searchParams.get("sort") ?? "").trim().toLowerCase();
    return ["latest", "heat", "credibility"].includes(value) ? value : DEFAULT_SORT_BY;
  }, [searchParams]);
  const sourceType = useMemo(() => {
    const value = (searchParams.get("sourceType") ?? "").trim().toLowerCase();
    return ["all", "authoritative", "mixed", "blog", "unknown"].includes(value)
      ? value
      : DEFAULT_SOURCE_TYPE;
  }, [searchParams]);
  const minHeatScore = useMemo(
    () => parseNonNegativeFloat(searchParams.get("minHeat"), DEFAULT_MIN_HEAT),
    [searchParams]
  );
  const minCredibilityScore = useMemo(
    () => parseNonNegativeFloat(searchParams.get("minCredibility"), DEFAULT_MIN_CREDIBILITY),
    [searchParams]
  );
  const entityFilter = useMemo(
    () => normalizeEntityFilter(searchParams.get("entity")),
    [searchParams]
  );

  const updateFilters = useCallback(
    (updates: {
      windowDays?: number;
      limit?: number;
      status?: string;
      sortBy?: string;
      sourceType?: string;
      minHeatScore?: number;
      minCredibilityScore?: number;
      entity?: string | null;
    }) => {
      const next = new URLSearchParams(searchParams.toString());
      const nextWindow = updates.windowDays ?? windowDays;
      const nextLimit = updates.limit ?? limit;
      const nextStatus = updates.status ?? status;
      const nextSortBy = updates.sortBy ?? sortBy;
      const nextSourceType = updates.sourceType ?? sourceType;
      const nextMinHeat = updates.minHeatScore ?? minHeatScore;
      const nextMinCredibility = updates.minCredibilityScore ?? minCredibilityScore;
      const nextEntity = updates.entity === undefined ? entityFilter : normalizeEntityFilter(updates.entity);

      if (nextWindow === DEFAULT_WINDOW_DAYS) {
        next.delete("window");
      } else {
        next.set("window", String(nextWindow));
      }

      if (nextLimit === DEFAULT_LIMIT) {
        next.delete("limit");
      } else {
        next.set("limit", String(nextLimit));
      }

      if (nextStatus === DEFAULT_STATUS) {
        next.delete("status");
      } else {
        next.set("status", nextStatus);
      }
      if (nextSortBy === DEFAULT_SORT_BY) {
        next.delete("sort");
      } else {
        next.set("sort", nextSortBy);
      }
      if (nextSourceType === DEFAULT_SOURCE_TYPE) {
        next.delete("sourceType");
      } else {
        next.set("sourceType", nextSourceType);
      }
      if (nextMinHeat <= DEFAULT_MIN_HEAT) {
        next.delete("minHeat");
      } else {
        next.set("minHeat", String(nextMinHeat));
      }
      if (nextMinCredibility <= DEFAULT_MIN_CREDIBILITY) {
        next.delete("minCredibility");
      } else {
        next.set("minCredibility", String(nextMinCredibility));
      }
      if (!nextEntity) {
        next.delete("entity");
      } else {
        next.set("entity", nextEntity);
      }

      const nextQuery = next.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [
      limit,
      minCredibilityScore,
      minHeatScore,
      entityFilter,
      pathname,
      router,
      searchParams,
      sortBy,
      sourceType,
      status,
      windowDays
    ]
  );

  const { data, loading, error, refetch } = useQuery<{ newsEvents: NewsEventListItem[] }>(NEWS_EVENTS_QUERY, {    variables: {
      limit,
      windowDays,
      status: status === "all" ? undefined : status,
      entity: entityFilter ?? undefined,
      sourceType: sourceType === "all" ? undefined : sourceType,
      minHeatScore: minHeatScore > 0 ? minHeatScore : undefined,
      minCredibilityScore: minCredibilityScore > 0 ? minCredibilityScore : undefined,
      sortBy: sortBy === DEFAULT_SORT_BY ? undefined : sortBy
    },
    // cache-and-network keeps the last resolved data visible during refetch:
    // with network-only, `data` becomes undefined between refetch and
    // response, and falling back to the SSR initialData would flash content
    // from the INITIAL filter (or an empty list) after filters change.
    fetchPolicy: "cache-and-network"
  });

  const resolvedData = data ?? initialData ?? undefined;
  useEffect(() => {
    if (!error) {
      return;
    }
    captureClientError("Failed to load events list", error);
  }, [error]);

  const sortedEvents = resolvedData?.newsEvents ?? [];

  const windowOptions = useMemo(
    () =>
      [3, 7, 14, 30, 90].map((days) => ({
        value: days,
        label: t("pages.events.filters.windowOption", { days })
      })),
    [t]
  );
  const limitOptions = useMemo(
    () =>
      [10, 20, 30, 50, 100].map((value) => ({
        value,
        label: t("pages.events.filters.limitOption", { value })
      })),
    [t]
  );
  const statusOptions = useMemo(
    () => [
      { value: "active", label: t("pages.events.filters.status.active") },
      { value: "archived", label: t("pages.events.filters.status.archived") },
      { value: "all", label: t("pages.events.filters.status.all") }
    ],
    [t]
  );
  const sortOptions = useMemo(
    () => [
      { value: "latest", label: t("pages.events.filters.sort.latest") },
      { value: "heat", label: t("pages.events.filters.sort.heat") },
      {
        value: "credibility",
        label: t("pages.events.filters.sort.credibility")
      }
    ],
    [t]
  );
  const sourceTypeOptions = useMemo(
    () => [
      { value: "all", label: t("pages.events.filters.sourceType.all") },
      {
        value: "authoritative",
        label: t("pages.events.filters.sourceType.authoritative")
      },
      { value: "mixed", label: t("pages.events.filters.sourceType.mixed") },
      { value: "blog", label: t("pages.events.filters.sourceType.blog") },
      { value: "unknown", label: t("pages.events.filters.sourceType.unknown") }
    ],
    [t]
  );
  const minHeatOptions = useMemo(
    () =>
      [0, 2, 4, 6, 8].map((value) => ({
        value,
        label:
          value === 0
            ? t("pages.events.filters.noMin")
            : `>= ${value}`
      })),
    [t]
  );
  const minCredibilityOptions = useMemo(
    () =>
      [0, 40, 60, 80].map((value) => ({
        value,
        label:
          value === 0
            ? t("pages.events.filters.noMin")
            : `>= ${value}`
      })),
    [t]
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t("nav.groups.situation")}
        title={t("pages.events.title")}
        description={t("pages.events.subtitle")}
        meta={
          <Tooltip title={`${timeZone} (${timeZoneLabel || timeZone})`}>
            <Tag className="m-0">{timeZoneLabel || timeZone}</Tag>
          </Tooltip>
        }
        actions={
          <>
            <Button onClick={() => router.push("/news-hub")}>{t("pages.events.quickNav.hub")}</Button>
            <Button onClick={() => router.push("/newsnow/hottest")}>{t("pages.events.quickNav.newsnow")}</Button>
            <Button onClick={() => router.push("/items")}>{t("pages.events.quickNav.items")}</Button>
          </>
        }
      />

      <AnalysisToolbar
        surface="events"
        exportTarget="events"
        queryString={searchParams.toString()}
        savedViewId={savedViewId}
      />

      {savedViewId ? (
        <AnnotationPanel subjectType="saved_view" subjectId={savedViewId} />
      ) : null}

      <Card className="content-card">
        <div className="flex flex-col gap-3">
          <FilterBar
            actions={
              <Button onClick={() => refetch()} loading={loading}>
                {t("common.refresh")}
              </Button>
            }
          >
            <FilterBar.Item
              width="sm"
              label={
                <Tooltip title={t("pages.events.filters.windowHelp")}>
                  <span>{t("pages.events.filters.window")}</span>
                </Tooltip>
              }
            >
              <Select
                size="small"
                value={windowDays}
                options={windowOptions}
                onChange={(value) => updateFilters({ windowDays: value })}
                className="w-full"
              />
            </FilterBar.Item>

            <FilterBar.Item width="sm" label={t("pages.events.filters.status.label")}>
              <Select
                size="small"
                value={status}
                options={statusOptions}
                onChange={(value) => updateFilters({ status: value })}
                className="w-full"
              />
            </FilterBar.Item>

            <FilterBar.Item width="sm" label={t("pages.events.filters.limit")}>
              <Select
                size="small"
                value={limit}
                options={limitOptions}
                onChange={(value) => updateFilters({ limit: value })}
                className="w-full"
              />
            </FilterBar.Item>

            <FilterBar.Item width="sm" label={t("pages.events.filters.sort.label")}>
              <Select
                size="small"
                value={sortBy}
                options={sortOptions}
                onChange={(value) => updateFilters({ sortBy: value })}
                className="w-full"
              />
            </FilterBar.Item>

            <FilterBar.Item width="md" label={t("pages.events.filters.sourceType.label")}>
              <Select
                size="small"
                value={sourceType}
                options={sourceTypeOptions}
                onChange={(value) => updateFilters({ sourceType: value })}
                className="w-full"
              />
            </FilterBar.Item>

            <FilterBar.Item width="sm" label={t("pages.events.filters.minHeat")}>
              <Select
                size="small"
                value={minHeatScore}
                options={minHeatOptions}
                onChange={(value) => updateFilters({ minHeatScore: Number(value) })}
                className="w-full"
              />
            </FilterBar.Item>

            <FilterBar.Item width="md" label={t("pages.events.filters.minCredibility")}>
              <Select
                size="small"
                value={minCredibilityScore}
                options={minCredibilityOptions}
                onChange={(value) => updateFilters({ minCredibilityScore: Number(value) })}
                className="w-full"
              />
            </FilterBar.Item>
            {entityFilter ? (
              <Tag
                closable
                onClose={(event) => {
                  event.preventDefault();
                  updateFilters({ entity: null });
                }}
              >
                {t("pages.events.filters.entityActive", {
                  entity: entityFilter
                })}
              </Tag>
            ) : null}
          </FilterBar>

          {error && resolvedData ? (
            <RequestErrorBanner
              error={error}
              onRetry={() => void refetch()}
              showCachedDataHint
            />
          ) : null}

          {error && !resolvedData ? (
            <RequestErrorBanner
              error={error}
              onRetry={() => void refetch()}
              actionLoading={loading}
            />
          ) : loading && !resolvedData ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : sortedEvents.length === 0 ? (
            <ChartEmptyState
              presentation="banner"
              description={t("pages.events.empty")}
              action={
                <Button
                  type="primary"
                  onClick={() =>
                    router.push(
                      buildAdminSettingsHref({
                        page: "news",
                        panel: "news-events",
                      }),
                    )
                  }
                >
                  {t("pages.events.emptyCta")}
                </Button>
              }
            />
          ) : (
            <List
              split={false}
              dataSource={sortedEvents}
              renderItem={(event) => {
                const title = resolveEventTitle(event);
                const topic = event.primaryTopic?.trim() ?? "";
                const entity = event.primaryEntity?.trim() ?? "";
                const language = event.language?.trim() ?? "";
                const startLabel = t("pages.events.fields.startAt");
                const lastLabel = t("pages.events.fields.lastAt");
                const itemCountLabel = t("pages.events.fields.items");
                const eventStatusLabel = t(`pages.events.status.${event.status}`, { defaultValue: event.status });
                const heatLabel = t("pages.events.fields.heat");
                const credibilityLabel = t("pages.events.fields.credibility");
                const sourcesLabel = t("pages.events.fields.sources");
                const sourceTypeLabel = t("pages.events.fields.sourceType");
                const futureEventLabel = t("pages.events.fields.futureEvent");
                const futureEventHint = t("pages.events.fields.futureEventHint");

                const startDate = formatDateTime(event.startAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  timeZone
                });
                const startTooltip = formatDateTime(event.startAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone,
                  timeZoneName: "short"
                });
                const startRelative = formatRelativeTime(event.startAt, locale, { timeZone });

                const lastDate = formatDateTime(event.lastAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  timeZone
                });
                const lastTooltip = formatDateTime(event.lastAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone,
                  timeZoneName: "short"
                });
                const lastRelative = formatRelativeTime(event.lastAt, locale, { timeZone });
                const isFutureEvent = isFutureEventTimestamp(event.lastAt);
                const heatPercent = toHeatPercent(event.heatScore);
                const credibilityPercent = toCredibilityPercent(event.credibilityScore);
                const rowStyle: CSSProperties = {
                  ...resolveEventRowSurface({ heatPercent, isDark, isFutureEvent }),
                  alignItems: "flex-start"
                };

                return (
                  <List.Item
                    key={event.id}
                    style={rowStyle}
                    className="flex-col items-start gap-2 sm:flex-row sm:items-center"
                    actions={[
                      <Button key="open" type="link" onClick={() => router.push(`/events/${event.id}`)}>
                        {t("pages.events.actions.open")}
                      </Button>,
                      <Button key="brief" type="link" onClick={() => router.push(`/events/${event.id}?tab=brief`)}>
                        {t("pages.events.actions.brief")}
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <div className="flex min-w-0 flex-col gap-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Typography.Text strong className="line-clamp-2 text-base font-semibold">
                              {title}
                            </Typography.Text>
                            <Tag color={event.status === "active" ? "processing" : "default"}>{eventStatusLabel}</Tag>
                            {event.breaking ? (
                              <Tag color="error">
                                {t("pages.events.fields.breaking")}
                              </Tag>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <EventSignalCard
                              tone="heat"
                              label={heatLabel}
                              value={event.heatScore.toFixed(1)}
                              percent={heatPercent}
                              minWidth={136}
                              progressSize={[120, 5]}
                            />
                            <EventSignalCard
                              tone="credibility"
                              label={credibilityLabel}
                              value={Math.round(event.credibilityScore)}
                              percent={credibilityPercent}
                              minWidth={136}
                              progressSize={[120, 5]}
                            />
                          </div>
                          <div className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
                            <span>{itemCountLabel}: {event.itemCount}</span>
                            {isFutureEvent ? <span>{futureEventLabel}</span> : null}
                            <span>{sourcesLabel}: {event.sourceEvidence.uniqueSourceCount}</span>
                            <span>{sourceTypeLabel}: {event.sourceType}</span>
                            {event.sourceEvidence.corroborated ? (
                              <span>{t("pages.events.fields.corroborated")}</span>
                            ) : null}
                            {language ? <span>{language}</span> : null}
                            {topic ? <span>{topic}</span> : null}
                            {entity ? (
                              <button
                                type="button"
                                className="font-mono text-xs text-muted-foreground underline-offset-4 hover:text-[var(--foreground)] hover:underline"
                                onClick={() => updateFilters({ entity: entityFilter === entity ? null : entity })}
                              >
                                {entity}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      }
                      description={
                        <div className="flex flex-col gap-2">
                          {event.summary ? (
                            <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} className="!mb-0">
                              {event.summary}
                            </Typography.Paragraph>
                          ) : null}
                          <Space size={[12, 0]} wrap>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {startLabel}:{" "}
                              <Tooltip title={`${startTooltip}${startRelative ? ` (${startRelative})` : ""}`}>
                                <span>{startDate}</span>
                              </Tooltip>
                            </Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {lastLabel}:{" "}
                              <Tooltip title={`${lastTooltip}${lastRelative ? ` (${lastRelative})` : ""}`}>
                                <span>{lastDate}</span>
                              </Tooltip>
                              {lastRelative ? <span className="ml-1 opacity-80">({lastRelative})</span> : null}
                              {isFutureEvent ? <span className="ml-1" style={futureEventHintStyle}>[{futureEventHint}]</span> : null}
                            </Typography.Text>
                          </Space>
                        </div>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          )}
        </div>
      </Card>

    </div>
  );
}
