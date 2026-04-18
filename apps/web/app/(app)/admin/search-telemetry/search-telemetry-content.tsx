"use client";

import { Alert, Card, Col, DatePicker, Row, Select, Space, Statistic, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";

type SearchTelemetrySurface = "all" | "search_page" | "events_archive";

interface SearchTelemetryDailyPoint {
  date: string;
  totalEvents: number;
  events: Record<string, number>;
  surfaces: Record<string, number>;
}

interface SearchTelemetrySummaryResponse {
  from: string;
  to: string;
  surface: SearchTelemetrySurface;
  totals: {
    totalEvents: number;
    eventCounts: Record<string, number>;
    surfaceCounts: Record<string, number>;
    queryLengthBuckets: Record<string, number>;
    loadMoreVerticalCounts: Record<string, number>;
  };
  daily: SearchTelemetryDailyPoint[];
}

const { RangePicker } = DatePicker;

const EMPTY_SUMMARY: SearchTelemetrySummaryResponse = {
  from: "",
  to: "",
  surface: "all",
  totals: {
    totalEvents: 0,
    eventCounts: {},
    surfaceCounts: {},
    queryLengthBuckets: {},
    loadMoreVerticalCounts: {},
  },
  daily: [],
};

function resolveDefaultRange() {
  const today = new Date();
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 6);
  return [dayjs(from), dayjs(to)] as [Dayjs, Dayjs];
}

