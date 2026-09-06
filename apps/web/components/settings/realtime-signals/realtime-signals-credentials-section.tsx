"use client";

import { Alert, Form, Input, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

export interface RealtimeSignalsCredentialsSectionProps {
  acledApiDisabled: boolean;
}

export function RealtimeSignalsCredentialsSection({
  acledApiDisabled,
}: RealtimeSignalsCredentialsSectionProps) {
  const { t } = useTranslation();

  return (
    <>
      <Typography.Title level={5}>
        {t("systemSettings.realtimeSignals.sections.credentials")}
      </Typography.Title>
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: "0.75rem" }}
      >
        {t("systemSettings.realtimeSignals.hints.secretOptional")}
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: "1rem" }}
        message={t("systemSettings.realtimeSignals.alerts.aisCredentials.title")}
        description={t(
          "systemSettings.realtimeSignals.alerts.aisCredentials.body",
        )}
      />
      {acledApiDisabled ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t(
            "systemSettings.realtimeSignals.alerts.acledDisabled.title",
          )}
          description={t(
            "systemSettings.realtimeSignals.alerts.acledDisabled.body",
          )}
        />
      ) : null}
      <Space direction="vertical" style={{ width: "100%" }} size={0}>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.aisRelaySharedSecret",
          )}
          name="aisRelaySharedSecret"
          extra={t(
            "systemSettings.realtimeSignals.hints.aisRelaySharedSecret",
          )}
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.secretValue",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t("systemSettings.realtimeSignals.fields.openskyClientId")}
          name="openskyClientId"
          extra={t("systemSettings.realtimeSignals.hints.openskyClientId")}
        >
          <Input
            autoComplete="username"
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.openskyClientId",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.openskyClientSecret",
          )}
          name="openskyClientSecret"
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.secretValue",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.acledOauthUsername",
          )}
          name="acledOauthUsername"
          extra={t(
            "systemSettings.realtimeSignals.hints.acledOauthUsername",
          )}
        >
          <Input
            autoComplete="username"
            disabled={acledApiDisabled}
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.acledOauthUsername",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.acledOauthPassword",
          )}
          name="acledOauthPassword"
        >
          <Input.Password
            autoComplete="new-password"
            disabled={acledApiDisabled}
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.secretValue",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.acledOauthClientId",
          )}
          name="acledOauthClientId"
          extra={t("systemSettings.realtimeSignals.hints.acledOauthClientId")}
        >
          <Input
            autoComplete="off"
            disabled={acledApiDisabled}
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.acledOauthClientId",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "systemSettings.realtimeSignals.fields.cloudflareApiToken",
          )}
          name="cloudflareApiToken"
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.secretValue",
            )}
          />
        </Form.Item>
        <Form.Item
          label={t("systemSettings.realtimeSignals.fields.wingbitsApiKey")}
          name="wingbitsApiKey"
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={t(
              "systemSettings.realtimeSignals.placeholders.secretValue",
            )}
          />
        </Form.Item>
      </Space>
    </>
  );
}
