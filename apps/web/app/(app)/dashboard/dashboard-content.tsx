"use client";

import { Card, Col, Empty, List, Row, Spin, Statistic, Typography } from "antd";
import { useQueueStatsQuery } from "@/graphql/generated";
import { QueueChart } from "./queue-chart";

export function DashboardContent() {
  const { data, loading, error } = useQueueStatsQuery();

  if (loading) {
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
    </div>
  );
}
