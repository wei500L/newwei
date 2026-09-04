"use client";

import { Alert, Button, Space, Spin, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import type { AlertEventReplayQuery } from "@/graphql/generated";

import type { AlertEventItem } from "./alert-center-list-model";

/**
 * Alert Center 详情 Replay 页签（FE-批3B 从 alert-center.tsx 提取）。
 * 懒加载门禁在编排层（选中 replay tab 且存在事件时才请求）。
 */

export interface AlertEventReplayTabProps {
  selectedEvent: AlertEventItem;
  replay: NonNullable<AlertEventReplayQuery["alertEventReplay"]> | null;
  replayPoints: NonNullable<AlertEventReplayQuery["alertEventReplay"]>["points"] | null | undefined;
  replayLoading: boolean;
  replayError: Error | undefined;
  replayOption: EChartsOption;
  echartsTheme: string;
  onReloadReplay: () => void;
}

export function AlertEventReplayTab({
  selectedEvent,
  replay,
  replayPoints,
  replayLoading,
  replayError,
  replayOption,
  echartsTheme,
  onReloadReplay,
}: AlertEventReplayTabProps) {
  const { t } = useTranslation();

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space size="small" wrap>
        <Button
          size="small"
          onClick={onReloadReplay}
          loading={replayLoading}
          disabled={!selectedEvent}
        >
          {t("alerts.center.detail.openReplay")}
        </Button>
        <Typography.Text type="secondary">
          {t("alerts.center.detail.replayHint")}
        </Typography.Text>
      </Space>
      {replayLoading ? (
        <div className="flex justify-center py-10">
          <Spin />
        </div>
      ) : replayError ? (
        <Alert
          type="error"
          showIcon
          message={t("alerts.center.detail.replayError")}
          description={replayError.message}
        />
      ) : replay ? (
        replayPoints && replayPoints.length > 0 ? (
          <DashboardChart
            option={replayOption}
            theme={echartsTheme}
            height={300}
          />
        ) : (
          <ChartEmptyState
            className="h-auto py-8"
            description={t("alerts.center.detail.replayEmpty")}
          />
        )
      ) : (
        <Alert
          type="info"
          showIcon
          message={t("alerts.center.detail.replayUnsupported")}
        />
      )}
    </Space>
  );
}
