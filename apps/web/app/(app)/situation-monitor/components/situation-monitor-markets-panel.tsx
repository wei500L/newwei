"use client";

import { Alert, Card, Divider, Space, Table, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { SupportedLocale } from "@/lib/i18n";

import type { SituationMonitorInsightsResponse } from "../types/situation-monitor-content";
import { formatPercent, formatUsd } from "../utils/situation-monitor-format";

interface SharedProps {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  locale: SupportedLocale;
  refreshStage: "idle" | "core" | "external";
}

export function SituationMonitorMarketsPanel(props: SharedProps) {
  const { data, initialLoading, locale, refreshStage } = props;
  const { t } = useTranslation();
  const marketsSnapshot = data?.markets;
  const hasMarketSnapshotData = Boolean(
    marketsSnapshot &&
      (marketsSnapshot.indices?.length ?? 0) +
        (marketsSnapshot.sectors?.length ?? 0) +
        (marketsSnapshot.commodities?.length ?? 0) >
        0,
  );

  return (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.markets.title")}
          </span>
          {marketsSnapshot && !marketsSnapshot.hasFinnhubApiKey ? (
            <Tag color="default">
              {t("situationMonitor.markets.missingKey")}
            </Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={
        initialLoading ||
        (refreshStage === "external" && marketsSnapshot === undefined)
      }
    >
      {marketsSnapshot?.error ? (
        <Alert type="warning" showIcon message={marketsSnapshot.error} />
      ) : null}
      {marketsSnapshot ? (
        <>
          {!marketsSnapshot.hasFinnhubApiKey ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.markets.hint")}
            </Typography.Text>
          ) : null}
          {hasMarketSnapshotData ? (
            <>
              <Table
                rowKey="symbol"
                size="small"
                pagination={false}
                columns={[
                  {
                    title: t("common.name"),
                    dataIndex: "name",
                    key: "name",
                  },
                  {
                    title: t("situationMonitor.markets.price"),
                    dataIndex: "price",
                    key: "price",
                    width: 120,
                    render: (value: number) => formatUsd(value, locale),
                  },
                  {
                    title: t("situationMonitor.markets.changePct"),
                    dataIndex: "changePercent",
                    key: "changePercent",
                    width: 110,
                    render: (value: number) => (
                      <Typography.Text
                        type={
                          Number.isFinite(value) && value < 0
                            ? "danger"
                            : "success"
                        }
                      >
                        {formatPercent(value)}
                      </Typography.Text>
                    ),
                  },
                ]}
                dataSource={(marketsSnapshot.indices ?? []).slice(0, 4)}
              />
              <Divider style={{ margin: "12px 0" }} />
              <Table
                rowKey="symbol"
                size="small"
                pagination={false}
                columns={[
                  {
                    title: t("common.name"),
                    dataIndex: "name",
                    key: "name",
                  },
                  {
                    title: t("situationMonitor.markets.price"),
                    dataIndex: "price",
                    key: "price",
                    width: 120,
                    render: (value: number) => formatUsd(value, locale),
                  },
                  {
                    title: t("situationMonitor.markets.changePct"),
                    dataIndex: "changePercent",
                    key: "changePercent",
                    width: 110,
                    render: (value: number) => (
                      <Typography.Text
                        type={
                          Number.isFinite(value) && value < 0
                            ? "danger"
                            : "success"
                        }
                      >
                        {formatPercent(value)}
                      </Typography.Text>
                    ),
                  },
                ]}
                dataSource={(marketsSnapshot.commodities ?? []).slice(0, 3)}
              />
            </>
          ) : !marketsSnapshot.hasFinnhubApiKey ? null : (
            <Typography.Text type="secondary">
              {t("situationMonitor.markets.empty")}
            </Typography.Text>
          )}
        </>
      ) : (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading")
            : t("situationMonitor.markets.empty")}
        </Typography.Text>
      )}
    </Card>
  );
}

export function SituationMonitorCryptoPanel(props: SharedProps) {
  const { data, initialLoading, locale, refreshStage } = props;
  const { t } = useTranslation();
  const cryptoSnapshot = data?.crypto;

  return (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.crypto.title")}
          </span>
          <Tag color="geekblue">{cryptoSnapshot?.length ?? 0}</Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={
        initialLoading ||
        (refreshStage === "external" && cryptoSnapshot === undefined)
      }
    >
      {!cryptoSnapshot ? (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading")
            : t("situationMonitor.crypto.empty")}
        </Typography.Text>
      ) : cryptoSnapshot.length ? (
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            {
              title: t("common.name"),
              dataIndex: "name",
              key: "name",
            },
            {
              title: t("situationMonitor.crypto.price"),
              dataIndex: "currentPriceUsd",
              key: "currentPriceUsd",
              width: 130,
              render: (value: number) => formatUsd(value, locale),
            },
            {
              title: t("situationMonitor.crypto.change24h"),
              dataIndex: "change24hPercent",
              key: "change24hPercent",
              width: 110,
              render: (value: number) => (
                <Typography.Text
                  type={
                    Number.isFinite(value) && value < 0 ? "danger" : "success"
                  }
                >
                  {formatPercent(value)}
                </Typography.Text>
              ),
            },
          ]}
          dataSource={cryptoSnapshot}
        />
      ) : (
        <Typography.Text type="secondary">
          {t("situationMonitor.crypto.empty")}
        </Typography.Text>
      )}
    </Card>
  );
}
