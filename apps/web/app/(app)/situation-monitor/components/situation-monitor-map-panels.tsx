"use client";

import { Card, Skeleton, Space, Table, Tag, Grid, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import type {
  SituationMonitorInsightsResponse,
  SituationMonitorTensionPair,
} from "../types/situation-monitor-content";
import { formatPercent } from "../utils/situation-monitor-format";

function SituationMonitorWarMapSkeleton() {
  return (
    <div className="flex h-full min-h-[320px] w-full items-center justify-center px-4 py-6">
      <Skeleton active paragraph={{ rows: 6 }} className="w-full" />
    </div>
  );
}

const WarMap = dynamic(
  () =>
    import("@/app/(app)/dashboard/charts/war-map").then((mod) => mod.WarMap),
  {
    ssr: false,
    loading: () => <SituationMonitorWarMapSkeleton />,
  },
);

export interface SituationMonitorMapPanelProps {
  translateToZh: boolean;
}

export function SituationMonitorMapPanel(props: SituationMonitorMapPanelProps) {
  const { translateToZh } = props;
  const { t } = useTranslation();

  return (
    <Card
      title={t("situationMonitor.map.title")}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      styles={{ body: { padding: 0, overflow: "hidden" } }}
    >
      <WarMap
        className="h-full"
        translateTarget={translateToZh ? "zh-CN" : undefined}
      />
    </Card>
  );
}

export interface SituationMonitorRealtimeSnapshotPanelProps {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  locale: SupportedLocale;
}

export function SituationMonitorRealtimeSnapshotPanel(
  props: SituationMonitorRealtimeSnapshotPanelProps,
) {
  const { data, initialLoading, locale } = props;
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();

  const realtimeSnapshotTensionLimit = screens.lg ? 4 : screens.md ? 3 : 2;
  const showRealtimeSnapshotChangeColumn = Boolean(screens.md);

  const tensionColumns: ColumnsType<SituationMonitorTensionPair> = [
    {
      title: t("situationMonitor.realtimeSnapshot.tensionPair"),
      dataIndex: "label",
      key: "label",
      ellipsis: true,
      render: (value: string) => (
        <Typography.Text ellipsis={{ tooltip: value }}>
          {value || "—"}
        </Typography.Text>
      ),
    },
    {
      title: t("situationMonitor.realtimeSnapshot.score"),
      dataIndex: "score",
      key: "score",
      width: 90,
      render: (value: number) =>
        Number.isFinite(value) ? value.toFixed(1) : "—",
    },
    ...(showRealtimeSnapshotChangeColumn
      ? [
          {
            title: t("situationMonitor.realtimeSnapshot.changePct"),
            dataIndex: "changePercent",
            key: "changePercent",
            width: 100,
            render: (value: number) => (
              <Typography.Text
                type={
                  value > 0 ? "danger" : value < 0 ? "success" : "secondary"
                }
              >
                {formatPercent(value)}
              </Typography.Text>
            ),
          },
        ]
      : []),
    {
      title: t("situationMonitor.realtimeSnapshot.trend"),
      dataIndex: "trend",
      key: "trend",
      width: 100,
      render: (value: SituationMonitorTensionPair["trend"]) => {
        const normalized = value.toLowerCase();
        const color =
          normalized === "rising"
            ? "red"
            : normalized === "falling"
              ? "green"
              : "default";
        return (
          <Tag color={color}>
            {t(`situationMonitor.realtimeSnapshot.trendStatus.${normalized}`, {
              defaultValue: normalized.toUpperCase(),
            })}
          </Tag>
        );
      },
    },
  ];

  return (
    <Card
      title={t("situationMonitor.realtimeSnapshot.title")}
      className="sm-panel-card sm-realtime-snapshot-card glass-panel border border-[var(--border)] h-full"
      styles={{ body: { padding: 16 } }}
      loading={initialLoading}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {data?.pizzint ? (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space size={[8, 8]} wrap>
              <Tag
                color={
                  data.pizzint.defcon <= 2
                    ? "red"
                    : data.pizzint.defcon <= 3
                      ? "orange"
                      : "default"
                }
              >
                {t("situationMonitor.realtimeSnapshot.pizzint")}{" "}
                DEFCON {data.pizzint.defcon}
              </Tag>
              <Typography.Text type="secondary">
                {t("situationMonitor.realtimeSnapshot.updatedAt")}
                :{" "}
                {dayjs(data.pizzint.updatedAt).isValid()
                  ? formatDateTime(
                      dayjs(data.pizzint.updatedAt).toDate(),
                      locale,
                      {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )
                  : "—"}
              </Typography.Text>
            </Space>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.adjustedScore")}
                </Typography.Text>
                <Typography.Text strong>
                  {data.pizzint.adjustedScore}
                </Typography.Text>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.openLocations")}
                </Typography.Text>
                <Typography.Text strong>
                  {data.pizzint.openLocations}
                </Typography.Text>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.activeSpikes")}
                </Typography.Text>
                <Typography.Text strong>
                  {data.pizzint.activeSpikes}
                </Typography.Text>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/30 px-3 py-2 dark:bg-white/5">
                <Typography.Text
                  type="secondary"
                  className="block text-[11px] uppercase tracking-[0.08em]"
                >
                  {t("situationMonitor.realtimeSnapshot.avgPop")}
                </Typography.Text>
                <Typography.Text strong>{data.pizzint.avgPop}</Typography.Text>
              </div>
            </div>
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {t("situationMonitor.realtimeSnapshot.pizzintEmpty")}
          </Typography.Text>
        )}

        <div>
          <Typography.Text type="secondary">
            {t("situationMonitor.realtimeSnapshot.tensionsTitle")}
          </Typography.Text>
          <Table
            rowKey="id"
            size="small"
            columns={tensionColumns}
            dataSource={(data?.tensions ?? []).slice(
              0,
              realtimeSnapshotTensionLimit,
            )}
            pagination={false}
            style={{ marginTop: 8 }}
            tableLayout="fixed"
            scroll={screens.md ? undefined : { x: 420 }}
            locale={{
              emptyText: t("situationMonitor.realtimeSnapshot.tensionsEmpty"),
            }}
          />
        </div>
      </Space>
    </Card>
  );
}
