"use client";

import { useApolloClient } from "@apollo/client";
import { Alert, Badge, Divider, List, Skeleton, Space, Tag, Typography } from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import type { AlertEventsStreamSubscription } from "@/graphql/generated";
import { AlertEventsStreamDocument, useAlertEventsQuery } from "@/graphql/generated";
import { usePendingAction } from "@/hooks/use-pending-action";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red"
};

const eventStatusBadge: Record<string, "success" | "processing" | "error" | "default"> = {
  delivered: "success",
  pending: "processing",
  failed: "error",
  confirmed: "success",
  ignored: "default"
};

export function AlertPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const client = useApolloClient();
  const { data: session, status } = useSession();
  const authenticated = status === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadAlerts = permissions.includes("alerts.read");
  const canManageAlerts = permissions.includes("alerts.manage");
  const { data: eventsData, loading, error, refetch: refetchEvents } = useAlertEventsQuery({
    variables: { limit: 10 },
    skip: !authenticated || !canReadAlerts
  });
  const { pending: refreshingEvents, run: refreshEvents } = usePendingAction(
    () => refetchEvents(),
  );

  useEffect(() => {
    if (!authenticated || !canReadAlerts) {
      return;
    }
    const sub = client
      .subscribe<AlertEventsStreamSubscription>({
        query: AlertEventsStreamDocument
      })
      .subscribe({
        next: () => {
          void refetchEvents();
        }
      });
    return () => sub.unsubscribe();
  }, [authenticated, canReadAlerts, client, refetchEvents]);

  const events = eventsData?.alertEvents ?? [];
  if (status === "loading") {
    return <Skeleton active paragraph={{ rows: 3 }} />;
  }

  if (authenticated && !canReadAlerts) {
    return (
      <ChartEmptyState
        variant="permission"
        title={t("common.accessDenied", { defaultValue: "Access denied" })}
        description={t("common.accessDeniedDescription", {
          defaultValue:
            "You don't have permission to view this data. Contact an administrator if you need access."
        })}
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type={canManageAlerts ? "info" : "warning"}
        message={t("alerts.center.configNotice.title", {
          defaultValue: "Alert rules are managed in Admin"
        })}
        description={
          canManageAlerts ? (
            <Link href="/admin/alerts">
              {t("alerts.center.configNotice.link", { defaultValue: "Open alert configuration" })}
            </Link>
          ) : (
            t("alerts.center.configNotice.description", {
              defaultValue: "Alert rule configuration is limited to administrators."
            })
          )
        }
      />
      <Divider />
      <div>
        <Typography.Title level={5}>{t("alerts.events.title")}</Typography.Title>
        {error ? (
          <ChartEmptyState
            presentation="banner"
            variant="error"
            className="mb-3"
            title={t("alerts.events.loadFailedTitle", { defaultValue: "Failed to load alert events" })}
            description={error instanceof Error ? error.message : String(error)}
            actionLabel={t("dashboard.actions.retryFetch", {
              defaultValue: "Retry fetch"
            })}
            actionLoading={refreshingEvents}
            onAction={() => {
              void refreshEvents();
            }}
          />
        ) : null}

        {loading && events.length === 0 ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : events.length === 0 ? (
          <ChartEmptyState
            className="h-auto py-6"
            title={t("alerts.events.emptyTitle", { defaultValue: "No alerts yet" })}
            description={t("alerts.events.emptyDescription", {
              defaultValue: "Alerts will appear here once a rule triggers.",
            })}
          />
        ) : (
          <List
            rowKey="id"
            loading={loading}
            dataSource={events}
            renderItem={(event) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space>
                      <Badge status={eventStatusBadge[event.status] ?? "default"} />
                      <Typography.Text>
                        {formatDateTime(event.triggeredAt, locale, {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZoneName: "short",
                        })}
                      </Typography.Text>
                      <Tag color={severityColor[event.severity] ?? "blue"}>{event.severity}</Tag>
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      <Typography.Text type="secondary">
                        {t("alerts.events.metrics", {
                          value: event.metricValue,
                          change:
                            typeof event.changePercent === "number"
                              ? `${event.changePercent.toFixed(2)}%`
                              : t("common.notAvailable"),
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {t("alerts.center.eventSummary", {
                          rule: event.ruleName ?? t("common.notAvailable"),
                          metric: event.metricSlug ?? t("common.notAvailable"),
                        })}
                      </Typography.Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </Space>
  );
}
