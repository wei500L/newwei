"use client";

import { Alert, Button, Col, Row, Select, Space, Statistic, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { FilterBar } from "@/components/filter-bar";
import { SectionHeader } from "@/components/section-header";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import { RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS } from "@/lib/rss-translation";

type RssTranslationProvider = "deeplx" | "llm";
type ProviderFilter = "all" | RssTranslationProvider;
type TargetLanguageFilter = "all" | string;

interface RssTranslationMetricsDailyRow {
  date: string;
  provider: RssTranslationProvider;
  targetLanguage: string;
  requestCount: number;
  itemCount: number;
  textCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  translatedCount: number;
  failureCount: number;
  skipTooLongCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  cacheHitRate: number;
  failureRate: number;
}

interface RssTranslationMetricsSummary {
  requestCount: number;
  itemCount: number;
  textCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  translatedCount: number;
  failureCount: number;
  skipTooLongCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  cacheHitRate: number;
  failureRate: number;
}

interface RssTranslationMetricsResponse {
  from: string;
  to: string;
  rows: RssTranslationMetricsDailyRow[];
  summary: RssTranslationMetricsSummary;
}

interface DailyTrendRow {
  date: string;
  requestCount: number;
  translatedCount: number;
  cacheHitRate: number;
  failureRate: number;
  avgLatencyMs: number;
}

const EMPTY_SUMMARY: RssTranslationMetricsSummary = {
  requestCount: 0,
  itemCount: 0,
  textCount: 0,
  cacheHitCount: 0,
  cacheMissCount: 0,
  translatedCount: 0,
  failureCount: 0,
  skipTooLongCount: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
  avgLatencyMs: 0,
  cacheHitRate: 0,
  failureRate: 0
};

const EMPTY_METRICS: RssTranslationMetricsResponse = {
  from: "",
  to: "",
  rows: [],
  summary: EMPTY_SUMMARY
};

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveDateRange(days: number): { from: string; to: string } {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - Math.max(0, days - 1));
  return {
    from: formatUtcDate(from),
    to: formatUtcDate(to)
  };
}

