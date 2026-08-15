"use client";

import { DownOutlined, FileSearchOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Card, Col, Popover, Progress, Row, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import type {
  MainCharacterEntry,
  NarrativeData,
  SituationMonitorFeedbackPayload,
  SituationMonitorInsightsResponse,
} from "../types/situation-monitor-content";
import {
  formatDurationMs,
  stopSituationMonitorInteractiveEvent,
  toCredibilityColor,
} from "../utils/situation-monitor-format";

export interface SituationMonitorNarrativePanelProps {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  translateToZh: boolean;
  locale: SupportedLocale;
  submitSignalFeedback: (payload: SituationMonitorFeedbackPayload) => Promise<void>;
  onReportMissed: () => void;
}

export function SituationMonitorNarrativePanel(
  props: SituationMonitorNarrativePanelProps,
) {
  const {
    data,
    initialLoading,
    translateToZh,
    locale,
    submitSignalFeedback,
    onReportMissed,
  } = props;
  const { t } = useTranslation();

  const narrativeColumns: ColumnsType<NarrativeData> = [
    {
      title: t("situationMonitor.narrative.name"),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>
            {translateToZh ? (record.nameZh ?? record.name) : record.name}
          </span>
          <Tag color={record.severity === "disinfo" ? "red" : "default"}>
            {t(`situationMonitor.narrative.${record.severity.toLowerCase()}`, {
              defaultValue: record.severity.toUpperCase(),
            })}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.narrative.count"),
      dataIndex: "count",
      key: "count",
      width: 90,
    },
    {
      title: t("situationMonitor.narrative.fringe"),
      dataIndex: "fringeCount",
      key: "fringeCount",
      width: 90,
    },
    {
      title: t("situationMonitor.narrative.alternative"),
      dataIndex: "alternativeCount",
      key: "alternativeCount",
      width: 80,
    },
    {
      title: t("situationMonitor.narrative.mainstream"),
      dataIndex: "mainstreamCount",
      key: "mainstreamCount",
      width: 110,
    },
    {
      title: t("situationMonitor.narrative.radar"),
      key: "radar",
      width: 140,
      render: (_, record) => {
        const radar = record.model?.crossSourceRadar;
        if (!radar) return "—";
        const consistency = Math.round((radar.consistency ?? 0) * 100);
        const divergence = Math.round((radar.divergence ?? 0) * 100);
        return (
          <Popover
            content={
              <Space direction="vertical" size={4}>
                <Typography.Text>
                  {t("situationMonitor.narrative.consistency")}
                  : {consistency}%
                </Typography.Text>
                <Typography.Text>
                  {t("situationMonitor.narrative.divergence")}
                  : {divergence}%
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.clusters")}
                  : {radar.clusterCount ?? 0}
                </Typography.Text>
              </Space>
            }
          >
            <Progress percent={consistency} size="small" showInfo={false} />
          </Popover>
        );
      },
    },
    {
      title: t("situationMonitor.narrative.credibility"),
      key: "credibility",
      width: 130,
      render: (_, record) => {
        const credibility = record.model?.credibility;
        if (!credibility) return "—";
        const reasons = Array.isArray(credibility.reasons)
          ? credibility.reasons
          : [];
        const components = credibility.components;
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                {reasons.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>
                      {t("situationMonitor.narrative.credibilityReasons")}
                    </Typography.Text>
                    {reasons.slice(0, 4).map((reason) => (
                      <Typography.Text key={reason} type="secondary">
                        - {reason}
                      </Typography.Text>
                    ))}
                  </Space>
                ) : null}
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>
                    {t("situationMonitor.narrative.credibilityBreakdown")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.sourceReliability")}
                  </Typography.Text>
                  <Progress
                    percent={Math.round(
                      (components.sourceReliability ?? 0) * 100,
                    )}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.corroboration")}
                  </Typography.Text>
                  <Progress
                    percent={Math.round((components.corroboration ?? 0) * 100)}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.citationSupport")}
                  </Typography.Text>
                  <Progress
                    percent={Math.round(
                      (components.citationSupport ?? 0) * 100,
                    )}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.divergence")}
                  </Typography.Text>
                  <Progress
                    percent={Math.round((components.divergence ?? 0) * 100)}
                    size="small"
                    showInfo={false}
                  />
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.feedbackPenalty")}
                  </Typography.Text>
                  <Progress
                    percent={Math.round(
                      (components.feedbackPenalty ?? 0) * 100,
                    )}
                    size="small"
                    showInfo={false}
                  />
                </Space>
              </Space>
            }
          >
            <Tag color={toCredibilityColor(credibility.level)}>
              {t(
                `situationMonitor.narrative.credibilityLevel.${credibility.level.toLowerCase()}`,
                {
                  defaultValue: credibility.level.toUpperCase(),
                },
              )}{" "}
              {credibility.score}
            </Tag>
          </Popover>
        );
      },
    },
    {
      title: t("situationMonitor.narrative.feedback"),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const headline = record.headlines?.[0];
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];
        return (
          <Popover
            placement="left"
            content={
              <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
                <Space size={8} wrap>
                  <Tag color="red">FP {fpCount}</Tag>
                  <Tag color="gold">FN {fnCount}</Tag>
                  <Tag>SUP {suppressedCount}</Tag>
                </Space>
                {boosted.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.boosted")}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {boosted.slice(0, 10).map((token) => (
                        <Tag key={`boost-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
                {blocked.length ? (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      {t("situationMonitor.narrative.blocked")}
                    </Typography.Text>
                    <Space size={6} wrap>
                      {blocked.slice(0, 10).map((token) => (
                        <Tag key={`block-${record.id}-${token}`}>{token}</Tag>
                      ))}
                    </Space>
                  </Space>
                ) : null}
              </Space>
            }
          >
            <Button
              size="small"
              danger
              onClick={() =>
                void submitSignalFeedback({
                  signalType: "narrative",
                  signalId: record.id,
                  label: "false_positive",
                  item: headline
                    ? {
                        itemMetaId: headline.itemMetaId,
                        title: headline.title,
                        source: headline.source,
                        link: headline.link,
                      }
                    : null,
                })
              }
            >
              {t("situationMonitor.narrative.falsePositive")}
              {fpCount > 0 ? ` (${fpCount})` : ""}
            </Button>
          </Popover>
        );
      },
    },
  ];

  const narrativeExpandable = useMemo(() => {
    const expandRowLabel = t("common.expand");
    const collapseRowLabel = t("common.collapse");

    return {
      rowExpandable: (record: NarrativeData) => Boolean(record.model),
      expandIcon: ({
        expanded,
        onExpand,
        record,
      }: {
        expanded: boolean;
        onExpand: (
          record: NarrativeData,
          event: ReactMouseEvent<HTMLElement>,
        ) => void;
        record: NarrativeData;
      }) => {
        if (!record?.model) {
          return <span aria-hidden className="inline-block w-7" />;
        }

        return (
          <Button
            data-sm-interactive
            type="text"
            size="small"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            aria-label={`${expanded ? collapseRowLabel : expandRowLabel} row`}
            onPointerDown={stopSituationMonitorInteractiveEvent}
            onMouseDown={stopSituationMonitorInteractiveEvent}
            onClick={(event) => {
              stopSituationMonitorInteractiveEvent(event);
              onExpand(record, event);
            }}
          />
        );
      },
      expandedRowRender: (record: NarrativeData) => {
        const model = record.model;
        if (!model) return null;

        const path = model.fringeToMainstreamPath;
        const citation = model.citationChain;
        const radar = model.crossSourceRadar;
        const credibility = model.credibility;

        const stepsLabel = path.steps
          .filter((step) => step.tier !== "unknown")
          .map((step) => step.tier)
          .join(" → ");
        const lagLabel = path.lagToMainstreamMs
          ? formatDurationMs(path.lagToMainstreamMs)
          : "—";

        return (
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.path")}
              </Typography.Text>
              <div className="mt-1">
                <Typography.Text>{stepsLabel || "—"}</Typography.Text>
              </div>
              <div className="mt-1">
                <Typography.Text type="secondary">
                  {t("situationMonitor.narrative.lag")}
                  : {lagLabel}
                </Typography.Text>
              </div>
              <div className="mt-2">
                <Space direction="vertical" size={2}>
                  {path.steps.map((step) => {
                    const firstSeen = step.firstSeenAt
                      ? new Date(step.firstSeenAt)
                      : null;
                    const lastSeen = step.lastSeenAt
                      ? new Date(step.lastSeenAt)
                      : null;
                    return (
                      <Typography.Text key={step.tier} type="secondary">
                        {step.tier.toUpperCase()}: {step.count}{" "}
                        {firstSeen
                          ? `(${formatDateTime(firstSeen, locale, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })} → ${
                              lastSeen
                                ? formatDateTime(lastSeen, locale, {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "—"
                            })`
                          : ""}
                      </Typography.Text>
                    );
                  })}
                </Space>
              </div>
            </Col>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.radarDetail")}
              </Typography.Text>
              <div className="mt-2">
                <Space size={10} wrap>
                  <Tag color="geekblue">
                    {t("situationMonitor.narrative.consistency")}
                    : {Math.round((radar.consistency ?? 0) * 100)}%
                  </Tag>
                  <Tag color="gold">
                    {t("situationMonitor.narrative.divergence")}
                    : {Math.round((radar.divergence ?? 0) * 100)}%
                  </Tag>
                  <Tag>
                    {t("situationMonitor.narrative.clusters")}
                    : {radar.clusterCount ?? 0}
                  </Tag>
                  <Tag color={toCredibilityColor(credibility.level)}>
                    {t("situationMonitor.narrative.credibility")}
                    : {credibility.score}
                  </Tag>
                </Space>
              </div>
              {credibility.reasons?.length ? (
                <div className="mt-2">
                  <Space direction="vertical" size={2}>
                    {credibility.reasons.slice(0, 4).map((reason) => (
                      <Typography.Text key={reason} type="secondary">
                        - {reason}
                      </Typography.Text>
                    ))}
                  </Space>
                </div>
              ) : null}
              {radar.outlierSources?.length ? (
                <div className="mt-2">
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.outliers")}
                    :
                  </Typography.Text>
                  <div className="mt-1">
                    <Space size={6} wrap>
                      {radar.outlierSources.slice(0, 8).map((source) => (
                        <Tag key={source}>{source}</Tag>
                      ))}
                    </Space>
                  </div>
                </div>
              ) : null}
              {radar.clusters?.length ? (
                <div className="mt-2">
                  <Space
                    direction="vertical"
                    size={4}
                    style={{ width: "100%" }}
                  >
                    {radar.clusters.slice(0, 4).map((cluster) => (
                      <div key={cluster.id}>
                        <Typography.Text type="secondary">
                          {cluster.id}: {cluster.itemCount}{" "}
                          {cluster.sources?.length
                            ? `· ${cluster.sources.slice(0, 4).join(", ")}`
                            : ""}
                        </Typography.Text>
                      </div>
                    ))}
                  </Space>
                </div>
              ) : null}
            </Col>
            <Col xs={24} lg={8}>
              <Typography.Text strong>
                {t("situationMonitor.narrative.citations")}
              </Typography.Text>
              <div className="mt-2">
                {citation.topCited?.length ? (
                  <Space size={6} wrap>
                    {citation.topCited.slice(0, 8).map((entry) => (
                      <Tag key={entry.source} color="cyan">
                        {entry.source} · {entry.weight}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                )}
              </div>
              {citation.links?.length ? (
                <div className="mt-2">
                  <Typography.Text type="secondary">
                    {t("situationMonitor.narrative.citationLinks")}
                  </Typography.Text>
                  <div className="mt-1">
                    <Space direction="vertical" size={2}>
                      {citation.links.slice(0, 6).map((link) => (
                        <Typography.Text
                          key={`${link.from}=>${link.to}`}
                          type="secondary"
                        >
                          {link.from} → {link.to} ({link.weight})
                        </Typography.Text>
                      ))}
                    </Space>
                  </div>
                </div>
              ) : null}
              {record.learning?.boostedTokens?.length ||
              record.learning?.blockedTokens?.length ||
              (record.learning?.suppressedCount ?? 0) > 0 ||
              (record.feedback?.falsePositive ?? 0) > 0 ||
              (record.feedback?.falseNegative ?? 0) > 0 ? (
                <div className="mt-3">
                  <Typography.Text strong>
                    {t("situationMonitor.narrative.learning")}
                  </Typography.Text>
                  <div className="mt-2">
                    <Space size={8} wrap>
                      <Tag color="red">
                        FP {record.feedback?.falsePositive ?? 0}
                      </Tag>
                      <Tag color="gold">
                        FN {record.feedback?.falseNegative ?? 0}
                      </Tag>
                      <Tag>SUP {record.learning?.suppressedCount ?? 0}</Tag>
                    </Space>
                    {record.learning?.boostedTokens?.length ? (
                      <Space size={6} wrap>
                        <Typography.Text type="secondary">
                          {t("situationMonitor.narrative.boosted")}
                          :
                        </Typography.Text>
                        {record.learning.boostedTokens
                          .slice(0, 8)
                          .map((token) => (
                            <Tag key={`boost-${token}`}>{token}</Tag>
                          ))}
                      </Space>
                    ) : null}
                    {record.learning?.blockedTokens?.length ? (
                      <div className="mt-1">
                        <Space size={6} wrap>
                          <Typography.Text type="secondary">
                            {t("situationMonitor.narrative.blocked")}
                            :
                          </Typography.Text>
                          {record.learning.blockedTokens
                            .slice(0, 8)
                            .map((token) => (
                              <Tag key={`block-${token}`}>{token}</Tag>
                            ))}
                        </Space>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </Col>
          </Row>
        );
      },
    };
  }, [locale, t]);

  return (
    <Card
      title={
        <Space size={12}>
          <span>
            {t("situationMonitor.narrative.title")}
          </span>
          <Tag color="geekblue">
            {(translateToZh
              ? (data?.narrativeSummary?.statusZh ??
                data?.narrativeSummary?.status)
              : data?.narrativeSummary?.status) ??
              t("common.loading")}
          </Tag>
          <Button
            size="small"
            icon={<FileSearchOutlined />}
            onClick={() => {
              onReportMissed();
            }}
          >
            {t("situationMonitor.narrative.reportMissed")}
          </Button>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Typography.Text type="secondary">
        {t("situationMonitor.narrative.hint")}
      </Typography.Text>
      <div className="mt-3">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.crossing")}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.fringeToMainstream ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
      <div className="mt-5">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.emerging")}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.emergingFringe ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
      <div className="mt-5">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.watch")}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.narrativeWatch ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
      <div className="mt-5">
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          {t("situationMonitor.narrative.disinfo")}
        </Typography.Title>
        <Table
          rowKey="id"
          size="small"
          columns={narrativeColumns}
          expandable={narrativeExpandable}
          dataSource={data?.narrative?.disinfoSignals ?? []}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
        />
      </div>
    </Card>
  );
}

export function SituationMonitorMainCharacterPanel(props: {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  translateToZh: boolean;
}) {
  const { data, initialLoading, translateToZh } = props;
  const { t } = useTranslation();

  const mainCharacterColumns: ColumnsType<MainCharacterEntry> = [
    { title: "#", dataIndex: "rank", key: "rank", width: 60 },
    {
      title: t("situationMonitor.mainCharacter.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("situationMonitor.mainCharacter.count"),
      dataIndex: "count",
      key: "count",
      width: 110,
    },
  ];

  return (
    <Card
      title={
        <Space size={12}>
          <span>
            {t("situationMonitor.mainCharacter.title")}
          </span>
          <Tag color="geekblue">
            {(translateToZh
              ? (data?.mainCharacterSummary?.statusZh ??
                data?.mainCharacterSummary?.status)
              : data?.mainCharacterSummary?.status) ??
              t("common.empty")}
          </Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Table
        rowKey="name"
        size="small"
        columns={mainCharacterColumns}
        dataSource={data?.mainCharacter?.characters ?? []}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
      />
    </Card>
  );
}
