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

  const latestLabel = t("dashboard.dataLatest.label");
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
      <Tag color="orange">{t("dashboard.dataDelayed.short")}</Tag>
    ) : state === "backfilling" ? (
      <Tag color="blue">{t("dashboard.dataBackfilling.short")}</Tag>
    ) : null;

  const statusTooltip =
    state === "delayed"
      ? t("dashboard.dataDelayed.tooltip")
      : state === "backfilling"
        ? t("dashboard.dataBackfilling.tooltip")
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
          title={t("dashboard.actions.fetchLatestTooltip")}
        >
          <Button
            size="small"
            type="text"
            aria-label={t("dashboard.actions.fetchLatest")}
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
