"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Form,
  Input,
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

interface NewsClassificationTaxonomyNode {
  path: string;
  displayName: string;
  description: string;
  legacyCategory: string;
  keywords: string[];
  synonyms: string[];
}

interface NewsClassificationSettingsModel {
  enabled: boolean;
  strictFail: boolean;
  enableLlm: boolean;
  enableEmbedding: boolean;
  enableRerank: boolean;
  llmModel: string | null;
  minConfidence: number;
  embeddingTopK: number;
  rerankTopN: number;
  cacheTtlSeconds: number;
  taxonomyVersion: string;
  taxonomy: NewsClassificationTaxonomyNode[];
}

interface QueryData {
  newsClassificationSettings: NewsClassificationSettingsModel;
}

interface MutationData {
  updateNewsClassificationSettings: NewsClassificationSettingsModel;
}

interface FormValues {
  enabled: boolean;
  strictFail: boolean;
  enableLlm: boolean;
  enableEmbedding: boolean;
  enableRerank: boolean;
  llmModel?: string | null;
  minConfidence: number;
  embeddingTopK: number;
  rerankTopN: number;
  cacheTtlSeconds: number;
  taxonomyVersion: string;
  taxonomyJson: string;
}

const NEWS_CLASSIFICATION_SETTINGS_QUERY = gql`
  query NewsClassificationSettings {
    newsClassificationSettings {
      enabled
      strictFail
      enableLlm
      enableEmbedding
      enableRerank
      llmModel
      minConfidence
      embeddingTopK
      rerankTopN
      cacheTtlSeconds
      taxonomyVersion
      taxonomy {
        path
        displayName
        description
        legacyCategory
        keywords
        synonyms
      }
    }
  }
`;

const UPDATE_NEWS_CLASSIFICATION_SETTINGS_MUTATION = gql`
  mutation UpdateNewsClassificationSettings(
    $input: UpdateNewsClassificationSettingsInput!
  ) {
    updateNewsClassificationSettings(input: $input) {
      enabled
      strictFail
      enableLlm
      enableEmbedding
      enableRerank
      llmModel
      minConfidence
      embeddingTopK
      rerankTopN
      cacheTtlSeconds
      taxonomyVersion
      taxonomy {
        path
        displayName
        description
        legacyCategory
        keywords
        synonyms
      }
    }
  }
`;

