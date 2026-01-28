"use client";

import { Alert, Button, Card, Col, DatePicker, Grid, List, Row, Select, Space, Spin, Statistic, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs, { toUtcIsoString } from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

type ExceptionEventKind = "http" | "graphql" | "unknown";
type ExceptionEventKindFilter = ExceptionEventKind | "all";

const { RangePicker } = DatePicker;

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

interface ExceptionEventStats {
  total: number;
  byKind: { kind: ExceptionEventKind; count: number }[];
  byDay: { date: string; count: number }[];
}

function renderKind(
  kind: ExceptionEventKind,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (kind === "http") {
    return <Tag color="blue">{t("errors.kinds.http")}</Tag>;
  }
  if (kind === "graphql") {
    return <Tag color="purple">{t("errors.kinds.graphql")}</Tag>;
  }
  return <Tag>{t("errors.kinds.unknown")}</Tag>;
}

function getLocation(event: ExceptionEvent, emptyLabel: string) {
  if (event.kind === "http") {
    const method = event.method ?? "";
    const path = event.path ?? "";
    return `${method} ${path}`.trim() || emptyLabel;
  }
  if (event.kind === "graphql") {
    const op = event.operation ?? "";
    const name = event.operationName ? ` (${event.operationName})` : "";
    return (op ? `${op}${name}` : name).trim() || emptyLabel;
  }
  return emptyLabel;
}

export function ErrorsContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const canView = session?.permissions?.includes("settings.manage") ?? false;
  const [loading, setLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [events, setEvents] = useState<ExceptionEvent[]>([]);
  const [stats, setStats] = useState<ExceptionEventStats | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const screens = Grid.useBreakpoint();
  const [filters, setFilters] = useState<{
    kind: ExceptionEventKindFilter;
    dateRange: [Dayjs, Dayjs] | null;
  }>({ kind: "all", dateRange: null });

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const queryParams = useMemo(() => {
    const params: Record<string, string> = {};
    if (filters.kind !== "all") {
      params.kind = filters.kind;
    }
    if (filters.dateRange) {
      const [start, end] = filters.dateRange;
      params.start = toUtcIsoString(dayjs(start).startOf("day"));
      params.end = toUtcIsoString(dayjs(end).endOf("day"));
    }
    return params;
  }, [filters]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<ListExceptionEventsResponse>("admin/errors", {
        params: { limit: 100, offset: 0, ...queryParams }
      });
      setEvents(response.data.items ?? []);
    } catch (error) {
      captureClientError("Failed to load error events", error);
      setErrorMessage(t("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, queryParams, t]);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const response = await apiClient.get<ExceptionEventStats>("admin/errors/stats", {
        params: queryParams
      });
      setStats(response.data);
    } catch (error) {
      captureClientError("Failed to load error stats", error);
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, [apiClient, queryParams]);

  useEffect(() => {
    if (canView) {
      void fetchEvents();
      void fetchStats();
    }
  }, [canView, fetchEvents, fetchStats]);

  const statsByKind = useMemo(() => {
    const map = new Map(stats?.byKind?.map((item) => [item.kind, item.count]));
    return {
      total: stats?.total ?? 0,
      http: map.get("http") ?? 0,
      graphql: map.get("graphql") ?? 0,
      unknown: map.get("unknown") ?? 0
    };
  }, [stats]);

  const dailyStats = useMemo(() => {
    return stats?.byDay ?? [];
  }, [stats]);

  const handleRangeChange = (range: [Dayjs, Dayjs] | null) => {
    const normalized =
      Array.isArray(range) && range.length === 2 ? range : null;
    setFilters((prev) => ({ ...prev, dateRange: normalized }));
  };

  const handleKindChange = (value: ExceptionEventKindFilter) => {
    setFilters((prev) => ({ ...prev, kind: value }));
  };

  const handleReset = () => {
    setFilters({ kind: "all", dateRange: null });
  };

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("errors.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("errors.adminOnly")}
        />
      </Card>
    );
  }

  const columns: ColumnsType<ExceptionEvent> = [
    {
      title: t("errors.columns.time"),
      dataIndex: "timestamp",
      key: "timestamp",
      width: 180,
      render: (value: string) =>
        value
          ? formatDateTime(value, locale, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false
            })
          : t("common.emptyValue")
    },
    {
      title: t("errors.columns.kind"),
      dataIndex: "kind",
      key: "kind",
      width: 110,
      render: (value: ExceptionEventKind) => renderKind(value, t)
    },
    {
      title: t("errors.columns.status"),
      dataIndex: "statusCode",
      key: "statusCode",
      width: 90,
      render: (value?: number) => (value ? String(value) : t("common.emptyValue"))
    },
    {
      title: t("errors.columns.traceId"),
      dataIndex: "traceId",
      key: "traceId",
      width: 260,
      render: (value: string) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          t("common.emptyValue")
        )
    },
    {
      title: t("errors.columns.location"),
      key: "location",
      render: (_, record) => (
        <Typography.Text>{getLocation(record, t("common.emptyValue"))}</Typography.Text>
      )
    },
    {
      title: t("errors.columns.message"),
      dataIndex: "message",
      key: "message",
      render: (value: string) => <Typography.Text>{value || t("common.emptyValue")}</Typography.Text>
    }
  ];

  return (
    <Card
      className="content-card"
      title={t("errors.title")}
      extra={
        <Button
          onClick={() => {
            void fetchEvents();
            void fetchStats();
          }}
          loading={loading}
        >
          {t("common.refresh")}
        </Button>
      }
    >
      {contextHolder}
      <Typography.Paragraph type="secondary">
        {t("errors.description")}
      </Typography.Paragraph>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space wrap size="middle" align="center">
          <Space direction="vertical" size={4}>
            <Typography.Text type="secondary">{t("errors.filters.timeRange")}</Typography.Text>
            <RangePicker
              id={{ start: "admin-errors-start", end: "admin-errors-end" }}
              value={filters.dateRange}
              onChange={(value) => handleRangeChange(value as [Dayjs, Dayjs] | null)}
              allowClear
            />
          </Space>
          <Space direction="vertical" size={4}>
            <Typography.Text type="secondary">{t("errors.filters.kind")}</Typography.Text>
            <Select
              value={filters.kind}
              style={{ minWidth: 180 }}
              onChange={handleKindChange}
              options={[
                { value: "all", label: t("errors.filters.kindAll") },
                { value: "http", label: t("errors.kinds.http") },
                { value: "graphql", label: t("errors.kinds.graphql") },
                { value: "unknown", label: t("errors.kinds.unknown") }
              ]}
            />
          </Space>
          <Button onClick={handleReset}>{t("common.reset")}</Button>
        </Space>
        <Spin spinning={statsLoading}>
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={6}>
              <Statistic title={t("errors.stats.total")} value={statsByKind.total} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title={t("errors.stats.http")} value={statsByKind.http} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title={t("errors.stats.graphql")} value={statsByKind.graphql} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title={t("errors.stats.unknown")} value={statsByKind.unknown} />
            </Col>
          </Row>
        </Spin>
        {dailyStats.length > 0 ? (
          <Space direction="vertical" size="small">
            <Typography.Text type="secondary">{t("errors.stats.daily")}</Typography.Text>
            <Table
              rowKey={(record) => record.date}
              size="small"
              pagination={false}
              dataSource={dailyStats}
              columns={[
                {
                  title: t("errors.stats.date"),
                  dataIndex: "date",
                  key: "date",
                  render: (value: string) =>
                    formatDateTime(`${value}T00:00:00Z`, locale, {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit"
                    })
                },
                {
                  title: t("errors.stats.count"),
                  dataIndex: "count",
                  key: "count"
                }
              ]}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">{t("errors.stats.empty")}</Typography.Text>
        )}
      </Space>
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
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}
      {!screens.md ? (
        <List
          dataSource={events}
          loading={loading}
          pagination={{ pageSize: 20, align: "center" }}
          renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    {renderKind(item.kind, t)}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatDateTime(item.timestamp, locale, {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Typography.Text>
                  </Space>
                }
                description={
                  <Space direction="vertical" size={0} className="w-full mt-2">
                    <Typography.Text strong>
                      {getLocation(item, t("common.emptyValue"))}
                    </Typography.Text>
                    {item.statusCode && (
                      <Tag>{t("errors.columns.status")}: {item.statusCode}</Tag>
                    )}
                    <Typography.Text className="line-clamp-2">
                      {item.message || t("common.emptyValue")}
                    </Typography.Text>
                    {item.traceId && (
                      <Typography.Text type="secondary" copyable className="text-xs">
                        {item.traceId}
                      </Typography.Text>
                    )}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      ) : (
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
                <Typography.Text type="secondary">{t("errors.noStack")}</Typography.Text>
              )
          }}
        />
      )}
    </Card>
  );
}