export function SearchTelemetryContent() {
  const { t } = useTranslation();
  const chartTheme = useChartTheme();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageSettings = permissions.includes("settings.manage");
  const [summary, setSummary] = useState<SearchTelemetrySummaryResponse>(EMPTY_SUMMARY);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(resolveDefaultRange);
  const [surface, setSurface] = useState<SearchTelemetrySurface>("all");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadSummary = useCallback(async () => {
    if (!canManageSettings) {
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<SearchTelemetrySummaryResponse>(
        "admin/search-telemetry/summary",
        {
          params: {
            from: range[0].format("YYYY-MM-DD"),
            to: range[1].format("YYYY-MM-DD"),
            ...(surface !== "all" ? { surface } : {}),
          },
        },
      );
      setSummary(response.data ?? EMPTY_SUMMARY);
    } catch (error) {
      captureClientError("Failed to load search telemetry summary", error);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("admin.searchTelemetry.errors.loadFailed", {
              defaultValue: "Failed to load search telemetry.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, canManageSettings, range, surface, t]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const dailyTrendOption = useMemo<EChartsOption | null>(() => {
    if (summary.daily.length === 0) {
      return null;
    }
    return {
      tooltip: { trigger: "axis" },
      legend: {
        textStyle: { color: chartTheme.colors.foreground },
      },
      grid: { left: 24, right: 16, top: 36, bottom: 24, containLabel: true },
      xAxis: {
        type: "category",
        data: summary.daily.map((row) => row.date),
        axisLabel: { color: chartTheme.colors.foreground },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartTheme.colors.foreground },
        splitLine: { lineStyle: { color: chartTheme.colors.grid } },
      },
      series: [
        {
          type: "line",
          name: t("admin.searchTelemetry.chart.total", {
            defaultValue: "Total events",
          }),
          smooth: true,
          lineStyle: { width: 3, color: chartTheme.colors.primary },
          itemStyle: { color: chartTheme.colors.primary },
          areaStyle: { color: "rgba(31, 59, 123, 0.12)" },
          data: summary.daily.map((row) => row.totalEvents),
        },
        {
          type: "line",
          name: t("admin.searchTelemetry.chart.loadMore", {
            defaultValue: "Load more",
          }),
          smooth: true,
          lineStyle: { width: 2, color: chartTheme.colors.accent },
          itemStyle: { color: chartTheme.colors.accent },
          data: summary.daily.map(
            (row) => row.events.archive_load_more_click ?? 0,
          ),
        },
      ],
    };
  }, [chartTheme.colors, summary.daily, t]);

  const eventRows = useMemo(
    () =>
      Object.entries(summary.totals.eventCounts).map(([key, count]) => ({
        key,
        count,
      })),
    [summary.totals.eventCounts],
  );
  const surfaceRows = useMemo(
    () =>
      Object.entries(summary.totals.surfaceCounts).map(([key, count]) => ({
        key,
        count,
      })),
    [summary.totals.surfaceCounts],
  );
  const queryLengthRows = useMemo(
    () =>
      Object.entries(summary.totals.queryLengthBuckets)
        .map(([bucket, count]) => ({ bucket, count }))
        .sort((left, right) => left.bucket.localeCompare(right.bucket)),
    [summary.totals.queryLengthBuckets],
  );
  const verticalRows = useMemo(
    () =>
      Object.entries(summary.totals.loadMoreVerticalCounts)
        .map(([vertical, count]) => ({ vertical, count }))
        .sort((left, right) => right.count - left.count),
    [summary.totals.loadMoreVerticalCounts],
  );

  const eventColumns: ColumnsType<{ key: string; count: number }> = [
    {
      title: t("admin.searchTelemetry.columns.event", { defaultValue: "Event" }),
      dataIndex: "key",
      key: "key",
    },
    {
      title: t("admin.searchTelemetry.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
    },
  ];

  const pairColumns: ColumnsType<{ key: string; count: number }> = [
    {
      title: t("admin.searchTelemetry.columns.surface", {
        defaultValue: "Surface",
      }),
      dataIndex: "key",
      key: "key",
    },
    {
      title: t("admin.searchTelemetry.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
    },
  ];

  if (status === "loading") {
    return <Card loading className="content-card" />;
  }

  if (!canManageSettings) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t("admin.searchTelemetry.permissions", {
          defaultValue: "Search telemetry is restricted to administrators.",
        })}
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card className="content-card">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Typography.Title level={4} style={{ marginBottom: 8 }}>
              {t("admin.searchTelemetry.title", {
                defaultValue: "Search Telemetry",
              })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("admin.searchTelemetry.description", {
                defaultValue:
                  "Inspect archive search submissions, short-query friction, and load-more usage over time.",
              })}
            </Typography.Text>
          </div>

          <Space wrap>
            <RangePicker
              value={range}
              allowClear={false}
              onChange={(values) => {
                if (!values?.[0] || !values?.[1]) {
                  return;
                }
                const nextRange = [values[0], values[1]] as [Dayjs, Dayjs];
                const diffDays =
                  nextRange[1].startOf("day").diff(nextRange[0].startOf("day"), "day") +
                  1;
                if (diffDays > 31) {
                  return;
                }
                setRange(nextRange);
              }}
            />
            <Select<SearchTelemetrySurface>
              value={surface}
              onChange={setSurface}
              style={{ minWidth: 220 }}
              options={[
                {
                  value: "all",
                  label: t("admin.searchTelemetry.filters.allSurfaces", {
                    defaultValue: "All surfaces",
                  }),
                },
                { value: "search_page", label: "search_page" },
                { value: "events_archive", label: "events_archive" },
              ]}
            />
          </Space>

          {errorMessage ? (
            <Alert type="error" showIcon message={errorMessage} />
          ) : null}

          <Row gutter={[16, 16]}>
            <Col xs={24} md={8}>
              <Card>
                <Statistic
                  title={t("admin.searchTelemetry.metrics.totalEvents", {
                    defaultValue: "Total events",
                  })}
                  value={summary.totals.totalEvents}
                  loading={loading}
                />
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card>
                <Statistic
                  title={t("admin.searchTelemetry.metrics.activeDays", {
                    defaultValue: "Tracked days",
                  })}
                  value={summary.daily.length}
                  loading={loading}
                />
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card>
                <Statistic
                  title={t("admin.searchTelemetry.metrics.averageDaily", {
                    defaultValue: "Avg events / day",
                  })}
                  value={
                    summary.daily.length > 0
                      ? (summary.totals.totalEvents / summary.daily.length).toFixed(1)
                      : 0
                  }
                  loading={loading}
                />
              </Card>
            </Col>
          </Row>
        </Space>
      </Card>

      <Card
        className="content-card"
        title={t("admin.searchTelemetry.chart.title", {
          defaultValue: "Daily trend",
        })}
      >
        {dailyTrendOption ? (
          <DashboardChart
            option={dailyTrendOption}
            theme={chartTheme.echartsTheme}
            height={320}
          />
        ) : (
          <Alert
            type="info"
            showIcon
            message={t("admin.searchTelemetry.chart.empty", {
              defaultValue: "No daily telemetry rows for the selected range.",
            })}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={t("admin.searchTelemetry.tables.events", {
              defaultValue: "Event totals",
            })}
          >
            <Table
              size="small"
              pagination={false}
              columns={eventColumns}
              dataSource={eventRows}
              rowKey="key"
              loading={loading}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={t("admin.searchTelemetry.tables.surfaces", {
              defaultValue: "Surface totals",
            })}
          >
            <Table
              size="small"
              pagination={false}
              columns={pairColumns}
              dataSource={surfaceRows}
              rowKey="key"
              loading={loading}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={t("admin.searchTelemetry.tables.queryLength", {
              defaultValue: "Query length buckets",
            })}
          >
            <Table
              size="small"
              pagination={false}
              columns={[
                {
                  title: t("admin.searchTelemetry.columns.bucket", {
                    defaultValue: "Bucket",
                  }),
                  dataIndex: "bucket",
                  key: "bucket",
                },
                {
                  title: t("admin.searchTelemetry.columns.count", {
                    defaultValue: "Count",
                  }),
                  dataIndex: "count",
                  key: "count",
                },
              ]}
              dataSource={queryLengthRows}
              rowKey="bucket"
              loading={loading}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={t("admin.searchTelemetry.tables.verticals", {
              defaultValue: "Load-more verticals",
            })}
          >
            <Table
              size="small"
              pagination={false}
              columns={[
                {
                  title: t("admin.searchTelemetry.columns.vertical", {
                    defaultValue: "Vertical",
                  }),
                  dataIndex: "vertical",
                  key: "vertical",
                },
                {
                  title: t("admin.searchTelemetry.columns.count", {
                    defaultValue: "Count",
                  }),
                  dataIndex: "count",
                  key: "count",
                },
              ]}
              dataSource={verticalRows}
              rowKey="vertical"
              loading={loading}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
