"use client";

import { BellOutlined } from "@ant-design/icons";
import {
  App,
  Badge,
  Button,
  List,
  Popover,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  NotificationType,
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
  useUnreadNotificationCountQuery,
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  dedupeNotifications,
  getNotificationDedupeKey,
  upsertNotification,
} from "@/lib/notification-dedupe";
import {
  formatNotificationPresentation,
  formatNotificationStreamError,
  resolveNotificationLink,
} from "@/lib/notifications";
import {
  useBufferedBatch,
  useScheduledAction,
  useTimedValueDeduper,
} from "@/lib/use-realtime-helpers";

import {
  useNotificationStream,
  type NotificationMessage,
} from "./use-notification-stream";

type NotificationItem = NotificationMessage;

const typeColor: Record<NotificationType, string> = {
  [NotificationType.CrawlCompleted]: "green",
  [NotificationType.CrawlFailed]: "red",
  [NotificationType.AnalysisCompleted]: "blue",
  [NotificationType.AnalysisFailed]: "red",
  [NotificationType.OrgInvite]: "purple",
  [NotificationType.AlertTriggered]: "orange",
  [NotificationType.System]: "geekblue",
};

const MAX_ITEMS = 30;
const LIVE_NOTIFICATION_TOAST_KEY = "notification-center-live";
const LIVE_NOTIFICATION_TOAST_FLUSH_MS = 800;
const LIVE_NOTIFICATION_UNREAD_SYNC_MS = 1200;

/** 触发按钮触控尺寸：default=32px（full/compact 紧凑档）；large=44px（minimal 触控优先档） */
export type NotificationCenterTriggerSize = "default" | "large";

export interface NotificationCenterProps {
  size?: NotificationCenterTriggerSize;
}

