"use client";

import { BellOutlined } from "@ant-design/icons";
import { Badge, Button, List, Popover, Space, Spin, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  NotificationType,
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
  useUnreadNotificationCountQuery
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import { useNotificationStream, type NotificationMessage } from "./use-notification-stream";

type NotificationItem = NotificationMessage;

const typeColor: Record<NotificationType, string> = {
  [NotificationType.CrawlCompleted]: "green",
  [NotificationType.CrawlFailed]: "red",
  [NotificationType.AnalysisCompleted]: "blue",
  [NotificationType.AnalysisFailed]: "red",
  [NotificationType.OrgInvite]: "purple",
  [NotificationType.AlertTriggered]: "orange",
  [NotificationType.System]: "geekblue"
};

const MAX_ITEMS = 30;

export function NotificationCenter() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data, loading, refetch } = useNotificationsQuery({
    variables: { limit: MAX_ITEMS }
  });
  const { data: unreadData, refetch: refetchUnread } = useUnreadNotificationCountQuery();
  const [markRead] = useMarkNotificationReadMutation();
  const [markAll] = useMarkAllNotificationsReadMutation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState<number>(0);

  useEffect(() => {
    if (data?.notifications) {
      setItems(dedupe([...data.notifications]));
    }
  }, [data?.notifications]);

  useEffect(() => {
    setUnread(unreadData?.unreadNotificationCount ?? 0);
  }, [unreadData?.unreadNotificationCount]);

  const handleIncoming = useCallback(
    (incoming: NotificationMessage) => {
      setItems((prev) => {
        const existing = prev.find((item) => item.id === incoming.id);
        if (!existing || existing.readAt) {
          setUnread((prevCount) => prevCount + 1);
        }
        return dedupe([incoming, ...prev]).slice(0, MAX_ITEMS);
      });
      message.info(incoming.title);
      void refetchUnread();
    },
    [refetchUnread]
  );

  const { connectionError } = useNotificationStream(handleIncoming);

  useEffect(() => {
    if (connectionError) {
      message.warning(connectionError);
    }
  }, [connectionError]);

  const markOneAsRead = useCallback(
    async (id: string) => {
      const target = items.find((item) => item.id === id);
      if (!target || target.readAt) {
        return;
      }
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)));
      setUnread((prev) => Math.max(0, prev - 1));
      await markRead({ variables: { id } });
      void refetchUnread();
    },
    [items, markRead, refetchUnread]
  );

  const markAllAsRead = useCallback(async () => {
    setItems((prev) => prev.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnread(0);
    await markAll();
    void refetchUnread();
  }, [markAll, refetchUnread]);

  const content = useMemo(() => {
    return (
      <div style={{ width: 380 }}>
        <Space
          align="center"
          style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}
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
            <Button size="small" type="text" onClick={() => void markAllAsRead()}>
              {t("notifications.markAllRead")}
            </Button>
          </Space>
        </Space>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
            <Spin />
          </div>
        ) : (
          <List
            dataSource={items}
            locale={{ emptyText: t("notifications.empty") }}
            renderItem={(item) => {
              const isUnread = !item.readAt;
              return (
                <List.Item
                  key={item.id}
                  style={{
                    cursor: "pointer",
                    background: isUnread ? "rgba(24,144,255,0.06)" : undefined,
                    borderRadius: 4,
                    paddingLeft: 12,
                    paddingRight: 12
                  }}
                  onClick={() => void markOneAsRead(item.id)}
                >
                  <List.Item.Meta
                    title={
                      <Space size="small" align="center">
                        <Tag color={typeColor[item.type] ?? "default"}>
                          {t(`notifications.type.${item.type}`)}
                        </Tag>
                        <Typography.Text strong>{item.title}</Typography.Text>
                      </Space>
                    }
                    description={
                      <div>
                        {item.body ? (
                          <Typography.Paragraph
                            style={{ marginBottom: 6 }}
                            ellipsis={{ rows: 2, expandable: false }}
                          >
                            {item.body}
                          </Typography.Paragraph>
                        ) : null}
                        <Typography.Text type="secondary">
                          {formatDateTime(item.createdAt, locale, {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            hour12: false
                          })}
                        </Typography.Text>
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
    );
  }, [items, loading, markAllAsRead, markOneAsRead, refetch]);

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
    >
      <Badge count={unread} size="small" showZero={false}>
        <Button type="text" icon={<BellOutlined />} />
      </Badge>
    </Popover>
  );
}

function dedupe(list: NotificationItem[]) {
  const seen = new Set<string>();
  const result: NotificationItem[] = [];
  for (const item of list) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
