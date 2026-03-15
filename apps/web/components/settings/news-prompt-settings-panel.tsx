"use client";

import { Button, Form, Input, Spin, Tag, Typography, message } from "antd";
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
            placeholder={t("settings.newsPrompts.placeholders.systemTemplate")}
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
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
