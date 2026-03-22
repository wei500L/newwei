"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  InputNumber,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

interface RssDiagnosticsChainResponse {
  generatedAt: string;
  windowDays: number;
  lookbackHours: number;
  schedulerEnabled: boolean;
  sources: {
    rssTotal: number;
    rssActive: number;
    seedEnabled: number;
    missingFeedUrl: number;
  };
  visibility: {
    visibleByProcessed: number;
    visibleByArticleFallback: number;
    hiddenSources: number;
  };
  processedCoverage: {
    completedTotal: number;
    missingSourceId: number;
    missingRate: number;
  };
  articleCoverage: {
    total: number;
    missingSourceId: number;
    missingRate: number;
  };
  pipelineJobs: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    latestCreatedAt?: string | null;
  };
  crawlTasks: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    latestUpdatedAt?: string | null;
  };
  crawlResults: {
    total: number;
    missingMarkdownRef: number;
    latestFetchedAt?: string | null;
  };
  recommendations: string[];
}

type SourceVisibility = "processed" | "article_fallback" | "none";

interface RssDiagnosticsSourceRow {
  sourceId: string;
  name: string;
  isActive: boolean;
  language?: string | null;
  siteUrl: string;
  feedUrl: string | null;
  seedEnabled: boolean;
  itemCountByProcessed: number;
  latestByProcessed?: string | null;
  itemCountByArticle: number;
  latestByArticle?: string | null;
  visibility: SourceVisibility;
  jobs24h: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
  lastJobStatus?: string | null;
  lastJobCreatedAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures: number;
  circuitOpenUntil?: string | null;
  issues: string[];
}

interface RssSourceIdBackfillResponse {
  dryRun: boolean;
  limit: number;
  scanned: number;
  matched: number;
  updated: number;
  unresolved: number;
  unresolvedSamples: {
    processedItemId: string;
    itemMetaId: string;
    reason: string;
  }[];
}

interface RssDiagnosticsOverviewResponse {
  generatedAt: string;
  chain: RssDiagnosticsChainResponse;
  sources: RssDiagnosticsSourceRow[];
}