function formatPercent(value: number): string {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(1)}%`;
}

function normalizeResponse(
  payload: RssTranslationMetricsResponse | null | undefined
): RssTranslationMetricsResponse {
  if (!payload) {
    return EMPTY_METRICS;
  }

  return {
    from: payload.from ?? "",
    to: payload.to ?? "",
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    summary: {
      ...EMPTY_SUMMARY,
      ...(payload.summary ?? {})
    }
  };
}

export function RssTranslationMetricsPanel() {
  const { t } = useTranslation();
  const { echartsTheme, colors } = useChartTheme();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [days, setDays] = useState<number>(14);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [targetLanguageFilter, setTargetLanguageFilter] = useState<TargetLanguageFilter>("all");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<RssTranslationMetricsResponse>(EMPTY_METRICS);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const range = resolveDateRange(days);
      const params: Record<string, string> = {
        from: range.from,
        to: range.to
      };
      if (providerFilter !== "all") {
        params.provider = providerFilter;
      }
      if (targetLanguageFilter !== "all") {
        params.targetLanguage = targetLanguageFilter;
      }

      const response = await apiClient.get<RssTranslationMetricsResponse>("system-settings/rss-translation/metrics", {
        params
      });
      setMetrics(normalizeResponse(response.data));
    } catch (error) {
      captureClientError("Failed to load RSS translation metrics", error);
      const messageText =
        extractApiError(error).message ||
        t("settings.rssTranslationMetrics.errors.loadFailed");
      setErrorMessage(messageText);
      messageApi.error(messageText);
    } finally {
      setLoading(false);
    }
  }, [apiClient, days, messageApi, providerFilter, targetLanguageFilter, t]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const dailyTrend = useMemo<DailyTrendRow[]>(() => {
    const byDate = new Map<
      string,
      {
        requestCount: number;
        translatedCount: number;
        totalLatencyMs: number;
        cacheHitCount: number;
        cacheMissCount: number;
        failureCount: number;
      }
    >();
    for (const row of metrics.rows) {
      const current = byDate.get(row.date) ?? {
        requestCount: 0,
        translatedCount: 0,
        totalLatencyMs: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
        failureCount: 0
      };
      current.requestCount += row.requestCount;
      current.translatedCount += row.translatedCount;
      current.totalLatencyMs += row.totalLatencyMs;
      current.cacheHitCount += row.cacheHitCount;
      current.cacheMissCount += row.cacheMissCount;
      current.failureCount += row.failureCount;
      byDate.set(row.date, current);
    }

    return Array.from(byDate.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, value]) => {
        const cacheTotal = value.cacheHitCount + value.cacheMissCount;
        return {
          date,
          requestCount: value.requestCount,
          translatedCount: value.translatedCount,
          cacheHitRate: cacheTotal > 0 ? value.cacheHitCount / cacheTotal : 0,
          failureRate: value.requestCount > 0 ? value.failureCount / value.requestCount : 0,
          avgLatencyMs: value.requestCount > 0 ? Math.round(value.totalLatencyMs / value.requestCount) : 0
        };
      });
  }, [metrics.rows]);

  const volumeChartOption = useMemo<EChartsOption | null>(() => {
    if (dailyTrend.length === 0) {
      return null;
    }

    return {
      tooltip: { trigger: "axis" },
      legend: {
        data: [
          t("settings.rssTranslationMetrics.charts.series.requests"),
          t("settings.rssTranslationMetrics.charts.series.translated")
        ]
      },
      grid: { top: 42, left: 24, right: 24, bottom: 24, containLabel: true },
      xAxis: {
        type: "category",
        data: dailyTrend.map((item) => item.date),
        axisLabel: { color: colors.foreground }
      },
      yAxis: {
        type: "value",
        splitLine: {
          lineStyle: {
            color: colors.grid,
            type: "dashed"
          }
        }
      },
      series: [
        {
          type: "bar",
          name: t("settings.rssTranslationMetrics.charts.series.requests"),
          data: dailyTrend.map((item) => item.requestCount),
          itemStyle: { color: colors.primary }
        },
        {
          type: "line",
          smooth: true,
          name: t("settings.rssTranslationMetrics.charts.series.translated"),
          data: dailyTrend.map((item) => item.translatedCount),
          itemStyle: { color: colors.bullish }
        }
      ]
    };
  }, [colors.bullish, colors.foreground, colors.grid, colors.primary, dailyTrend, t]);

  const qualityChartOption = useMemo<EChartsOption | null>(() => {
    if (dailyTrend.length === 0) {
      return null;
    }

    return {
      tooltip: { trigger: "axis" },
      legend: {
        data: [
          t("settings.rssTranslationMetrics.charts.series.cacheHitRate"),
          t("settings.rssTranslationMetrics.charts.series.failureRate"),
          t("settings.rssTranslationMetrics.charts.series.avgLatency")
        ]
      },
      grid: { top: 42, left: 24, right: 24, bottom: 24, containLabel: true },
      xAxis: {
        type: "category",
        data: dailyTrend.map((item) => item.date),
        axisLabel: { color: colors.foreground }
      },
      yAxis: [
        {
          type: "value",
          min: 0,
          max: 100,
          axisLabel: { formatter: "{value}%" },
          splitLine: {
            lineStyle: {
              color: colors.grid,
              type: "dashed"
            }
          }
        },
        {
          type: "value",
          axisLabel: { formatter: "{value}ms" },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          type: "line",
          smooth: true,
          name: t("settings.rssTranslationMetrics.charts.series.cacheHitRate"),
          data: dailyTrend.map((item) => Number((item.cacheHitRate * 100).toFixed(2))),
          itemStyle: { color: colors.bullish }
        },
        {
          type: "line",
          smooth: true,
          name: t("settings.rssTranslationMetrics.charts.series.failureRate"),
          data: dailyTrend.map((item) => Number((item.failureRate * 100).toFixed(2))),
          itemStyle: { color: colors.destructive }
        },
        {
          type: "line",
          smooth: true,
          yAxisIndex: 1,
          name: t("settings.rssTranslationMetrics.charts.series.avgLatency"),
          data: dailyTrend.map((item) => item.avgLatencyMs),
          itemStyle: { color: colors.accent }
        }
      ]
    };
  }, [colors.accent, colors.bullish, colors.destructive, colors.foreground, colors.grid, dailyTrend, t]);

  const columns = useMemo<ColumnsType<RssTranslationMetricsDailyRow>>(
    () => [
      {
        title: t("settings.rssTranslationMetrics.table.columns.date"),
        dataIndex: "date",
        key: "date",
        width: 110,
        fixed: "left"
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.provider"),
        dataIndex: "provider",
        key: "provider",
        width: 110,
        render: (value: RssTranslationProvider) => (
          <Tag>{value.toUpperCase()}</Tag>
        )
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.targetLanguage"),
        dataIndex: "targetLanguage",
        key: "targetLanguage",
        width: 100
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.requestCount"),
        dataIndex: "requestCount",
        key: "requestCount",
        width: 110
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.textCount"),
        dataIndex: "textCount",
        key: "textCount",
        width: 100
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.translatedCount"),
        dataIndex: "translatedCount",
        key: "translatedCount",
        width: 110
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.cacheHitRate"),
        dataIndex: "cacheHitRate",
        key: "cacheHitRate",
        width: 130,
        render: (value: number) => `${(value * 100).toFixed(1)}%`
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.failureRate"),
        dataIndex: "failureRate",
        key: "failureRate",
        width: 120,
        render: (value: number) => `${(value * 100).toFixed(1)}%`
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.avgLatencyMs"),
        dataIndex: "avgLatencyMs",
        key: "avgLatencyMs",
        width: 120,
        render: (value: number) => `${value}ms`
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.maxLatencyMs"),
        dataIndex: "maxLatencyMs",
        key: "maxLatencyMs",
        width: 120,
        render: (value: number) => `${value}ms`
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.failureCount"),
        dataIndex: "failureCount",
        key: "failureCount",
        width: 100
      },
      {
        title: t("settings.rssTranslationMetrics.table.columns.skipTooLongCount"),
        dataIndex: "skipTooLongCount",
        key: "skipTooLongCount",
        width: 160
      }
    ],
    [t]
  );

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <section className="flex flex-col gap-3">
        <FilterBar
          actions={
            <Button onClick={() => void loadMetrics()} loading={loading}>
              {t("common.refresh")}
            </Button>
          }
        >
          <FilterBar.Item width="sm">
            <Select
              className="w-full"
              value={days}
              options={[
                { value: 7, label: t("settings.rssTranslationMetrics.filters.lastDays", { days: 7 }) },
                { value: 14, label: t("settings.rssTranslationMetrics.filters.lastDays", { days: 14 }) },
                { value: 30, label: t("settings.rssTranslationMetrics.filters.lastDays", { days: 30 }) }
              ]}
              onChange={(value) => setDays(Number(value))}
            />
          </FilterBar.Item>
          <FilterBar.Item width="md">
            <Select
              className="w-full"
              value={providerFilter}
              onChange={(value) => setProviderFilter(value as ProviderFilter)}
              options={[
                { value: "all", label: t("settings.rssTranslationMetrics.filters.providers.all") },
                { value: "deeplx", label: t("settings.rssTranslationMetrics.filters.providers.deeplx") },
                { value: "llm", label: t("settings.rssTranslationMetrics.filters.providers.llm") }
              ]}
            />
          </FilterBar.Item>
          <FilterBar.Item width="lg">
            <Select
              className="w-full"
              value={targetLanguageFilter}
              onChange={(value) => setTargetLanguageFilter(String(value))}
              options={[
                { value: "all", label: t("settings.rssTranslationMetrics.filters.languages.all") },
                ...RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))
              ]}
            />
          </FilterBar.Item>
        </FilterBar>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {errorMessage ? <Alert type="error" showIcon message={errorMessage} /> : null}

          <Space wrap>
            <Tag color="default">
              {t("settings.rssTranslationMetrics.window", {
                from: metrics.from || "-",
                to: metrics.to || "-"
              })}
            </Tag>
          </Space>

          <Row gutter={[12, 12]}>
            <Col xs={24} sm={12} md={8} xl={6}>
              <Statistic
                title={t("settings.rssTranslationMetrics.summary.requestCount")}
                value={metrics.summary.requestCount}
              />
            </Col>
            <Col xs={24} sm={12} md={8} xl={6}>
              <Statistic
                title={t("settings.rssTranslationMetrics.summary.translatedCount")}
                value={metrics.summary.translatedCount}
              />
            </Col>
            <Col xs={24} sm={12} md={8} xl={6}>
              <Statistic
                title={t("settings.rssTranslationMetrics.summary.cacheHitRate")}
                value={Number((metrics.summary.cacheHitRate * 100).toFixed(2))}
                suffix="%"
              />
            </Col>
            <Col xs={24} sm={12} md={8} xl={6}>
              <Statistic
                title={t("settings.rssTranslationMetrics.summary.failureRate")}
                value={Number((metrics.summary.failureRate * 100).toFixed(2))}
                suffix="%"
              />
            </Col>
            <Col xs={24} sm={12} md={8} xl={6}>
              <Statistic
                title={t("settings.rssTranslationMetrics.summary.avgLatencyMs")}
                value={metrics.summary.avgLatencyMs}
                suffix="ms"
              />
            </Col>
            <Col xs={24} sm={12} md={8} xl={6}>
              <Statistic
                title={t("settings.rssTranslationMetrics.summary.maxLatencyMs")}
                value={metrics.summary.maxLatencyMs}
                suffix="ms"
              />
            </Col>
          </Row>

          <Row gutter={[12, 12]}>
            <Col xs={24} xl={12}>
              <div className="surface-inset flex flex-col gap-2">
                <p className="kicker m-0">
                  {t("settings.rssTranslationMetrics.charts.volume")}
                </p>
                {volumeChartOption ? (
                  <DashboardChart option={volumeChartOption} theme={echartsTheme} height={300} />
                ) : (
                  <ChartEmptyState
                    description={t("settings.rssTranslationMetrics.charts.empty")}
                  />
                )}
              </div>
            </Col>
            <Col xs={24} xl={12}>
              <div className="surface-inset flex flex-col gap-2">
                <p className="kicker m-0">
                  {t("settings.rssTranslationMetrics.charts.quality")}
                </p>
                {qualityChartOption ? (
                  <DashboardChart option={qualityChartOption} theme={echartsTheme} height={300} />
                ) : (
                  <ChartEmptyState
                    description={t("settings.rssTranslationMetrics.charts.empty")}
                  />
                )}
              </div>
            </Col>
          </Row>

          <div className="flex flex-col gap-2">
            <SectionHeader
              as="h3"
              title={t("settings.rssTranslationMetrics.table.title")}
            />
            <Table<RssTranslationMetricsDailyRow>
              rowKey={(row) => `${row.date}:${row.provider}:${row.targetLanguage}`}
              loading={loading}
              columns={columns}
              dataSource={metrics.rows}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1400 }}
              locale={{
                emptyText: t("settings.rssTranslationMetrics.table.empty")
              }}
            />
          </div>

          <Typography.Text type="secondary">
            {t("settings.rssTranslationMetrics.summary.cacheOverview", {
              hits: metrics.summary.cacheHitCount,
              misses: metrics.summary.cacheMissCount,
              failures: metrics.summary.failureCount,
              skipTooLong: metrics.summary.skipTooLongCount
            })}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("settings.rssTranslationMetrics.summary.rates", {
              cacheHitRate: formatPercent(metrics.summary.cacheHitRate),
              failureRate: formatPercent(metrics.summary.failureRate)
            })}
          </Typography.Text>
        </Space>
      </section>
    </div>
  );
}
