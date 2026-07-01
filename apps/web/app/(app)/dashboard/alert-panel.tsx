"use client";

import { useApolloClient } from "@apollo/client";
import { Alert, App, Badge, Divider, List, Skeleton, Space, Tag, Typography } from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import type { AlertEventsStreamSubscription } from "@/graphql/generated";
import { AlertEventsStreamDocument, useAlertEventsQuery } from "@/graphql/generated";
import { usePendingAction } from "@/hooks/use-pending-action";
import { createCoalescedRefetchScheduler } from "@/lib/coalesced-refetch";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { useTimedValueDeduper } from "@/lib/use-realtime-helpers";

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
  const { message } = App.useApp();
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
  const shouldShowStreamError = useTimedValueDeduper(30_000);

  useEffect(() => {
    if (!authenticated || !canReadAlerts) {
      return;
    }
    const refetchScheduler = createCoalescedRefetchScheduler(() =>
      refetchEvents(),
    );
    const sub = client
      .subscribe<AlertEventsStreamSubscription>({
        query: AlertEventsStreamDocument
      })
      .subscribe({
        next: () => {
          refetchScheduler.schedule();
        },
        error: (error) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const toastMessage = t("alerts.streamError", { error: errorMessage });
          if (!shouldShowStreamError(toastMessage)) {
            return;
          }
          message.error(toastMessage);
        }
      });
    return () => {
      sub.unsubscribe();
      refetchScheduler.cancel();
    };
  }, [
    authenticated,
    canReadAlerts,
    client,
    message,
    refetchEvents,
    shouldShowStreamError,
    t,
  ]);

  const events = eventsData?.alertEvents ?? [];
  if (status === "loading") {
    return <Skeleton active paragraph={{ rows: 3 }} />;
  }

  if (authenticated && !canReadAlerts) {
    return (
      <ChartEmptyState
        variant="permission"
        title={t("common.accessDenied")}
        description={t("common.accessDeniedDescription")}
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type={canManageAlerts ? "info" : "warning"}
        message={t("alerts.center.configNotice.title")}
        description={
          canManageAlerts ? (
            <Link href="/admin/alerts">
              {t("alerts.center.configNotice.link")}
            </Link>
          ) : (
            t("alerts.center.configNotice.description")
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
            title={t("alerts.events.loadFailedTitle")}
            description={error instanceof Error ? error.message : String(error)}
            actionLabel={t("dashboard.actions.retryFetch")}
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
            title={t("alerts.events.emptyTitle")}
            description={t("alerts.events.emptyDescription")}
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
