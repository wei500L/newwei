"use client";

import { Card, Grid, List, Space, Table, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

import type {
  SituationMonitorInsightsResponse,
  SituationMonitorSituationPanel,
  SituationMonitorWorldLeader,
} from "../types/situation-monitor-content";

export interface SituationMonitorLeadersPanelProps {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  locale: SupportedLocale;
  translateToZh: boolean;
}

export function SituationMonitorLeadersPanel(
  props: SituationMonitorLeadersPanelProps,
) {
  const { data, initialLoading, translateToZh } = props;
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();

  return (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.leaders.title")}
          </span>
          <Tag color="geekblue">{data?.leaders?.length ?? 0}</Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Table
        rowKey="id"
        size="small"
        pagination={{ pageSize: screens.lg ? 8 : 6, hideOnSinglePage: true }}
        columns={[
          {
            title: t("situationMonitor.leaders.leader"),
            dataIndex: "name",
            key: "name",
            render: (_: string, record: SituationMonitorWorldLeader) => (
              <Space size={8}>
                {record.flag ? <span>{record.flag}</span> : null}
                <span>{record.name}</span>
                <Typography.Text type="secondary">
                  {record.country}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t("situationMonitor.leaders.mentions"),
            dataIndex: "matchCount",
            key: "matchCount",
            width: 110,
          },
          {
            title: t("situationMonitor.leaders.sample"),
            dataIndex: "headlines",
            key: "headlines",
            render: (value: SituationMonitorWorldLeader["headlines"]) => {
              const first = Array.isArray(value) ? value[0] : undefined;
              const href = first?.link ? safeHttpUrl(first.link) : null;
              if (!first)
                return <Typography.Text type="secondary">—</Typography.Text>;
              const title = translateToZh
                ? (first.titleZh ?? first.title)
                : first.title;
              return href ? (
                <Typography.Link href={href} target="_blank" rel="noreferrer">
                  {title}
                </Typography.Link>
              ) : (
                <Typography.Text>{title}</Typography.Text>
              );
            },
          },
        ]}
        dataSource={(data?.leaders ?? []).filter(
          (leader) => leader.matchCount > 0,
        )}
      />
    </Card>
  );
}

export interface SituationMonitorSituationCardProps {
  id: SituationMonitorSituationPanel["id"];
  fallbackTitle: string;
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  locale: SupportedLocale;
  translateToZh: boolean;
  refreshStage: "idle" | "core" | "external";
}

export function SituationMonitorSituationCard(
  props: SituationMonitorSituationCardProps,
) {
  const {
    id,
    fallbackTitle,
    data,
    initialLoading,
    locale,
    translateToZh,
    refreshStage,
  } = props;
  const { t } = useTranslation();

    const panel =
      (data?.situations ?? []).find((entry) => entry.id === id) ?? null;
    const statusTag = panel ? (
      <Tag
        color={
          panel.level === "critical"
            ? "red"
            : panel.level === "elevated"
              ? "orange"
              : "default"
        }
      >
        {panel.status}
      </Tag>
    ) : refreshStage === "core" ? (
      <Tag color="default">
        {t("common.loading")}
      </Tag>
    ) : null;

    return (
      <Card
        title={
          <Space size={10}>
            <span>
              {panel
                ? translateToZh
                  ? (panel.titleZh ?? panel.title)
                  : panel.title
                : fallbackTitle}
            </span>
            {statusTag}
          </Space>
        }
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
        loading={initialLoading}
      >
        {panel?.subtitle ? (
          <Typography.Text type="secondary">
            {translateToZh
              ? (panel.subtitleZh ?? panel.subtitle)
              : panel.subtitle}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">
            {refreshStage === "core"
              ? t("common.loading")
              : t("situationMonitor.situations.empty")}
          </Typography.Text>
        )}
        <div className="mt-3">
          {panel?.headlines?.length ? (
            <List
              size="small"
              dataSource={panel.headlines.slice(0, 6)}
              renderItem={(entry, index) => {
                const key = `${panel.id}-${index}`;
                const href = entry.link ? safeHttpUrl(entry.link) : null;
                const date = Number.isFinite(entry.timestamp)
                  ? new Date(entry.timestamp)
                  : null;
                return (
                  <List.Item key={key}>
                    <Space
                      direction="vertical"
                      size={2}
                      style={{ width: "100%" }}
                    >
                      {href ? (
                        <Typography.Link
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {translateToZh
                            ? (entry.titleZh ?? entry.title)
                            : entry.title}
                        </Typography.Link>
                      ) : (
                        <Typography.Text>
                          {translateToZh
                            ? (entry.titleZh ?? entry.title)
                            : entry.title}
                        </Typography.Text>
                      )}
                      <Space size={8} wrap>
                        <Typography.Text type="secondary">
                          {entry.source}
                        </Typography.Text>
                        {date ? (
                          <Typography.Text type="secondary">
                            {formatDateTime(date, locale, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    </Space>
                  </List.Item>
                );
              }}
            />
          ) : (
            <Typography.Text type="secondary">
              {t("situationMonitor.situations.empty")}
            </Typography.Text>
          )}
        </div>
      </Card>
    );
}
