"use client";

import { Alert, Button, Card, Spin, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

type ExceptionEventKind = "http" | "graphql" | "unknown";

interface ExceptionEvent {
  id: string;
  kind: ExceptionEventKind;
  traceId: string;
  timestamp: string;
  statusCode?: number;
  message: string;
  path?: string;
  method?: string;
  operation?: string;
  operationName?: string;
  errorName?: string;
  stack?: string;
}

interface ListExceptionEventsResponse {
  total: number;
  items: ExceptionEvent[];
}

function renderKind(kind: ExceptionEventKind) {
  if (kind === "http") {
    return <Tag color="blue">HTTP</Tag>;
  }
  if (kind === "graphql") {
    return <Tag color="purple">GraphQL</Tag>;
  }
  return <Tag>Unknown</Tag>;
}

function getLocation(event: ExceptionEvent) {
  if (event.kind === "http") {
    const method = event.method ?? "";
    const path = event.path ?? "";
    return `${method} ${path}`.trim() || "-";
  }
  if (event.kind === "graphql") {
    const op = event.operation ?? "";
    const name = event.operationName ? ` (${event.operationName})` : "";
    return (op ? `${op}${name}` : name).trim() || "-";
  }
  return "-";
}

export function ErrorsContent() {
  const { data: session, status } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const canView = session?.permissions?.includes("settings.manage") ?? false;
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<ExceptionEvent[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<ListExceptionEventsResponse>("admin/errors", {
        params: { limit: 100, offset: 0 }
      });
      setEvents(response.data.items ?? []);
    } catch (error) {
      captureClientError("Failed to load error events", error);
      setErrorMessage("Failed to load recent errors");
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    if (canView) {
      void fetchEvents();
    }
  }, [canView, fetchEvents]);

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title="Recent Errors">
        <Alert
          type="warning"
          message="Admins only"
          description="Only administrators can view recent error events."
        />
      </Card>
    );
  }

  const columns: ColumnsType<ExceptionEvent> = [
    {
      title: "Time",
      dataIndex: "timestamp",
      key: "timestamp",
      width: 180,
      render: (value: string) => (value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "-")
    },
    {
      title: "Kind",
      dataIndex: "kind",
      key: "kind",
      width: 110,
      render: (value: ExceptionEventKind) => renderKind(value)
    },
    {
      title: "Status",
      dataIndex: "statusCode",
      key: "statusCode",
      width: 90,
      render: (value?: number) => (value ? String(value) : "-")
    },
    {
      title: "Trace ID",
      dataIndex: "traceId",
      key: "traceId",
      width: 260,
      render: (value: string) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          "-"
        )
    },
    {
      title: "Location",
      key: "location",
      render: (_, record) => <Typography.Text>{getLocation(record)}</Typography.Text>
    },
    {
      title: "Message",
      dataIndex: "message",
      key: "message",
      render: (value: string) => <Typography.Text>{value || "-"}</Typography.Text>
    }
  ];

  return (
    <Card
      className="content-card"
      title="Recent Errors"
      extra={
        <Button onClick={() => void fetchEvents()} loading={loading}>
          Refresh
        </Button>
      }
    >
      {contextHolder}
      <Typography.Paragraph type="secondary">
        Shows recent HTTP and GraphQL exceptions captured by the API. Use the Trace ID to correlate
        logs and traces.
      </Typography.Paragraph>
      {errorMessage ? (
        <Alert
          type="error"
          message={errorMessage}
          showIcon
          action={
            <Button
              size="small"
              onClick={() => {
                messageApi.destroy();
                void fetchEvents();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : null}
      <Table
        rowKey="id"
        style={{ marginTop: "1rem" }}
        loading={loading}
        columns={columns}
        dataSource={events}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        expandable={{
          expandedRowRender: (record) =>
            record.stack ? (
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{record.stack}</pre>
            ) : (
              <Typography.Text type="secondary">No stack trace recorded.</Typography.Text>
            )
        }}
      />
    </Card>
  );
}
