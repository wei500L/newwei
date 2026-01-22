"use client";

import { gql, useQuery } from "@apollo/client";
import { Button, Card, Drawer, Empty, Grid, List, Select, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import { formatDateTime, formatRelativeTime, formatTimeZoneOffsetLabel, getDefaultTimeZone, resolveLocale } from "@/lib/i18n";

import { EventDetailsDrawer } from "./event-details-drawer";

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
  representativeProcessedArticleId?: string | null;
  representativeProcessedItemId?: string | null;
  createdAt: string;
  updatedAt: string;
}

const NEWS_EVENTS_QUERY = gql`
  query NewsEvents($limit: Int, $windowDays: Int, $status: NewsEventStatus) {
    newsEvents(limit: $limit, windowDays: $windowDays, status: $status) {
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
  const locale = resolveLocale(i18n.language);
  const timeZone = getDefaultTimeZone();
  const timeZoneLabel = useMemo(() => formatTimeZoneOffsetLabel(new Date(), timeZone), [timeZone]);
  const screens = Grid.useBreakpoint();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

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

  const updateFilters = useCallback(
    (updates: { windowDays?: number; limit?: number; status?: string }) => {
      const next = new URLSearchParams(searchParams.toString());
      const nextWindow = updates.windowDays ?? windowDays;
      const nextLimit = updates.limit ?? limit;
      const nextStatus = updates.status ?? status;

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

      const nextQuery = next.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [limit, pathname, router, searchParams, status, windowDays]
  );

  const { data, loading, error, refetch } = useQuery<{ newsEvents: NewsEventListItem[] }>(NEWS_EVENTS_QUERY, {
    variables: {
      limit,
      windowDays,
      status: status === "all" ? undefined : status
    },
    fetchPolicy: "network-only"
  });

  const resolvedData = data ?? initialData ?? undefined;
  const sortedEvents = useMemo(() => {
    const events = resolvedData?.newsEvents ?? [];
    return [...events].sort((a, b) => {
      const timeDiff = dayjs(b.lastAt).valueOf() - dayjs(a.lastAt).valueOf();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return b.itemCount - a.itemCount;
    });
  }, [resolvedData?.newsEvents]);

  const drawerWidth = screens.lg ? 860 : undefined;

  const windowOptions = useMemo(
    () =>
      [3, 7, 14, 30, 90].map((days) => ({
        value: days,
        label: t("pages.events.filters.windowOption", { defaultValue: "{{days}} days", days })
      })),
    [t]
  );
  const limitOptions = useMemo(
    () =>
      [10, 20, 30, 50, 100].map((value) => ({
        value,
        label: t("pages.events.filters.limitOption", { defaultValue: "{{value}} events", value })
      })),
    [t]
  );
  const statusOptions = useMemo(
    () => [
      { value: "active", label: t("pages.events.filters.status.active", { defaultValue: "Active" }) },
      { value: "archived", label: t("pages.events.filters.status.archived", { defaultValue: "Archived" }) },
      { value: "all", label: t("pages.events.filters.status.all", { defaultValue: "All" }) }
    ],
    [t]
  );

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Space align="center" wrap size={[8, 6]}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t("pages.events.title", { defaultValue: "News Events" })}
          </Typography.Title>
          <Tooltip title={`${timeZone} (${timeZoneLabel || timeZone})`}>
            <Tag>{timeZoneLabel || timeZone}</Tag>
          </Tooltip>
        </Space>
        <Typography.Text type="secondary">
          {t("pages.events.subtitle", {
            defaultValue: "Clustered storylines built from processed news articles."
          })}
        </Typography.Text>
      </Space>

      <Card className="content-card">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
            <Space wrap size="small">
              <Tooltip title={t("pages.events.filters.windowHelp", { defaultValue: "Time window for listing events." })}>
                <Space size={6}>
                  <Typography.Text type="secondary">
                    {t("pages.events.filters.window", { defaultValue: "Window" })}
                  </Typography.Text>
                  <Select
                    size="small"
                    value={windowDays}
                    options={windowOptions}
                    onChange={(value) => updateFilters({ windowDays: value })}
                    style={{ minWidth: 140 }}
                  />
                </Space>
              </Tooltip>

              <Space size={6}>
                <Typography.Text type="secondary">{t("pages.events.filters.status.label", { defaultValue: "Status" })}</Typography.Text>
                <Select
                  size="small"
                  value={status}
                  options={statusOptions}
                  onChange={(value) => updateFilters({ status: value })}
                  style={{ minWidth: 140 }}
                />
              </Space>

              <Space size={6}>
                <Typography.Text type="secondary">{t("pages.events.filters.limit", { defaultValue: "Limit" })}</Typography.Text>
                <Select
                  size="small"
                  value={limit}
                  options={limitOptions}
                  onChange={(value) => updateFilters({ limit: value })}
                  style={{ minWidth: 140 }}
                />
              </Space>
            </Space>

            <Button onClick={() => refetch()} loading={loading}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
          </div>

          {error ? (
            <Typography.Text type="danger">
              {t("pages.events.loadFailed", { defaultValue: "Failed to load events." })}: {error.message}
            </Typography.Text>
          ) : null}

          {loading && !resolvedData ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : sortedEvents.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("pages.events.empty", {
                defaultValue: "No events yet. Enable ingestion in System Settings and wait for the scheduled job."
              })}
            >
              <Button type="primary" onClick={() => router.push("/admin/system?tab=newsEvents")}>
                {t("pages.events.emptyCta", { defaultValue: "Open system settings" })}
              </Button>
            </Empty>
          ) : (
            <List
              dataSource={sortedEvents}
              renderItem={(event) => {
                const title = resolveEventTitle(event);
                const topic = event.primaryTopic?.trim() ?? "";
                const entity = event.primaryEntity?.trim() ?? "";
                const language = event.language?.trim() ?? "";
                const startLabel = t("pages.events.fields.startAt", { defaultValue: "Start" });
                const lastLabel = t("pages.events.fields.lastAt", { defaultValue: "Last" });
                const itemCountLabel = t("pages.events.fields.items", { defaultValue: "Items" });
                const eventStatusLabel = t(`pages.events.status.${event.status}`, { defaultValue: event.status });

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

                return (
                  <List.Item
                    key={event.id}
                    actions={[
                      <Button key="open" type="link" onClick={() => setSelectedEventId(event.id)}>
                        {t("pages.events.actions.details", { defaultValue: "Details" })}
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space wrap size={[6, 6]}>
                          <Typography.Text strong>{title}</Typography.Text>
                          <Tag>{itemCountLabel}: {event.itemCount}</Tag>
                          <Tag color={event.status === "active" ? "green" : "default"}>{eventStatusLabel}</Tag>
                          {language ? <Tag color="blue">{language}</Tag> : null}
                          {topic ? <Tag color="geekblue">{topic}</Tag> : null}
                          {entity ? <Tag color="purple">{entity}</Tag> : null}
                        </Space>
                      }
                      description={
                        <div className="flex flex-col gap-1">
                          {event.summary ? (
                            <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>
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

      <Drawer
        open={selectedEventId !== null}
        width={drawerWidth}
        destroyOnClose
        onClose={() => setSelectedEventId(null)}
        title={t("pages.events.drawer.title", { defaultValue: "Event details" })}
      >
        {selectedEventId ? <EventDetailsDrawer eventId={selectedEventId} /> : null}
      </Drawer>
    </div>
  );
}
