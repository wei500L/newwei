"use client";

import { Form, InputNumber, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { SOURCE_CONFIGS } from "./realtime-signals-constants";

export function RealtimeSignalsSourcesSection() {
  const { t } = useTranslation();

  return (
    <>
      <Typography.Title level={5}>
        {t("systemSettings.realtimeSignals.sections.sources")}
      </Typography.Title>
      {SOURCE_CONFIGS.map((sourceConfig) => {
        const sourceName = t(sourceConfig.nameKey, {
          defaultValue: sourceConfig.fallbackName,
        });
        return (
          <Space
            key={sourceConfig.enabledField}
            wrap
            style={{ display: "flex", width: "100%" }}
          >
            <Form.Item
              name={sourceConfig.enabledField}
              valuePropName="checked"
              label={t(
                "systemSettings.realtimeSignals.fields.sourceEnabled",
                {
                  source: sourceName,
                },
              )}
              style={{ minWidth: 280, flex: 1 }}
            >
              <Switch />
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(prev, next) =>
                prev[sourceConfig.enabledField] !==
                next[sourceConfig.enabledField]
              }
            >
              {({ getFieldValue }) => (
                <Form.Item
                  name={sourceConfig.intervalField}
                  label={t(
                    "systemSettings.realtimeSignals.fields.sourceIntervalSec",
                    { source: sourceName },
                  )}
                  style={{ minWidth: 280, flex: 1 }}
                  rules={[
                    {
                      required: true,
                      message: t(
                        "systemSettings.realtimeSignals.validation.sourceIntervalSec",
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
                    disabled={!getFieldValue(sourceConfig.enabledField)}
                  />
                </Form.Item>
              )}
            </Form.Item>
          </Space>
        );
      })}
    </>
  );
}
