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
  Typography,
  message,
} from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

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

  useEffect(() => {
    if (data?.newsEventSettings) {
      form.setFieldsValue(data.newsEventSettings);
    }
  }, [data?.newsEventSettings, form]);

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
