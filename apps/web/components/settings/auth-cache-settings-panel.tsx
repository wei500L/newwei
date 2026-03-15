"use client";

import { Button, Form, Spin, Typography, message } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { NumberRangeExtra } from "@/components/settings/form-field-feedback";
import { UnitInputNumber } from "@/components/settings/unit-input-number";
import {
  useAuthCacheSettingsQuery,
  useUpdateAuthCacheSettingsMutation,
} from "@/graphql/generated";
import type { UpdateAuthCacheSettingsMutationVariables } from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

export function AuthCacheSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateAuthCacheSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useAuthCacheSettingsQuery();
  const [updateSettings, { loading: saving }] =
    useUpdateAuthCacheSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.authCacheSettings) {
      form.setFieldsValue(data.authCacheSettings);
    }
  }, [data?.authCacheSettings, form]);

  const handleSubmit = async (
    values: UpdateAuthCacheSettingsMutationVariables["input"],
  ) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.authCache.saved"));
    } catch (error) {
      captureClientError("Failed to save auth cache settings", error);
      messageApi.error(t("settings.authCache.saveFailed"));
    }
  };

  if (loading && !data?.authCacheSettings) {
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
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        {t("settings.authCache.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.authCache.fields.profileTtl")}
          name="profileTtlSeconds"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.profileTtlRequired"),
            },
            {
              type: "number",
              min: 60,
              max: 86_400,
              message: t("common.validation.numberRange", {
                min: 60,
                max: 86_400,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="profileTtlSeconds"
              min={60}
              max={86_400}
              unit="s"
            />
          }
        >
          <UnitInputNumber
            min={60}
            max={86_400}
            step={30}
            unit="s"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.authCache.fields.lockTtl")}
          name="lockTtlMs"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.lockTtlRequired"),
            },
            {
              type: "number",
              min: 100,
              max: 60_000,
              message: t("common.validation.numberRange", {
                min: 100,
                max: 60_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="lockTtlMs"
              min={100}
              max={60_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={100}
            max={60_000}
            step={50}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.authCache.fields.maxWait")}
          name="maxWaitMs"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.maxWaitRequired"),
            },
            {
              type: "number",
              min: 50,
              max: 120_000,
              message: t("common.validation.numberRange", {
                min: 50,
                max: 120_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="maxWaitMs"
              min={50}
              max={120_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={50}
            max={120_000}
            step={50}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.authCache.fields.retryDelay")}
          name="retryDelayMs"
          rules={[
            {
              required: true,
              message: t("settings.authCache.validation.retryDelayRequired"),
            },
            {
              type: "number",
              min: 10,
              max: 1_000,
              message: t("common.validation.numberRange", {
                min: 10,
                max: 1_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="retryDelayMs"
              min={10}
              max={1_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={10}
            max={1_000}
            step={10}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
