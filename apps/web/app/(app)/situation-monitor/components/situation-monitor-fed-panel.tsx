"use client";

import { Alert, Card, Divider, Grid, List, Progress, Space, Table, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { ArticlePublishedTime } from "@/components/article-published-time";
import type { SupportedLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

import type {
  SituationMonitorFedIndicator,
  SituationMonitorInsightsResponse,
} from "../types/situation-monitor-content";
import { getFedMoneyPrinterLabel } from "../utils/situation-monitor-format";

export interface SituationMonitorFedPanelProps {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  locale: SupportedLocale;
  translateToZh: boolean;
  refreshStage: "idle" | "core" | "external";
}

export function SituationMonitorFedPanel(props: SituationMonitorFedPanelProps) {
  const { data, initialLoading, locale, translateToZh, refreshStage } = props;
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  const fedSnapshot = data?.fed;
  const hasFedIndicatorSnapshotData = (fedSnapshot?.indicators?.length ?? 0) > 0;
  const fedNewsPerPanel = screens.lg ? 8 : 5;

  return (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.fed.title")}
          </span>
          {fedSnapshot && !fedSnapshot.hasFredApiKey ? (
            <Tag color="default">FRED API</Tag>
          ) : null}
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={
        initialLoading ||
        (refreshStage === "external" && fedSnapshot === undefined)
      }
    >
      {!fedSnapshot ? (
        <Typography.Text type="secondary">
          {refreshStage === "external"
            ? t("common.loading")
            : t("situationMonitor.fed.empty")}
        </Typography.Text>
      ) : (
        <>
          {fedSnapshot.error ? (
            <Alert type="warning" showIcon message={fedSnapshot.error} />
          ) : null}
          {!fedSnapshot.hasFredApiKey ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.fed.hint")}
            </Typography.Text>
          ) : null}
          {hasFedIndicatorSnapshotData ? (
            <Table
              rowKey="seriesId"
              size="small"
              pagination={false}
              columns={[
                {
                  title: t("common.name"),
                  dataIndex: "name",
                  key: "name",
                },
                {
                  title: t("situationMonitor.fed.value"),
                  dataIndex: "value",
                  key: "value",
                  width: 110,
                  render: (
                    value: number | null,
                    record: SituationMonitorFedIndicator,
                  ) =>
                    value === null ? "—" : `${value.toFixed(2)}${record.unit}`,
                },
                {
                  title: t("situationMonitor.fed.delta"),
                  dataIndex: "change",
                  key: "change",
                  width: 90,
                  render: (value: number | null) =>
                    value === null ? (
                      "—"
                    ) : (
                      <Typography.Text type={value < 0 ? "danger" : "success"}>
                        {value > 0 ? "+" : ""}
                        {value.toFixed(2)}
                      </Typography.Text>
                    ),
                },
              ]}
              dataSource={fedSnapshot.indicators}
            />
          ) : !fedSnapshot.hasFredApiKey ? null : (
            <Typography.Text type="secondary">
              {t("situationMonitor.fed.empty")}
            </Typography.Text>
          )}

          {fedSnapshot.moneyPrinter ? (
            <>
              <Divider style={{ margin: "12px 0" }} />
              <Space direction="vertical" size={6} style={{ width: "100%" }}>
                <Space size={10} wrap>
                  <Tag
                    color={
                      fedSnapshot.moneyPrinter.changeTrillions > 0
                        ? "green"
                        : "red"
                    }
                  >
                    {getFedMoneyPrinterLabel(
                      fedSnapshot.moneyPrinter.changeTrillions > 0,
                      t,
                    )}
                  </Tag>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.fed.balanceSheet")}
                    : {fedSnapshot.moneyPrinter.valueTrillions.toFixed(2)}T
                  </Typography.Text>
                  <Typography.Text
                    type={
                      fedSnapshot.moneyPrinter.changePercent < 0
                        ? "danger"
                        : "success"
                    }
                  >
                    {fedSnapshot.moneyPrinter.changeTrillions > 0 ? "+" : ""}
                    {(fedSnapshot.moneyPrinter.changeTrillions * 1000).toFixed(
                      0,
                    )}
                    B ({fedSnapshot.moneyPrinter.changePercent > 0 ? "+" : ""}
                    {fedSnapshot.moneyPrinter.changePercent.toFixed(2)}%)
                  </Typography.Text>
                </Space>
                <Progress
                  percent={Math.min(
                    100,
                    Math.max(0, fedSnapshot.moneyPrinter.percentOfMax),
                  )}
                  showInfo={false}
                />
              </Space>
            </>
          ) : null}

          {fedSnapshot.news?.length ? (
            <>
              <Divider style={{ margin: "12px 0" }} />
              <List
                size="small"
                dataSource={fedSnapshot.news.slice(0, fedNewsPerPanel)}
                renderItem={(item) => {
                  const href = item.link ? safeHttpUrl(item.link) : null;
                  const date = Number.isFinite(item.timestamp)
                    ? new Date(item.timestamp)
                    : null;
                  const title = translateToZh
                    ? (item.titleZh ?? item.title)
                    : item.title;
                  const description = translateToZh
                    ? (item.descriptionZh ?? item.description)
                    : item.description;
                  const descriptionText =
                    typeof description === "string" ? description.trim() : "";
                  return (
                    <List.Item key={item.id}>
                      <Space
                        direction="vertical"
                        size={2}
                        style={{ width: "100%" }}
                      >
                        <Space size={8} wrap>
                          <Tag
                            color={item.type === "powell" ? "orange" : "blue"}
                          >
                            {translateToZh
                              ? (item.typeLabelZh ?? item.typeLabel)
                              : item.typeLabel}
                          </Tag>
                          {item.hasVideo ? (
                            <Tag color="purple">VIDEO</Tag>
                          ) : null}
                          {href ? (
                            <Typography.Link
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {title}
                            </Typography.Link>
                          ) : (
                            <Typography.Text>{title}</Typography.Text>
                          )}
                        </Space>
                        {descriptionText ? (
                          <Typography.Paragraph
                            type="secondary"
                            ellipsis={{ rows: 2 }}
                            style={{ marginBottom: 0 }}
                          >
                            {descriptionText}
                          </Typography.Paragraph>
                        ) : null}
                        <Space size={8} wrap>
                          <ArticlePublishedTime
                            publishedAt={date?.toISOString() ?? null}
                            locale={locale}
                            formatOptions={{
                              dateStyle: "medium",
                              timeStyle: "short",
                              timeZoneName: "short",
                            }}
                            primaryStrong
                            secondaryStyle={{ fontSize: 12 }}
                          />
                          {item.isPowellRelated && item.type !== "powell" ? (
                            <Tag color="orange">POWELL</Tag>
                          ) : null}
                        </Space>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}
