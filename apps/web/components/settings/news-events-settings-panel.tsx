"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Form,
  InputNumber,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

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

const NEWS_EVENT_SETTINGS_QUERY = gql`
  query NewsEventSettings {
    newsEventSettings {
      enabled
      ingestionEnabled
      timelineEnabled
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
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();

  const { data, loading, refetch, error } = useQuery<QueryData>(
    NEWS_EVENT_SETTINGS_QUERY,
    {
      fetchPolicy: "cache-and-network",
    },
  );

  const [updateSettings, { loading: saving }] = useMutation<MutationData>(
    UPDATE_NEWS_EVENT_SETTINGS_MUTATION,
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
    </>
  );
}
