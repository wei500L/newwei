"use client";

import { Card, Col, Empty, List, Row, Spin, Statistic, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { QueueChart } from "./queue-chart";

interface DashboardContentProps {
  accessToken: string;
}

interface DashboardStats {
  itemCount: number;
  processedCount: number;
  queue: Record<string, number>;
  recentQueueLogs: Array<{
    _id: string;
    jobId: string;
    stage: string;
    status: string;
    createdAt: string;
    message?: string;
  }>;
}

export function DashboardContent({ accessToken }: DashboardContentProps) {
  const { data, isLoading, error } = useQuery<DashboardStats>({
    queryKey: ["dashboard", "stats"],
    queryFn: async () => {
      const client = createApiClient({ accessToken });
      const response = await client.get<DashboardStats>("/dashboard/stats");
      return response.data;
    }
  });

  if (isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error || !data) {
    return <Empty description="Unable to load dashboard metrics" />;
  }

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card">
            <Statistic title="Total Items" value={data.itemCount} />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card">
            <Statistic title="Processed Items" value={data.processedCount} />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={8}>
          <Card className="content-card" title="Queue Snapshot">
            <QueueChart data={data.queue} />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} md={12}>
          <Card title="Recent Queue Activity" className="content-card">
            <List
              rowKey={(item) => item._id}
              dataSource={data.recentQueueLogs}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={`${item.stage.toUpperCase()} • ${item.status}`}
                    description={
                      <Typography.Text type="secondary">
                        {new Date(item.createdAt).toLocaleString()} — Job {item.jobId}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
            {data.recentQueueLogs.length === 0 && <Empty description="No recent queue logs" />}
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