export function NewsClassificationSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();

  const { data, loading, refetch, error } = useQuery<QueryData>(
    NEWS_CLASSIFICATION_SETTINGS_QUERY,
    {
      fetchPolicy: "cache-and-network",
    },
  );

  const [updateSettings, { loading: saving }] = useMutation<MutationData>(
    UPDATE_NEWS_CLASSIFICATION_SETTINGS_MUTATION,
  );

  useEffect(() => {
    if (!data?.newsClassificationSettings) {
      return;
    }
    const settings = data.newsClassificationSettings;
    form.setFieldsValue({
      enabled: settings.enabled,
      strictFail: settings.strictFail,
      enableLlm: settings.enableLlm,
      enableEmbedding: settings.enableEmbedding,
      enableRerank: settings.enableRerank,
      llmModel: settings.llmModel,
      minConfidence: settings.minConfidence,
      embeddingTopK: settings.embeddingTopK,
      rerankTopN: settings.rerankTopN,
      cacheTtlSeconds: settings.cacheTtlSeconds,
      taxonomyVersion: settings.taxonomyVersion,
      taxonomyJson: JSON.stringify(settings.taxonomy, null, 2),
    });
  }, [data?.newsClassificationSettings, form]);

  const handleSubmit = async (values: FormValues) => {
    try {
      let taxonomy: NewsClassificationTaxonomyNode[] | undefined = undefined;
      const rawTaxonomy = values.taxonomyJson?.trim();
      if (rawTaxonomy) {
        const parsed = JSON.parse(rawTaxonomy);
        if (!Array.isArray(parsed)) {
          throw new Error("taxonomy must be a JSON array");
        }
        taxonomy = parsed as NewsClassificationTaxonomyNode[];
      }

      await updateSettings({
        variables: {
          input: {
            enabled: values.enabled,
            strictFail: values.strictFail,
            enableLlm: values.enableLlm,
            enableEmbedding: values.enableEmbedding,
            enableRerank: values.enableRerank,
            llmModel: values.llmModel?.trim() || null,
            minConfidence: values.minConfidence,
            embeddingTopK: values.embeddingTopK,
            rerankTopN: values.rerankTopN,
            cacheTtlSeconds: values.cacheTtlSeconds,
            taxonomyVersion: values.taxonomyVersion,
            taxonomy,
          },
        },
      });
      await refetch();
      messageApi.success(
        t("settings.newsClassification.messages.saved", {
          defaultValue: "Saved",
        }),
      );
    } catch (err) {
      captureClientError("Failed to save news classification settings", err);
      messageApi.error(
        t("settings.newsClassification.messages.saveFailed", {
          defaultValue: "Failed to save classification settings",
        }),
      );
    }
  };

  if (loading && !data?.newsClassificationSettings) {
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
        {t("settings.newsClassification.description", {
          defaultValue:
            "Configure multi-layer news classification (LLM + Embedding + Reranker) and taxonomy.",
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsClassification.notice.title", {
          defaultValue: "Execution behavior",
        })}
        description={t("settings.newsClassification.notice.body", {
          defaultValue:
            "Strict mode stops the pipeline when any enabled classification layer fails.",
        })}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsClassification.messages.loadFailed", {
            defaultValue: "Failed to load settings",
          })}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsClassification.fields.enabled", {
            defaultValue: "Enabled",
          })}
          name="enabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.strictFail", {
            defaultValue: "Strict fail",
          })}
          name="strictFail"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Space style={{ width: "100%" }} direction="vertical">
          <Form.Item
            label={t("settings.newsClassification.fields.enableLlm", {
              defaultValue: "Enable LLM layer",
            })}
            name="enableLlm"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label={t("settings.newsClassification.fields.enableEmbedding", {
              defaultValue: "Enable Embedding layer",
            })}
            name="enableEmbedding"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label={t("settings.newsClassification.fields.enableRerank", {
              defaultValue: "Enable Reranker layer",
            })}
            name="enableRerank"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
        </Space>

        <Form.Item
          label={t("settings.newsClassification.fields.llmModel", {
            defaultValue: "Override LLM model (optional)",
          })}
          name="llmModel"
        >
          <Input allowClear />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.minConfidence", {
            defaultValue: "Minimum confidence",
          })}
          name="minConfidence"
          rules={[{ required: true, message: "Required" }]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.embeddingTopK", {
            defaultValue: "Embedding Top-K",
          })}
          name="embeddingTopK"
          rules={[{ required: true, message: "Required" }]}
        >
          <InputNumber min={1} max={100} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.rerankTopN", {
            defaultValue: "Rerank Top-N",
          })}
          name="rerankTopN"
          rules={[{ required: true, message: "Required" }]}
        >
          <InputNumber min={1} max={30} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.cacheTtlSeconds", {
            defaultValue: "Cache TTL (seconds)",
          })}
          name="cacheTtlSeconds"
          rules={[{ required: true, message: "Required" }]}
        >
          <InputNumber min={0} max={3600} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.taxonomyVersion", {
            defaultValue: "Taxonomy version",
          })}
          name="taxonomyVersion"
          rules={[{ required: true, message: "Required" }]}
        >
          <Input />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.taxonomyJson", {
            defaultValue: "Taxonomy JSON",
          })}
          name="taxonomyJson"
          extra={t("settings.newsClassification.hints.taxonomyJson", {
            defaultValue:
              "Provide a JSON array of taxonomy nodes with path/displayName/description/legacyCategory/keywords/synonyms.",
          })}
          rules={[{ required: true, message: "Required" }]}
        >
          <Input.TextArea rows={16} />
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
