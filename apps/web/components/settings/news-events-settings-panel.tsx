"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import {
  TIMELINE_PRESET_VALUES,
  detectClosestTimelinePreset,
  resolveTimelinePresetValues,
  type TimelinePresetKey,
  type TimelinePresetSelection,
  type TimelinePresetValues,
} from "@/lib/news-events-timeline-presets";

interface NewsEventSettingsModel {
  enabled: boolean;
  ingestionEnabled: boolean;
  timelineEnabled: boolean;
  clusteringMode: "vector" | "bertopic_primary";
  bertopicMinItemsPerGroup: number;
  bertopicMaxItemsPerRequest: number;
  bertopicMinTopicSize: number;
  forceAuthoritativeMode: boolean;
  forceMinAuthoritativeSources: number;
  maxBatchSize: number;
  backfillDays: number;
  lookbackDays: number;
  timelineMaxEventsPerRun: number;
  vectorMinScore: number;
  crossLanguagePenalty: number;
  classificationGateEnabled: boolean;
  categoryConflictReject: boolean;
  categorySoftPenalty: number;
  minCategoryConfidenceForGate: number;
  timelineLowConfidenceThreshold: number;
  timelineHighConfidenceThreshold: number;
  timelineDriftKlThreshold: number;
  timelineMinBucketItemsForDrift: number;
  timelineCrossCategoryWarningShare: number;
  timelineMaxCategoryDistributionItems: number;
  timelineMaxPhaseSummaries: number;
  timelinePresetCustomDistanceThreshold: number;
  cacheTtlSeconds: number;
}

interface QueryData {
  newsEventSettings: NewsEventSettingsModel;
}

interface MutationData {
  updateNewsEventSettings: NewsEventSettingsModel;
}

interface FormValues {
  enabled: boolean;
  ingestionEnabled: boolean;
  timelineEnabled: boolean;
  clusteringMode: "vector" | "bertopic_primary";
  bertopicMinItemsPerGroup: number;
  bertopicMaxItemsPerRequest: number;
  bertopicMinTopicSize: number;
  forceAuthoritativeMode: boolean;
  forceMinAuthoritativeSources: number;
  maxBatchSize: number;
  backfillDays: number;
  lookbackDays: number;
  timelineMaxEventsPerRun: number;
  vectorMinScore: number;
  crossLanguagePenalty: number;
  classificationGateEnabled: boolean;
  categoryConflictReject: boolean;
  categorySoftPenalty: number;
  minCategoryConfidenceForGate: number;
  timelineLowConfidenceThreshold: number;
  timelineHighConfidenceThreshold: number;
  timelineDriftKlThreshold: number;
  timelineMinBucketItemsForDrift: number;
  timelineCrossCategoryWarningShare: number;
  timelineMaxCategoryDistributionItems: number;
  timelineMaxPhaseSummaries: number;
  timelinePresetCustomDistanceThreshold: number;
  cacheTtlSeconds: number;
}

interface ClusteringReadinessResponse {
  modelService: {
    ready: boolean;
    enabled: boolean;
    baseUrl: string | null;
    hasToken: boolean;
  };
  llmBackfill: {
    ready: boolean;
    profileId: string | null;
    profileName: string | null;
    model: string | null;
    apiSurface: "chat_completions" | "responses" | null;
  };
  recoveryAutomation?: {
    enabled: boolean;
    intervalSeconds: number;
    retryAfterSeconds: number;
    batchSize: number;
    actorId: string;
  };
}

interface ClusteringFailureOverview {
  pendingCount: number;
  processingCount: number;
  resolvedCount: number;
  ignoredCount: number;
  latestFailureAt: string | null;
}

interface ClusteringFailureRow {
  groupId: string;
  status: "pending" | "processing" | "resolved" | "ignored";
  clusteringMode: string;
  failureReason: string;
  failureMessage: string | null;
  language: string | null;
  embeddingModel: string | null;
  itemCount: number;
  sampleTitles: string[];
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  activeJobId: string | null;
  progressProcessedCount: number;
  progressTotalCount: number;
  lastRecoveryModel: string | null;
  resolvedAt: string | null;
  resolutionMode: string | null;
  resolvedEventIds: string[];
  createdAt: string;
}

const NEWS_EVENT_SETTINGS_QUERY = gql`
  query NewsEventSettings {
    newsEventSettings {
      enabled
      ingestionEnabled
      timelineEnabled
      clusteringMode
      bertopicMinItemsPerGroup
      bertopicMaxItemsPerRequest
      bertopicMinTopicSize
      forceAuthoritativeMode
      forceMinAuthoritativeSources
      maxBatchSize
      backfillDays
      lookbackDays
      timelineMaxEventsPerRun
      vectorMinScore
      crossLanguagePenalty
      classificationGateEnabled
      categoryConflictReject
      categorySoftPenalty
      minCategoryConfidenceForGate
      timelineLowConfidenceThreshold
      timelineHighConfidenceThreshold
      timelineDriftKlThreshold
      timelineMinBucketItemsForDrift
      timelineCrossCategoryWarningShare
      timelineMaxCategoryDistributionItems
      timelineMaxPhaseSummaries
      timelinePresetCustomDistanceThreshold
      cacheTtlSeconds
    }
  }
`;

