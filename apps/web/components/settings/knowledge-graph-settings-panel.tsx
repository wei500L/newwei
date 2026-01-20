"use client";

import { Alert, Button, Divider, Form, InputNumber, Select, Slider, Space, Spin, Switch, Typography, message } from "antd";
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

  const minEdgeConfidence = Form.useWatch("minEdgeConfidence", form);
  const dynamicEnabled = Form.useWatch("dynamicEdgeConfidenceEnabled", form);
  const dynamicQuantile = Form.useWatch("dynamicEdgeConfidenceQuantile", form);
  const validationEnabled = Form.useWatch("multiModelValidationEnabled", form);
  const validationModelCount = Form.useWatch("multiModelValidationModelCount", form);
  const validationMaxRelations = Form.useWatch("multiModelValidationMaxRelationsPerArticle", form);

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
        <Divider orientation="left" plain>
          {t("settings.knowledgeGraph.sections.ingestion")}
        </Divider>

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

        <Divider orientation="left" plain>
          {t("settings.knowledgeGraph.sections.quality")}
        </Divider>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.minEdgeConfidence")}
          extra={t("settings.knowledgeGraph.hints.minEdgeConfidence")}
        >
          <Space style={{ width: "100%" }}>
            <Form.Item name="minEdgeConfidence" noStyle>
              <Slider min={0} max={1} step={0.05} style={{ width: 260 }} />
            </Form.Item>
            <Form.Item name="minEdgeConfidence" noStyle>
              <InputNumber min={0} max={1} step={0.05} />
            </Form.Item>
          </Space>
        </Form.Item>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.dynamicEdgeConfidenceEnabled")}
          name="dynamicEdgeConfidenceEnabled"
          valuePropName="checked"
          extra={t("settings.knowledgeGraph.hints.dynamicEdgeConfidenceEnabled")}
        >
          <Switch />
        </Form.Item>

        {dynamicEnabled ? (
          <Form.Item
            label={t("settings.knowledgeGraph.fields.dynamicEdgeConfidenceQuantile")}
            extra={t("settings.knowledgeGraph.hints.dynamicEdgeConfidenceQuantile")}
          >
            <Space style={{ width: "100%" }}>
              <Form.Item name="dynamicEdgeConfidenceQuantile" noStyle>
                <Slider min={0} max={1} step={0.05} style={{ width: 260 }} />
              </Form.Item>
              <Form.Item name="dynamicEdgeConfidenceQuantile" noStyle>
                <InputNumber min={0} max={1} step={0.05} />
              </Form.Item>
            </Space>
          </Form.Item>
        ) : null}

        <Alert
          type="info"
          showIcon
          message={
            dynamicEnabled
              ? t("settings.knowledgeGraph.hints.effectiveThresholdDynamic", {
                  min: typeof minEdgeConfidence === "number" ? minEdgeConfidence.toFixed(2) : "-",
                  quantile: typeof dynamicQuantile === "number" ? dynamicQuantile.toFixed(2) : "-"
                })
              : t("settings.knowledgeGraph.hints.effectiveThresholdStatic", {
                  value: typeof minEdgeConfidence === "number" ? minEdgeConfidence.toFixed(2) : "-"
                })
          }
          style={{ marginBottom: "1rem" }}
        />

        <Divider orientation="left" plain>
          {t("settings.knowledgeGraph.sections.validation")}
        </Divider>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.multiModelValidationEnabled")}
          name="multiModelValidationEnabled"
          valuePropName="checked"
          extra={t("settings.knowledgeGraph.hints.multiModelValidationEnabled")}
        >
          <Switch />
        </Form.Item>

        {validationEnabled ? (
          <>
            <Form.Item
              label={t("settings.knowledgeGraph.fields.multiModelValidationModelCount")}
              name="multiModelValidationModelCount"
              extra={t("settings.knowledgeGraph.hints.multiModelValidationModelCount")}
            >
              <InputNumber min={2} max={3} step={1} style={{ width: "100%" }} />
            </Form.Item>

            <Form.Item
              label={t("settings.knowledgeGraph.fields.multiModelValidationMaxRelationsPerArticle")}
              name="multiModelValidationMaxRelationsPerArticle"
              extra={t("settings.knowledgeGraph.hints.multiModelValidationMaxRelationsPerArticle")}
            >
              <InputNumber min={0} max={20} step={1} style={{ width: "100%" }} />
            </Form.Item>

            <Form.Item
              label={t("settings.knowledgeGraph.fields.multiModelValidationModels")}
              name="multiModelValidationModels"
              extra={t("settings.knowledgeGraph.hints.multiModelValidationModels")}
            >
              <Select mode="tags" placeholder="openai/gpt-4o-mini" />
            </Form.Item>

            <Alert
              type="warning"
              showIcon
              message={t("settings.knowledgeGraph.hints.validationCost", {
                calls:
                  typeof validationModelCount === "number" && typeof validationMaxRelations === "number"
                    ? validationModelCount * validationMaxRelations
                    : "-",
                models: typeof validationModelCount === "number" ? validationModelCount : "-",
                relations: typeof validationMaxRelations === "number" ? validationMaxRelations : "-"
              })}
              style={{ marginBottom: "1rem" }}
            />
          </>
        ) : (
          <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
            {t("settings.knowledgeGraph.hints.multiModelValidationDisabled")}
          </Typography.Paragraph>
        )}

        <Divider orientation="left" plain>
          {t("settings.knowledgeGraph.sections.disambiguation")}
        </Divider>

        <Form.Item
          label={t("settings.knowledgeGraph.fields.entityDisambiguationEnabled")}
          name="entityDisambiguationEnabled"
          valuePropName="checked"
          extra={t("settings.knowledgeGraph.hints.entityDisambiguationEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) => {
            const enabled = Boolean(getFieldValue("entityDisambiguationEnabled"));
            return enabled ? (
              <Form.Item
                label={t("settings.knowledgeGraph.fields.entityDisambiguationMaxCandidates")}
                name="entityDisambiguationMaxCandidates"
                extra={t("settings.knowledgeGraph.hints.entityDisambiguationMaxCandidates")}
              >
                <InputNumber min={2} max={20} step={1} style={{ width: "100%" }} />
              </Form.Item>
            ) : null;
          }}
        </Form.Item>

        <Divider orientation="left" plain>
          {t("settings.knowledgeGraph.sections.cache")}
        </Divider>

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
