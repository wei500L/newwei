"use client";

import {
  Alert,
  Button,
  Card,
  Form,
  InputNumber,
  Spin,
  Typography,
  message,
} from "antd";
import Link from "next/link";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { NumberRangeExtra } from "@/components/settings/form-field-feedback";
import { UnitInputNumber } from "@/components/settings/unit-input-number";
import {
  useRateLimitSettingsQuery,
  useUpdateRateLimitSettingsMutation,
} from "@/graphql/generated";
import type { UpdateRateLimitSettingsMutationVariables } from "@/graphql/generated";
import { buildAdminLogsHref } from "@/lib/admin-logs";
import { captureClientError } from "@/lib/client-telemetry";

interface RateLimitFieldGroupProps {
  title: string;
  description: string;
  field: "login" | "crawlCreate" | "rbacWrite";
}

function RateLimitFieldGroup({
  title,
  description,
  field,
}: RateLimitFieldGroupProps) {
  const { t } = useTranslation();

  return (
    <Card size="small" style={{ marginBottom: "1rem" }} title={title}>
      <Typography.Paragraph type="secondary">
        {description}
      </Typography.Paragraph>
      <div style={{ display: "flex", gap: "1rem" }}>
        <Form.Item
          label={t("settings.rateLimits.fields.maxAttempts")}
          name={[field, "limit"]}
          rules={[
            {
              required: true,
              message: t("settings.rateLimits.validation.maxAttempts"),
            },
            {
              type: "number",
              min: 1,
              max: 1000,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 1000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra name={[field, "limit"]} min={1} max={1000} />
          }
        >
          <InputNumber min={1} max={1000} />
        </Form.Item>
        <Form.Item
          label={t("settings.rateLimits.fields.windowSeconds")}
          name={[field, "windowSeconds"]}
          rules={[
            {
              required: true,
              message: t("settings.rateLimits.validation.windowSeconds"),
            },
            {
              type: "number",
              min: 5,
              max: 86_400,
              message: t("common.validation.numberRange", {
                min: 5,
                max: 86_400,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name={[field, "windowSeconds"]}
              min={5}
              max={86_400}
              unit="s"
            />
          }
        >
          <UnitInputNumber min={5} max={86_400} unit="s" />
        </Form.Item>
      </div>
    </Card>
  );
}

export function RateLimitSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateRateLimitSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useRateLimitSettingsQuery();
  const [updateRateLimitSettings, { loading: saving }] =
    useUpdateRateLimitSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.rateLimitSettings) {
      form.setFieldsValue(data.rateLimitSettings);
    }
  }, [data?.rateLimitSettings, form]);

  const handleSubmit = async (
    values: UpdateRateLimitSettingsMutationVariables["input"],
  ) => {
    try {
      await updateRateLimitSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.rateLimits.saved"));
    } catch (error) {
      captureClientError("Failed to save rate limits", error);
      messageApi.error(t("settings.rateLimits.saveFailed"));
    }
  };

  if (loading && !data?.rateLimitSettings) {
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
      <Alert
        type="warning"
        showIcon
        message={t("settings.rateLimits.riskTitle")}
        description={
          <span>
            {t("settings.rateLimits.riskDescription")}{" "}
            <Link href={buildAdminLogsHref({ tab: "audit" })}>
              {t("settings.rateLimits.auditLink")}
            </Link>
          </span>
        }
        style={{ marginBottom: "1rem" }}
      />
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        {t("settings.rateLimits.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <RateLimitFieldGroup
          title={t("settings.rateLimits.login.title")}
          field="login"
          description={t("settings.rateLimits.login.description")}
        />
        <RateLimitFieldGroup
          title={t("settings.rateLimits.crawlCreate.title")}
          field="crawlCreate"
          description={t("settings.rateLimits.crawlCreate.description")}
        />
        <RateLimitFieldGroup
          title={t("settings.rateLimits.rbacWrite.title")}
          field="rbacWrite"
          description={t("settings.rateLimits.rbacWrite.description")}
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