const UPDATE_NEWS_EVENT_SETTINGS_MUTATION = gql`
  mutation UpdateNewsEventSettings($input: UpdateNewsEventSettingsInput!) {
    updateNewsEventSettings(input: $input) {
      enabled
      ingestionEnabled
      timelineEnabled
      clusteringMode
      bertopicMinItemsPerGroup
      bertopicMaxItemsPerRequest
      bertopicMinTopicSize
      forceAuthoritativeMode
      forceMinAuthoritativeSources
      maxBatchSize
      backfillDays
      lookbackDays
      timelineMaxEventsPerRun
      vectorMinScore
      crossLanguagePenalty
      classificationGateEnabled
      categoryConflictReject
      categorySoftPenalty
      minCategoryConfidenceForGate
      timelineLowConfidenceThreshold
      timelineHighConfidenceThreshold
      timelineDriftKlThreshold
      timelineMinBucketItemsForDrift
      timelineCrossCategoryWarningShare
      timelineMaxCategoryDistributionItems
      timelineMaxPhaseSummaries
      timelinePresetCustomDistanceThreshold
      cacheTtlSeconds
    }
  }
`;

export function NewsEventsSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const [clusteringReadiness, setClusteringReadiness] =
    useState<ClusteringReadinessResponse | null>(null);
  const [failureOverview, setFailureOverview] =
    useState<ClusteringFailureOverview | null>(null);
  const [failureRows, setFailureRows] = useState<ClusteringFailureRow[]>([]);
  const [failuresLoading, setFailuresLoading] = useState(false);
  const [actionGroupId, setActionGroupId] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const { data, loading, refetch, error } = useQuery<QueryData>(
    NEWS_EVENT_SETTINGS_QUERY,
    {
      fetchPolicy: "cache-and-network",
    },
  );

  const [updateSettings, { loading: saving }] = useMutation<MutationData>(
    UPDATE_NEWS_EVENT_SETTINGS_MUTATION,
  );
  const watchedClusteringMode = Form.useWatch("clusteringMode", form);
  const watchedBertopicMinItemsPerGroup = Form.useWatch(
    "bertopicMinItemsPerGroup",
    form,
  );
  const watchedLowConfidenceThreshold = Form.useWatch(
    "timelineLowConfidenceThreshold",
    form,
  );
  const watchedHighConfidenceThreshold = Form.useWatch(
    "timelineHighConfidenceThreshold",
    form,
  );
  const watchedDriftKlThreshold = Form.useWatch("timelineDriftKlThreshold", form);
  const watchedMinBucketItemsForDrift = Form.useWatch(
    "timelineMinBucketItemsForDrift",
    form,
  );
  const watchedCrossCategoryWarningShare = Form.useWatch(
    "timelineCrossCategoryWarningShare",
    form,
  );
  const watchedMaxCategoryDistributionItems = Form.useWatch(
    "timelineMaxCategoryDistributionItems",
    form,
  );
  const watchedMaxPhaseSummaries = Form.useWatch("timelineMaxPhaseSummaries", form);
  const watchedTimelinePresetCustomDistanceThreshold = Form.useWatch(
    "timelinePresetCustomDistanceThreshold",
    form,
  );

  const loadClusteringAdminState = useCallback(async () => {
    setFailuresLoading(true);
    try {
      const [readinessResponse, overviewResponse, failuresResponse] =
        await Promise.all([
          apiClient.get<ClusteringReadinessResponse>(
            "system-settings/news-events/clustering/readiness",
          ),
          apiClient.get<ClusteringFailureOverview>(
            "system-settings/news-events/clustering/overview",
          ),
          apiClient.get<ClusteringFailureRow[]>(
            "system-settings/news-events/clustering/failures",
            {
              params: { limit: 20 },
            },
          ),
        ]);
      setClusteringReadiness(readinessResponse.data ?? null);
      setFailureOverview(overviewResponse.data ?? null);
      setFailureRows(
        Array.isArray(failuresResponse.data) ? failuresResponse.data : [],
      );
    } catch (error) {
      captureClientError("Failed to load news event clustering admin state", error);
      messageApi.error(
        extractApiError(error).message ||
          t("settings.newsEvents.messages.clusteringAdminLoadFailed", {
            defaultValue: "Failed to load BERTopic clustering diagnostics.",
          }),
      );
    } finally {
      setFailuresLoading(false);
    }
  }, [apiClient, messageApi, t]);

  useEffect(() => {
    void loadClusteringAdminState();
  }, [loadClusteringAdminState]);

  const applyTimelinePreset = (preset: TimelinePresetKey) => {
    form.setFieldsValue(TIMELINE_PRESET_VALUES[preset]);
    messageApi.success(
      t("settings.newsEvents.messages.presetApplied", {
        defaultValue: "Preset applied. Save changes to persist.",
      }),
    );
  };

  useEffect(() => {
    if (data?.newsEventSettings) {
      form.setFieldsValue(data.newsEventSettings);
    }
  }, [data?.newsEventSettings, form]);

  const currentTimelinePresetValues = useMemo<TimelinePresetValues>(() => {
    return resolveTimelinePresetValues({
      timelineLowConfidenceThreshold:
        typeof watchedLowConfidenceThreshold === "number"
          ? watchedLowConfidenceThreshold
          : data?.newsEventSettings.timelineLowConfidenceThreshold,
      timelineHighConfidenceThreshold:
        typeof watchedHighConfidenceThreshold === "number"
          ? watchedHighConfidenceThreshold
          : data?.newsEventSettings.timelineHighConfidenceThreshold,
      timelineDriftKlThreshold:
        typeof watchedDriftKlThreshold === "number"
          ? watchedDriftKlThreshold
          : data?.newsEventSettings.timelineDriftKlThreshold,
      timelineMinBucketItemsForDrift:
        typeof watchedMinBucketItemsForDrift === "number"
          ? watchedMinBucketItemsForDrift
          : data?.newsEventSettings.timelineMinBucketItemsForDrift,
      timelineCrossCategoryWarningShare:
        typeof watchedCrossCategoryWarningShare === "number"
          ? watchedCrossCategoryWarningShare
          : data?.newsEventSettings.timelineCrossCategoryWarningShare,
      timelineMaxCategoryDistributionItems:
        typeof watchedMaxCategoryDistributionItems === "number"
          ? watchedMaxCategoryDistributionItems
          : data?.newsEventSettings.timelineMaxCategoryDistributionItems,
      timelineMaxPhaseSummaries:
        typeof watchedMaxPhaseSummaries === "number"
          ? watchedMaxPhaseSummaries
          : data?.newsEventSettings.timelineMaxPhaseSummaries,
    });
  }, [
    data?.newsEventSettings.timelineCrossCategoryWarningShare,
    data?.newsEventSettings.timelineDriftKlThreshold,
    data?.newsEventSettings.timelineHighConfidenceThreshold,
    data?.newsEventSettings.timelineLowConfidenceThreshold,
    data?.newsEventSettings.timelineMaxCategoryDistributionItems,
    data?.newsEventSettings.timelineMaxPhaseSummaries,
    data?.newsEventSettings.timelineMinBucketItemsForDrift,
    watchedCrossCategoryWarningShare,
    watchedDriftKlThreshold,
    watchedHighConfidenceThreshold,
    watchedLowConfidenceThreshold,
    watchedMaxCategoryDistributionItems,
    watchedMaxPhaseSummaries,
    watchedMinBucketItemsForDrift,
  ]);

  const closestTimelinePresetResult = useMemo(
    () =>
      detectClosestTimelinePreset(currentTimelinePresetValues, {
        customDistanceThreshold:
          typeof watchedTimelinePresetCustomDistanceThreshold === "number"
            ? watchedTimelinePresetCustomDistanceThreshold
            : data?.newsEventSettings.timelinePresetCustomDistanceThreshold,
      }),
    [
      currentTimelinePresetValues,
      data?.newsEventSettings.timelinePresetCustomDistanceThreshold,
      watchedTimelinePresetCustomDistanceThreshold,
    ],
  );
  const timelinePresetSelection: TimelinePresetSelection =
    closestTimelinePresetResult.selection;

  const closestTimelinePresetLabel = useMemo(() => {
    switch (timelinePresetSelection) {
      case "conservative":
        return t("settings.newsEvents.presets.conservative", {
          defaultValue: "Conservative",
        });
      case "aggressive":
        return t("settings.newsEvents.presets.aggressive", {
          defaultValue: "Aggressive",
        });
      case "custom":
        return t("settings.newsEvents.presets.custom", {
          defaultValue: "Custom",
        });
      case "balanced":
      default:
        return t("settings.newsEvents.presets.balanced", {
          defaultValue: "Balanced",
        });
    }
  }, [t, timelinePresetSelection]);

  const handleSubmit = async (values: FormValues) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      await loadClusteringAdminState();
      messageApi.success(
        t("settings.newsEvents.messages.saved", { defaultValue: "Saved" }),
      );
    } catch (err) {
      captureClientError("Failed to save news event settings", err);
      messageApi.error(
        t("settings.newsEvents.messages.saveFailed", {
          defaultValue: "Failed to save",
        }),
      );
    }
  };

  const modelServiceReady = Boolean(
    clusteringReadiness?.modelService.ready,
  );
  const llmBackfillReady = Boolean(clusteringReadiness?.llmBackfill.ready);
  const recoveryAutomation = clusteringReadiness?.recoveryAutomation;
  const automationEnabled = Boolean(recoveryAutomation?.enabled);

  const formatSecondsAsMinutes = useCallback(
    (seconds: number | null | undefined) => {
      const safeSeconds = Math.max(0, Number(seconds ?? 0));
      const minutes = Math.max(1, Math.round(safeSeconds / 60));
      return t("settings.newsEvents.clusteringQueue.automation.minutes", {
        defaultValue: "{{count}} min",
        count: minutes,
      });
    },
    [t],
  );

  const getAutoRetryFeedback = useCallback(
    (row: ClusteringFailureRow) => {
      if (!automationEnabled) {
        return null;
      }
      if (row.status === "processing") {
        return {
          color: "processing",
          text: t(
            "settings.newsEvents.clusteringQueue.automation.processing",
            {
              defaultValue: "Recovery job running",
            },
          ),
        };
      }
      if (row.status !== "pending") {
        return null;
      }
      if (!llmBackfillReady) {
        return {
          color: "warning",
          text: t("settings.newsEvents.clusteringQueue.automation.blocked", {
            defaultValue: "Auto retry blocked: LLM not ready",
          }),
        };
      }
      if (!row.lastAttemptAt) {
        return {
          color: "blue",
          text: t("settings.newsEvents.clusteringQueue.automation.nextTick", {
            defaultValue: "Auto retry on next scheduler tick",
          }),
        };
      }

      const retryAfterMs =
        Math.max(0, recoveryAutomation?.retryAfterSeconds ?? 0) * 1000;
      const nextRetryAt = new Date(
        new Date(row.lastAttemptAt).getTime() + retryAfterMs,
      );
      if (nextRetryAt.getTime() <= Date.now()) {
        return {
          color: "blue",
          text: t("settings.newsEvents.clusteringQueue.automation.eligible", {
            defaultValue: "Auto retry eligible now",
          }),
        };
      }

      return {
        color: "default",
        text: t("settings.newsEvents.clusteringQueue.automation.after", {
          defaultValue: "Auto retry after {{time}}",
          time: nextRetryAt.toLocaleString(),
        }),
      };
    },
    [automationEnabled, llmBackfillReady, recoveryAutomation, t],
  );

  const handleLlmBackfill = useCallback(
    async (groupId: string) => {
      setActionGroupId(groupId);
      try {
        await apiClient.post(
          `system-settings/news-events/clustering/failures/${groupId}/llm-backfill`,
        );
        messageApi.success(
          t("settings.newsEvents.messages.llmBackfillQueued", {
            defaultValue: "LLM backfill queued.",
          }),
        );
        await loadClusteringAdminState();
      } catch (error) {
        captureClientError("Failed to queue news event llm backfill", error);
        messageApi.error(
          extractApiError(error).message ||
            t("settings.newsEvents.messages.llmBackfillFailed", {
              defaultValue: "Failed to queue LLM backfill.",
            }),
        );
      } finally {
        setActionGroupId((current) => (current === groupId ? null : current));
      }
    },
    [apiClient, loadClusteringAdminState, messageApi, t],
  );

  const handleIgnoreFailure = useCallback(
    async (groupId: string) => {
      setActionGroupId(groupId);
      try {
        await apiClient.post(
          `system-settings/news-events/clustering/failures/${groupId}/ignore`,
        );
        messageApi.success(
          t("settings.newsEvents.messages.failureIgnored", {
            defaultValue: "Failure group ignored.",
          }),
        );
        await loadClusteringAdminState();
      } catch (error) {
        captureClientError("Failed to ignore clustering failure group", error);
        messageApi.error(
          extractApiError(error).message ||
            t("settings.newsEvents.messages.failureIgnoreFailed", {
              defaultValue: "Failed to ignore failure group.",
            }),
        );
      } finally {
        setActionGroupId((current) => (current === groupId ? null : current));
      }
    },
    [apiClient, loadClusteringAdminState, messageApi, t],
  );

  const failureColumns = useMemo(
    () => [
      {
        title: t("settings.newsEvents.clusteringQueue.columns.group", {
          defaultValue: "Group",
        }),
        dataIndex: "groupId",
        key: "groupId",
        render: (value: string, row: ClusteringFailureRow) => (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{value}</Typography.Text>
            <Typography.Text type="secondary">
              {row.failureReason}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: t("settings.newsEvents.clusteringQueue.columns.status", {
          defaultValue: "Status",
        }),
        key: "status",
        render: (_: unknown, row: ClusteringFailureRow) => (
          <Space wrap>
            <Tag
              color={
                row.status === "pending"
                  ? "warning"
                  : row.status === "processing"
                    ? "processing"
                  : row.status === "resolved"
                    ? "success"
                    : "default"
              }
            >
              {row.status}
            </Tag>
            {row.lastRecoveryModel ? <Tag>{row.lastRecoveryModel}</Tag> : null}
            {row.embeddingModel ? <Tag>{row.embeddingModel}</Tag> : null}
            {row.language ? <Tag>{row.language}</Tag> : null}
          </Space>
        ),
      },
      {
        title: t("settings.newsEvents.clusteringQueue.columns.items", {
          defaultValue: "Items",
        }),
        dataIndex: "itemCount",
        key: "itemCount",
        width: 90,
      },
      {
        title: t("settings.newsEvents.clusteringQueue.columns.recovery", {
          defaultValue: "Recovery",
        }),
        key: "recovery",
        render: (_: unknown, row: ClusteringFailureRow) => {
          const autoRetryFeedback = getAutoRetryFeedback(row);
          return (
            <Space direction="vertical" size={4}>
              <Typography.Text type="secondary">
                {row.progressTotalCount > 0
                  ? `${row.progressProcessedCount}/${row.progressTotalCount}`
                  : "-"}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("settings.newsEvents.clusteringQueue.automation.attempts", {
                  defaultValue: "Attempts: {{count}}",
                  count: row.attemptCount,
                })}
              </Typography.Text>
              {autoRetryFeedback ? (
                <Tag color={autoRetryFeedback.color}>
                  {autoRetryFeedback.text}
                </Tag>
              ) : null}
              {row.activeJobId ? (
                <Typography.Text type="secondary" ellipsis>
                  {row.activeJobId}
                </Typography.Text>
              ) : null}
              {row.lastError ? (
                <Typography.Text type="danger" ellipsis>
                  {row.lastError}
                </Typography.Text>
              ) : null}
            </Space>
          );
        },
      },
      {
        title: t("settings.newsEvents.clusteringQueue.columns.samples", {
          defaultValue: "Samples",
        }),
        key: "sampleTitles",
        render: (_: unknown, row: ClusteringFailureRow) =>
          row.sampleTitles.length > 0 ? (
            <Space direction="vertical" size={2}>
              {row.sampleTitles.slice(0, 3).map((title) => (
                <Typography.Text key={`${row.groupId}:${title}`} ellipsis>
                  {title}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          ),
      },
      {
        title: t("settings.newsEvents.clusteringQueue.columns.actions", {
          defaultValue: "Actions",
        }),
        key: "actions",
        render: (_: unknown, row: ClusteringFailureRow) => (
          <Space wrap>
            <Button
              size="small"
              type="primary"
              disabled={row.status !== "pending" || !llmBackfillReady}
              loading={actionGroupId === row.groupId}
              onClick={() => void handleLlmBackfill(row.groupId)}
            >
              {t("settings.newsEvents.clusteringQueue.actions.llmBackfill", {
                defaultValue: "LLM backfill",
              })}
            </Button>
            <Button
              size="small"
              disabled={row.status !== "pending"}
              loading={actionGroupId === row.groupId}
              onClick={() => void handleIgnoreFailure(row.groupId)}
            >
              {t("settings.newsEvents.clusteringQueue.actions.ignore", {
                defaultValue: "Ignore",
              })}
            </Button>
          </Space>
        ),
      },
    ],
    [
      actionGroupId,
      getAutoRetryFeedback,
      handleIgnoreFailure,
      handleLlmBackfill,
      llmBackfillReady,
      t,
    ],
  );

  if (loading && !data?.newsEventSettings) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("settings.newsEvents.description", {
          defaultValue:
            "Cluster processed news articles into events and generate timelines.",
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsEvents.notice.title", {
          defaultValue: "Notes",
        })}
        description={t("settings.newsEvents.notice.body", {
          defaultValue:
            "Ingestion runs on a schedule. Disable timeline if you only need clustering.",
        })}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsEvents.messages.loadFailed", {
            defaultValue: "Failed to load settings",
          })}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t("settings.newsEvents.sections.clustering", {
          defaultValue: "Clustering",
        })}
      </Typography.Title>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsEvents.fields.enabled", {
            defaultValue: "Enabled",
          })}
          name="enabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.clusteringMode", {
            defaultValue: "Clustering mode",
          })}
          name="clusteringMode"
          extra={t("settings.newsEvents.hints.clusteringMode", {
            defaultValue:
              "Use vector assignment only, or run BERTopic first and queue hard failures for automatic LLM recovery.",
          })}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <Select
            options={[
              {
                value: "vector",
                label: t("settings.newsEvents.options.clusteringMode.vector", {
                  defaultValue: "Vector only",
                }),
              },
              {
                value: "bertopic_primary",
                label: t(
                  "settings.newsEvents.options.clusteringMode.bertopicPrimary",
                  {
                    defaultValue: "BERTopic primary",
                  },
                ),
              },
            ]}
          />
        </Form.Item>

        {watchedClusteringMode === "bertopic_primary" ? (
          <>
            <Alert
              type={modelServiceReady ? "info" : "warning"}
              showIcon
              style={{ marginBottom: "1rem" }}
              message={t("settings.newsEvents.clusteringMode.notice.title", {
                defaultValue: "BERTopic execution path",
              })}
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text>
                    {modelServiceReady
                      ? t(
                          "settings.newsEvents.clusteringMode.notice.ready",
                          {
                            defaultValue:
                              "Model service credentials are available. BERTopic will run before vector fallback.",
                          },
                        )
                      : t(
                          "settings.newsEvents.clusteringMode.notice.notReady",
                          {
                            defaultValue:
                              "Model service is not fully configured. BERTopic requests will fail and affected groups will enter the admin review queue.",
                          },
                        )}
                  </Typography.Text>
                  <Link
                    href={buildAdminSettingsHref({
                      page: "ai",
                      panel: "model-service",
                    })}
                  >
                    {t("settings.newsEvents.clusteringMode.actions.modelService", {
                      defaultValue: "Open model service settings",
                    })}
                  </Link>
                </Space>
              }
            />

            <Space style={{ width: "100%" }} size="middle" direction="vertical">
              <Form.Item
                label={t("settings.newsEvents.fields.bertopicMinItemsPerGroup", {
                  defaultValue: "BERTopic min items per group",
                })}
                name="bertopicMinItemsPerGroup"
                extra={t("settings.newsEvents.hints.bertopicMinItemsPerGroup", {
                  defaultValue:
                    "Language + embedding-model groups below this size skip BERTopic and use vector assignment directly.",
                })}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required", {
                      defaultValue: "Required",
                    }),
                  },
                ]}
              >
                <InputNumber min={2} max={100} step={1} style={{ width: "100%" }} />
              </Form.Item>

              <Form.Item
                label={t("settings.newsEvents.fields.bertopicMaxItemsPerRequest", {
                  defaultValue: "BERTopic max items per request",
                })}
                name="bertopicMaxItemsPerRequest"
                dependencies={["bertopicMinItemsPerGroup"]}
                extra={t("settings.newsEvents.hints.bertopicMaxItemsPerRequest", {
                  defaultValue:
                    "Upper bound for each BERTopic request to control CPU and memory pressure on the model service. Must be greater than or equal to the min items per group.",
                })}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required", {
                      defaultValue: "Required",
                    }),
                  },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      const minItemsPerGroup = Number(
                        getFieldValue("bertopicMinItemsPerGroup"),
                      );
                      if (
                        !Number.isFinite(value) ||
                        !Number.isFinite(minItemsPerGroup) ||
                        value >= minItemsPerGroup
                      ) {
                        return Promise.resolve();
                      }
                      return Promise.reject(
                        new Error(
                          t(
                            "settings.newsEvents.validation.bertopicMaxItemsMustBeAtLeastMinGroup",
                            {
                              defaultValue:
                                "BERTopic max items per request must be greater than or equal to min items per group.",
                            },
                          ),
                        ),
                      );
                    },
                  }),
                ]}
              >
                <InputNumber
                  min={
                    typeof watchedBertopicMinItemsPerGroup === "number"
                      ? Math.max(2, watchedBertopicMinItemsPerGroup)
                      : 2
                  }
                  max={500}
                  step={1}
                  style={{ width: "100%" }}
                />
              </Form.Item>

              <Form.Item
                label={t("settings.newsEvents.fields.bertopicMinTopicSize", {
                  defaultValue: "BERTopic min topic size",
                })}
                name="bertopicMinTopicSize"
                extra={t("settings.newsEvents.hints.bertopicMinTopicSize", {
                  defaultValue:
                    "Minimum local cluster size passed through to BERTopic/HDBSCAN before a topic is kept.",
                })}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required", {
                      defaultValue: "Required",
                    }),
                  },
                ]}
              >
                <InputNumber min={2} max={100} step={1} style={{ width: "100%" }} />
              </Form.Item>
            </Space>
          </>
        ) : null}

        <Form.Item
          label={t("settings.newsEvents.fields.ingestionEnabled", {
            defaultValue: "Ingestion enabled",
          })}
          name="ingestionEnabled"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.ingestionEnabled", {
            defaultValue: "Controls scheduled ingestion jobs.",
          })}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineEnabled", {
            defaultValue: "Timeline enabled",
          })}
          name="timelineEnabled"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.timelineEnabled", {
            defaultValue: "Builds bucketed timeline entries for each event.",
          })}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.forceAuthoritativeMode", {
            defaultValue: "Force authoritative mode",
          })}
          name="forceAuthoritativeMode"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.forceAuthoritativeMode", {
            defaultValue:
              "When enabled, all dashboard timeline event queries are forced to authoritative sources.",
          })}
        >
          <Switch />
        </Form.Item>

        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) => (
            <Form.Item
              label={t(
                "settings.newsEvents.fields.forceMinAuthoritativeSources",
                {
                  defaultValue: "Min authoritative sources",
                },
              )}
              name="forceMinAuthoritativeSources"
              extra={t(
                "settings.newsEvents.hints.forceMinAuthoritativeSources",
                {
                  defaultValue:
                    "Minimum unique authoritative sources required when force authoritative mode is enabled.",
                },
              )}
              rules={[
                {
                  required: true,
                  message: t("settings.newsEvents.validation.required", {
                    defaultValue: "Required",
                  }),
                },
              ]}
            >
              <InputNumber
                min={1}
                max={5}
                disabled={!getFieldValue("forceAuthoritativeMode")}
                style={{ width: "100%" }}
              />
            </Form.Item>
          )}
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.maxBatchSize", {
            defaultValue: "Max batch size",
          })}
          name="maxBatchSize"
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={1} max={2000} style={{ width: "100%" }} />
        </Form.Item>

        <Space style={{ width: "100%" }} size="middle" direction="vertical">
          <Form.Item
            label={t("settings.newsEvents.fields.backfillDays", {
              defaultValue: "Backfill days",
            })}
            name="backfillDays"
            rules={[
              {
                required: true,
                message: t("settings.newsEvents.validation.required", {
                  defaultValue: "Required",
                }),
              },
            ]}
          >
            <InputNumber min={1} max={365} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item
            label={t("settings.newsEvents.fields.lookbackDays", {
              defaultValue: "Lookback days",
            })}
            name="lookbackDays"
            rules={[
              {
                required: true,
                message: t("settings.newsEvents.validation.required", {
                  defaultValue: "Required",
                }),
              },
            ]}
          >
            <InputNumber min={1} max={365} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMaxEventsPerRun", {
            defaultValue: "Timeline max events per run",
          })}
          name="timelineMaxEventsPerRun"
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={1} max={5000} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.vectorMinScore", {
            defaultValue: "Vector min score",
          })}
          name="vectorMinScore"
          extra={t("settings.newsEvents.hints.vectorMinScore", {
            defaultValue: "Higher = stricter vector assignment.",
          })}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.crossLanguagePenalty", {
            defaultValue: "Cross-language penalty",
          })}
          name="crossLanguagePenalty"
          extra={t("settings.newsEvents.hints.crossLanguagePenalty", {
            defaultValue: "Penalty applied when languages differ (0–1).",
          })}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.classificationGateEnabled", {
            defaultValue: "Classification gate enabled",
          })}
          name="classificationGateEnabled"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.classificationGateEnabled", {
            defaultValue:
              "Use classification labels as a conservative gate during event assignment.",
          })}
        >
          <Switch />
        </Form.Item>

        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) => (
            <>
              <Form.Item
                label={t("settings.newsEvents.fields.categoryConflictReject", {
                  defaultValue: "Reject category conflicts",
                })}
                name="categoryConflictReject"
                valuePropName="checked"
                extra={t("settings.newsEvents.hints.categoryConflictReject", {
                  defaultValue:
                    "When enabled, conflicting category candidates are rejected from vector merge.",
                })}
              >
                <Switch disabled={!getFieldValue("classificationGateEnabled")} />
              </Form.Item>

              <Form.Item
                label={t("settings.newsEvents.fields.categorySoftPenalty", {
                  defaultValue: "Category soft penalty",
                })}
                name="categorySoftPenalty"
                extra={t("settings.newsEvents.hints.categorySoftPenalty", {
                  defaultValue:
                    "Penalty multiplier (0-1) for partial category mismatch when hard rejection is off.",
                })}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required", {
                      defaultValue: "Required",
                    }),
                  },
                ]}
              >
                <InputNumber
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={!getFieldValue("classificationGateEnabled")}
                  style={{ width: "100%" }}
                />
              </Form.Item>

              <Form.Item
                label={t(
                  "settings.newsEvents.fields.minCategoryConfidenceForGate",
                  {
                    defaultValue: "Min category confidence",
                  },
                )}
                name="minCategoryConfidenceForGate"
                extra={t(
                  "settings.newsEvents.hints.minCategoryConfidenceForGate",
                  {
                    defaultValue:
                      "Only enforce category gate when signal confidence reaches this threshold.",
                  },
                )}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required", {
                      defaultValue: "Required",
                    }),
                  },
                ]}
              >
                <InputNumber
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={!getFieldValue("classificationGateEnabled")}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </>
          )}
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: "1.5rem" }}>
          {t("settings.newsEvents.sections.timelineClassification", {
            defaultValue: "Timeline classification & drift",
          })}
        </Typography.Title>

        <Form.Item
          label={t("settings.newsEvents.fields.timelinePreset", {
            defaultValue: "Recommended preset",
          })}
          extra={t("settings.newsEvents.hints.timelinePreset", {
            defaultValue:
              "Apply a tuned template for timeline confidence and drift sensitivity.",
          })}
        >
          <Space wrap>
            <Button
              type={
                timelinePresetSelection === "conservative"
                  ? "primary"
                  : "default"
              }
              onClick={() => applyTimelinePreset("conservative")}
            >
              {t("settings.newsEvents.presets.conservative", {
                defaultValue: "Conservative",
              })}
            </Button>
            <Button
              type={
                timelinePresetSelection === "balanced" ? "primary" : "default"
              }
              onClick={() => applyTimelinePreset("balanced")}
            >
              {t("settings.newsEvents.presets.balanced", {
                defaultValue: "Balanced",
              })}
            </Button>
            <Button
              type={
                timelinePresetSelection === "aggressive"
                  ? "primary"
                  : "default"
              }
              onClick={() => applyTimelinePreset("aggressive")}
            >
              {t("settings.newsEvents.presets.aggressive", {
                defaultValue: "Aggressive",
              })}
            </Button>
          </Space>
          <Space size={6} style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">
              {t("settings.newsEvents.hints.closestPreset", {
                defaultValue: "Closest match:",
              })}
            </Typography.Text>
            <Tag
              color={
                timelinePresetSelection === "custom" ? "warning" : "processing"
              }
            >
              {closestTimelinePresetLabel}
            </Tag>
          </Space>
        </Form.Item>

        <Form.Item
          label={t(
            "settings.newsEvents.fields.timelinePresetCustomDistanceThreshold",
            {
              defaultValue: "Preset custom distance threshold",
            },
          )}
          name="timelinePresetCustomDistanceThreshold"
          extra={t(
            "settings.newsEvents.hints.timelinePresetCustomDistanceThreshold",
            {
              defaultValue:
                "When the closest preset distance is above this threshold, preset matching is shown as Custom.",
            },
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={7} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineLowConfidenceThreshold", {
            defaultValue: "Low confidence threshold",
          })}
          name="timelineLowConfidenceThreshold"
          dependencies={["timelineHighConfidenceThreshold"]}
          extra={t("settings.newsEvents.hints.timelineLowConfidenceThreshold", {
            defaultValue:
              "Entries below this confidence are marked tentative in timeline output.",
          })}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
            {
              validator: async (_rule, value: number | null | undefined) => {
                const high = form.getFieldValue(
                  "timelineHighConfidenceThreshold",
                ) as number | null | undefined;
                if (
                  typeof value !== "number" ||
                  typeof high !== "number" ||
                  value <= high
                ) {
                  return;
                }
                throw new Error(
                  t("settings.newsEvents.validation.lowMustBeAtMostHigh", {
                    defaultValue:
                      "Low confidence threshold must be less than or equal to high confidence threshold.",
                  }),
                );
              },
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineHighConfidenceThreshold", {
            defaultValue: "High confidence threshold",
          })}
          name="timelineHighConfidenceThreshold"
          dependencies={["timelineLowConfidenceThreshold"]}
          extra={t("settings.newsEvents.hints.timelineHighConfidenceThreshold", {
            defaultValue:
              "Entries above this confidence are marked as timeline anchors.",
          })}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
            {
              validator: async (_rule, value: number | null | undefined) => {
                const low = form.getFieldValue(
                  "timelineLowConfidenceThreshold",
                ) as number | null | undefined;
                if (
                  typeof value !== "number" ||
                  typeof low !== "number" ||
                  value >= low
                ) {
                  return;
                }
                throw new Error(
                  t("settings.newsEvents.validation.highMustBeAtLeastLow", {
                    defaultValue:
                      "High confidence threshold must be greater than or equal to low confidence threshold.",
                  }),
                );
              },
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineDriftKlThreshold", {
            defaultValue: "Drift KL threshold",
          })}
          name="timelineDriftKlThreshold"
          extra={t("settings.newsEvents.hints.timelineDriftKlThreshold", {
            defaultValue:
              "Higher threshold means fewer topic drift splits between adjacent timeline buckets.",
          })}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={5} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMinBucketItemsForDrift", {
            defaultValue: "Min items per bucket for drift",
          })}
          name="timelineMinBucketItemsForDrift"
          extra={t(
            "settings.newsEvents.hints.timelineMinBucketItemsForDrift",
            {
              defaultValue:
                "Only compare drift when both adjacent buckets have at least this many signals.",
            },
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={1} max={50} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineCrossCategoryWarningShare", {
            defaultValue: "Cross-category warning share",
          })}
          name="timelineCrossCategoryWarningShare"
          extra={t(
            "settings.newsEvents.hints.timelineCrossCategoryWarningShare",
            {
              defaultValue:
                "Trigger a cross-category warning when non-dominant categories exceed this share.",
            },
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMaxCategoryDistributionItems", {
            defaultValue: "Max category distribution items",
          })}
          name="timelineMaxCategoryDistributionItems"
          extra={t(
            "settings.newsEvents.hints.timelineMaxCategoryDistributionItems",
            {
              defaultValue:
                "Limit of category slices returned by timeline/category-distribution metadata.",
            },
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={4} max={64} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMaxPhaseSummaries", {
            defaultValue: "Max phase summaries",
          })}
          name="timelineMaxPhaseSummaries"
          extra={t("settings.newsEvents.hints.timelineMaxPhaseSummaries", {
            defaultValue:
              "Upper bound for staged timeline summaries generated per event.",
          })}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={1} max={20} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.cacheTtlSeconds", {
            defaultValue: "Cache TTL (seconds)",
          })}
          name="cacheTtlSeconds"
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={3600} step={10} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={saving}
            disabled={loading}
          >
            {t("common.saveChanges", { defaultValue: "Save changes" })}
          </Button>
        </Form.Item>
      </Form>

      <Typography.Title level={5} style={{ marginTop: "1.5rem" }}>
        {t("settings.newsEvents.sections.clusteringQueue", {
          defaultValue: "BERTopic failure queue",
        })}
      </Typography.Title>

      <Card>
        <Space direction="vertical" size="middle" style={{ display: "flex" }}>
          <Descriptions
            size="small"
            column={2}
            items={[
              {
                key: "pendingCount",
                label: t("settings.newsEvents.clusteringQueue.overview.pending", {
                  defaultValue: "Pending",
                }),
                children: failureOverview?.pendingCount ?? 0,
              },
              {
                key: "processingCount",
                label: t(
                  "settings.newsEvents.clusteringQueue.overview.processing",
                  {
                    defaultValue: "Processing",
                  },
                ),
                children: failureOverview?.processingCount ?? 0,
              },
              {
                key: "resolvedCount",
                label: t(
                  "settings.newsEvents.clusteringQueue.overview.resolved",
                  {
                    defaultValue: "Resolved",
                  },
                ),
                children: failureOverview?.resolvedCount ?? 0,
              },
              {
                key: "ignoredCount",
                label: t("settings.newsEvents.clusteringQueue.overview.ignored", {
                  defaultValue: "Ignored",
                }),
                children: failureOverview?.ignoredCount ?? 0,
              },
              {
                key: "latestFailureAt",
                label: t("settings.newsEvents.clusteringQueue.overview.latest", {
                  defaultValue: "Latest failure",
                }),
                children: failureOverview?.latestFailureAt ? (
                  new Date(failureOverview.latestFailureAt).toLocaleString()
                ) : (
                  <Typography.Text type="secondary">-</Typography.Text>
                ),
              },
            ]}
          />

          <Alert
            type={llmBackfillReady ? "info" : "warning"}
            showIcon
            message={t("settings.newsEvents.clusteringQueue.notice.title", {
              defaultValue: "Automatic recovery path",
            })}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>
                  {t("settings.newsEvents.clusteringQueue.notice.body", {
                    defaultValue:
                      "Only hard BERTopic request failures enter this queue. Small groups, missing embeddings, and outliers still fall back to the standard vector assignment automatically.",
                  })}
                </Typography.Text>
                <Typography.Text>
                  {llmBackfillReady
                    ? t("settings.newsEvents.clusteringQueue.notice.ready", {
                        defaultValue:
                          "Automatic LLM recovery is ready. Pending groups are retried by the scheduler; manual backfill queues a group immediately.",
                      })
                    : t("settings.newsEvents.clusteringQueue.notice.notReady", {
                        defaultValue:
                          "Automatic LLM recovery is blocked. Configure an active LLM gateway completion profile before pending groups can be retried.",
                      })}
                </Typography.Text>
                {automationEnabled && recoveryAutomation ? (
                  <Typography.Text type="secondary">
                    {t(
                      "settings.newsEvents.clusteringQueue.notice.automation",
                      {
                        defaultValue:
                          "Scheduler: every {{interval}}, retry backoff {{backoff}}, up to {{batchSize}} groups per tick.",
                        interval: formatSecondsAsMinutes(
                          recoveryAutomation.intervalSeconds,
                        ),
                        backoff: formatSecondsAsMinutes(
                          recoveryAutomation.retryAfterSeconds,
                        ),
                        batchSize: recoveryAutomation.batchSize,
                      },
                    )}
                  </Typography.Text>
                ) : null}
                <Link
                  href={buildAdminSettingsHref({
                    page: "ai",
                    panel: "llm-gateway",
                  })}
                >
                  {t("settings.newsEvents.clusteringQueue.actions.openLlmGateway", {
                    defaultValue: "Open LLM gateway settings",
                  })}
                </Link>
              </Space>
            }
          />

          <Table<ClusteringFailureRow>
            rowKey="groupId"
            loading={failuresLoading}
            columns={failureColumns}
            dataSource={failureRows}
            pagination={false}
            scroll={{ x: 920 }}
            locale={{
              emptyText: t("settings.newsEvents.clusteringQueue.empty", {
                defaultValue: "No queued BERTopic failures.",
              }),
            }}
          />
        </Space>
      </Card>
    </>
  );
}
