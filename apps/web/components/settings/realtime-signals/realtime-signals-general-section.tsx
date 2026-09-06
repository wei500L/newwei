"use client";

import { Form, InputNumber, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

export function RealtimeSignalsGeneralSection() {
  const { t } = useTranslation();

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t("systemSettings.realtimeSignals.sections.general")}
      </Typography.Title>
      <Form.Item
        name="enabled"
        valuePropName="checked"
        label={t("systemSettings.realtimeSignals.fields.enabled")}
      >
        <Switch />
      </Form.Item>
      <Space wrap style={{ display: "flex", width: "100%" }}>
        <Form.Item
          label={t("systemSettings.realtimeSignals.fields.requestTimeoutMs")}
          name="requestTimeoutMs"
          style={{ minWidth: 220, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.requestTimeoutMs",
              ),
            },
            {
              type: "number",
              min: 1_000,
              max: 120_000,
              message: t("common.validation.numberRange", {
                min: 1_000,
                max: 120_000,
              }),
            },
          ]}
        >
          <InputNumber
            min={1_000}
            max={120_000}
            step={500}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("systemSettings.realtimeSignals.fields.maxRetries")}
          name="maxRetries"
          style={{ minWidth: 220, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.maxRetries",
              ),
            },
            {
              type: "number",
              min: 0,
              max: 6,
              message: t("common.validation.numberRange", {
                min: 0,
                max: 6,
              }),
            },
          ]}
        >
          <InputNumber
            min={0}
            max={6}
            step={1}
            style={{ width: "100%" }}
          />
        </Form.Item>
      </Space>
    </>
  );
}
