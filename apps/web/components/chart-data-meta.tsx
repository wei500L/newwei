"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Tag, Tooltip, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { ChartDataState } from "@/lib/chart-data-state";
import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

export interface ChartDataMetaProps {
  state: ChartDataState;
  latestTimestamp?: Date | null;
  locale: SupportedLocale;
  refreshing?: boolean;
  onRefresh?: (() => void) | undefined;
}

export function ChartDataMeta({
  state,
  latestTimestamp,
  locale,
  refreshing = false,
  onRefresh,
}: ChartDataMetaProps) {
  const { t } = useTranslation();

  const latestLabel = t("dashboard.dataLatest.label", {
    defaultValue: "Latest"
  });
  const formattedLatest = latestTimestamp
    ? formatDateTime(latestTimestamp.toISOString(), locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
    : t("common.notAvailable");

  const statusTag =
    state === "delayed" ? (
      <Tag color="orange">{t("dashboard.dataDelayed.short", { defaultValue: "Delayed" })}</Tag>
    ) : state === "backfilling" ? (
      <Tag color="blue">{t("dashboard.dataBackfilling.short", { defaultValue: "Updating" })}</Tag>
    ) : null;

  const statusTooltip =
    state === "delayed"
      ? t("dashboard.dataDelayed.tooltip", {
          defaultValue: "Data is delayed. Latest point is behind the selected range."
        })
      : state === "backfilling"
        ? t("dashboard.dataBackfilling.tooltip", {
            defaultValue: "Data is being backfilled and may update shortly."
          })
        : null;

  return (
    <Space size={8} wrap>
      {statusTag && statusTooltip ? (
        <Tooltip title={statusTooltip}>
          <span>{statusTag}</span>
        </Tooltip>
      ) : null}
      <Tooltip title={`${latestLabel}: ${formattedLatest}`}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {latestLabel}: {formattedLatest}
        </Typography.Text>
      </Tooltip>
      {onRefresh ? (
        <Tooltip
          title={t("dashboard.actions.fetchLatestTooltip", {
            defaultValue:
              "Pull the current view from the server again. This does not trigger a server-side refresh job."
          })}
        >
          <Button
            size="small"
            type="text"
            aria-label={t("dashboard.actions.fetchLatest", {
              defaultValue: "Pull latest data"
            })}
            icon={<ReloadOutlined />}
            loading={refreshing}
            disabled={refreshing}
            onClick={onRefresh}
          />
        </Tooltip>
      ) : null}
    </Space>
  );
}
