"use client";

import { Card, Col, Empty, List, Row, Spin, Statistic, Typography, message, Select, Space, Button } from "antd";
import { useEffect, useState } from "react";
import { useDashboardsQuery, useQueueStatsQuery, useUpsertDashboardMutation, useDeleteDashboardMutation } from "@/graphql/generated";
import { QueueChart } from "./queue-chart";
import { DashboardEditor } from "./dashboard-editor";
import { AlertPanel } from "./alert-panel";
import { AnalysisPanel } from "./analysis-panel";
import { DrilldownChart } from "./drilldown-chart";
import { AlertConfigForm } from "./alert-config-form";
import { LiveAlertsToasts } from "./live-alerts";
import { useDashboardRangeStore } from "@/store/time-range";

export function DashboardContent() {
  const { data, loading, error } = useQueueStatsQuery();
  const { data: dashboardsData, loading: dashboardsLoading, refetch: refetchDashboards } = useDashboardsQuery();
  const [saveDashboard, { loading: savingDashboard }] = useUpsertDashboardMutation();
  const [deleteDashboard] = useDeleteDashboardMutation();
  const { range, setRange } = useDashboardRangeStore();

  if (loading || dashboardsLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error || !data?.queueStats) {
    return <Empty description="Unable to load dashboard metrics" />;
  }

  const { counts, processedCount, itemCount, recentLogs } = data.queueStats;
  const dashboards = dashboardsData?.dashboards ?? [];
  const [activeId, setActiveId] = useState<string | undefined>(dashboards[0]?.id);
  const activeDashboard = dashboards.find((d) => d.id === activeId) ?? dashboards[0];

  useEffect(() => {
    if (dashboards.length && !activeId) {
      setActiveId(dashboards[0].id);
    }
  }, [dashboards, activeId]);
  const chartData: Record<string, number> = {
    waiting: counts.waiting,
    active: counts.active,
    completed: counts.completed,
    failed: counts.failed,
    delayed: counts.delayed
  };

  const parsedLogs = recentLogs.map((log) => {
    let parsedPayload: Record<string, unknown> | undefined;
    if (log.data) {
      try {
        parsedPayload = JSON.parse(log.data);
      } catch (err) {
        parsedPayload = undefined;
      }
    }
    return {
      ...log,
      payload: parsedPayload
    };
  });

  return (
    <div>
      <LiveAlertsToasts />
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card">
            <Statistic title="Total Items" value={itemCount} />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card">
            <Statistic title="Processed Items" value={processedCount} />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={8}>
          <Card className="content-card" title="Queue Snapshot">
            <QueueChart data={chartData} />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} md={12}>
          <Card title="Recent Queue Activity" className="content-card">
            <List
              rowKey={(item) => item.jobId}
              dataSource={parsedLogs}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={`${item.event} • ${item.jobId}`}
                    description={
                      <Typography.Text type="secondary">
                        {new Date(item.timestamp).toLocaleString()}
                        {item.payload?.message ? ` — ${item.payload?.message}` : ""}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
            {parsedLogs.length === 0 && <Empty description="No recent queue logs" />}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="Next Actions" className="content-card">
            <Typography.Paragraph>
              Queue jobs are processed through the dedupe → transform → tag → score pipeline. Monitor
              the queue metrics to ensure SLAs are met.
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary">
              TODO: surface anomaly detection and alert routing rules once observability stack is
              integrated.
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
      <Row style={{ marginTop: "2rem" }}>
        <Col span={24}>
          <Card title="Custom Dashboard Editor" className="content-card">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space align="center">
                <Typography.Text type="secondary">
                  Drag and resize widgets, then persist layout through the dashboard GraphQL mutations. Layouts are stored in MySQL.
                </Typography.Text>
                <Select
                  size="small"
                  value={range !== "custom" ? range : undefined}
                  onChange={(val) => setRange(val as any)}
                  options={[
                    { label: "1M", value: "1M" },
                    { label: "3M", value: "3M" },
                    { label: "6M", value: "6M" },
                    { label: "1Y", value: "1Y" }
                  ]}
                  style={{ width: 120 }}
                />
                <Select
                  placeholder="Select dashboard"
                  style={{ minWidth: 220 }}
                  value={activeDashboard?.id}
                  onChange={(val) => setActiveId(val)}
                  options={dashboards.map((d) => ({ label: d.name, value: d.id }))}
                />
                <Button
                  size="small"
                  onClick={() => {
                    setActiveId(undefined);
                  }}
                >
                  New Dashboard
                </Button>
              </Space>
              <DashboardEditor
                dashboard={activeDashboard}
                saving={savingDashboard}
                onSave={async (input) => {
                  await saveDashboard({ variables: { input } });
                  await refetchDashboards();
                  message.success("Dashboard saved");
                }}
                onDelete={
                  activeDashboard?.id
                    ? async (id: string) => {
                        await deleteDashboard({ variables: { id } });
                        await refetchDashboards();
                        message.success("Dashboard deleted");
                        setActiveId(undefined);
                      }
                    : undefined
                }
              />
            </Space>
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={12}>
          <Card title="Smart Alerts" className="content-card">
            <AlertPanel />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="AI Analysis" className="content-card">
            <AnalysisPanel />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={24}>
          <DrilldownChart category="economic-short" title="Economic Drilldown (linked zoom + click to drill)" />
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={24}>
          <Card title="Alert Configuration" className="content-card">
            <AlertConfigForm />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
