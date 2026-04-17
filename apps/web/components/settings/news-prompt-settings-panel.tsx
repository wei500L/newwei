"use client";

import {
  Button,
  Card,
  Form,
  Input,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  TokenEstimateExtra,
  TotalTokenEstimateText,
} from "@/components/settings/form-field-feedback";
import {
  useNewsPromptConfigQuery,
  useUpdateNewsPromptConfigMutation,
} from "@/graphql/generated";
import type { UpdateNewsPromptConfigMutationVariables } from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

const PLACEHOLDER_TOKENS = [
  "{{language_hint}}",
  "{{url}}",
  "{{cache_hit}}",
  "{{metadata_section}}",
  "{{keywords_section}}",
  "{{summary_hints_section}}",
  "{{markdown}}",
];

const STAGE_PLACEHOLDER_TOKENS = [
  "{{title}}",
  "{{summary}}",
  "{{language}}",
  "{{markdown}}",
];

export function NewsPromptSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateNewsPromptConfigMutationVariables["input"]>();
  const { data, loading, refetch } = useNewsPromptConfigQuery();
  const [updateConfig, { loading: saving }] =
    useUpdateNewsPromptConfigMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.newsPromptConfig) {
      form.setFieldsValue(data.newsPromptConfig);
    }
  }, [data?.newsPromptConfig, form]);

  const handleSubmit = async (
    values: UpdateNewsPromptConfigMutationVariables["input"],
  ) => {
    try {
      await updateConfig({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.newsPrompts.saved"));
    } catch (error) {
      captureClientError("Failed to save prompt configuration", error);
      messageApi.error(t("settings.newsPrompts.saveFailed"));
    }
  };

  if (loading && !data?.newsPromptConfig) {
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
      <Typography.Paragraph type="secondary" style={{ marginBottom: "0.5rem" }}>
        {t("settings.newsPrompts.description")}
      </Typography.Paragraph>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        {PLACEHOLDER_TOKENS.map((token) => (
          <Tag key={token}>{token}</Tag>
        ))}
      </div>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsPrompts.fields.version")}
          name="version"
          rules={[
            {
              required: true,
              message: t("settings.newsPrompts.validation.version"),
            },
          ]}
        >
          <Input placeholder={t("settings.newsPrompts.placeholders.version")} />
        </Form.Item>

        <Card
          size="small"
          title={t("settings.newsPrompts.cleaningTitle", {
            defaultValue: "Cleaning prompts",
          })}
          style={{ marginBottom: "1rem" }}
        >
          <Form.Item
            label={t("settings.newsPrompts.fields.systemTemplate")}
            name="systemPromptTemplate"
            rules={[
              {
                required: true,
                message: t("settings.newsPrompts.validation.systemTemplate"),
              },
            ]}
            extra={<TokenEstimateExtra name="systemPromptTemplate" />}
          >
            <Input.TextArea
              rows={5}
              placeholder={t(
                "settings.newsPrompts.placeholders.systemTemplate",
              )}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.newsPrompts.fields.userTemplate")}
            name="userPromptTemplate"
            rules={[
              {
                required: true,
                message: t("settings.newsPrompts.validation.userTemplate"),
              },
            ]}
            extra={<TokenEstimateExtra name="userPromptTemplate" />}
          >
            <Input.TextArea
              rows={10}
              placeholder={t("settings.newsPrompts.placeholders.userTemplate")}
            />
          </Form.Item>
          <TotalTokenEstimateText
            systemName="systemPromptTemplate"
            userName="userPromptTemplate"
          />
        </Card>

        <Card
          size="small"
          title={t("settings.newsPrompts.entityTitle", {
            defaultValue: "Entity extraction prompts",
          })}
          style={{ marginBottom: "1rem" }}
        >
          <Typography.Paragraph type="secondary">
            {STAGE_PLACEHOLDER_TOKENS.map((token) => (
              <Tag key={`entity-${token}`}>{token}</Tag>
            ))}
          </Typography.Paragraph>
          <Form.Item
            label={t("settings.newsPrompts.fields.entitySystemTemplate", {
              defaultValue: "Entity system template",
            })}
            name="entitySystemPromptTemplate"
            extra={<TokenEstimateExtra name="entitySystemPromptTemplate" />}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            label={t("settings.newsPrompts.fields.entityUserTemplate", {
              defaultValue: "Entity user template",
            })}
            name="entityUserPromptTemplate"
            extra={<TokenEstimateExtra name="entityUserPromptTemplate" />}
          >
            <Input.TextArea rows={8} />
          </Form.Item>
          <TotalTokenEstimateText
            systemName="entitySystemPromptTemplate"
            userName="entityUserPromptTemplate"
          />
        </Card>

        <Card
          size="small"
          title={t("settings.newsPrompts.sentimentTitle", {
            defaultValue: "Sentiment prompts",
          })}
          style={{ marginBottom: "1rem" }}
        >
          <Typography.Paragraph type="secondary">
            {STAGE_PLACEHOLDER_TOKENS.map((token) => (
              <Tag key={`sentiment-${token}`}>{token}</Tag>
            ))}
          </Typography.Paragraph>
          <Form.Item
            label={t("settings.newsPrompts.fields.sentimentSystemTemplate", {
              defaultValue: "Sentiment system template",
            })}
            name="sentimentSystemPromptTemplate"
            extra={<TokenEstimateExtra name="sentimentSystemPromptTemplate" />}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            label={t("settings.newsPrompts.fields.sentimentUserTemplate", {
              defaultValue: "Sentiment user template",
            })}
            name="sentimentUserPromptTemplate"
            extra={<TokenEstimateExtra name="sentimentUserPromptTemplate" />}
          >
            <Input.TextArea rows={6} />
          </Form.Item>
          <TotalTokenEstimateText
            systemName="sentimentSystemPromptTemplate"
            userName="sentimentUserPromptTemplate"
          />
        </Card>

        <Card
          size="small"
          title={t("settings.newsPrompts.kgTitle", {
            defaultValue: "Knowledge graph prompts",
          })}
          style={{ marginBottom: "1rem" }}
        >
          <Typography.Paragraph type="secondary">
            {STAGE_PLACEHOLDER_TOKENS.map((token) => (
              <Tag key={`kg-${token}`}>{token}</Tag>
            ))}
          </Typography.Paragraph>
          <Form.Item
            label={t("settings.newsPrompts.fields.kgSystemTemplate", {
              defaultValue: "Knowledge graph system template",
            })}
            name="kgSystemPromptTemplate"
            extra={<TokenEstimateExtra name="kgSystemPromptTemplate" />}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            label={t("settings.newsPrompts.fields.kgUserTemplate", {
              defaultValue: "Knowledge graph user template",
            })}
            name="kgUserPromptTemplate"
            extra={<TokenEstimateExtra name="kgUserPromptTemplate" />}
          >
            <Input.TextArea rows={8} />
          </Form.Item>
          <TotalTokenEstimateText
            systemName="kgSystemPromptTemplate"
            userName="kgUserPromptTemplate"
          />
        </Card>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
