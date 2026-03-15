"use client";

import { Button, Form, InputNumber, Spin, Typography, message } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { NumberRangeExtra } from "@/components/settings/form-field-feedback";
import {
  useAuditLogRetentionQuery,
  useUpdateAuditLogRetentionMutation,
} from "@/graphql/generated";
import type { UpdateAuditLogRetentionMutationVariables } from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

export function AuditLogRetentionPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateAuditLogRetentionMutationVariables["input"]>();
  const { data, loading, refetch } = useAuditLogRetentionQuery();
  const [updateRetention, { loading: saving }] =
    useUpdateAuditLogRetentionMutation();
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (data?.auditLogRetention?.retentionDays) {
      form.setFieldsValue({
        retentionDays: data.auditLogRetention.retentionDays,
      });
    }
  }, [data?.auditLogRetention?.retentionDays, form]);

  const handleSubmit = async (
    values: UpdateAuditLogRetentionMutationVariables["input"],
  ) => {
    try {
      await updateRetention({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.auditLog.saved"));
    } catch (error) {
      captureClientError("Failed to update audit log retention", error);
      messageApi.error(t("settings.auditLog.saveFailed"));
    }
  };

  if (loading && !data?.auditLogRetention) {
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
        {t("settings.auditLog.descriptionSystem")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.auditLog.fields.retentionDays")}
          name="retentionDays"
          rules={[
            {
              required: true,
              message: t("settings.auditLog.validation.retentionRequired"),
            },
            {
              type: "number",
              min: 1,
              max: 3650,
              message: t("settings.auditLog.validation.retentionRange"),
            },
          ]}
          extra={<NumberRangeExtra name="retentionDays" min={1} max={3650} />}
        >
          <InputNumber min={1} max={3650} />
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
