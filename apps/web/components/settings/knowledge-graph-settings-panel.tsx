"use client";

import { Alert, Button, Form, InputNumber, Space, Spin, Switch, Typography, message } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useKnowledgeGraphSettingsQuery, useUpdateKnowledgeGraphSettingsMutation } from "@/graphql/generated";
import type { UpdateKnowledgeGraphSettingsMutationVariables } from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

type FormValues = UpdateKnowledgeGraphSettingsMutationVariables["input"];

export function KnowledgeGraphSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const { data, loading, refetch } = useKnowledgeGraphSettingsQuery();
  const [updateSettings, { loading: saving }] = useUpdateKnowledgeGraphSettingsMutation();

  useEffect(() => {
    if (data?.knowledgeGraphSettings) {
      form.setFieldsValue(data.knowledgeGraphSettings);
    }
  }, [data?.knowledgeGraphSettings, form]);

  const handleSubmit = async (values: FormValues) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.knowledgeGraph.saved"));
    } catch (error) {
      captureClientError("Failed to save knowledge graph settings", error);
      messageApi.error(t("settings.knowledgeGraph.saveFailed"));
    }
  };

  if (loading && !data?.knowledgeGraphSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        {t("settings.knowledgeGraph.description")}
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        message={t("settings.knowledgeGraph.hints.note")}
        style={{ marginBottom: "1rem" }}
      />
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item label={t("settings.knowledgeGraph.fields.enabled")} name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.ingestionEnabled")}
          name="ingestionEnabled"
          valuePropName="checked"
          extra={t("settings.knowledgeGraph.hints.ingestionEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.seedIngestionEnabled")}
          name="seedIngestionEnabled"
          valuePropName="checked"
          extra={t("settings.knowledgeGraph.hints.seedIngestionEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.seedSwIndustriesPerRun")}
          name="seedSwIndustriesPerRun"
          extra={t("settings.knowledgeGraph.hints.seedSwIndustriesPerRun")}
          rules={[{ required: true, message: t("settings.knowledgeGraph.validation.required") }]}
        >
          <InputNumber min={1} max={50} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.maxBatchSize")}
          name="maxBatchSize"
          extra={t("settings.knowledgeGraph.hints.maxBatchSize")}
          rules={[{ required: true, message: t("settings.knowledgeGraph.validation.required") }]}
        >
          <InputNumber min={1} max={500} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.maxRelationsPerArticle")}
          name="maxRelationsPerArticle"
          extra={t("settings.knowledgeGraph.hints.maxRelationsPerArticle")}
          rules={[{ required: true, message: t("settings.knowledgeGraph.validation.required") }]}
        >
          <InputNumber min={0} max={100} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.cacheTtlSeconds")}
          name="cacheTtlSeconds"
          extra={t("settings.knowledgeGraph.hints.cacheTtlSeconds")}
          rules={[{ required: true, message: t("settings.knowledgeGraph.validation.required") }]}
        >
          <Space style={{ width: "100%" }}>
            <InputNumber min={0} max={3600} step={10} style={{ width: "100%" }} />
          </Space>
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} disabled={loading}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