export function NotificationCenter({
  size = "default",
}: NotificationCenterProps = {}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadAlerts = permissions.includes("alerts.read");
  const { data, loading, refetch } = useNotificationsQuery({
    variables: { limit: MAX_ITEMS },
  });
  const { data: unreadData, refetch: refetchUnread } =
    useUnreadNotificationCountQuery();
  const [markRead] = useMarkNotificationReadMutation();
  const [markAll] = useMarkAllNotificationsReadMutation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState<number>(0);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const shouldShowConnectionError = useTimedValueDeduper(30_000);

  const { add: enqueueNotificationToast } = useBufferedBatch<string>({
    delayMs: LIVE_NOTIFICATION_TOAST_FLUSH_MS,
    onFlush: (titles) => {
      const uniqueTitles = Array.from(
        new Set(titles.filter((title) => title.trim().length > 0)),
      );
      if (uniqueTitles.length === 0) {
        return;
      }
      const content =
        uniqueTitles.length === 1
          ? uniqueTitles[0]
          : t("notifications.live.batchMessage", {
              count: uniqueTitles.length,
              titles:
                uniqueTitles.slice(0, 3).join(" · ") ||
                t("notifications.title"),
            });
      message.open({
        type: "info",
        key: LIVE_NOTIFICATION_TOAST_KEY,
        content,
      });
    },
  });

  const { schedule: scheduleUnreadCountSync } = useScheduledAction(() => {
    void refetchUnread();
  }, LIVE_NOTIFICATION_UNREAD_SYNC_MS);

  useEffect(() => {
    if (data?.notifications) {
      const nextItems = dedupeNotifications([...data.notifications]);
      const nextSeen = new Set<string>();
      for (const item of nextItems) {
        nextSeen.add(item.id);
        nextSeen.add(getNotificationDedupeKey(item));
      }
      seenKeysRef.current = nextSeen;
      setItems(nextItems);
    }
  }, [data?.notifications]);

  useEffect(() => {
    setUnread(unreadData?.unreadNotificationCount ?? 0);
  }, [unreadData?.unreadNotificationCount]);

  useEffect(() => {
    const nextSeen = new Set<string>();
    for (const item of items) {
      nextSeen.add(item.id);
      nextSeen.add(getNotificationDedupeKey(item));
    }
    seenKeysRef.current = nextSeen;
  }, [items]);

  const handleIncoming = useCallback(
    (incoming: NotificationMessage) => {
      const incomingKey = getNotificationDedupeKey(incoming);
      const alreadySeen =
        seenKeysRef.current.has(incoming.id) ||
        seenKeysRef.current.has(incomingKey);
      const presentation = formatNotificationPresentation(incoming, locale, t);

      if (!alreadySeen) {
        seenKeysRef.current.add(incoming.id);
        seenKeysRef.current.add(incomingKey);
      }

      setItems((prev) => {
        if (!alreadySeen && !incoming.readAt) {
          setUnread((prevCount) => prevCount + 1);
        }
        return dedupeNotifications(upsertNotification(prev, incoming)).slice(
          0,
          MAX_ITEMS,
        );
      });
      if (!alreadySeen) {
        enqueueNotificationToast(presentation.toastText);
      }
      scheduleUnreadCountSync();
    },
    [enqueueNotificationToast, locale, scheduleUnreadCountSync, t],
  );

  const { connectionError } = useNotificationStream(handleIncoming);

  useEffect(() => {
    if (!connectionError) {
      return;
    }
    const localizedError = formatNotificationStreamError(
      connectionError,
      t,
      connectionError.kind,
    );
    if (!shouldShowConnectionError(localizedError)) {
      return;
    }
    message.warning(localizedError);
  }, [connectionError, message, shouldShowConnectionError, t]);

  const markOneAsRead = useCallback(
    async (id: string) => {
      const target = items.find((item) => item.id === id);
      if (!target || target.readAt) {
        return;
      }
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, readAt: new Date().toISOString() } : item,
        ),
      );
      setUnread((prev) => Math.max(0, prev - 1));
      await markRead({ variables: { id } });
      void refetchUnread();
    },
    [items, markRead, refetchUnread],
  );

  const markAllAsRead = useCallback(async () => {
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        readAt: item.readAt ?? new Date().toISOString(),
      })),
    );
    setUnread(0);
    await markAll();
    void refetchUnread();
  }, [markAll, refetchUnread]);

  const content = useMemo(() => {
    return (
      <div style={{ width: 380 }}>
        <Space
          align="center"
          style={{
            width: "100%",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <Space size="small" align="center">
            <Typography.Text strong>{t("notifications.title")}</Typography.Text>
            <Typography.Text type="secondary">
              {t("notifications.unreadCount", { count: unread })}
            </Typography.Text>
          </Space>
          <Space size="small">
            <Button size="small" type="text" onClick={() => void refetch()}>
              {t("common.refresh")}
            </Button>
            <Button
              size="small"
              type="text"
              onClick={() => void markAllAsRead()}
            >
              {t("notifications.markAllRead")}
            </Button>
          </Space>
        </Space>
        <div
          style={{
            maxHeight: "min(60vh, 480px)",
            overflowY: "auto",
            overscrollBehavior: "contain",
            WebkitOverflowScrolling: "touch",
          }}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {loading ? (
            <div
              style={{ display: "flex", justifyContent: "center", padding: 16 }}
            >
              <Spin />
            </div>
          ) : (
            <List
              dataSource={items}
              locale={{ emptyText: t("notifications.empty") }}
              renderItem={(item) => {
                const isUnread = !item.readAt;
                const action = resolveNotificationLink(item.data ?? null, t, {
                  canReadAlerts,
                });
                const presentation = formatNotificationPresentation(
                  item,
                  locale,
                  t,
                );
                return (
                  <List.Item
                    key={item.id}
                    style={{
                      cursor: "pointer",
                      background: isUnread
                        ? "rgba(24,144,255,0.06)"
                        : undefined,
                      borderRadius: 4,
                      paddingLeft: 12,
                      paddingRight: 12,
                    }}
                    onClick={() => void markOneAsRead(item.id)}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small" align="center">
                          <Tag color={typeColor[item.type] ?? "default"}>
                            {t(`notifications.type.${item.type}`)}
                          </Tag>
                          <Typography.Text strong>
                            {presentation.title}
                          </Typography.Text>
                        </Space>
                      }
                      description={
                        <div>
                          {presentation.body ? (
                            <Typography.Paragraph
                              style={{ marginBottom: 6 }}
                              ellipsis={{ rows: 2, expandable: false }}
                            >
                              {presentation.body}
                            </Typography.Paragraph>
                          ) : null}
                          <Space size="small" align="center">
                            <Typography.Text type="secondary">
                              {formatDateTime(item.createdAt, locale, {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                                hour12: false,
                              })}
                            </Typography.Text>
                            {action ? (
                              <Button
                                type="link"
                                size="small"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void markOneAsRead(item.id);
                                  router.push(action.href);
                                  setOpen(false);
                                }}
                                className="px-0"
                              >
                                {action.label}
                              </Button>
                            ) : null}
                          </Space>
                        </div>
                      }
                    />
                    {isUnread ? <Badge status="processing" /> : null}
                  </List.Item>
                );
              }}
            />
          )}
        </div>
      </div>
    );
  }, [
    items,
    loading,
    locale,
    markAllAsRead,
    markOneAsRead,
    refetch,
    router,
    t,
    canReadAlerts,
    unread,
  ]);

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
    >
      <span className="inline-flex shrink-0">
        <Badge count={unread} size="small" showZero={false} offset={[-2, 2]}>
          <Button
            type="text"
            icon={<BellOutlined />}
            aria-label={t("notifications.title")}
            className={
              size === "large"
                ? "inline-flex !h-11 !w-11 items-center justify-center p-0"
                : "inline-flex h-8 w-8 items-center justify-center p-0"
            }
          />
        </Badge>
      </span>
    </Popover>
  );
}
