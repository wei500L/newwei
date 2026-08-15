"use client";

import { DownOutlined, FileSearchOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Card, Col, Grid, Popover, Row, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { safeHttpUrl } from "@/lib/url";

import type {
  CrossSourceCorrelation,
  EmergingPattern,
  HeadlineRef,
  MomentumSignal,
  PredictiveSignal,
  SituationMonitorFeedbackPayload,
  SituationMonitorInsightsResponse,
} from "../types/situation-monitor-content";
import { stopSituationMonitorInteractiveEvent, toTagColor } from "../utils/situation-monitor-format";

export interface SituationMonitorCorrelationPanelProps {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  translateToZh: boolean;
  submitSignalFeedback: (payload: SituationMonitorFeedbackPayload) => Promise<void>;
  onReportMissed: () => void;
}

export function SituationMonitorCorrelationPanel(
  props: SituationMonitorCorrelationPanelProps,
) {
  const { data, initialLoading, translateToZh, submitSignalFeedback, onReportMissed } =
    props;
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();

  const emergingColumns: ColumnsType<EmergingPattern> = [
    {
      title: t("situationMonitor.correlation.topic"),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>
            {translateToZh ? (record.nameZh ?? record.name) : record.name}
          </span>
          <Tag color={toTagColor(record.level)}>
            {t(
              `situationMonitor.correlation.level.${record.level.toLowerCase()}`,
              {
                defaultValue: record.level.toUpperCase(),
              },
            )}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.correlation.count"),
      dataIndex: "count",
      key: "count",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.sources"),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) =>
        Array.isArray(value) ? value.slice(0, 4).join(", ") : "",
    },
    {
      title: t("situationMonitor.correlation.sample"),
      dataIndex: "headlines",
      key: "headlines",
      render: (value: HeadlineRef[]) => {
        const first = Array.isArray(value) ? value[0] : undefined;
        const href = first?.link ? safeHttpUrl(first.link) : null;
        if (!first) return null;
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
    {
      title: t("situationMonitor.correlation.feedback"),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                        <Tag key={`c-boost-${record.id}-${token}`}>{token}</Tag>
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
                        <Tag key={`c-block-${record.id}-${token}`}>{token}</Tag>
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
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
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

  const momentumColumns: ColumnsType<MomentumSignal> = [
    {
      title: t("situationMonitor.correlation.topic"),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) =>
        translateToZh ? (record.nameZh ?? record.name) : record.name,
    },
    {
      title: t("situationMonitor.correlation.current"),
      dataIndex: "current",
      key: "current",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.delta"),
      dataIndex: "delta",
      key: "delta",
      width: 80,
      render: (value: number) => (
        <Typography.Text type={value >= 0 ? "success" : "danger"}>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: t("situationMonitor.correlation.momentum"),
      dataIndex: "momentum",
      key: "momentum",
      width: 110,
      render: (value: MomentumSignal["momentum"]) => {
        const normalized = value.toLowerCase();
        const color =
          normalized === "surging"
            ? "red"
            : normalized === "rising"
              ? "orange"
              : "default";
        return (
          <Tag color={color}>
            {t(`situationMonitor.correlation.momentumStatus.${normalized}`, {
              defaultValue: value.toUpperCase(),
            })}
          </Tag>
        );
      },
    },
    {
      title: t("situationMonitor.correlation.feedback"),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                        <Tag key={`c-boost-m-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                        <Tag key={`c-block-m-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
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

  const predictiveColumns: ColumnsType<PredictiveSignal> = [
    {
      title: t("situationMonitor.correlation.topic"),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) =>
        translateToZh ? (record.nameZh ?? record.name) : record.name,
    },
    {
      title: t("situationMonitor.correlation.score"),
      dataIndex: "score",
      key: "score",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.confidence"),
      dataIndex: "confidence",
      key: "confidence",
      width: 120,
      render: (value: number) => `${value}%`,
    },
    {
      title: t("situationMonitor.correlation.prediction"),
      dataIndex: "prediction",
      key: "prediction",
      render: (_value: string, record) =>
        translateToZh
          ? (record.predictionZh ?? record.prediction)
          : record.prediction,
    },
    {
      title: t("situationMonitor.correlation.feedback"),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                        <Tag key={`c-boost-p-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                        <Tag key={`c-block-p-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
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

  const crossSourceColumns: ColumnsType<CrossSourceCorrelation> = [
    {
      title: t("situationMonitor.correlation.topic"),
      dataIndex: "name",
      key: "name",
      render: (_value: string, record) => (
        <Space size={8}>
          <span>
            {translateToZh ? (record.nameZh ?? record.name) : record.name}
          </span>
          <Tag color={toTagColor(record.level)}>
            {t(
              `situationMonitor.correlation.level.${record.level.toLowerCase()}`,
              {
                defaultValue: record.level.toUpperCase(),
              },
            )}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.correlation.sources"),
      dataIndex: "sourceCount",
      key: "sourceCount",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.sourcesList"),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) =>
        Array.isArray(value) ? value.slice(0, 4).join(", ") : "",
    },
    {
      title: t("situationMonitor.correlation.sample"),
      dataIndex: "headlines",
      key: "headlines",
      render: (value: HeadlineRef[]) => {
        const first = Array.isArray(value) ? value[0] : undefined;
        const href = first?.link ? safeHttpUrl(first.link) : null;
        if (!first) return null;
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
    {
      title: t("situationMonitor.correlation.feedback"),
      key: "feedback",
      width: 120,
      render: (_, record) => {
        const first = Array.isArray(record.headlines)
          ? record.headlines[0]
          : undefined;
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
                        <Tag key={`c-boost-x-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                        <Tag key={`c-block-x-${record.id}-${token}`}>
                          {token}
                        </Tag>
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
                  signalType: "correlation",
                  signalId: record.id,
                  label: "false_positive",
                  item: first
                    ? {
                        itemMetaId: first.itemMetaId,
                        title: first.title,
                        source: first.source,
                        link: first.link,
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

  type CorrelationRow =
    | EmergingPattern
    | MomentumSignal
    | CrossSourceCorrelation
    | PredictiveSignal;

  const correlationExpandable = useMemo(() => {
    const expandRowLabel = t("common.expand");
    const collapseRowLabel = t("common.collapse");

    return {
      rowExpandable: (record: CorrelationRow) => {
        const boosted = record.learning?.boostedTokens?.length ?? 0;
        const blocked = record.learning?.blockedTokens?.length ?? 0;
        const suppressed = record.learning?.suppressedCount ?? 0;
        const fp = record.feedback?.falsePositive ?? 0;
        const fn = record.feedback?.falseNegative ?? 0;
        return boosted > 0 || blocked > 0 || suppressed > 0 || fp > 0 || fn > 0;
      },
      expandIcon: ({
        expanded,
        onExpand,
        record,
      }: {
        expanded: boolean;
        onExpand: (
          record: CorrelationRow,
          event: ReactMouseEvent<HTMLElement>,
        ) => void;
        record: CorrelationRow;
      }) => {
        if (!record) {
          return null;
        }

        const canExpand =
          (record.learning?.boostedTokens?.length ?? 0) > 0 ||
          (record.learning?.blockedTokens?.length ?? 0) > 0 ||
          (record.learning?.suppressedCount ?? 0) > 0 ||
          (record.feedback?.falsePositive ?? 0) > 0 ||
          (record.feedback?.falseNegative ?? 0) > 0;

        if (!canExpand) {
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
      expandedRowRender: (record: CorrelationRow) => {
        const fpCount = record.feedback?.falsePositive ?? 0;
        const fnCount = record.feedback?.falseNegative ?? 0;
        const suppressedCount = record.learning?.suppressedCount ?? 0;
        const boosted = record.learning?.boostedTokens ?? [];
        const blocked = record.learning?.blockedTokens ?? [];

        return (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              {t("situationMonitor.correlation.learningHint")}
            </Typography.Text>
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
                  {boosted.slice(0, 16).map((token) => (
                    <Tag key={`corr-boost-${record.id}-${token}`}>{token}</Tag>
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
                  {blocked.slice(0, 16).map((token) => (
                    <Tag key={`corr-block-${record.id}-${token}`}>{token}</Tag>
                  ))}
                </Space>
              </Space>
            ) : null}
          </Space>
        );
      },
    };
  }, [t]);

  return (
    <Card
      title={
        <Space size={12}>
          <span>
            {t("situationMonitor.correlation.title")}
          </span>
          <Tag color="geekblue">
            {(translateToZh
              ? (data?.correlationSummary?.statusZh ??
                data?.correlationSummary?.status)
              : data?.correlationSummary?.status) ??
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
      <Row gutter={[12, 12]}>
        <Col span={24}>
          <Typography.Text type="secondary">
            {t("situationMonitor.correlation.hint")}
          </Typography.Text>
        </Col>
        <Col span={24}>
          <Table
            rowKey="id"
            size="small"
            columns={emergingColumns}
            expandable={
              correlationExpandable as TableProps<EmergingPattern>["expandable"]
            }
            dataSource={data?.correlation?.emergingPatterns ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.crossSourceTitle")}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={crossSourceColumns}
            expandable={
              correlationExpandable as TableProps<CrossSourceCorrelation>["expandable"]
            }
            dataSource={data?.correlation?.crossSourceCorrelations ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.momentumTitle")}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={momentumColumns}
            expandable={
              correlationExpandable as TableProps<MomentumSignal>["expandable"]
            }
            dataSource={data?.correlation?.momentumSignals ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
        <Col span={24}>
          <Typography.Title level={5} style={{ marginBottom: 8 }}>
            {t("situationMonitor.correlation.predictiveTitle")}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            columns={predictiveColumns}
            expandable={
              correlationExpandable as TableProps<PredictiveSignal>["expandable"]
            }
            dataSource={data?.correlation?.predictiveSignals ?? []}
            pagination={{
              pageSize: screens.lg ? 6 : 4,
              hideOnSinglePage: true,
            }}
          />
        </Col>
      </Row>
    </Card>
  );
}
