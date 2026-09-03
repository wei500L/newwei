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
import Link from "next/link";
import { useSession } from "next-auth/react";
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
          t("settings.newsEvents.messages.clusteringAdminLoadFailed"),
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
      t("settings.newsEvents.messages.presetApplied"),
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
        return t("settings.newsEvents.presets.conservative");
      case "aggressive":
        return t("settings.newsEvents.presets.aggressive");
      case "custom":
        return t("settings.newsEvents.presets.custom");
      case "balanced":
      default:
        return t("settings.newsEvents.presets.balanced");
    }
  }, [t, timelinePresetSelection]);

  const handleSubmit = async (values: FormValues) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      await loadClusteringAdminState();
      messageApi.success(
        t("settings.newsEvents.messages.saved"),
      );
    } catch (err) {
      captureClientError("Failed to save news event settings", err);
      messageApi.error(
        t("settings.newsEvents.messages.saveFailed"),
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
          ),
        };
      }
      if (row.status !== "pending") {
        return null;
      }
      if (!llmBackfillReady) {
        return {
          color: "warning",
          text: t("settings.newsEvents.clusteringQueue.automation.blocked"),
        };
      }
      if (!row.lastAttemptAt) {
        return {
          color: "blue",
          text: t("settings.newsEvents.clusteringQueue.automation.nextTick"),
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
          text: t("settings.newsEvents.clusteringQueue.automation.eligible"),
        };
      }

      return {
        color: "default",
        text: t("settings.newsEvents.clusteringQueue.automation.after", {
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
          t("settings.newsEvents.messages.llmBackfillQueued"),
        );
        await loadClusteringAdminState();
      } catch (error) {
        captureClientError("Failed to queue news event llm backfill", error);
        messageApi.error(
          extractApiError(error).message ||
            t("settings.newsEvents.messages.llmBackfillFailed"),
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
          t("settings.newsEvents.messages.failureIgnored"),
        );
        await loadClusteringAdminState();
      } catch (error) {
        captureClientError("Failed to ignore clustering failure group", error);
        messageApi.error(
          extractApiError(error).message ||
            t("settings.newsEvents.messages.failureIgnoreFailed"),
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
        title: t("settings.newsEvents.clusteringQueue.columns.group"),
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
        title: t("settings.newsEvents.clusteringQueue.columns.status"),
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
        title: t("settings.newsEvents.clusteringQueue.columns.items"),
        dataIndex: "itemCount",
        key: "itemCount",
        width: 90,
      },
      {
        title: t("settings.newsEvents.clusteringQueue.columns.recovery"),
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
        title: t("settings.newsEvents.clusteringQueue.columns.samples"),
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
        title: t("settings.newsEvents.clusteringQueue.columns.actions"),
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
              {t("settings.newsEvents.clusteringQueue.actions.llmBackfill")}
            </Button>
            <Button
              size="small"
              disabled={row.status !== "pending"}
              loading={actionGroupId === row.groupId}
              onClick={() => void handleIgnoreFailure(row.groupId)}
            >
              {t("settings.newsEvents.clusteringQueue.actions.ignore")}
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
        {t("settings.newsEvents.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsEvents.notice.title")}
        description={t("settings.newsEvents.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsEvents.messages.loadFailed")}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t("settings.newsEvents.sections.clustering")}
      </Typography.Title>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsEvents.fields.enabled")}
          name="enabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.clusteringMode")}
          name="clusteringMode"
          extra={t("settings.newsEvents.hints.clusteringMode")}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <Select
            options={[
              {
                value: "vector",
                label: t("settings.newsEvents.options.clusteringMode.vector"),
              },
              {
                value: "bertopic_primary",
                label: t(
                  "settings.newsEvents.options.clusteringMode.bertopicPrimary",
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
              message={t("settings.newsEvents.clusteringMode.notice.title")}
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text>
                    {modelServiceReady
                      ? t(
                          "settings.newsEvents.clusteringMode.notice.ready",
                        )
                      : t(
                          "settings.newsEvents.clusteringMode.notice.notReady",
                        )}
                  </Typography.Text>
                  <Link
                    href={buildAdminSettingsHref({
                      page: "ai",
                      panel: "model-service",
                    })}
                  >
                    {t("settings.newsEvents.clusteringMode.actions.modelService")}
                  </Link>
                </Space>
              }
            />

            <Space style={{ width: "100%" }} size="middle" direction="vertical">
              <Form.Item
                label={t("settings.newsEvents.fields.bertopicMinItemsPerGroup")}
                name="bertopicMinItemsPerGroup"
                extra={t("settings.newsEvents.hints.bertopicMinItemsPerGroup")}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required"),
                  },
                ]}
              >
                <InputNumber min={2} max={100} step={1} style={{ width: "100%" }} />
              </Form.Item>

              <Form.Item
                label={t("settings.newsEvents.fields.bertopicMaxItemsPerRequest")}
                name="bertopicMaxItemsPerRequest"
                dependencies={["bertopicMinItemsPerGroup"]}
                extra={t("settings.newsEvents.hints.bertopicMaxItemsPerRequest")}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required"),
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
                label={t("settings.newsEvents.fields.bertopicMinTopicSize")}
                name="bertopicMinTopicSize"
                extra={t("settings.newsEvents.hints.bertopicMinTopicSize")}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required"),
                  },
                ]}
              >
                <InputNumber min={2} max={100} step={1} style={{ width: "100%" }} />
              </Form.Item>
            </Space>
          </>
        ) : null}

        <Form.Item
          label={t("settings.newsEvents.fields.ingestionEnabled")}
          name="ingestionEnabled"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.ingestionEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineEnabled")}
          name="timelineEnabled"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.timelineEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.forceAuthoritativeMode")}
          name="forceAuthoritativeMode"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.forceAuthoritativeMode")}
        >
          <Switch />
        </Form.Item>

        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) => (
            <Form.Item
              label={t(
                "settings.newsEvents.fields.forceMinAuthoritativeSources",
              )}
              name="forceMinAuthoritativeSources"
              extra={t(
                "settings.newsEvents.hints.forceMinAuthoritativeSources",
              )}
              rules={[
                {
                  required: true,
                  message: t("settings.newsEvents.validation.required"),
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
          label={t("settings.newsEvents.fields.maxBatchSize")}
          name="maxBatchSize"
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={1} max={2000} style={{ width: "100%" }} />
        </Form.Item>

        <Space style={{ width: "100%" }} size="middle" direction="vertical">
          <Form.Item
            label={t("settings.newsEvents.fields.backfillDays")}
            name="backfillDays"
            rules={[
              {
                required: true,
                message: t("settings.newsEvents.validation.required"),
              },
            ]}
          >
            <InputNumber min={1} max={365} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item
            label={t("settings.newsEvents.fields.lookbackDays")}
            name="lookbackDays"
            rules={[
              {
                required: true,
                message: t("settings.newsEvents.validation.required"),
              },
            ]}
          >
            <InputNumber min={1} max={365} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMaxEventsPerRun")}
          name="timelineMaxEventsPerRun"
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={1} max={5000} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.vectorMinScore")}
          name="vectorMinScore"
          extra={t("settings.newsEvents.hints.vectorMinScore")}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.crossLanguagePenalty")}
          name="crossLanguagePenalty"
          extra={t("settings.newsEvents.hints.crossLanguagePenalty")}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.classificationGateEnabled")}
          name="classificationGateEnabled"
          valuePropName="checked"
          extra={t("settings.newsEvents.hints.classificationGateEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) => (
            <>
              <Form.Item
                label={t("settings.newsEvents.fields.categoryConflictReject")}
                name="categoryConflictReject"
                valuePropName="checked"
                extra={t("settings.newsEvents.hints.categoryConflictReject")}
              >
                <Switch disabled={!getFieldValue("classificationGateEnabled")} />
              </Form.Item>

              <Form.Item
                label={t("settings.newsEvents.fields.categorySoftPenalty")}
                name="categorySoftPenalty"
                extra={t("settings.newsEvents.hints.categorySoftPenalty")}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required"),
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
                )}
                name="minCategoryConfidenceForGate"
                extra={t(
                  "settings.newsEvents.hints.minCategoryConfidenceForGate",
                )}
                rules={[
                  {
                    required: true,
                    message: t("settings.newsEvents.validation.required"),
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
          {t("settings.newsEvents.sections.timelineClassification")}
        </Typography.Title>

        <Form.Item
          label={t("settings.newsEvents.fields.timelinePreset")}
          extra={t("settings.newsEvents.hints.timelinePreset")}
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
              {t("settings.newsEvents.presets.conservative")}
            </Button>
            <Button
              type={
                timelinePresetSelection === "balanced" ? "primary" : "default"
              }
              onClick={() => applyTimelinePreset("balanced")}
            >
              {t("settings.newsEvents.presets.balanced")}
            </Button>
            <Button
              type={
                timelinePresetSelection === "aggressive"
                  ? "primary"
                  : "default"
              }
              onClick={() => applyTimelinePreset("aggressive")}
            >
              {t("settings.newsEvents.presets.aggressive")}
            </Button>
          </Space>
          <Space size={6} style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">
              {t("settings.newsEvents.hints.closestPreset")}
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
          )}
          name="timelinePresetCustomDistanceThreshold"
          extra={t(
            "settings.newsEvents.hints.timelinePresetCustomDistanceThreshold",
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={0} max={7} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineLowConfidenceThreshold")}
          name="timelineLowConfidenceThreshold"
          dependencies={["timelineHighConfidenceThreshold"]}
          extra={t("settings.newsEvents.hints.timelineLowConfidenceThreshold")}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
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
                  t("settings.newsEvents.validation.lowMustBeAtMostHigh"),
                );
              },
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineHighConfidenceThreshold")}
          name="timelineHighConfidenceThreshold"
          dependencies={["timelineLowConfidenceThreshold"]}
          extra={t("settings.newsEvents.hints.timelineHighConfidenceThreshold")}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
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
                  t("settings.newsEvents.validation.highMustBeAtLeastLow"),
                );
              },
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineDriftKlThreshold")}
          name="timelineDriftKlThreshold"
          extra={t("settings.newsEvents.hints.timelineDriftKlThreshold")}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={0} max={5} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMinBucketItemsForDrift")}
          name="timelineMinBucketItemsForDrift"
          extra={t(
            "settings.newsEvents.hints.timelineMinBucketItemsForDrift",
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={1} max={50} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineCrossCategoryWarningShare")}
          name="timelineCrossCategoryWarningShare"
          extra={t(
            "settings.newsEvents.hints.timelineCrossCategoryWarningShare",
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMaxCategoryDistributionItems")}
          name="timelineMaxCategoryDistributionItems"
          extra={t(
            "settings.newsEvents.hints.timelineMaxCategoryDistributionItems",
          )}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={4} max={64} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.timelineMaxPhaseSummaries")}
          name="timelineMaxPhaseSummaries"
          extra={t("settings.newsEvents.hints.timelineMaxPhaseSummaries")}
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
            },
          ]}
        >
          <InputNumber min={1} max={20} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsEvents.fields.cacheTtlSeconds")}
          name="cacheTtlSeconds"
          rules={[
            {
              required: true,
              message: t("settings.newsEvents.validation.required"),
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
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>

      <Typography.Title level={5} style={{ marginTop: "1.5rem" }}>
        {t("settings.newsEvents.sections.clusteringQueue")}
      </Typography.Title>

      <Card>
        <Space direction="vertical" size="middle" style={{ display: "flex" }}>
          <Descriptions
            size="small"
            column={2}
            items={[
              {
                key: "pendingCount",
                label: t("settings.newsEvents.clusteringQueue.overview.pending"),
                children: failureOverview?.pendingCount ?? 0,
              },
              {
                key: "processingCount",
                label: t(
                  "settings.newsEvents.clusteringQueue.overview.processing",
                ),
                children: failureOverview?.processingCount ?? 0,
              },
              {
                key: "resolvedCount",
                label: t(
                  "settings.newsEvents.clusteringQueue.overview.resolved",
                ),
                children: failureOverview?.resolvedCount ?? 0,
              },
              {
                key: "ignoredCount",
                label: t("settings.newsEvents.clusteringQueue.overview.ignored"),
                children: failureOverview?.ignoredCount ?? 0,
              },
              {
                key: "latestFailureAt",
                label: t("settings.newsEvents.clusteringQueue.overview.latest"),
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
            message={t("settings.newsEvents.clusteringQueue.notice.title")}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>
                  {t("settings.newsEvents.clusteringQueue.notice.body")}
                </Typography.Text>
                <Typography.Text>
                  {llmBackfillReady
                    ? t("settings.newsEvents.clusteringQueue.notice.ready")
                    : t("settings.newsEvents.clusteringQueue.notice.notReady")}
                </Typography.Text>
                {automationEnabled && recoveryAutomation ? (
                  <Typography.Text type="secondary">
                    {t(
                      "settings.newsEvents.clusteringQueue.notice.automation",
                      {
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
                  {t("settings.newsEvents.clusteringQueue.actions.openLlmGateway")}
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
              emptyText: t("settings.newsEvents.clusteringQueue.empty"),
            }}
          />
        </Space>
      </Card>
    </>
  );
}
