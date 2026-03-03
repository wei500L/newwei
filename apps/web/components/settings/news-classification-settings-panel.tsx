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
import {
  parseNewsClassificationTaxonomyJson,
  type NewsClassificationTaxonomyNodeInput,
  type NewsClassificationTaxonomyValidationError,
} from "@/lib/news-classification-taxonomy";

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
  taxonomy: NewsClassificationTaxonomyNodeInput[];
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

function getGraphqlErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const graphQLErrors = (
    error as { graphQLErrors?: Array<{ message?: unknown }> }
  ).graphQLErrors;
  if (Array.isArray(graphQLErrors) && graphQLErrors.length > 0) {
    const firstMessage = graphQLErrors[0]?.message;
    if (typeof firstMessage === "string" && firstMessage.trim()) {
      return firstMessage.trim();
    }
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  return null;
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

  const getTaxonomyValidationMessage = (
    validationError: NewsClassificationTaxonomyValidationError,
  ) => {
    switch (validationError.code) {
      case "invalidJson":
        return t("settings.newsClassification.validation.invalidJson", {
          defaultValue: "Taxonomy JSON is invalid",
        });
      case "mustBeArray":
        return t("settings.newsClassification.validation.mustBeArray", {
          defaultValue: "Taxonomy JSON must be an array",
        });
      case "minItems":
        return t("settings.newsClassification.validation.minItems", {
          defaultValue: "Taxonomy must contain at least one node",
        });
      case "nodeInvalid":
      default:
        return t("settings.newsClassification.validation.nodeInvalid", {
          defaultValue: "Taxonomy node #{{index}} is invalid: {{field}}",
          index: validationError.index ?? "?",
          field: validationError.field ?? "node",
        });
    }
  };

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
    const parsedTaxonomy = parseNewsClassificationTaxonomyJson(
      values.taxonomyJson?.trim() ?? "",
    );
    if (!parsedTaxonomy.ok) {
      messageApi.error(getTaxonomyValidationMessage(parsedTaxonomy.error));
      return;
    }

    try {
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
            taxonomy: parsedTaxonomy.taxonomy,
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
        getGraphqlErrorMessage(err) ??
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
          rules={[
            {
              required: true,
              message: t("settings.newsClassification.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.embeddingTopK", {
            defaultValue: "Embedding Top-K",
          })}
          name="embeddingTopK"
          rules={[
            {
              required: true,
              message: t("settings.newsClassification.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={1} max={100} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.rerankTopN", {
            defaultValue: "Rerank Top-N",
          })}
          name="rerankTopN"
          rules={[
            {
              required: true,
              message: t("settings.newsClassification.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={1} max={30} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.cacheTtlSeconds", {
            defaultValue: "Cache TTL (seconds)",
          })}
          name="cacheTtlSeconds"
          rules={[
            {
              required: true,
              message: t("settings.newsClassification.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
        >
          <InputNumber min={0} max={3600} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.newsClassification.fields.taxonomyVersion", {
            defaultValue: "Taxonomy version",
          })}
          name="taxonomyVersion"
          rules={[
            {
              required: true,
              message: t("settings.newsClassification.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
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
          rules={[
            {
              required: true,
              message: t("settings.newsClassification.validation.required", {
                defaultValue: "Required",
              }),
            },
          ]}
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
