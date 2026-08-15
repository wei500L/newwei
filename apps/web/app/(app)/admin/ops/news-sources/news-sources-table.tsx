"use client";

import type {
  Grid,
  message} from "antd";
import {
  Button,
  Card,
  Dropdown,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import axios from "axios";
import dayjs from "dayjs";
import type { useRouter } from "next/navigation";
import type { Dispatch, SetStateAction } from "react";
import type { useTranslation } from "react-i18next";

import type { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, type SupportedLocale } from "@/lib/i18n";
import type { RssAdaptiveListUiModel } from "@/lib/news-source-rss-adaptive-ui";

import {
  crawlTaskStatusColors,
  extractApiErrorMessage,
  getCrawlStrategyTags,
  getSeedMode,
  isPlainObject,
  mapWithConcurrency,
  pipelineJobStatusColors,
} from "./news-sources.helpers";
import type {
  CrawlTemplateRecord,
  NewsSourceCancelQueuedResponse,
  NewsSourceClearInflightResponse,
  NewsSourceDispatchResponse,
  NewsSourceRecord,
  NewsSourceRetryLatestResponse,
} from "./news-sources.types";

export interface NewsSourcesTableProps {
  t: ReturnType<typeof useTranslation>["t"];
  locale: SupportedLocale;
  router: ReturnType<typeof useRouter>;
  canManage: boolean;
  screens: ReturnType<typeof Grid.useBreakpoint>;
  sources: NewsSourceRecord[];
  loading: boolean;
  sourcePage: number;
  sourcePageSize: number;
  sourceTotal: number;
  setSourcePage: (page: number) => void;
  setSourcePageSize: (pageSize: number) => void;
  searchInput: string;
  setSearchInput: (value: string) => void;
  selectedSourceIds: string[];
  setSelectedSourceIds: Dispatch<SetStateAction<string[]>>;
  selectedSources: NewsSourceRecord[];
  uniqueGroups: string[];
  templateMap: Map<string, CrawlTemplateRecord>;
  siteTypeOptions: { value: string; label: string }[];
  resolveRssAdaptiveObservability: (
    record: NewsSourceRecord,
  ) => RssAdaptiveListUiModel | null;
  dispatchingSourceIds: Set<string>;
  opsLoadingSourceIds: Set<string>;
  setOpsLoadingSourceIds: Dispatch<SetStateAction<Set<string>>>;
  batchRunLoading: boolean;
  setBatchRunLoading: Dispatch<SetStateAction<boolean>>;
  batchToggleLoading: boolean;
  setBatchToggleLoading: Dispatch<SetStateAction<boolean>>;
  batchGroupLoading: boolean;
  setBatchGroupLoading: Dispatch<SetStateAction<boolean>>;
  scheduleLoading: boolean;
  apiClient: ReturnType<typeof createApiClient>;
  loadSources: () => Promise<boolean>;
  loadGroups: () => Promise<void>;
  messageApi: ReturnType<typeof message.useMessage>[0];
  handleRunNow: (source: NewsSourceRecord) => Promise<void>;
  openEdit: (source: NewsSourceRecord) => void;
  handlePreview: (source: NewsSourceRecord) => Promise<void>;
  openSchedule: (source: NewsSourceRecord) => void;
  openBatchSchedule: (targets: NewsSourceRecord[]) => void;
}

export function NewsSourcesTable({
  t,
  locale,
  router,
  canManage,
  screens,
  sources,
  loading,
  sourcePage,
  sourcePageSize,
  sourceTotal,
  setSourcePage,
  setSourcePageSize,
  searchInput,
  setSearchInput,
  selectedSourceIds,
  setSelectedSourceIds,
  selectedSources,
  uniqueGroups,
  templateMap,
  siteTypeOptions,
  resolveRssAdaptiveObservability,
  dispatchingSourceIds,
  opsLoadingSourceIds,
  setOpsLoadingSourceIds,
  batchRunLoading,
  setBatchRunLoading,
  batchToggleLoading,
  setBatchToggleLoading,
  batchGroupLoading,
  setBatchGroupLoading,
  scheduleLoading,
  apiClient,
  loadSources,
  loadGroups,
  messageApi,
  handleRunNow,
  openEdit,
  handlePreview,
  openSchedule,
  openBatchSchedule,
}: NewsSourcesTableProps) {
  const handleToggleActive = async (
    source: NewsSourceRecord,
    nextActive: boolean,
  ) => {
    try {
      await apiClient.patch(`admin/news-sources/${source.id}`, {
        isActive: nextActive,
      });
      await loadSources();
      messageApi.success(
        nextActive
          ? t("newsSources.messages.enabled")
          : t("newsSources.messages.disabled"),
      );
    } catch (error) {
      captureClientError("Failed to update news source", error);
      messageApi.error(
        t("newsSources.errors.saveFailed"),
      );
    }
  };
  const handleBatchToggleActive = async (nextActive: boolean) => {
    const ids = selectedSourceIds;
    if (ids.length === 0) {
      return;
    }

    setBatchToggleLoading(true);
    try {
      const response = await apiClient.patch<{
        updatedCount: number;
        requestedCount: number;
      }>("admin/news-sources/batch/active", {
        ids,
        isActive: nextActive,
      });
      const okCount = response.data.updatedCount ?? ids.length;
      const failedCount = Math.max(0, ids.length - okCount);

      if (failedCount > 0) {
        messageApi.warning(
          t("newsSources.messages.batchTogglePartial", {
            ok: okCount,
            total: ids.length,
          }),
        );
      } else {
        messageApi.success(
          nextActive
            ? t("newsSources.messages.enabledBatch", {
                count: okCount,
              })
            : t("newsSources.messages.disabledBatch", {
                count: okCount,
              }),
        );
      }

      setSelectedSourceIds([]);
      await loadSources();
    } catch (error) {
      captureClientError("Failed to batch update news sources", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.errors.saveFailed"),
      );
    } finally {
      setBatchToggleLoading(false);
    }
  };

  const handleBatchSetGroup = async (group: string | null) => {
    const ids = selectedSourceIds;
    if (ids.length === 0) {
      return;
    }
    setBatchGroupLoading(true);
    try {
      await apiClient.patch("admin/news-sources/batch/group", { ids, group });
      messageApi.success(
        t("newsSources.messages.groupUpdatedBatch", {
          count: ids.length,
        }),
      );
      setSelectedSourceIds([]);
      await loadSources();
      await loadGroups();
    } catch (error) {
      captureClientError("Failed to batch update group", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.errors.saveFailed"),
      );
    } finally {
      setBatchGroupLoading(false);
    }
  };

  const handleBatchRunNow = async () => {
    const targets = selectedSources;
    if (targets.length === 0) {
      return;
    }

    setBatchRunLoading(true);
    try {
      type BatchDispatchResult =
        | { ok: true; sourceId: string; payload: NewsSourceDispatchResponse }
        | {
            ok: false;
            sourceId: string;
            error: string;
            kind?: "conflict" | "error";
          };

      const results = await mapWithConcurrency(
        targets,
        3,
        async (target): Promise<BatchDispatchResult> => {
          try {
            const response = await apiClient.post<NewsSourceDispatchResponse>(
              `admin/news-sources/${target.id}/dispatch`,
            );
            return { ok: true, sourceId: target.id, payload: response.data };
          } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 409) {
              return {
                ok: false,
                sourceId: target.id,
                kind: "conflict",
                error: t("newsSources.messages.dispatchInProgress"),
              };
            }
            return {
              ok: false,
              sourceId: target.id,
              kind: "error",
              error:
                extractApiErrorMessage(error) ??
                (error instanceof Error ? error.message : "Failed to dispatch"),
            };
          }
        },
      );

      const okResults = results.filter(
        (result): result is Extract<BatchDispatchResult, { ok: true }> =>
          result.ok,
      );
      const failedResults = results.filter(
        (result): result is Extract<BatchDispatchResult, { ok: false }> =>
          !result.ok,
      );

      const scheduledTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.scheduledCount ?? 0),
        0,
      );
      const queuedTaskTotal = okResults.reduce(
        (sum, result) =>
          sum +
          (result.payload.mode === "rss"
            ? 0
            : (result.payload.scheduledCount ?? 0)),
        0,
      );
      const queuedJobTotal = okResults.reduce(
        (sum, result) =>
          sum +
          (result.payload.mode === "rss"
            ? (result.payload.scheduledCount ?? 0)
            : 0),
        0,
      );
      const enqueueFailuresTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.enqueueFailures ?? 0),
        0,
      );
      const skippedTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.skippedCount ?? 0),
        0,
      );
      const rssNoBodySkippedTotal = okResults.reduce(
        (sum, result) => sum + (result.payload.rssSkippedNoBodyCount ?? 0),
        0,
      );

      const conflictCount = failedResults.filter(
        (result) => result.kind === "conflict",
      ).length;
      const requestFailureCount = failedResults.length - conflictCount;

      const warning = requestFailureCount > 0 || enqueueFailuresTotal > 0;
      const messageType = warning
        ? "warning"
        : conflictCount > 0
          ? "info"
          : "success";
      const useDetailedBatchMessage =
        queuedJobTotal > 0 || rssNoBodySkippedTotal > 0;
      messageApi.open({
        type: messageType,
        content: useDetailedBatchMessage
          ? t("newsSources.messages.batchDispatchDetailed", {
              sources: targets.length,
              tasks: queuedTaskTotal,
              jobs: queuedJobTotal,
              skipped: skippedTotal,
              rssNoBody: rssNoBodySkippedTotal,
              enqueueFailures: enqueueFailuresTotal,
              conflicts: conflictCount,
              failures: requestFailureCount,
            })
          : t("newsSources.messages.batchDispatch", {
              sources: targets.length,
              tasks: scheduledTotal,
              skipped: skippedTotal,
              enqueueFailures: enqueueFailuresTotal,
              conflicts: conflictCount,
              failures: requestFailureCount,
            }),
      });

      setSelectedSourceIds([]);
      await loadSources();
    } finally {
      setBatchRunLoading(false);
    }
  };

  const handleCancelQueued = async (source: NewsSourceRecord) => {
    Modal.confirm({
      title: t("newsSources.ops.cancelQueued.title"),
      content: t("newsSources.ops.cancelQueued.description"),
      okText: t("newsSources.ops.cancelQueued.ok"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setOpsLoadingSourceIds((prev) => {
          const next = new Set(prev);
          next.add(source.id);
          return next;
        });
        try {
          const response = await apiClient.post<NewsSourceCancelQueuedResponse>(
            `admin/news-sources/${source.id}/cancel-queued`,
          );
          const payload = response.data;
          messageApi.success(
            t("newsSources.ops.cancelQueued.done", {
              removed: payload.removedJobs ?? 0,
              scanned: payload.scannedJobs ?? 0,
            }),
          );
          await loadSources();
        } catch (error) {
          captureClientError("Failed to cancel queued crawls", error);
          messageApi.error(
            extractApiErrorMessage(error) ??
              t("newsSources.ops.cancelQueued.failed"),
          );
        } finally {
          setOpsLoadingSourceIds((prev) => {
            const next = new Set(prev);
            next.delete(source.id);
            return next;
          });
        }
      },
    });
  };

  const handleClearInflight = async (source: NewsSourceRecord) => {
    Modal.confirm({
      title: t("newsSources.ops.clearInflight.title"),
      content: t("newsSources.ops.clearInflight.description"),
      okText: t("newsSources.ops.clearInflight.ok"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setOpsLoadingSourceIds((prev) => {
          const next = new Set(prev);
          next.add(source.id);
          return next;
        });
        try {
          const response =
            await apiClient.post<NewsSourceClearInflightResponse>(
              `admin/news-sources/${source.id}/clear-inflight`,
            );
          const payload = response.data;
          messageApi.success(
            t("newsSources.ops.clearInflight.done", {
              count: payload.clearedJobs ?? 0,
            }),
          );
          await loadSources();
        } catch (error) {
          captureClientError("Failed to clear inflight jobs", error);
          messageApi.error(
            extractApiErrorMessage(error) ??
              t("newsSources.ops.clearInflight.failed"),
          );
        } finally {
          setOpsLoadingSourceIds((prev) => {
            const next = new Set(prev);
            next.delete(source.id);
            return next;
          });
        }
      },
    });
  };

  const handleRetryLatestFailedTask = async (source: NewsSourceRecord) => {
    setOpsLoadingSourceIds((prev) => {
      const next = new Set(prev);
      next.add(source.id);
      return next;
    });
    try {
      const response = await apiClient.post<NewsSourceRetryLatestResponse>(
        `admin/news-sources/${source.id}/retry-latest`,
      );
      const payload = response.data;
      await loadSources();

      if (!payload?.retried) {
        messageApi.info(
          t(
            payload?.retryType === "pipeline"
              ? "newsSources.ops.retryLatest.skippedPipeline"
              : "newsSources.ops.retryLatest.skipped",
            {
              defaultValue:
                payload?.retryType === "pipeline"
                  ? "Latest pipeline job is not failed (status: {{status}})."
                  : "Latest task is not failed (status: {{status}}).",
              status: payload?.status ?? "unknown",
            },
          ),
        );
        return;
      }

      messageApi.success(
        payload.retryType === "crawl" && payload.crawlTaskId ? (
          <Space size={8} wrap>
            <span>
              {t("newsSources.ops.retryLatest.done")}
            </span>
            <Button
              type="link"
              size="small"
              onClick={() =>
                router.push(`/admin/ops/crawl-tasks/${payload.crawlTaskId}`)
              }
            >
              {t("newsSources.actions.openTask")}
            </Button>
          </Space>
        ) : (
          t("newsSources.ops.retryLatest.donePipeline")
        ),
      );
    } catch (error) {
      captureClientError("Failed to retry latest failed task", error);
      messageApi.error(
        extractApiErrorMessage(error) ??
          t("newsSources.ops.retryLatest.failed"),
      );
    } finally {
      setOpsLoadingSourceIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
    }
  };
  const handleDelete = (source: NewsSourceRecord) => {
    Modal.confirm({
      title: t("newsSources.delete.title"),
      content: t("newsSources.delete.description"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await apiClient.delete(`admin/news-sources/${source.id}`);
          await loadSources();
          messageApi.success(
            t("newsSources.messages.deleted"),
          );
        } catch (error) {
          captureClientError("Failed to delete news source", error);
          messageApi.error(
            t("newsSources.errors.deleteFailed"),
          );
        }
      },
    });
  };
  const columns: ColumnsType<NewsSourceRecord> = [
    {
      title: t("newsSources.columns.name"),
      dataIndex: "name",
      key: "name",
      width: 320,
      render: (_, record) => {
        const mode = getSeedMode(record.config);
        const modeTag =
          mode === null
            ? null
            : (() => {
                const color =
                  mode === "rss"
                    ? "blue"
                    : mode === "list"
                      ? "gold"
                      : mode === "deep"
                        ? "geekblue"
                        : "purple";
                const label =
                  mode === "rss"
                    ? t("newsSources.seedMode.rss")
                    : mode === "list"
                      ? t("newsSources.seedMode.list")
                      : mode === "deep"
                        ? t("newsSources.seedMode.deep")
                        : t("newsSources.seedMode.sitemap");
                return <Tag color={color}>{label}</Tag>;
              })();
        const rssAdaptive = resolveRssAdaptiveObservability(record);
        const rssAdaptiveTierColor =
          rssAdaptive?.tier === "hot"
            ? "volcano"
            : rssAdaptive?.tier === "warm"
              ? "gold"
              : rssAdaptive?.tier === "cold"
                ? "blue"
                : "default";
        const rssAdaptiveTierLabel =
          rssAdaptive?.tier === "hot"
            ? t("newsSources.rssAdaptive.tier.hot")
            : rssAdaptive?.tier === "warm"
              ? t("newsSources.rssAdaptive.tier.warm")
              : rssAdaptive?.tier === "cold"
                ? t("newsSources.rssAdaptive.tier.cold")
                : t("newsSources.rssAdaptive.tier.normal");

        return (
          <Space direction="vertical" size={2}>
            <Space size={8} wrap>
              <Typography.Text strong>{record.name}</Typography.Text>
              {modeTag}
              {rssAdaptive ? (
                <Tooltip
                  title={
                    <Space direction="vertical" size={0}>
                      <Typography.Text>
                        {t("newsSources.rssAdaptive.tooltip.hitRate", {
                          value:
                            typeof rssAdaptive.hitRate === "number"
                              ? `${Math.round(rssAdaptive.hitRate * 100)}%`
                              : t("common.emptyValue"),
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {rssAdaptive.hasHistory
                          ? t(
                              "newsSources.rssAdaptive.tooltip.consecutiveNoHit",
                              {
                                value: rssAdaptive.consecutiveNoHit,
                              },
                            )
                          : t("newsSources.rssAdaptive.tooltip.noHistory")}
                      </Typography.Text>
                      {rssAdaptive.updatedAt ? (
                        <Typography.Text type="secondary">
                          {t("newsSources.rssAdaptive.tooltip.updatedAt", {
                            value: formatDateTime(
                              rssAdaptive.updatedAt,
                              locale,
                              {
                                dateStyle: "medium",
                                timeStyle: "short",
                              },
                            ),
                          })}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                >
                  <Tag color={rssAdaptiveTierColor}>
                    {t("newsSources.rssAdaptive.tierTag", {
                      tier: rssAdaptiveTierLabel,
                    })}
                  </Tag>
                </Tooltip>
              ) : null}
              {rssAdaptive ? (
                <Tag>
                  {t("newsSources.rssAdaptive.intervalTag", {
                    seconds: rssAdaptive.effectiveIntervalSeconds,
                  })}
                </Tag>
              ) : null}
              {rssAdaptive ? (
                <Tag>
                  {t("newsSources.rssAdaptive.discoveryTtlTag", {
                    seconds: rssAdaptive.effectiveDiscoveryCacheTtlSeconds,
                  })}
                </Tag>
              ) : null}
            </Space>
            <Space size={6} wrap>
              {record.crawlTaskQueuedCount > 0 ? (
                <Tag color="cyan">
                  {t("newsSources.queueCounts.queued", {
                    count: record.crawlTaskQueuedCount,
                  })}
                </Tag>
              ) : null}
              {record.crawlTaskRunningCount > 0 ? (
                <Tag color="blue">
                  {t("newsSources.queueCounts.active", {
                    count: record.crawlTaskRunningCount,
                  })}
                </Tag>
              ) : null}
              <Button
                size="small"
                type="link"
                onClick={() =>
                  router.push(`/admin/ops/crawl-tasks?sourceId=${record.id}`)
                }
              >
                {t("newsSources.actions.viewTasks")}
              </Button>
            </Space>
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: record.url }}
            >
              {record.url}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.type"),
      dataIndex: "siteType",
      key: "siteType",
      width: 110,
      render: (value: string) => {
        const label =
          siteTypeOptions.find((option) => option.value === value)?.label ??
          value;
        return <Tag>{label}</Tag>;
      },
    },
    {
      title: t("newsSources.columns.template"),
      dataIndex: "crawlTemplateId",
      key: "crawlTemplateId",
      width: 160,
      render: (value?: string | null) => {
        if (!value) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        const template = templateMap.get(value);
        if (!template) {
          return <Tag color="default">{value}</Tag>;
        }
        return (
          <Tag color={template.isActive ? "blue" : "orange"}>
            {template.isActive
              ? template.name
              : `${template.name} (${t("common.disabled")})`}
          </Tag>
        );
      },
    },
    {
      title: t("newsSources.columns.strategy"),
      key: "strategy",
      width: 300,
      render: (_: unknown, record) => {
        const strategyTags = getCrawlStrategyTags(record.config, t);
        if (!strategyTags.length) {
          return (
            <Typography.Text type="secondary">
              {t("newsSources.columns.strategyEmpty")}
            </Typography.Text>
          );
        }
        return (
          <Space wrap size={[4, 4]}>
            {strategyTags.map((tag) => (
              <Tag key={tag.key} color={tag.color}>
                {tag.label}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.frequency"),
      dataIndex: "frequencySeconds",
      key: "frequencySeconds",
      width: 120,
    },
    {
      title: t("newsSources.columns.priority"),
      dataIndex: "priority",
      key: "priority",
      width: 90,
    },
    {
      title: t("newsSources.columns.status"),
      dataIndex: "isActive",
      key: "isActive",
      width: 170,
      render: (value: boolean, record) => {
        const failureCount = Number(record.consecutiveFailures ?? 0);
        const circuitOpenUntil = record.circuitOpenUntil
          ? new Date(record.circuitOpenUntil)
          : null;
        const circuitOpen = circuitOpenUntil
          ? circuitOpenUntil.getTime() > Date.now()
          : false;
        const lastFailureAt = record.lastFailureAt ?? null;

        const healthTag = circuitOpen ? (
          <Tooltip
            title={
              circuitOpenUntil
                ? t("newsSources.health.circuitOpenUntil", {
                    time: formatDateTime(
                      circuitOpenUntil.toISOString(),
                      locale,
                      {
                        dateStyle: "medium",
                        timeStyle: "short",
                      },
                    ),
                  })
                : t("newsSources.health.circuitOpen")
            }
          >
            <Tag color="red">
              {t("newsSources.health.circuitOpen")}
            </Tag>
          </Tooltip>
        ) : failureCount > 0 ? (
          <Tooltip
            title={
              lastFailureAt
                ? t("newsSources.health.lastFailureAt", {
                    time: formatDateTime(lastFailureAt, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })
                : t("newsSources.health.failing")
            }
          >
            <Tag color="orange">
              {t("newsSources.health.failingCount", {
                count: failureCount,
              })}
            </Tag>
          </Tooltip>
        ) : value ? (
          <Tag color="green">
            {t("newsSources.health.healthy")}
          </Tag>
        ) : null;

        return (
          <Space direction="vertical" size={2}>
            {canManage ? (
              <Switch
                checked={value}
                onChange={(next) => void handleToggleActive(record, next)}
              />
            ) : (
              <Tag color={value ? "green" : "default"}>
                {value ? t("common.enabled") : t("common.disabled")}
              </Tag>
            )}
            {healthTag}
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.nextRun"),
      dataIndex: "nextRunAt",
      key: "nextRunAt",
      width: 190,
      render: (value: string | null | undefined, record) => {
        if (!value) {
          return t("common.never");
        }
        const scheduled = dayjs(value);
        const overdue = scheduled.isValid() && scheduled.isBefore(dayjs());
        const backpressureUntil = record.backpressureUntil;
        const backpressurePendingJobs = record.backpressurePendingJobs;
        const backpressureThreshold = record.backpressureThreshold;
        const backpressureAt = backpressureUntil
          ? dayjs(backpressureUntil)
          : null;
        const isBackpressured = Boolean(
          backpressureAt &&
            backpressureAt.isValid() &&
            backpressureAt.isAfter(dayjs()),
        );
        return (
          <Space size={6} wrap>
            {overdue ? (
              <Tag color="gold">
                {t("newsSources.nextRun.due")}
              </Tag>
            ) : null}
            {isBackpressured && backpressureUntil ? (
              <Tooltip
                title={
                  <Space direction="vertical" size={0}>
                    <Typography.Text>
                      {typeof backpressurePendingJobs === "number" &&
                      typeof backpressureThreshold === "number"
                        ? t("newsSources.nextRun.backpressureReason", {
                            pendingJobs: backpressurePendingJobs,
                            threshold: backpressureThreshold,
                          })
                        : t("newsSources.nextRun.backpressureReasonFallback")}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("newsSources.nextRun.backpressureUntil", {
                        time: formatDateTime(backpressureUntil, locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })}
                    </Typography.Text>
                  </Space>
                }
              >
                <Tag color="orange">
                  {t("newsSources.nextRun.backpressure")}
                </Tag>
              </Tooltip>
            ) : null}
            <Typography.Text>
              {formatDateTime(value, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.lastRun"),
      dataIndex: "lastRunAt",
      key: "lastRunAt",
      width: 160,
      render: (value?: string | null) =>
        value
          ? formatDateTime(value, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : t("common.never"),
    },
    {
      title: t("newsSources.columns.lastSuccess"),
      dataIndex: "lastSuccessAt",
      key: "lastSuccessAt",
      width: 160,
      responsive: ["md"],
      render: (value?: string | null) =>
        value
          ? formatDateTime(value, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : t("common.never"),
    },
    {
      title: t("newsSources.columns.stats24h"),
      key: "stats24h",
      width: 110,
      responsive: ["md"],
      render: (_: unknown, record) => {
        const completed = record.stats24h?.completed ?? 0;
        const failed = record.stats24h?.failed ?? 0;
        const successRate =
          typeof record.stats24h?.successRate === "number"
            ? record.stats24h.successRate
            : null;
        const avgDurationMs =
          typeof record.stats24h?.avgDurationMs === "number" &&
          Number.isFinite(record.stats24h.avgDurationMs)
            ? record.stats24h.avgDurationMs
            : null;
        const backpressureCount = record.backpressureCount24h ?? 0;

        const rateLabel =
          typeof successRate === "number" && Number.isFinite(successRate)
            ? `${Math.round(successRate * 100)}%`
            : t("common.emptyValue");
        const color =
          typeof successRate === "number" && Number.isFinite(successRate)
            ? successRate >= 0.9
              ? "green"
              : successRate >= 0.7
                ? "orange"
                : "red"
            : "default";

        const avgLabel =
          typeof avgDurationMs === "number" && Number.isFinite(avgDurationMs)
            ? `${(avgDurationMs / 1000).toFixed(1)}s`
            : t("common.emptyValue");

        return (
          <Tooltip
            title={
              <Space direction="vertical" size={0}>
                <Typography.Text>
                  {t("newsSources.stats24h.jobs", {
                    ok: completed,
                    fail: failed,
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("newsSources.stats24h.avgDuration", {
                    value: avgLabel,
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("newsSources.stats24h.backpressure", {
                    count: backpressureCount,
                  })}
                </Typography.Text>
              </Space>
            }
          >
            <Space direction="vertical" size={2}>
              <Tag color={color}>{rateLabel}</Tag>
              <Typography.Text type="secondary">
                {t("newsSources.stats24h.jobsShort", {
                  ok: completed,
                  fail: failed,
                })}
              </Typography.Text>
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: t("newsSources.columns.latest"),
      key: "latest",
      width: 380,
      responsive: ["md"],
      render: (_: unknown, record) => {
        const job = record.latestJob ?? null;
        const task = record.latestCrawlTask ?? null;
        const article = record.latestArticle ?? null;
        const jobError = job?.error ?? null;
        const taskError = task?.lastError ?? null;
        const ingestPath =
          job?.metadata && isPlainObject(job.metadata)
            ? (job.metadata.ingestPath as string | undefined)
            : undefined;
        const isRssPrefetched = ingestPath === "rss_prefetched";
        const prefetchedMarkdownSource =
          job?.metadata &&
          isPlainObject(job.metadata) &&
          typeof job.metadata.prefetchedMarkdownSource === "string"
            ? job.metadata.prefetchedMarkdownSource.trim().toLowerCase()
            : "";

        const jobTag = job ? (
          <Tooltip
            title={
              jobError
                ? t("newsSources.latest.jobError", {
                    error: jobError,
                  })
                : t("newsSources.latest.jobId", {
                    id: job.id,
                  })
            }
          >
            <Tag color={pipelineJobStatusColors[job.status] ?? "default"}>
              {job.status}
            </Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        );
        const ingestPathTag = isRssPrefetched ? (
          <Tag color="cyan">
            {t("newsSources.latest.rssPrefetched")}
          </Tag>
        ) : null;
        const prefetchedMarkdownSourceTag =
          prefetchedMarkdownSource === "content" ? (
            <Tag color="green">
              {t("newsSources.latest.rssPrefetchedContent")}
            </Tag>
          ) : prefetchedMarkdownSource === "description" ? (
            <Tag color="gold">
              {t("newsSources.latest.rssPrefetchedSummary")}
            </Tag>
          ) : prefetchedMarkdownSource === "stub" ? (
            <Tag color="orange">
              {t("newsSources.latest.rssPrefetchedStub")}
            </Tag>
          ) : null;

        const taskTag = task ? (
          <Tooltip
            title={
              taskError
                ? t("newsSources.latest.taskError", {
                    error: taskError,
                  })
                : t("newsSources.latest.taskId", {
                    id: task.id,
                  })
            }
          >
            <Tag color={crawlTaskStatusColors[task.status] ?? "default"}>
              {task.status}
            </Tag>
          </Tooltip>
        ) : null;
        const noTaskHint =
          !task && isRssPrefetched ? (
            <Typography.Text type="secondary">
              {t("newsSources.latest.noCrawlTask")}
            </Typography.Text>
          ) : null;

        const openTaskButton = task ? (
          <Button
            size="small"
            onClick={() => router.push(`/admin/ops/crawl-tasks/${task.id}`)}
          >
            {t("newsSources.actions.openTask")}
          </Button>
        ) : null;

        const articleLink = article ? (
          <Typography.Link
            href={article.url}
            target="_blank"
            rel="noreferrer"
            ellipsis
            title={article.url}
          >
            {article.titleGuess?.trim()
              ? article.titleGuess.trim()
              : article.url}
          </Typography.Link>
        ) : null;

        return (
          <Space direction="vertical" size={2}>
            <Space size={6} wrap>
              {jobTag}
              {ingestPathTag}
              {prefetchedMarkdownSourceTag}
              {taskTag}
              {openTaskButton}
            </Space>
            {job?.createdAt ? (
              <Typography.Text type="secondary">
                {formatDateTime(job.createdAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
            ) : null}
            {articleLink}
            {noTaskHint}
          </Space>
        );
      },
    },
    {
      title: t("newsSources.columns.group"),
      dataIndex: "group",
      key: "group",
      width: 140,
      render: (group: string | null) => (group ? <Tag>{group}</Tag> : null),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 340,
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => void handlePreview(record)}>
            {t("newsSources.actions.preview")}
          </Button>
          {canManage ? (
            <Button size="small" onClick={() => openEdit(record)}>
              {t("common.edit")}
            </Button>
          ) : null}
          {canManage ? (
            <Tooltip
              title={
                record.nextRunAt
                  ? t("newsSources.schedule.current", {
                      time: formatDateTime(record.nextRunAt, locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })
                  : t("newsSources.schedule.none")
              }
            >
              <Button size="small" onClick={() => openSchedule(record)}>
                {record.nextRunAt
                  ? t("newsSources.actions.reschedule")
                  : t("newsSources.actions.schedule")}
              </Button>
            </Tooltip>
          ) : null}
          {canManage ? (
            <Button
              size="small"
              onClick={() => void handleRunNow(record)}
              loading={dispatchingSourceIds.has(record.id)}
              disabled={dispatchingSourceIds.has(record.id)}
            >
              {t("newsSources.actions.runNow")}
            </Button>
          ) : null}
          {canManage ? (
            <Dropdown
              menu={{
                items: [
                  {
                    key: "view-tasks",
                    label: t("newsSources.actions.viewTasks"),
                    onClick: () =>
                      router.push(
                        `/admin/ops/crawl-tasks?sourceId=${record.id}`,
                      ),
                  },
                  { type: "divider" },
                  {
                    key: "retry-latest",
                    label: t("newsSources.ops.retryLatest.label"),
                    onClick: () => void handleRetryLatestFailedTask(record),
                  },
                  {
                    key: "cancel-queued",
                    label: t("newsSources.ops.cancelQueued.label"),
                    onClick: () => void handleCancelQueued(record),
                  },
                  {
                    key: "clear-inflight",
                    label: t("newsSources.ops.clearInflight.label"),
                    onClick: () => void handleClearInflight(record),
                  },
                ],
              }}
              placement="bottomRight"
              trigger={["click"]}
            >
              <Button size="small" loading={opsLoadingSourceIds.has(record.id)}>
                {t("newsSources.actions.ops")}
              </Button>
            </Dropdown>
          ) : null}
          {canManage ? (
            <Button size="small" danger onClick={() => handleDelete(record)}>
              {t("common.delete")}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {canManage && selectedSourceIds.length > 0 ? (
            <Card size="small">
              <Space wrap>
                <Typography.Text strong>
                  {t("newsSources.selection.count", {
                    count: selectedSourceIds.length,
                  })}
                </Typography.Text>
                <Button
                  onClick={() => openBatchSchedule(selectedSources)}
                  disabled={scheduleLoading}
                >
                  {t("newsSources.actions.schedule")}
                </Button>
                <Button
                  type="primary"
                  onClick={() => void handleBatchRunNow()}
                  loading={batchRunLoading}
                >
                  {t("newsSources.actions.runNow")}
                </Button>
                <Button
                  onClick={() => void handleBatchToggleActive(true)}
                  loading={batchToggleLoading}
                >
                  {t("common.enable")}
                </Button>
                <Button
                  onClick={() => void handleBatchToggleActive(false)}
                  loading={batchToggleLoading}
                >
                  {t("common.disable")}
                </Button>
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: "clear-group",
                        label: t("newsSources.actions.clearGroup"),
                        onClick: () => void handleBatchSetGroup(null),
                      },
                      ...uniqueGroups.map((g) => ({
                        key: g,
                        label: g,
                        onClick: () => void handleBatchSetGroup(g),
                      })),
                    ],
                  }}
                  disabled={batchGroupLoading}
                >
                  <Button loading={batchGroupLoading}>
                    {t("newsSources.actions.setGroup")}
                  </Button>
                </Dropdown>
                <Button onClick={() => setSelectedSourceIds([])}>
                  {t("common.clear")}
                </Button>
              </Space>
            </Card>
          ) : null}
          <Input
            id="news-sources-search"
            name="newsSourcesSearch"
            placeholder={t("newsSources.searchPlaceholder")}
            allowClear
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={sources}
            scroll={{ x: "max-content" }}
            rowSelection={
              canManage
                ? {
                    preserveSelectedRowKeys: true,
                    selectedRowKeys: selectedSourceIds,
                    onChange: (keys) => setSelectedSourceIds(keys as string[]),
                  }
                : undefined
            }
            pagination={{
              current: sourcePage,
              pageSize: sourcePageSize,
              total: sourceTotal,
              showTotal: (total) =>
                t("common.totalCount", {
                  count: total,
                }),
              showSizeChanger: screens.md,
              onChange: (page, pageSize) => {
                setSourcePage(page);
                setSourcePageSize(pageSize);
              },
            }}
          />

    </Space>
  );
}
