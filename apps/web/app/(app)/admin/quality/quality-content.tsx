"use client";

import { Alert, Button, Card, Col, Grid, Row, Select, Space, Spin, Statistic, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface PipelineQualitySummary {
  windowMinutes: number;
  totals: {
    total: number;
    completed: number;
    failed: number;
    processing: number;
    pending: number;
  };
  successRate: number | null;
  averageLatencyMs: number | null;
  ingestionLatencyMs?: {
    sampleSize: number;
    averageMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
  };
  failureTypes: { stage: string; errorName: string; count: number }[];
  outbox?: {
    totals: {
      total: number;
      pending: number;
      processing: number;
      failed: number;
      staleProcessing: number;
    };
    oldestAgeMinutes: number | null;
  };
}

interface NewsSourceQualitySummary {
  windowHours: number;
  totals: {
    total: number;
    active: number;
    failing: number;
    circuitOpen: number;
  };
  topFailingSources: {
    sourceId: string;
    name: string;
    url: string;
    failedJobs: number;
    consecutiveFailures: number;
    lastFailureAt: string | null;
    circuitOpenUntil: string | null;
    nextRunAt: string | null;
  }[];
}

const msToSeconds = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value / 100) / 10 : undefined;

export function QualityContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const canView = session?.permissions?.includes("settings.manage") ?? false;
  const [loading, setLoading] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineQualitySummary | null>(null);
  const [sources, setSources] = useState<NewsSourceQualitySummary | null>(null);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const screens = Grid.useBreakpoint();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pipelineRes, sourcesRes] = await Promise.all([
        apiClient.get<PipelineQualitySummary>("admin/quality/pipeline", { params: { windowMinutes } }),
        apiClient.get<NewsSourceQualitySummary>("admin/quality/news-sources", { params: { windowHours: 24 } })
      ]);
      setPipeline(pipelineRes.data ?? null);
      setSources(sourcesRes.data ?? null);
    } catch (error) {
      captureClientError("Failed to load quality dashboard", error);
      messageApi.error(t("quality.errors.loadFailed", { defaultValue: "Failed to load quality dashboard." }));
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, t, windowMinutes]);

  useEffect(() => {
    if (canView) {
      void load();
    }
  }, [canView, load]);

  const failureColumns: ColumnsType<PipelineQualitySummary["failureTypes"][number]> = [
    {
      title: t("quality.columns.stage", { defaultValue: "Stage" }),
      dataIndex: "stage",
      key: "stage"
    },
    {
      title: t("quality.columns.error", { defaultValue: "Error" }),
      dataIndex: "errorName",
      key: "errorName",
      render: (value: string) => <Tag>{value}</Tag>
    },
    {
      title: t("quality.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count"
    }
  ];

  const sourceColumns: ColumnsType<NewsSourceQualitySummary["topFailingSources"][number]> = [
    {
      title: t("quality.sources.columns.name", { defaultValue: "Source" }),
      dataIndex: "name",
      key: "name",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" ellipsis={{ tooltip: record.url }}>
            {record.url}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t("quality.sources.columns.failedJobs", { defaultValue: "Failed jobs" }),
      dataIndex: "failedJobs",
      key: "failedJobs"
    },
    {
      title: t("quality.sources.columns.streak", { defaultValue: "Failure streak" }),
      dataIndex: "consecutiveFailures",
      key: "consecutiveFailures"
    },
    {
      title: t("quality.sources.columns.circuit", { defaultValue: "Circuit" }),
      dataIndex: "circuitOpenUntil",
      key: "circuitOpenUntil",
      render: (value: string | null) =>
        value ? <Tag color="orange">{t("quality.sources.circuitOpen", { defaultValue: "OPEN" })}</Tag> : <Tag>OK</Tag>
    }
  ];

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("quality.title", { defaultValue: "Data Quality" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <>
      {contextHolder}
      <div className="flex flex-col gap-6">
        <Space direction={screens.md ? "horizontal" : "vertical"} style={{ width: "100%", justifyContent: "space-between" }}>
          <Space direction="vertical" size={2}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t("quality.title", { defaultValue: "Data Quality" })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("quality.subtitle", { defaultValue: "Pipeline success, latency, and source reliability." })}
            </Typography.Text>
          </Space>
          <Space>
            <Select
              value={windowMinutes}
              onChange={(value) => setWindowMinutes(value)}
              options={[
                { value: 60, label: t("quality.windows.60m", { defaultValue: "Last 60m" }) },
                { value: 240, label: t("quality.windows.4h", { defaultValue: "Last 4h" }) },
                { value: 1440, label: t("quality.windows.24h", { defaultValue: "Last 24h" }) }
              ]}
              style={{ minWidth: 160 }}
            />
            <Button onClick={() => void load()} loading={loading}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
          </Space>
        </Space>

        <Card className="content-card" title={t("quality.pipeline.title", { defaultValue: "Pipeline" })} loading={loading}>
          {pipeline ? (
            <Row gutter={[16, 16]}>
              <Col xs={12} md={6}>
                <Statistic title={t("quality.pipeline.total", { defaultValue: "Total" })} value={pipeline.totals.total} />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title={t("quality.pipeline.completed", { defaultValue: "Completed" })} value={pipeline.totals.completed} />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title={t("quality.pipeline.failed", { defaultValue: "Failed" })} value={pipeline.totals.failed} />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title={t("quality.pipeline.successRate", { defaultValue: "Success rate" })}
                  value={
                    pipeline.successRate !== null ? Math.round(pipeline.successRate * 1000) / 10 : undefined
                  }
                  suffix={pipeline.successRate !== null ? "%" : undefined}
                />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title={t("quality.pipeline.llmLatency", { defaultValue: "Avg LLM latency" })}
                  value={
                    pipeline.averageLatencyMs !== null ? Math.round(pipeline.averageLatencyMs / 100) / 10 : undefined
                  }
                  suffix={pipeline.averageLatencyMs !== null ? "s" : undefined}
                />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title={t("quality.pipeline.ingestP50", { defaultValue: "Ingest p50" })}
                  value={msToSeconds(pipeline.ingestionLatencyMs?.p50Ms)}
                  suffix={pipeline.ingestionLatencyMs?.p50Ms != null ? "s" : undefined}
                />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title={t("quality.pipeline.ingestP90", { defaultValue: "Ingest p90" })}
                  value={msToSeconds(pipeline.ingestionLatencyMs?.p90Ms)}
                  suffix={pipeline.ingestionLatencyMs?.p90Ms != null ? "s" : undefined}
                />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title={t("quality.pipeline.outboxOldest", { defaultValue: "Outbox oldest" })}
                  value={pipeline.outbox?.oldestAgeMinutes ?? undefined}
                  suffix={pipeline.outbox?.oldestAgeMinutes != null ? "m" : undefined}
                />
              </Col>
            </Row>
          ) : (
            <Typography.Text type="secondary">{t("common.empty", { defaultValue: "Empty" })}</Typography.Text>
          )}
        </Card>

        <Card className="content-card" title={t("quality.pipeline.failures", { defaultValue: "Top Failures" })} loading={loading}>
          <Table
            rowKey={(row) => `${row.stage}:${row.errorName}`}
            columns={failureColumns}
            dataSource={pipeline?.failureTypes ?? []}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            size={screens.md ? "middle" : "small"}
          />
        </Card>

        <Card className="content-card" title={t("quality.sources.title", { defaultValue: "Source Reliability" })} loading={loading}>
          {sources ? (
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <Row gutter={[16, 16]}>
                <Col xs={12} md={6}>
                  <Statistic title={t("quality.sources.total", { defaultValue: "Total sources" })} value={sources.totals.total} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title={t("quality.sources.active", { defaultValue: "Active" })} value={sources.totals.active} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title={t("quality.sources.failing", { defaultValue: "Failing" })} value={sources.totals.failing} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title={t("quality.sources.circuitOpen", { defaultValue: "Circuit open" })} value={sources.totals.circuitOpen} />
                </Col>
              </Row>
              <Table
                rowKey="sourceId"
                columns={sourceColumns}
                dataSource={sources.topFailingSources}
                pagination={{ pageSize: 5, showSizeChanger: false }}
                size={screens.md ? "middle" : "small"}
              />
            </Space>
          ) : (
            <Typography.Text type="secondary">{t("common.empty", { defaultValue: "Empty" })}</Typography.Text>
          )}
        </Card>
      </div>
    </>
  );
}
