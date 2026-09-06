"use client";

import { Alert, Form, Input, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

export function RealtimeSignalsEndpointsSection() {
  const { t } = useTranslation();

  return (
    <>
      <Typography.Title level={5}>
        {t("systemSettings.realtimeSignals.sections.endpoints")}
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: "1rem" }}
        message={t(
          "systemSettings.realtimeSignals.alerts.aisRelayPurpose.title",
        )}
        description={t(
          "systemSettings.realtimeSignals.alerts.aisRelayPurpose.body",
        )}
      />
      <Space wrap style={{ display: "flex", width: "100%" }}>
        <Form.Item
          label={t("systemSettings.realtimeSignals.fields.openskyBaseUrl")}
          name="openskyBaseUrl"
          style={{ minWidth: 280, flex: 1 }}
          extra={t("systemSettings.realtimeSignals.hints.openskyBaseUrl")}
        >
          <Input
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.openskyBaseUrl",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t("systemSettings.realtimeSignals.fields.openskyTokenUrl")}
          name="openskyTokenUrl"
          style={{ minWidth: 280, flex: 1 }}
          extra={t("systemSettings.realtimeSignals.hints.openskyTokenUrl")}
        >
          <Input
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.openskyTokenUrl",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t("systemSettings.realtimeSignals.fields.aisRelayBaseUrl")}
          name="aisRelayBaseUrl"
          style={{ minWidth: 280, flex: 1 }}
          extra={t("systemSettings.realtimeSignals.hints.aisRelayBaseUrl")}
        >
          <Input
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.aisRelayBaseUrl",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.polymarketProxyUrl",
          )}
          name="polymarketProxyUrl"
          style={{ minWidth: 280, flex: 1 }}
          extra={t("systemSettings.realtimeSignals.hints.polymarketProxyUrl")}
        >
          <Input
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.polymarketProxyUrl",
            )}
          />
        </Form.Item>
      </Space>
    </>
  );
}
