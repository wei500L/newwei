"use client";

import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { gql, useMutation, useQuery } from "@apollo/client";
import { Alert, Button, Form, Input, InputNumber, Space, Spin, Typography, message } from "antd";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

interface NewsDedupeCategoryThresholdModel {
  category: string;
  threshold: number;
}

interface NewsDedupeSettingsModel {
  defaultThreshold: number;
  categoryThresholds: NewsDedupeCategoryThresholdModel[];
}

interface QueryData {
  newsDedupeSettings: NewsDedupeSettingsModel;
}

interface MutationData {
  updateNewsDedupeSettings: NewsDedupeSettingsModel;
}

interface FormValues {
  defaultThreshold: number;
  categoryThresholds: NewsDedupeCategoryThresholdModel[];
}

const NEWS_DEDUPE_SETTINGS_QUERY = gql`
  query NewsDedupeSettings {
    newsDedupeSettings {
      defaultThreshold
      categoryThresholds {
        category
        threshold
      }
    }
  }
`;

const UPDATE_NEWS_DEDUPE_SETTINGS_MUTATION = gql`
  mutation UpdateNewsDedupeSettings($input: UpdateNewsDedupeSettingsInput!) {
    updateNewsDedupeSettings(input: $input) {
      defaultThreshold
      categoryThresholds {
        category
        threshold
      }
    }
  }
`;

function normalizeCategoryThresholds(values: NewsDedupeCategoryThresholdModel[]) {
  const map = new Map<string, NewsDedupeCategoryThresholdModel>();
  for (const entry of values) {
    const category = typeof entry?.category === "string" ? entry.category.trim() : "";
    if (!category) {
      continue;
    }
    const key = category.replace(/\s+/g, " ").toLowerCase();
    const threshold =
      typeof entry.threshold === "number" && Number.isFinite(entry.threshold) ? entry.threshold : 0;
    const clamped = Math.min(1, Math.max(0, threshold));
    map.set(key, { category, threshold: clamped });
    if (map.size >= 100) {
      break;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.category.localeCompare(b.category));
}

export function NewsDedupeSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();

  const { data, loading, refetch, error } = useQuery<QueryData>(NEWS_DEDUPE_SETTINGS_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const [updateSettings, { loading: saving }] = useMutation<MutationData>(UPDATE_NEWS_DEDUPE_SETTINGS_MUTATION);

  useEffect(() => {
    if (data?.newsDedupeSettings) {
      form.setFieldsValue({
        defaultThreshold: data.newsDedupeSettings.defaultThreshold,
        categoryThresholds: data.newsDedupeSettings.categoryThresholds ?? []
      });
    }
  }, [data?.newsDedupeSettings, form]);

  const categoryThresholds = Form.useWatch("categoryThresholds", form);
  const normalizedPreview = useMemo(
    () => normalizeCategoryThresholds(Array.isArray(categoryThresholds) ? categoryThresholds : []),
    [categoryThresholds]
  );

  const handleSubmit = async (values: FormValues) => {
    try {
      const payload: FormValues = {
        defaultThreshold: Math.min(1, Math.max(0, values.defaultThreshold)),
        categoryThresholds: normalizeCategoryThresholds(values.categoryThresholds ?? [])
      };
      await updateSettings({ variables: { input: payload } });
      await refetch();
      messageApi.success(t("settings.newsDedupe.messages.saved", { defaultValue: "Saved" }));
    } catch (err) {
      captureClientError("Failed to save news dedupe settings", err);
      messageApi.error(t("settings.newsDedupe.messages.saveFailed", { defaultValue: "Failed to save" }));
    }
  };

  if (loading && !data?.newsDedupeSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("settings.newsDedupe.description", {
          defaultValue: "Configure semantic dedupe thresholds per topic/category."
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsDedupe.notice.title", { defaultValue: "How it works" })}
        description={t("settings.newsDedupe.notice.body", {
          defaultValue:
            "The pipeline picks the strictest (highest) threshold among matched category/topics; otherwise it uses the default threshold. Length-based adjustments still apply."
        })}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsDedupe.messages.loadFailed", { defaultValue: "Failed to load settings" })}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsDedupe.fields.defaultThreshold", { defaultValue: "Default threshold" })}
          name="defaultThreshold"
          extra={t("settings.newsDedupe.hints.defaultThreshold", {
            defaultValue: "Used when no category/topics match. Range 0–1 (higher = stricter)."
          })}
          rules={[{ required: true, message: t("settings.newsDedupe.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: "0.5rem" }}>
          {t("settings.newsDedupe.sections.overrides", { defaultValue: "Per-topic overrides" })}
        </Typography.Title>

        <Form.List name="categoryThresholds">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Space key={field.key} align="baseline" style={{ display: "flex", marginBottom: 8 }}>
                  <Form.Item
                    {...field}
                    label={t("settings.newsDedupe.fields.category", { defaultValue: "Category/topic" })}
                    name={[field.name, "category"]}
                    rules={[
                      { required: true, message: t("settings.newsDedupe.validation.category", { defaultValue: "Required" }) }
                    ]}
                    style={{ flex: 1, minWidth: 240 }}
                  >
                    <Input
                      placeholder={t("settings.newsDedupe.placeholders.category", {
                        defaultValue: "e.g. finance / 科技 / geopolitics"
                      })}
                    />
                  </Form.Item>

                  <Form.Item
                    {...field}
                    label={t("settings.newsDedupe.fields.threshold", { defaultValue: "Threshold" })}
                    name={[field.name, "threshold"]}
                    rules={[
                      { required: true, message: t("settings.newsDedupe.validation.threshold", { defaultValue: "Required" }) }
                    ]}
                    style={{ width: 220 }}
                  >
                    <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
                  </Form.Item>

                  <Button
                    danger
                    type="text"
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(field.name)}
                    aria-label={t("settings.newsDedupe.actions.remove", { defaultValue: "Remove" })}
                  />
                </Space>
              ))}

              <Form.Item>
                <Button type="dashed" onClick={() => add({ category: "", threshold: 0.92 })} icon={<PlusOutlined />}>
                  {t("settings.newsDedupe.actions.add", { defaultValue: "Add override" })}
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>

        {normalizedPreview.length > 0 ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: "-0.25rem" }}>
            {t("settings.newsDedupe.hints.normalizedCount", {
              defaultValue: "Effective overrides: {{count}}",
              count: normalizedPreview.length
            })}
          </Typography.Paragraph>
        ) : null}

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} disabled={loading}>
            {t("common.saveChanges", { defaultValue: "Save changes" })}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