function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${(safe * 100).toFixed(1)}%`;
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return "-";
  }
  return parsed.toLocaleString();
}

function visibilityColor(
  visibility: SourceVisibility,
): "green" | "gold" | "default" {
  if (visibility === "processed") {
    return "green";
  }
  if (visibility === "article_fallback") {
    return "gold";
  }
  return "default";
}

export function RssDiagnosticsPanel() {
  const { t } = useTranslation();
  const { echartsTheme, colors } = useChartTheme();
  const { data: session } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const [messageApi, contextHolder] = message.useMessage();
  const [windowDays, setWindowDays] = useState<number>(7);
  const [lookbackHours, setLookbackHours] = useState<number>(24);
  const [backfillLimit, setBackfillLimit] = useState<number>(500);
  const [loading, setLoading] = useState(false);
  const [runningBackfill, setRunningBackfill] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [chain, setChain] = useState<RssDiagnosticsChainResponse | null>(null);
  const [sources, setSources] = useState<RssDiagnosticsSourceRow[]>([]);
  const [backfillResult, setBackfillResult] =
    useState<RssSourceIdBackfillResponse | null>(null);

  const loadDiagnostics = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const overviewResponse =
        await apiClient.get<RssDiagnosticsOverviewResponse>(
          "system-settings/rss-diagnostics/overview",
          {
            params: { windowDays, lookbackHours },
          },
        );
      setChain(overviewResponse.data?.chain ?? null);
      setSources(
        Array.isArray(overviewResponse.data?.sources)
          ? overviewResponse.data.sources
          : [],
      );
    } catch (error) {
      captureClientError("Failed to load RSS diagnostics", error);
      const messageText =
        extractApiError(error).message ||
        t("settings.rssDiagnostics.errors.loadFailed", {
          defaultValue: "Failed to load RSS diagnostics.",
        });
      setErrorMessage(messageText);
      messageApi.error(messageText);
    } finally {
      setLoading(false);
    }
  }, [apiClient, lookbackHours, messageApi, t, windowDays]);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const runBackfill = useCallback(
    async (dryRun: boolean) => {
      setRunningBackfill(true);
      try {
        const response = await apiClient.post<RssSourceIdBackfillResponse>(
          "system-settings/rss-diagnostics/backfill-source-id",
          {
            dryRun,
            limit: backfillLimit,
          },
        );
        setBackfillResult(response.data);
        messageApi.success(
          dryRun
            ? t("settings.rssDiagnostics.messages.dryRunDone", {
                defaultValue: "Backfill dry-run finished.",
              })
            : t("settings.rssDiagnostics.messages.backfillDone", {
                defaultValue: "Backfill completed.",
              }),
        );
        await loadDiagnostics();
      } catch (error) {
        captureClientError("Failed to run RSS sourceId backfill", error);
        const messageText =
          extractApiError(error).message ||
          t("settings.rssDiagnostics.errors.backfillFailed", {
            defaultValue: "Failed to execute backfill.",
          });
        messageApi.error(messageText);
      } finally {
        setRunningBackfill(false);
      }
    },
    [apiClient, backfillLimit, loadDiagnostics, messageApi, t],
  );

  const visibilityChartOption = useMemo<EChartsOption | null>(() => {
    if (!chain) {
      return null;
    }
    return {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "pie",
          radius: ["45%", "70%"],
          data: [
            {
              name: t("settings.rssDiagnostics.visibility.processed", {
                defaultValue: "Visible (Processed)",
              }),
              value: chain.visibility.visibleByProcessed,
            },
            {
              name: t("settings.rssDiagnostics.visibility.articleFallback", {
                defaultValue: "Visible (Article Fallback)",
              }),
              value: chain.visibility.visibleByArticleFallback,
            },
            {
              name: t("settings.rssDiagnostics.visibility.hidden", {
                defaultValue: "Hidden",
              }),
              value: chain.visibility.hiddenSources,
            },
          ],
          label: { color: colors.foreground },
        },
      ],
    };
  }, [chain, colors.foreground, t]);

  const pipelineChartOption = useMemo<EChartsOption | null>(() => {
    if (!chain) {
      return null;
    }
    return {
      tooltip: { trigger: "axis" },
      grid: { top: 24, left: 24, right: 24, bottom: 24, containLabel: true },
      xAxis: {
        type: "category",
        data: [
          t("settings.rssDiagnostics.pipeline.queued", {
            defaultValue: "Queued",
          }),
          t("settings.rssDiagnostics.pipeline.running", {
            defaultValue: "Running",
          }),
          t("settings.rssDiagnostics.pipeline.completed", {
            defaultValue: "Completed",
          }),
          t("settings.rssDiagnostics.pipeline.failed", {
            defaultValue: "Failed",
          }),
        ],
        axisLabel: { color: colors.foreground },
      },
      yAxis: {
        type: "value",
        splitLine: {
          lineStyle: {
            color: colors.grid,
            type: "dashed",
          },
        },
      },
      series: [
        {
          type: "bar",
          data: [
            chain.pipelineJobs.queued,
            chain.pipelineJobs.running,
            chain.pipelineJobs.completed,
            chain.pipelineJobs.failed,
          ],
          itemStyle: { color: colors.primary },
        },
      ],
    };
  }, [chain, colors.foreground, colors.grid, colors.primary, t]);

  const sourceColumns = useMemo<ColumnsType<RssDiagnosticsSourceRow>>(
    () => [
      {
        title: t("settings.rssDiagnostics.table.source", {
          defaultValue: "Source",
        }),
        dataIndex: "name",
        key: "name",
        width: 240,
        render: (value: string, row) => (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{value}</Typography.Text>
            <Typography.Text type="secondary">{row.sourceId}</Typography.Text>
          </Space>
        ),
      },
      {
        title: t("settings.rssDiagnostics.table.visibility", {
          defaultValue: "Visibility",
        }),
        dataIndex: "visibility",
        key: "visibility",
        width: 170,
        render: (value: SourceVisibility) => (
          <Tag color={visibilityColor(value)}>
            {value === "processed"
              ? t("settings.rssDiagnostics.visibility.processed", {
                  defaultValue: "Processed",
                })
              : value === "article_fallback"
                ? t("settings.rssDiagnostics.visibility.articleFallbackShort", {
                    defaultValue: "Article Fallback",
                  })
                : t("settings.rssDiagnostics.visibility.hidden", {
                    defaultValue: "Hidden",
                  })}
          </Tag>
        ),
      },
      {
        title: t("settings.rssDiagnostics.table.processedCount", {
          defaultValue: "Processed",
        }),
        dataIndex: "itemCountByProcessed",
        key: "itemCountByProcessed",
        width: 110,
      },
      {
        title: t("settings.rssDiagnostics.table.articleCount", {
          defaultValue: "Articles",
        }),
        dataIndex: "itemCountByArticle",
        key: "itemCountByArticle",
        width: 110,
      },
      {
        title: t("settings.rssDiagnostics.table.jobs24h", {
          defaultValue: "Jobs(24h)",
        }),
        key: "jobs24h",
        width: 210,
        render: (_, row) => (
          <Space size={4} wrap>
            <Tag>{`Q:${row.jobs24h.queued}`}</Tag>
            <Tag color="processing">{`R:${row.jobs24h.running}`}</Tag>
            <Tag color="success">{`C:${row.jobs24h.completed}`}</Tag>
            <Tag color="error">{`F:${row.jobs24h.failed}`}</Tag>
          </Space>
        ),
      },
      {
        title: t("settings.rssDiagnostics.table.issues", {
          defaultValue: "Issues",
        }),
        dataIndex: "issues",
        key: "issues",
        render: (issues: string[]) => {
          if (!issues?.length) {
            return <Typography.Text type="secondary">-</Typography.Text>;
          }
          return (
            <Space size={4} wrap>
              {issues.map((issue) => (
                <Tag key={issue} color="gold">
                  {issue}
                </Tag>
              ))}
            </Space>
          );
        },
      },
    ],
    [t],
  );

  const unresolvedColumns = useMemo<
    ColumnsType<RssSourceIdBackfillResponse["unresolvedSamples"][number]>
  >(
    () => [
      {
        title: t(
          "settings.rssDiagnostics.backfill.unresolved.processedItemId",
          { defaultValue: "Processed Item ID" },
        ),
        dataIndex: "processedItemId",
        key: "processedItemId",
      },
      {
        title: t("settings.rssDiagnostics.backfill.unresolved.itemMetaId", {
          defaultValue: "Item Meta ID",
        }),
        dataIndex: "itemMetaId",
        key: "itemMetaId",
      },
      {
        title: t("settings.rssDiagnostics.backfill.unresolved.reason", {
          defaultValue: "Reason",
        }),
        dataIndex: "reason",
        key: "reason",
      },
    ],
    [t],
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {contextHolder}
      <Card>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t("settings.rssDiagnostics.title", {
              defaultValue: "RSS Chain Diagnostics",
            })}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("settings.rssDiagnostics.description", {
              defaultValue:
                "Inspect RSS ingestion health and repair missing ProcessedItem.sourceId links.",
            })}
          </Typography.Text>

          <Space wrap>
            <Space>
              <Typography.Text>
                {t("settings.rssDiagnostics.controls.windowDays", {
                  defaultValue: "Window Days",
                })}
              </Typography.Text>
              <InputNumber
                min={1}
                max={30}
                value={windowDays}
                onChange={(value) => setWindowDays(Number(value ?? 7))}
              />
            </Space>
            <Space>
              <Typography.Text>
                {t("settings.rssDiagnostics.controls.lookbackHours", {
                  defaultValue: "Lookback Hours",
                })}
              </Typography.Text>
              <InputNumber
                min={1}
                max={720}
                value={lookbackHours}
                onChange={(value) => setLookbackHours(Number(value ?? 24))}
              />
            </Space>
            <Button onClick={() => void loadDiagnostics()} loading={loading}>
              {t("common.refresh")}
            </Button>
          </Space>

          {errorMessage ? (
            <Alert type="error" showIcon message={errorMessage} />
          ) : null}
          {!chain ? null : (
            <>
              {!chain.schedulerEnabled ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t("settings.rssDiagnostics.schedulerDisabled", {
                    defaultValue: "NEWS source scheduler is disabled.",
                  })}
                />
              ) : null}
              {chain.recommendations.length > 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message={t("settings.rssDiagnostics.recommendations", {
                    defaultValue: "Recommendations",
                  })}
                  description={
                    <Space direction="vertical" size={0}>
                      {chain.recommendations.map((item) => (
                        <Typography.Text key={item}>{item}</Typography.Text>
                      ))}
                    </Space>
                  }
                />
              ) : null}

              <Row gutter={[12, 12]}>
                <Col xs={24} sm={12} md={8} lg={6}>
                  <Statistic
                    title={t("settings.rssDiagnostics.cards.rssSources", {
                      defaultValue: "RSS Sources",
                    })}
                    value={chain.sources.rssTotal}
                  />
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  <Statistic
                    title={t("settings.rssDiagnostics.cards.visibleProcessed", {
                      defaultValue: "Visible (Processed)",
                    })}
                    value={chain.visibility.visibleByProcessed}
                  />
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  <Statistic
                    title={t("settings.rssDiagnostics.cards.visibleFallback", {
                      defaultValue: "Visible (Fallback)",
                    })}
                    value={chain.visibility.visibleByArticleFallback}
                  />
                </Col>
                <Col xs={24} sm={12} md={8} lg={6}>
                  <Statistic
                    title={t("settings.rssDiagnostics.cards.hidden", {
                      defaultValue: "Hidden Sources",
                    })}
                    value={chain.visibility.hiddenSources}
                  />
                </Col>
              </Row>

              <Row gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={t(
                      "settings.rssDiagnostics.cards.processedCoverage",
                      { defaultValue: "Processed sourceId coverage" },
                    )}
                  >
                    <Space direction="vertical" size={4}>
                      <Typography.Text>
                        {t("settings.rssDiagnostics.cards.totalCompleted", {
                          defaultValue: "Completed: {{value}}",
                          value: chain.processedCoverage.completedTotal,
                        })}
                      </Typography.Text>
                      <Typography.Text>
                        {t("settings.rssDiagnostics.cards.missingSourceId", {
                          defaultValue: "Missing sourceId: {{value}}",
                          value: chain.processedCoverage.missingSourceId,
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {formatPercent(chain.processedCoverage.missingRate)}
                      </Typography.Text>
                    </Space>
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={t("settings.rssDiagnostics.cards.articleCoverage", {
                      defaultValue: "Article sourceId coverage",
                    })}
                  >
                    <Space direction="vertical" size={4}>
                      <Typography.Text>
                        {t("settings.rssDiagnostics.cards.totalArticle", {
                          defaultValue: "Articles: {{value}}",
                          value: chain.articleCoverage.total,
                        })}
                      </Typography.Text>
                      <Typography.Text>
                        {t(
                          "settings.rssDiagnostics.cards.missingArticleSourceId",
                          {
                            defaultValue: "Missing sourceId: {{value}}",
                            value: chain.articleCoverage.missingSourceId,
                          },
                        )}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {formatPercent(chain.articleCoverage.missingRate)}
                      </Typography.Text>
                    </Space>
                  </Card>
                </Col>
              </Row>

              <Row gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={t("settings.rssDiagnostics.charts.visibility", {
                      defaultValue: "Source Visibility",
                    })}
                  >
                    {visibilityChartOption ? (
                      <DashboardChart
                        option={visibilityChartOption}
                        theme={echartsTheme}
                        height={280}
                      />
                    ) : null}
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={t("settings.rssDiagnostics.charts.pipeline", {
                      defaultValue: "Pipeline Jobs",
                    })}
                  >
                    {pipelineChartOption ? (
                      <DashboardChart
                        option={pipelineChartOption}
                        theme={echartsTheme}
                        height={280}
                      />
                    ) : null}
                  </Card>
                </Col>
              </Row>
            </>
          )}
        </Space>
      </Card>

      <Card>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t("settings.rssDiagnostics.backfill.title", {
              defaultValue: "sourceId Backfill",
            })}
          </Typography.Title>
          <Space wrap>
            <Space>
              <Typography.Text>
                {t("settings.rssDiagnostics.backfill.limit", {
                  defaultValue: "Scan Limit",
                })}
              </Typography.Text>
              <InputNumber
                min={1}
                max={5000}
                value={backfillLimit}
                onChange={(value) => setBackfillLimit(Number(value ?? 500))}
              />
            </Space>
            <Button
              onClick={() => void runBackfill(true)}
              loading={runningBackfill}
            >
              {t("settings.rssDiagnostics.backfill.dryRun", {
                defaultValue: "Dry Run",
              })}
            </Button>
            <Button
              type="primary"
              onClick={() => void runBackfill(false)}
              loading={runningBackfill}
            >
              {t("settings.rssDiagnostics.backfill.execute", {
                defaultValue: "Execute Backfill",
              })}
            </Button>
          </Space>

          {backfillResult ? (
            <Alert
              type={backfillResult.dryRun ? "info" : "success"}
              showIcon
              message={
                backfillResult.dryRun
                  ? t("settings.rssDiagnostics.backfill.dryRunSummary", {
                      defaultValue: "Dry-run finished.",
                    })
                  : t("settings.rssDiagnostics.backfill.executeSummary", {
                      defaultValue: "Backfill finished.",
                    })
              }
              description={
                <Space direction="vertical" size={0}>
                  <Typography.Text>{`scanned=${backfillResult.scanned}`}</Typography.Text>
                  <Typography.Text>{`matched=${backfillResult.matched}`}</Typography.Text>
                  <Typography.Text>{`updated=${backfillResult.updated}`}</Typography.Text>
                  <Typography.Text>{`unresolved=${backfillResult.unresolved}`}</Typography.Text>
                </Space>
              }
            />
          ) : null}

          {backfillResult && backfillResult.unresolvedSamples.length > 0 ? (
            <Table
              size="small"
              rowKey={(row) => `${row.processedItemId}-${row.reason}`}
              columns={unresolvedColumns}
              dataSource={backfillResult.unresolvedSamples}
              pagination={false}
              scroll={{ x: 900 }}
            />
          ) : null}
        </Space>
      </Card>

      <Card
        title={t("settings.rssDiagnostics.table.title", {
          defaultValue: "Per-source Diagnostics",
        })}
      >
        <Table<RssDiagnosticsSourceRow>
          size="small"
          loading={loading}
          rowKey={(row) => row.sourceId}
          columns={sourceColumns}
          dataSource={sources}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          scroll={{ x: 1200 }}
        />
      </Card>

      {chain ? (
        <Card size="small">
          <Space direction="vertical" size={4}>
            <Typography.Text type="secondary">
              {t("settings.rssDiagnostics.meta.generatedAt", {
                defaultValue: "Generated at: {{value}}",
                value: formatDateTime(chain.generatedAt),
              })}
            </Typography.Text>
            <Typography.Text type="secondary">
              {t("settings.rssDiagnostics.meta.pipelineLatest", {
                defaultValue: "Latest pipeline job: {{value}}",
                value: formatDateTime(chain.pipelineJobs.latestCreatedAt),
              })}
            </Typography.Text>
            <Typography.Text type="secondary">
              {t("settings.rssDiagnostics.meta.crawlResultLatest", {
                defaultValue: "Latest crawl result: {{value}}",
                value: formatDateTime(chain.crawlResults.latestFetchedAt),
              })}
            </Typography.Text>
          </Space>
        </Card>
      ) : null}
    </Space>
  );
}
