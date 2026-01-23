"use client";

import { Alert, Button, Card, Form, Modal, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

interface SystemSecuritySettingsResponse {
  secretEncryptionEnabled: boolean;
  encryptionKeyPresent: boolean;
  encryptionKeyValid: boolean;
  encryptionKeyError: string | null;
}

interface SystemSecuritySettingsFormValues {
  secretEncryptionEnabled: boolean;
}

const EMPTY_SETTINGS: SystemSecuritySettingsResponse = {
  secretEncryptionEnabled: false,
  encryptionKeyPresent: false,
  encryptionKeyValid: false,
  encryptionKeyError: null
};

export function SystemSecuritySettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<SystemSecuritySettingsFormValues>();
  const [settings, setSettings] = useState<SystemSecuritySettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<SystemSecuritySettingsResponse>("system-settings/security");
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        secretEncryptionEnabled: data.secretEncryptionEnabled
      });
    } catch (error) {
      captureClientError("Failed to load system security settings", error);
      setErrorMessage(t("systemSettings.security.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (values: SystemSecuritySettingsFormValues) => {
    const nextEnabled = Boolean(values.secretEncryptionEnabled);

    const performSave = async () => {
      setSaving(true);
      setErrorMessage(null);
      try {
        const response = await apiClient.put<SystemSecuritySettingsResponse>("system-settings/security", {
          secretEncryptionEnabled: nextEnabled
        });
        const data = response.data ?? EMPTY_SETTINGS;
        setSettings(data);
        form.setFieldsValue({
          secretEncryptionEnabled: data.secretEncryptionEnabled
        });
        messageApi.success(t("systemSettings.security.messages.saved"));
      } catch (error) {
        captureClientError("Failed to save system security settings", error);
        messageApi.error(extractApiError(error).message ?? t("systemSettings.security.errors.saveFailed"));
      } finally {
        setSaving(false);
      }
    };

    if (!nextEnabled) {
      Modal.confirm({
        title: t("systemSettings.security.modal.disableTitle"),
        content: t("systemSettings.security.modal.disableContent"),
        okText: t("common.confirm"),
        cancelText: t("common.cancel"),
        okButtonProps: { danger: true },
        onOk: async () => performSave()
      });
      return;
    }

    await performSave();
  };

  const keyStatusTag = (() => {
    if (!settings.encryptionKeyPresent) {
      return <Tag color="default">{t("systemSettings.security.status.keyMissing")}</Tag>;
    }
    if (!settings.encryptionKeyValid) {
      return <Tag color="red">{t("systemSettings.security.status.keyInvalid")}</Tag>;
    }
    return <Tag color="green">{t("systemSettings.security.status.keyPresent")}</Tag>;
  })();

  const encryptionTag = settings.secretEncryptionEnabled ? (
    <Tag color="green">{t("systemSettings.security.status.encryptionEnabled")}</Tag>
  ) : (
    <Tag color="default">{t("systemSettings.security.status.encryptionDisabled")}</Tag>
  );

  const topAlert = (() => {
    if (settings.secretEncryptionEnabled && !settings.encryptionKeyValid) {
      return (
        <Alert
          type="error"
          showIcon
          message={t("systemSettings.security.alerts.enabledMissingKey.title")}
          description={
            settings.encryptionKeyError
              ? t("systemSettings.security.alerts.enabledMissingKey.bodyWithError", {
                  error: settings.encryptionKeyError
                })
              : t("systemSettings.security.alerts.enabledMissingKey.body")
          }
          style={{ marginBottom: "1rem" }}
        />
      );
    }

    if (!settings.secretEncryptionEnabled && settings.encryptionKeyValid) {
      return (
        <Alert
          type="info"
          showIcon
          message={t("systemSettings.security.alerts.keyReady.title")}
          description={t("systemSettings.security.alerts.keyReady.body")}
          style={{ marginBottom: "1rem" }}
        />
      );
    }

    if (!settings.encryptionKeyPresent) {
      return (
        <Alert
          type="warning"
          showIcon
          message={t("systemSettings.security.alerts.keyMissing.title")}
          description={t("systemSettings.security.alerts.keyMissing.body")}
          style={{ marginBottom: "1rem" }}
        />
      );
    }

    return null;
  })();

  if (loading && settings === EMPTY_SETTINGS) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.security.description")}
      </Typography.Paragraph>

      {topAlert}

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Card size="small" style={{ marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.security.status.label")}</Typography.Text>
          {encryptionTag}
          {keyStatusTag}
        </Space>
      </Card>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          name="secretEncryptionEnabled"
          valuePropName="checked"
          label={t("systemSettings.security.fields.secretEncryptionEnabled")}
          extra={t("systemSettings.security.hints.secretEncryptionEnabled")}
        >
          <Switch />
        </Form.Item>

        <Button type="primary" htmlType="submit" loading={saving}>
          {t("common.saveChanges")}
        </Button>
      </Form>
    </>
  );
}
