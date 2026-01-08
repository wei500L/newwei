'use client';

import { Badge, Button, Card, Col, List, Row, Skeleton, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from 'react-i18next';

import {
  NotificationType,
  useAlertEventsQuery,
  useAlertRulesQuery,
  useAlertChannelsQuery,
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
  useUnreadNotificationCountQuery
} from '@/graphql/generated';
import { formatDateTime, resolveLocale } from '@/lib/i18n';
import { resolveNotificationLink } from '@/lib/notifications';

const typeColor: Record<NotificationType, string> = {
  [NotificationType.CrawlCompleted]: 'green',
  [NotificationType.CrawlFailed]: 'red',
  [NotificationType.AnalysisCompleted]: 'blue',
  [NotificationType.AnalysisFailed]: 'red',
  [NotificationType.OrgInvite]: 'purple',
  [NotificationType.AlertTriggered]: 'orange',
  [NotificationType.System]: 'geekblue'
};

const buildThresholdSummary = (
  operator: string | null | undefined,
  thresholdValue: number | undefined,
  lower: number | undefined,
  upper: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
) => {
  if (!operator) {
    return t("common.notAvailable");
  }
  const operatorSymbolMap: Record<string, string> = {
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    eq: "="
  };
  if (operator === "outside_range" || operator === "within_range") {
    if (lower === undefined || upper === undefined) {
      return t("common.notAvailable");
    }
    const range = `${lower} - ${upper}`;
    return t(
      operator === "outside_range"
        ? "alerts.center.threshold.outside"
        : "alerts.center.threshold.within",
      { defaultValue: `${operator === "outside_range" ? "Outside" : "Within"} ${range}`, range }
    );
  }
  if (operator === "change_up_pct" || operator === "change_down_pct") {
    if (thresholdValue === undefined) {
      return t("common.notAvailable");
    }
    const symbol = operator === "change_up_pct" ? ">=" : "<=";
    return t("alerts.center.threshold.changePct", {
      defaultValue: `Change ${symbol} ${thresholdValue}%`,
      symbol,
      value: thresholdValue
    });
  }
  if (thresholdValue === undefined) {
    return t("common.notAvailable");
  }
  const symbol = operatorSymbolMap[operator] ?? operator;
  return `${symbol} ${thresholdValue}`;
};

const formatContextValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatContextValue(item)).filter(Boolean).join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return undefined;
};

const extractAlertEventId = (payload: Record<string, unknown> | null | undefined): string | undefined => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const rawId = payload.alertEventId ?? payload.eventId;
  return typeof rawId === "string" && rawId.trim().length > 0 ? rawId : undefined;
};

const extractRuleId = (payload: Record<string, unknown> | null | undefined): string | undefined => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const rawId = payload.ruleId;
  return typeof rawId === "string" && rawId.trim().length > 0 ? rawId : undefined;
};

