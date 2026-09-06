"use client";

import { Form, InputNumber, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

export interface RealtimeSignalsOpenskySectionProps {
  openskySourceName: string;
}

export function RealtimeSignalsOpenskySection({
  openskySourceName,
}: RealtimeSignalsOpenskySectionProps) {
  const { t } = useTranslation();

  return (
    <>
      <Typography.Title level={5}>
        {t("systemSettings.realtimeSignals.sections.openskyBudget")}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        {t("systemSettings.realtimeSignals.hints.openskyBudget")}
      </Typography.Paragraph>
      <Space wrap style={{ display: "flex", width: "100%" }}>
        <Form.Item
          name="openskyEnabled"
          valuePropName="checked"
          label={t("systemSettings.realtimeSignals.fields.sourceEnabled", {
            source: openskySourceName,
          })}
          style={{ minWidth: 280, flex: 1 }}
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyDailyCreditBudget",
          )}
          name="openskyDailyCreditBudget"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.openskyDailyCreditBudget",
              ),
            },
            {
              type: "number",
              min: 1,
              max: 100_000,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 100_000,
              }),
            },
          ]}
        >
          <InputNumber
            min={1}
            max={100_000}
            step={100}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyDayIntervalSec",
          )}
          name="openskyDayIntervalSec"
          style={{ minWidth: 280, flex: 1 }}
          extra={t(
            "systemSettings.realtimeSignals.hints.openskyDayIntervalSec",
          )}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.openskyDayIntervalSec",
              ),
            },
            {
              type: "number",
              min: 30,
              max: 86_400,
              message: t("common.validation.numberRange", {
                min: 30,
                max: 86_400,
              }),
            },
          ]}
        >
          <InputNumber
            min={30}
            max={86_400}
            step={30}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyNightIntervalSec",
          )}
          name="openskyNightIntervalSec"
          style={{ minWidth: 280, flex: 1 }}
          extra={t(
            "systemSettings.realtimeSignals.hints.openskyNightIntervalSec",
          )}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.openskyNightIntervalSec",
              ),
            },
            {
              type: "number",
              min: 30,
              max: 86_400,
              message: t("common.validation.numberRange", {
                min: 30,
                max: 86_400,
              }),
            },
          ]}
        >
          <InputNumber
            min={30}
            max={86_400}
            step={30}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyDayStartHourHkt",
          )}
          name="openskyDayStartHourHkt"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.openskyDayStartHourHkt",
              ),
            },
            {
              type: "number",
              min: 0,
              max: 23,
              message: t("common.validation.numberRange", {
                min: 0,
                max: 23,
              }),
            },
          ]}
        >
          <InputNumber
            min={0}
            max={23}
            step={1}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyNightStartHourHkt",
          )}
          name="openskyNightStartHourHkt"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.openskyNightStartHourHkt",
              ),
            },
            {
              type: "number",
              min: 0,
              max: 23,
              message: t("common.validation.numberRange", {
                min: 0,
                max: 23,
              }),
            },
          ]}
        >
          <InputNumber
            min={0}
            max={23}
            step={1}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyWarningRemainingPct",
          )}
          name="openskyWarningRemainingPct"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.openskyWarningRemainingPct",
              ),
            },
            {
              type: "number",
              min: 1,
              max: 99,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 99,
              }),
            },
          ]}
        >
          <InputNumber
            min={1}
            max={99}
            step={1}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyCriticalRemainingPct",
          )}
          name="openskyCriticalRemainingPct"
          style={{ minWidth: 280, flex: 1 }}
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.realtimeSignals.validation.openskyCriticalRemainingPct",
              ),
            },
            {
              type: "number",
              min: 0,
              max: 98,
              message: t("common.validation.numberRange", {
                min: 0,
                max: 98,
              }),
            },
          ]}
        >
          <InputNumber
            min={0}
            max={98}
            step={1}
            style={{ width: "100%" }}
          />
        </Form.Item>
      </Space>
    </>
  );
}
