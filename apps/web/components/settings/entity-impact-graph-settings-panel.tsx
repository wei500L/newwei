"use client";

import { Alert, Button, Form, InputNumber, Select, Slider, Space, Spin, Switch, Typography, message } from "antd";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  useEntityImpactGraphSettingsQuery,
  useUpdateEntityImpactGraphSettingsMutation
} from "@/graphql/generated";
import type { UpdateEntityImpactGraphSettingsMutationVariables } from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

const CATEGORY_VALUES = ["person", "organization", "stock", "commodity"] as const;

type FormValues = UpdateEntityImpactGraphSettingsMutationVariables["input"];

export function EntityImpactGraphSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const { data, loading, refetch } = useEntityImpactGraphSettingsQuery();
  const [updateSettings, { loading: saving }] = useUpdateEntityImpactGraphSettingsMutation();

  const categoryOptions = useMemo(
    () => [
      { label: t("settings.entityImpactGraph.categories.person"), value: "person" },
      { label: t("settings.entityImpactGraph.categories.organization"), value: "organization" },
      { label: t("settings.entityImpactGraph.categories.stock"), value: "stock" },
      { label: t("settings.entityImpactGraph.categories.commodity"), value: "commodity" }
    ],
    [t]
  );

  useEffect(() => {
    if (data?.entityImpactGraphSettings) {
      form.setFieldsValue(data.entityImpactGraphSettings);
    }
  }, [data?.entityImpactGraphSettings, form]);

  const handleSubmit = async (values: FormValues) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.entityImpactGraph.saved"));
    } catch (error) {
      captureClientError("Failed to save entity impact graph settings", error);
      messageApi.error(t("settings.entityImpactGraph.saveFailed"));
    }
  };

  if (loading && !data?.entityImpactGraphSettings) {
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
        {t("settings.entityImpactGraph.description")}
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        message={t("settings.entityImpactGraph.hints.note")}
        style={{ marginBottom: "1rem" }}
      />
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.entityImpactGraph.fields.enabled")}
          name="enabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.entityImpactGraph.fields.minEntityConfidence")}
          extra={t("settings.entityImpactGraph.hints.minEntityConfidence")}
        >
          <Space style={{ width: "100%" }}>
            <Form.Item name="minEntityConfidence" noStyle>
              <Slider min={0} max={1} step={0.05} style={{ width: 260 }} />
            </Form.Item>
            <Form.Item name="minEntityConfidence" noStyle>
              <InputNumber min={0} max={1} step={0.05} />
            </Form.Item>
          </Space>
        </Form.Item>

        <Form.Item
          label={t("settings.entityImpactGraph.fields.minCorrelation")}
          extra={t("settings.entityImpactGraph.hints.minCorrelation")}
        >
          <Space style={{ width: "100%" }}>
            <Form.Item name="minCorrelation" noStyle>
              <Slider min={0} max={1} step={0.05} style={{ width: 260 }} />
            </Form.Item>
            <Form.Item name="minCorrelation" noStyle>
              <InputNumber min={0} max={1} step={0.05} />
            </Form.Item>
          </Space>
        </Form.Item>

        <Form.Item
          label={t("settings.entityImpactGraph.fields.minCoOccurrence")}
          name="minCoOccurrence"
          extra={t("settings.entityImpactGraph.hints.minCoOccurrence")}
          rules={[{ required: true, message: t("settings.entityImpactGraph.validation.required") }]}
        >
          <InputNumber min={1} max={100} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label={t("settings.entityImpactGraph.fields.maxNodes")}
          extra={t("settings.entityImpactGraph.hints.maxNodes")}
        >
          <Space style={{ width: "100%" }}>
            <Form.Item name="maxNodes" noStyle>
              <Slider min={10} max={500} step={10} style={{ width: 260 }} />
            </Form.Item>
            <Form.Item name="maxNodes" noStyle>
              <InputNumber min={10} max={500} step={10} />
            </Form.Item>
          </Space>
        </Form.Item>

        <Form.Item
          label={t("settings.entityImpactGraph.fields.categories")}
          name="categories"
          extra={t("settings.entityImpactGraph.hints.categories")}
          rules={[{ required: true, message: t("settings.entityImpactGraph.validation.required") }]}
        >
          <Select mode="multiple" options={categoryOptions} placeholder={t("settings.entityImpactGraph.hints.select")} />
        </Form.Item>

        <Form.Item
          label={t("settings.entityImpactGraph.fields.cacheTtlSeconds")}
          name="cacheTtlSeconds"
          extra={t("settings.entityImpactGraph.hints.cacheTtlSeconds")}
          rules={[{ required: true, message: t("settings.entityImpactGraph.validation.required") }]}
        >
          <InputNumber min={0} max={3600} step={10} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} disabled={loading}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t("settings.entityImpactGraph.hints.allowedCategories", { values: CATEGORY_VALUES.join(", ") })}
      </Typography.Paragraph>
    </>
  );
}