export default function SubscriptionsPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: rulesData, loading: rulesLoading, refetch: refetchRules } = useAlertRulesQuery();
  const { data: channelsData, loading: channelsLoading, refetch: refetchChannels } = useAlertChannelsQuery();
  const { data: eventsData, loading: eventsLoading, refetch: refetchEvents } = useAlertEventsQuery({
    variables: { limit: 50 }
  });
  const {
    data: notificationsData,
    loading: notificationsLoading,
    refetch: refetchNotifications
  } = useNotificationsQuery({ variables: { limit: 50 } });
  const { data: unreadData, refetch: refetchUnread } = useUnreadNotificationCountQuery();
  const [markRead] = useMarkNotificationReadMutation();
  const [markAll] = useMarkAllNotificationsReadMutation();

  const unreadCount = unreadData?.unreadNotificationCount ?? 0;
  const rules = rulesData?.alertRules ?? [];
  const channels = channelsData?.alertChannels ?? [];
  const events = eventsData?.alertEvents ?? [];
  const notifications = notificationsData?.notifications ?? [];
  const isRulesInitialLoading = rulesLoading && rules.length === 0;
  const isChannelsInitialLoading = channelsLoading && channels.length === 0;
  const isEventsInitialLoading = eventsLoading && events.length === 0;
  const isNotificationsInitialLoading = notificationsLoading && notifications.length === 0;

  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const alertNotifications = useMemo(
    () => notifications.filter((item) => item.type === NotificationType.AlertTriggered),
    [notifications]
  );
  const notificationsByRuleId = useMemo(() => {
    const grouped = new Map<string, typeof alertNotifications>();
    for (const notification of alertNotifications) {
      const payload = notification.data ?? null;
      const ruleId = extractRuleId(payload) ?? eventById.get(extractAlertEventId(payload) ?? "")?.ruleId;
      if (!ruleId) {
        continue;
      }
      const list = grouped.get(ruleId) ?? [];
      list.push(notification);
      grouped.set(ruleId, list);
    }
    return grouped;
  }, [alertNotifications, eventById]);
  const orderedNotifications = useMemo(() => {
    return [...notifications].sort((a, b) => {
      const aUnread = !a.readAt;
      const bUnread = !b.readAt;
      if (aUnread !== bUnread) {
        return aUnread ? -1 : 1;
      }
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
  }, [notifications]);

  const resolveAlertEvent = (notification: (typeof notifications)[number]) => {
    const payload = notification.data ?? null;
    const eventId = extractAlertEventId(payload);
    return eventId ? eventById.get(eventId) : undefined;
  };

  const renderAlertEvidence = (notification: (typeof notifications)[number]) => {
    const event = resolveAlertEvent(notification);
    const context =
      event?.context && typeof event.context === "object" && !Array.isArray(event.context)
        ? (event.context as Record<string, unknown>)
        : null;
    const source =
      toStringValue(context?.sourceName) ??
      toStringValue(context?.sourceEndpoint) ??
      toStringValue(context?.sourceFunction) ??
      toStringValue(context?.sourceField);
    const country = toStringValue(context?.countryName ?? context?.countryCode ?? context?.country);
    const itemName = toStringValue(context?.itemName);
    const resource = toStringValue(context?.resource);
    const action = toStringValue(context?.action);
    const statusesValue = Array.isArray(context?.statuses)
      ? (context?.statuses as unknown[]).map((entry) => formatContextValue(entry)).filter(Boolean).join(", ")
      : toStringValue(context?.statuses ?? context?.status);
    const evidenceTags = [
      typeof event?.metricValue === "number" ? `value: ${event.metricValue}` : null,
      typeof event?.changePercent === "number" ? `change: ${event.changePercent.toFixed(2)}%` : null,
      source ? `source: ${source}` : null,
      itemName ? `item: ${itemName}` : null,
      country ? `country: ${country}` : null,
      resource ? `resource: ${resource}` : null,
      action ? `action: ${action}` : null,
      statusesValue ? `statuses: ${statusesValue}` : null
    ]
      .filter(Boolean)
      .slice(0, 4) as string[];
    const windowMinutes = event?.changeWindowMin ?? toNumber(context?.windowMinutes);
    const windowLabel =
      windowMinutes !== undefined && windowMinutes !== null
        ? `${windowMinutes} min`
        : t("common.notAvailable");
    const thresholdSummary = event
      ? buildThresholdSummary(
          event.operator,
          event.thresholdValue ?? toNumber(context?.threshold),
          event.thresholdLower ?? toNumber(context?.lower),
          event.thresholdUpper ?? toNumber(context?.upper),
          t
        )
      : t("common.notAvailable");
    const triggerReason = event?.message ?? notification.body ?? t("alerts.events.triggered");

    return (
      <Space direction="vertical" size={2}>
        <Typography.Text type="secondary">
          {t("alerts.events.triggerReason", { defaultValue: "Trigger {{reason}}", reason: triggerReason })}
        </Typography.Text>
        {evidenceTags.length > 0 ? (
          <Space size={[4, 4]} wrap>
            {evidenceTags.map((entry) => (
              <Tag key={`${notification.id}-${entry}`} className="text-xs">
                {entry}
              </Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {t("alerts.events.evidenceEmpty", { defaultValue: "No evidence fields." })}
          </Typography.Text>
        )}
        <Typography.Text type="secondary">
          {t("alerts.events.window", { defaultValue: "Window {{window}}", window: windowLabel })}
          {" · "}
          {t("alerts.rules.threshold", {
            defaultValue: "Threshold {{threshold}}",
            threshold: thresholdSummary
          })}
        </Typography.Text>
      </Space>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("subscriptions.title", { defaultValue: "My Subscriptions" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("subscriptions.subtitle", {
            defaultValue: "Review channels, rules, and notification history in one place."
          })}
        </Typography.Text>
      </Space>

      <Card
        className="content-card"
        title={
          <Space size="middle" align="center">
            <Typography.Text strong>
              {t("subscriptions.rulesTitle", { defaultValue: "Rule Subscriptions" })}
            </Typography.Text>
          </Space>
        }
        extra={
          <Button
            size="small"
            onClick={async () => {
              await Promise.all([refetchRules(), refetchEvents(), refetchNotifications()]);
            }}
          >
            {t("common.refresh")}
          </Button>
        }
      >
        {isRulesInitialLoading || isEventsInitialLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : (
          <List
            dataSource={rules}
            locale={{
              emptyText: t("subscriptions.rulesEmpty", {
                defaultValue: "No alert rules configured."
              })
            }}
            renderItem={(rule) => {
              const ruleNotifications = notificationsByRuleId.get(rule.id) ?? [];
              const latestNotification = ruleNotifications[0];
              const latestNotificationTime = latestNotification
                ? formatDateTime(latestNotification.createdAt, locale, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false
                  })
                : t("common.notAvailable");
              return (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space size="small">
                        <Typography.Text strong>{rule.name}</Typography.Text>
                        <Tag>{rule.severity}</Tag>
                        <Tag>{rule.operator}</Tag>
                      </Space>
                    }
                    description={
                      <Space direction="vertical" size={2}>
                        <Typography.Text type="secondary">
                          {t("alerts.rules.threshold", {
                            defaultValue: "Threshold {{threshold}}",
                            threshold: buildThresholdSummary(
                              rule.operator,
                              rule.thresholdValue ?? undefined,
                              rule.thresholdLower ?? undefined,
                              rule.thresholdUpper ?? undefined,
                              t
                            )
                          })}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {t("alerts.center.detail.window", {
                            defaultValue: "Window {{minutes}} min",
                            minutes: rule.changeWindowMin ?? t("common.notAvailable")
                          })}
                        </Typography.Text>
                        <Space size={[4, 4]} wrap>
                          {(rule.channels ?? []).length > 0 ? (
                            rule.channels.map((channel) => (
                              <Tag key={channel.id}>{channel.name}</Tag>
                            ))
                          ) : (
                            <Typography.Text type="secondary">
                              {t("subscriptions.channelsEmpty", { defaultValue: "No alert channels configured." })}
                            </Typography.Text>
                          )}
                        </Space>
                        <Typography.Text type="secondary">
                          {t("subscriptions.ruleNotifications", {
                            defaultValue: "Notifications {{count}} · Latest {{time}}",
                            count: ruleNotifications.length,
                            time: latestNotificationTime
                          })}
                        </Typography.Text>
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={
              <Space size="middle" align="center">
                <Typography.Text strong>
                  {t("subscriptions.channelsTitle", { defaultValue: "Alert Channels" })}
                </Typography.Text>
              </Space>
            }
            extra={
              <Button size="small" onClick={() => void refetchChannels()}>
                {t('common.refresh')}
              </Button>
            }
          >
            {isChannelsInitialLoading ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : (
              <List
                dataSource={channels}
                locale={{
                  emptyText: t("subscriptions.channelsEmpty", {
                    defaultValue: "No alert channels configured."
                  })
                }}
                renderItem={(channel) => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space size="small">
                          <Typography.Text strong>{channel.name}</Typography.Text>
                          <Tag>{channel.type}</Tag>
                        </Space>
                      }
                      description={<Typography.Text type="secondary">{channel.target}</Typography.Text>}
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={
              <Space size="middle" align="center">
                <Typography.Text strong>
                  {t("subscriptions.notificationsTitle", { defaultValue: "Notifications" })}
                </Typography.Text>
                <Badge count={unreadCount} size="small" />
              </Space>
            }
            extra={
              <Space size="small">
                <Button size="small" onClick={() => void refetchNotifications()}>
                  {t('common.refresh')}
                </Button>
                <Button
                  size="small"
                  onClick={async () => {
                    await markAll();
                    await Promise.all([refetchNotifications(), refetchUnread()]);
                  }}
                >
                  {t('notifications.markAllRead')}
                </Button>
              </Space>
            }
          >
            {isNotificationsInitialLoading ? (
              <Skeleton active paragraph={{ rows: 4 }} />
            ) : (
              <List
                dataSource={orderedNotifications}
                locale={{ emptyText: t('notifications.empty') }}
                renderItem={(item) => {
                  const action = resolveNotificationLink(item.data ?? null, t);
                  const isAlertNotification = item.type === NotificationType.AlertTriggered;
                  return (
                  <List.Item
                    onClick={async () => {
                      if (!item.readAt) {
                        await markRead({ variables: { id: item.id } });
                        await Promise.all([refetchNotifications(), refetchUnread()]);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                    className={!item.readAt ? "bg-slate-50" : undefined}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small" align="center">
                          <Tag color={typeColor[item.type] ?? 'default'}>
                            {t(`notifications.type.${item.type}`)}
                          </Tag>
                          <Typography.Text strong>{item.title}</Typography.Text>
                          {!item.readAt ? <Badge status="processing" /> : null}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={0}>
                          {item.body ? (
                            <Typography.Paragraph
                              style={{ marginBottom: 6 }}
                              ellipsis={{ rows: 2, expandable: false }}
                            >
                              {item.body}
                            </Typography.Paragraph>
                          ) : null}
                          {isAlertNotification ? renderAlertEvidence(item) : null}
                          <Space size="small" align="center">
                            <Typography.Text type="secondary">
                              {formatDateTime(item.createdAt, locale, {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false
                              })}
                            </Typography.Text>
                            {action ? (
                              <Button
                                type="link"
                                size="small"
                                onClick={async (event) => {
                                  event.stopPropagation();
                                  if (!item.readAt) {
                                    await markRead({ variables: { id: item.id } });
                                    await Promise.all([refetchNotifications(), refetchUnread()]);
                                  }
                                  router.push(action.href);
                                }}
                                className="px-0"
                              >
                                {action.label}
                              </Button>
                            ) : null}
                          </Space>
                        </Space>
                      }
                    />
                  </List.Item>
                  );
                }}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
