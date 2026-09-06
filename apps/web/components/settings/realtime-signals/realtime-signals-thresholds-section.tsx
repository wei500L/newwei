"use client";

import { Form, InputNumber, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

export function RealtimeSignalsThresholdsSection() {
  const { t } = useTranslation();

  return (
    <>
      <Typography.Title level={5}>
        {t("systemSettings.realtimeSignals.sections.thresholds")}
      </Typography.Title>
      <Space wrap style={{ display: "flex", width: "100%" }}>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.keywordSpikeMinCount",
          )}
          name="keywordSpikeMinCount"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.keywordSpikeMinCount",
              ),
            },
            {
              type: "number",
              min: 1,
              max: 500,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 500,
              }),
            },
          ]}
        >
          <InputNumber
            min={1}
            max={500}
            step={1}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.keywordSpikeMultiplier",
          )}
          name="keywordSpikeMultiplier"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.keywordSpikeMultiplier",
              ),
            },
            {
              type: "number",
              min: 1,
              max: 100,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 100,
              }),
            },
          ]}
        >
          <InputNumber
            min={1}
            max={100}
            step={0.1}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.predictionShiftThreshold",
          )}
          name="predictionShiftThreshold"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.predictionShiftThreshold",
              ),
            },
            {
              type: "number",
              min: 1,
              max: 100,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 100,
              }),
            },
          ]}
        >
          <InputNumber
            min={1}
            max={100}
            step={0.1}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.predictionNewsActivityThreshold",
          )}
          name="predictionNewsActivityThreshold"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.predictionNewsActivityThreshold",
              ),
            },
            {
              type: "number",
              min: 0,
              max: 1_000,
              message: t("common.validation.numberRange", {
                min: 0,
                max: 1_000,
              }),
            },
          ]}
        >
          <InputNumber
            min={0}
            max={1_000}
            step={1}
            style={{ width: "100%" }}
          />
        </Form.Item>
      </Space>
    </>
  );
}
