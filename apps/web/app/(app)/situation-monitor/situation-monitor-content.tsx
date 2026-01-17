"use client";

import { Alert, Button, Card, Col, Grid, List, Row, Select, Space, Switch, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { WarMap } from "@/app/(app)/dashboard/charts/war-map";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

interface HeadlineRef {
  title: string;
  link: string;
  source: string;
}

interface EmergingPattern {
  id: string;
  name: string;
  category: string;
  count: number;
  level: "high" | "elevated" | "emerging";
  sources: string[];
  headlines: HeadlineRef[];
}

interface MomentumSignal {
  id: string;
  name: string;
  category: string;
  current: number;
  delta: number;
  momentum: "surging" | "rising" | "stable";
  headlines: HeadlineRef[];
}

interface PredictiveSignal {
  id: string;
  name: string;
  category: string;
  score: number;
  confidence: number;
  prediction: string;
  level: "high" | "medium" | "low";
  headlines: HeadlineRef[];
}

interface CrossSourceCorrelation {
  id: string;
  name: string;
  category: string;
  sourceCount: number;
  sources: string[];
  level: "high" | "elevated" | "emerging";
  headlines: HeadlineRef[];
}

interface CorrelationResults {
  emergingPatterns: EmergingPattern[];
  momentumSignals: MomentumSignal[];
  crossSourceCorrelations: CrossSourceCorrelation[];
  predictiveSignals: PredictiveSignal[];
}

type SituationMonitorCategory = "politics" | "tech" | "finance" | "gov" | "ai" | "intel";

interface SituationMonitorHeadline {
  id: string;
  title: string;
  link: string;
  source: string;
  timestamp: number;
  category: SituationMonitorCategory;
  isAlert: boolean;
  alertKeyword?: string;
}

interface NarrativeData {
  id: string;
  name: string;
  category: string;
  severity: "watch" | "emerging" | "spreading" | "disinfo";
  count: number;
  fringeCount: number;
  mainstreamCount: number;
  sources: string[];
  headlines: { title: string; link: string; source: string; timestamp: number }[];
  keywords: string[];
}

interface FringeToMainstream extends NarrativeData {
  status: "crossing";
  crossoverLevel: number;
}

interface EmergingFringe extends NarrativeData {
  status: "emerging" | "spreading" | "viral";
}

interface NarrativeResults {
  emergingFringe: EmergingFringe[];
  fringeToMainstream: FringeToMainstream[];
  disinfoSignals: NarrativeData[];
  narrativeWatch: NarrativeData[];
}

interface MainCharacterEntry {
  name: string;
  count: number;
  rank: number;
}

interface SituationMonitorInsightsResponse {
  generatedAt: string;
  windowHours: number;
  maxItems: number;
  analyzedItems: number;
  headlines: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  correlation: CorrelationResults | null;
  correlationSummary: { totalSignals: number; status: string };
  narrative: NarrativeResults | null;
  narrativeSummary: { total: number; status: string };
  mainCharacter: { characters: MainCharacterEntry[]; topCharacter: MainCharacterEntry | null };
  mainCharacterSummary: { name: string; count: number; status: string };
}

function toTagColor(level: string) {
  switch (level) {
    case "high":
      return "red";
    case "elevated":
      return "orange";
    case "emerging":
      return "blue";
    default:
      return "default";
  }
}

export function SituationMonitorContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const screens = Grid.useBreakpoint();

  const [windowHours, setWindowHours] = useState(24);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SituationMonitorInsightsResponse | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const load = useCallback(async () => {
    if (!session?.accessToken) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<SituationMonitorInsightsResponse>("situation-monitor/insights", {
        params: { windowHours, maxItems: 400 },
      });
      setData(response.data ?? null);
    } catch (err) {
      captureClientError("Failed to load situation monitor insights", err);
      setError(err instanceof Error ? err.message : "Failed to load situation monitor insights.");
    } finally {
      setLoading(false);
    }
  }, [apiClient, session?.accessToken, windowHours]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const emergingColumns: ColumnsType<EmergingPattern> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (value: string, record) => (
        <Space size={8}>
          <span>{value}</span>
          <Tag color={toTagColor(record.level)}>{record.level.toUpperCase()}</Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.correlation.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.sources", { defaultValue: "Sources" }),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) => (Array.isArray(value) ? value.slice(0, 4).join(", ") : ""),
    },
    {
      title: t("situationMonitor.correlation.sample", { defaultValue: "Sample" }),
      dataIndex: "headlines",
      key: "headlines",
      render: (value: HeadlineRef[]) => {
        const first = Array.isArray(value) ? value[0] : undefined;
        const href = first?.link ? safeHttpUrl(first.link) : null;
        if (!first) return null;
        return href ? (
          <Typography.Link href={href} target="_blank" rel="noreferrer">
            {first.title}
          </Typography.Link>
        ) : (
          <Typography.Text>{first.title}</Typography.Text>
        );
      },
    },
  ];

  const momentumColumns: ColumnsType<MomentumSignal> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("situationMonitor.correlation.current", { defaultValue: "Current" }),
      dataIndex: "current",
      key: "current",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.delta", { defaultValue: "Δ" }),
      dataIndex: "delta",
      key: "delta",
      width: 80,
      render: (value: number) => (
        <Typography.Text type={value >= 0 ? "success" : "danger"}>{value}</Typography.Text>
      ),
    },
    {
      title: t("situationMonitor.correlation.momentum", { defaultValue: "Momentum" }),
      dataIndex: "momentum",
      key: "momentum",
      width: 110,
      render: (value: MomentumSignal["momentum"]) => (
        <Tag color={value === "surging" ? "red" : value === "rising" ? "orange" : "default"}>
          {value.toUpperCase()}
        </Tag>
      ),
    },
  ];

  const predictiveColumns: ColumnsType<PredictiveSignal> = [
    { title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }), dataIndex: "name", key: "name" },
    { title: t("situationMonitor.correlation.score", { defaultValue: "Score" }), dataIndex: "score", key: "score", width: 90 },
    { title: t("situationMonitor.correlation.confidence", { defaultValue: "Confidence" }), dataIndex: "confidence", key: "confidence", width: 120, render: (value: number) => `${value}%` },
    { title: t("situationMonitor.correlation.prediction", { defaultValue: "Prediction" }), dataIndex: "prediction", key: "prediction" },
  ];

  const crossSourceColumns: ColumnsType<CrossSourceCorrelation> = [
    {
      title: t("situationMonitor.correlation.topic", { defaultValue: "Topic" }),
      dataIndex: "name",
      key: "name",
      render: (value: string, record) => (
        <Space size={8}>
          <span>{value}</span>
          <Tag color={toTagColor(record.level)}>{record.level.toUpperCase()}</Tag>
        </Space>
      ),
    },
    {
      title: t("situationMonitor.correlation.sources", { defaultValue: "Sources" }),
      dataIndex: "sourceCount",
      key: "sourceCount",
      width: 90,
    },
    {
      title: t("situationMonitor.correlation.sourcesList", { defaultValue: "Source list" }),
      dataIndex: "sources",
      key: "sources",
      render: (value: string[]) => (Array.isArray(value) ? value.slice(0, 4).join(", ") : ""),
    },
    {
      title: t("situationMonitor.correlation.sample", { defaultValue: "Sample" }),
      dataIndex: "headlines",
      key: "headlines",
      render: (value: HeadlineRef[]) => {
        const first = Array.isArray(value) ? value[0] : undefined;
        const href = first?.link ? safeHttpUrl(first.link) : null;
        if (!first) return null;
        return href ? (
          <Typography.Link href={href} target="_blank" rel="noreferrer">
            {first.title}
          </Typography.Link>
        ) : (
          <Typography.Text>{first.title}</Typography.Text>
        );
      },
    },
  ];

  const narrativeColumns: ColumnsType<NarrativeData> = [
    {
      title: t("situationMonitor.narrative.name", { defaultValue: "Narrative" }),
      dataIndex: "name",
      key: "name",
      render: (value: string, record) => (
        <Space size={8}>
          <span>{value}</span>
          <Tag color={record.severity === "disinfo" ? "red" : "default"}>{record.severity.toUpperCase()}</Tag>
        </Space>
      ),
    },
    { title: t("situationMonitor.narrative.count", { defaultValue: "Count" }), dataIndex: "count", key: "count", width: 90 },
    { title: t("situationMonitor.narrative.fringe", { defaultValue: "Fringe" }), dataIndex: "fringeCount", key: "fringeCount", width: 90 },
    { title: t("situationMonitor.narrative.mainstream", { defaultValue: "Mainstream" }), dataIndex: "mainstreamCount", key: "mainstreamCount", width: 110 },
  ];

  const mainCharacterColumns: ColumnsType<MainCharacterEntry> = [
    { title: "#", dataIndex: "rank", key: "rank", width: 60 },
    { title: t("situationMonitor.mainCharacter.name", { defaultValue: "Name" }), dataIndex: "name", key: "name" },
    { title: t("situationMonitor.mainCharacter.count", { defaultValue: "Mentions" }), dataIndex: "count", key: "count", width: 110 },
  ];

  const categoryLabels: Record<SituationMonitorCategory, string> = useMemo(
    () => ({
      politics: t("situationMonitor.categories.politics", { defaultValue: "Politics" }),
      tech: t("situationMonitor.categories.tech", { defaultValue: "Tech" }),
      finance: t("situationMonitor.categories.finance", { defaultValue: "Finance" }),
      gov: t("situationMonitor.categories.gov", { defaultValue: "Government" }),
      ai: t("situationMonitor.categories.ai", { defaultValue: "AI" }),
      intel: t("situationMonitor.categories.intel", { defaultValue: "Intel" }),
    }),
    [t],
  );

  const feedCategories: SituationMonitorCategory[] = useMemo(
    () => ["politics", "tech", "finance", "gov", "ai", "intel"],
    [],
  );

  const feedItemsPerCategory = screens.lg ? 6 : 4;

  const updatedAt = data?.generatedAt ? dayjs(data.generatedAt).toDate() : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.situationMonitor.title", { defaultValue: "Situation Monitor" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.situationMonitor.subtitle", {
            defaultValue: "Correlation, narratives, and key figures across your recent items."
          })}
        </Typography.Text>

        <Space wrap>
          <Select
            value={windowHours}
            onChange={(value) => setWindowHours(value)}
            options={[
              { label: t("situationMonitor.window.6h", { defaultValue: "Last 6h" }), value: 6 },
              { label: t("situationMonitor.window.24h", { defaultValue: "Last 24h" }), value: 24 },
              { label: t("situationMonitor.window.72h", { defaultValue: "Last 72h" }), value: 72 },
            ]}
            style={{ width: 160 }}
          />
          <Button onClick={() => void load()} loading={loading}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
          <Space size={8}>
            <Switch checked={autoRefresh} onChange={(checked) => setAutoRefresh(checked)} />
            <Typography.Text type="secondary">
              {t("situationMonitor.autoRefresh", { defaultValue: "Auto refresh" })}
            </Typography.Text>
          </Space>
          {updatedAt ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.updatedAt", {
                defaultValue: "Updated: {{time}}",
                time: formatDateTime(updatedAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                }),
              })}
            </Typography.Text>
          ) : null}
          {typeof data?.analyzedItems === "number" ? (
            <Typography.Text type="secondary">
              {t("situationMonitor.sampleSize", {
                defaultValue: "Analyzed: {{count}}",
                count: data.analyzedItems,
              })}
            </Typography.Text>
          ) : null}
        </Space>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Row gutter={[16, 16]}>
        {feedCategories.map((category) => {
          const entries = data?.headlines?.[category] ?? [];
          return (
            <Col xs={24} md={12} xl={8} key={category}>
              <Card
                title={
                  <Space size={10}>
                    <span>{categoryLabels[category]}</span>
                    <Tag color="geekblue">{entries.length}</Tag>
                  </Space>
                }
                className="glass-panel border border-[var(--border)]"
                size="small"
                loading={loading && !data}
              >
                {entries.length === 0 ? (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.feeds.empty", { defaultValue: "No headlines yet." })}
                  </Typography.Text>
                ) : (
                  <List
                    size="small"
                    dataSource={entries.slice(0, feedItemsPerCategory)}
                    renderItem={(entry) => {
                      const href = entry.link ? safeHttpUrl(entry.link) : null;
                      const date = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
                      return (
                        <List.Item key={entry.id}>
                          <Space direction="vertical" size={2} style={{ width: "100%" }}>
                            <Space size={8} wrap>
                              {entry.isAlert ? (
                                <Tag color="red">
                                  {t("situationMonitor.feeds.alert", { defaultValue: "ALERT" })}
                                </Tag>
                              ) : null}
                              {href ? (
                                <Typography.Link href={href} target="_blank" rel="noreferrer">
                                  {entry.title}
                                </Typography.Link>
                              ) : (
                                <Typography.Text>{entry.title}</Typography.Text>
                              )}
                            </Space>
                            <Space size={8} wrap>
                              <Typography.Text type="secondary">{entry.source}</Typography.Text>
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
                              {entry.alertKeyword ? (
                                <Typography.Text type="secondary">{entry.alertKeyword}</Typography.Text>
                              ) : null}
                            </Space>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                )}
              </Card>
            </Col>
          );
        })}
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={t("situationMonitor.map.title", { defaultValue: "Global Map" })}
            className="glass-panel border border-[var(--border)]"
          >
            <WarMap />
          </Card>

          <Card
            title={
              <Space size={12}>
                <span>{t("situationMonitor.correlation.title", { defaultValue: "Correlation Engine" })}</span>
                <Tag color="geekblue">
                  {data?.correlationSummary?.status ?? t("common.loading", { defaultValue: "Loading" })}
                </Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)] mt-4"
            loading={loading && !data}
          >
            <Row gutter={[12, 12]}>
              <Col span={24}>
                <Typography.Text type="secondary">
                  {t("situationMonitor.correlation.hint", {
                    defaultValue: "Pattern-based correlation across titles (momentum uses a short Redis history window).",
                  })}
                </Typography.Text>
              </Col>
              <Col span={24}>
                <Table
                  rowKey="id"
                  size="small"
                  columns={emergingColumns}
                  dataSource={data?.correlation?.emergingPatterns ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
              <Col span={24}>
                <Typography.Title level={5} style={{ marginBottom: 8 }}>
                  {t("situationMonitor.correlation.crossSourceTitle", { defaultValue: "Cross-source" })}
                </Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  columns={crossSourceColumns}
                  dataSource={data?.correlation?.crossSourceCorrelations ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
              <Col span={24}>
                <Typography.Title level={5} style={{ marginBottom: 8 }}>
                  {t("situationMonitor.correlation.momentumTitle", { defaultValue: "Momentum" })}
                </Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  columns={momentumColumns}
                  dataSource={data?.correlation?.momentumSignals ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
              <Col span={24}>
                <Typography.Title level={5} style={{ marginBottom: 8 }}>
                  {t("situationMonitor.correlation.predictiveTitle", { defaultValue: "Predictive" })}
                </Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  columns={predictiveColumns}
                  dataSource={data?.correlation?.predictiveSignals ?? []}
                  pagination={{ pageSize: screens.lg ? 6 : 4, hideOnSinglePage: true }}
                />
              </Col>
            </Row>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card
            title={
              <Space size={12}>
                <span>{t("situationMonitor.narrative.title", { defaultValue: "Narrative Tracker" })}</span>
                <Tag color="geekblue">
                  {data?.narrativeSummary?.status ?? t("common.loading", { defaultValue: "Loading" })}
                </Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)]"
            loading={loading && !data}
          >
            <Typography.Text type="secondary">
              {t("situationMonitor.narrative.hint", {
                defaultValue: "Keyword-based narratives and fringe-to-mainstream crossover signals.",
              })}
            </Typography.Text>
            <div className="mt-3">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.crossing", { defaultValue: "Crossing" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.fringeToMainstream ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
            <div className="mt-5">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.emerging", { defaultValue: "Emerging" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.emergingFringe ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
            <div className="mt-5">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.watch", { defaultValue: "Watchlist" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.narrativeWatch ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
            <div className="mt-5">
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t("situationMonitor.narrative.disinfo", { defaultValue: "Disinfo" })}
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                columns={narrativeColumns}
                dataSource={data?.narrative?.disinfoSignals ?? []}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
          </Card>

          <Card
            title={
              <Space size={12}>
                <span>{t("situationMonitor.mainCharacter.title", { defaultValue: "Main Character" })}</span>
                <Tag color="geekblue">{data?.mainCharacterSummary?.status ?? "NO DATA"}</Tag>
              </Space>
            }
            className="glass-panel border border-[var(--border)] mt-4"
            loading={loading && !data}
          >
            <Table
              rowKey="name"
              size="small"
              columns={mainCharacterColumns}
              dataSource={data?.mainCharacter?.characters ?? []}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
