"use client";

import { Alert, Button, Form, Input, Modal, Select, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SectionHeader } from "@/components/section-header";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

interface SystemSecuritySettingsResponse {
  secretEncryptionEnabled: boolean;
  secretEncryptionActive: boolean;
  mfaPolicy: "off" | "admins_only" | "all_users";
  encryptionKeyPresent: boolean;
  encryptionKeyValid: boolean;
  encryptionKeyError: string | null;
}

interface SystemSecuritySettingsFormValues {
  secretEncryptionEnabled: boolean;
  mfaPolicy: "off" | "admins_only" | "all_users";
}

interface OidcConfigResponse {
  enabled: boolean;
  issuerUrl: string;
  discoveryUrl: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string[];
  buttonLabel: string;
  requireEmailVerified: boolean;
}

interface OidcConfigFormValues {
  enabled: boolean;
  issuerUrl: string;
  discoveryUrl?: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  buttonLabel?: string;
  requireEmailVerified?: boolean;
}

const EMPTY_SETTINGS: SystemSecuritySettingsResponse = {
  secretEncryptionEnabled: false,
  secretEncryptionActive: false,
  mfaPolicy: "off",
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
  const [oidcConfig, setOidcConfig] = useState<OidcConfigResponse>({
    enabled: false,
    issuerUrl: "",
    discoveryUrl: "",
    clientId: "",
    hasClientSecret: false,
    scopes: ["openid", "email", "profile"],
    buttonLabel: "",
    requireEmailVerified: true,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingOidc, setSavingOidc] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [oidcForm] = Form.useForm<OidcConfigFormValues>();

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
        secretEncryptionEnabled: data.secretEncryptionEnabled,
        mfaPolicy: data.mfaPolicy,
      });
      const oidcResponse = await apiClient.get<OidcConfigResponse>("auth/admin/oidc-config");
      setOidcConfig(oidcResponse.data);
      oidcForm.setFieldsValue({
        enabled: oidcResponse.data.enabled,
        issuerUrl: oidcResponse.data.issuerUrl,
        discoveryUrl: oidcResponse.data.discoveryUrl || undefined,
        clientId: oidcResponse.data.clientId,
        scopes: oidcResponse.data.scopes,
        buttonLabel: oidcResponse.data.buttonLabel || undefined,
        requireEmailVerified: oidcResponse.data.requireEmailVerified ?? true,
      });
    } catch (error) {
      captureClientError("Failed to load system security settings", error);
      setErrorMessage(t("systemSettings.security.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, oidcForm, t]);

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
          secretEncryptionEnabled: nextEnabled,
          mfaPolicy: values.mfaPolicy,
        });
        const data = response.data ?? EMPTY_SETTINGS;
        setSettings(data);
        form.setFieldsValue({
          secretEncryptionEnabled: data.secretEncryptionEnabled,
          mfaPolicy: data.mfaPolicy,
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
      return <Tag color="error">{t("systemSettings.security.status.keyInvalid")}</Tag>;
    }
    return <Tag color="success">{t("systemSettings.security.status.keyPresent")}</Tag>;
  })();

  const encryptionTag = settings.secretEncryptionActive ? (
    <Tag color="success">{t("systemSettings.security.status.encryptionEnabled")}</Tag>
  ) : (
    <Tag color="default">{t("systemSettings.security.status.encryptionDisabled")}</Tag>
  );

  const handleOidcSubmit = async (values: OidcConfigFormValues) => {
    setSavingOidc(true);
    try {
      const response = await apiClient.put<OidcConfigResponse>("auth/admin/oidc-config", {
        enabled: values.enabled,
        issuerUrl: values.issuerUrl,
        discoveryUrl: values.discoveryUrl,
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        scopes: values.scopes ?? [],
        buttonLabel: values.buttonLabel,
        requireEmailVerified: values.requireEmailVerified ?? true,
      });
      setOidcConfig(response.data);
      oidcForm.setFieldsValue({
        ...values,
        clientSecret: undefined,
      });
      messageApi.success("OIDC configuration saved");
    } catch (error) {
      captureClientError("Failed to save OIDC settings", error);
      messageApi.error(extractApiError(error).message ?? "Failed to save OIDC settings");
    } finally {
      setSavingOidc(false);
    }
  };

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
        />
      );
    }

    if (!settings.secretEncryptionActive && settings.encryptionKeyValid) {
      return (
        <Alert
          type="warning"
          showIcon
          message={t("systemSettings.security.alerts.disabledWithKey.title")}
          description={t("systemSettings.security.alerts.disabledWithKey.body")}
        />
      );
    }

    if (settings.encryptionKeyPresent && !settings.encryptionKeyValid) {
      return (
        <Alert
          type="warning"
          showIcon
          message={t("systemSettings.security.alerts.keyInvalid.title")}
          description={t("systemSettings.security.alerts.keyInvalid.body")}
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
        />
      );
    }

    return null;
  })();

  if (loading && settings === EMPTY_SETTINGS) {
    return (
      <div className="flex justify-center py-10">
        <Spin />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Typography.Paragraph type="secondary" className="m-0">
        {t("systemSettings.security.description")}
      </Typography.Paragraph>

      {topAlert}

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} />
      ) : null}

      <div className="surface-inset">
        <Space wrap>
          <Typography.Text>{t("systemSettings.security.status.label")}</Typography.Text>
          {encryptionTag}
          {keyStatusTag}
          <Tag>
            {t("systemSettings.security.mfaPolicyTag", {
              policy: settings.mfaPolicy,
            })}
          </Tag>
        </Space>
      </div>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          name="secretEncryptionEnabled"
          valuePropName="checked"
          label={t("systemSettings.security.fields.secretEncryptionEnabled")}
          extra={t("systemSettings.security.hints.secretEncryptionEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item label={t("systemSettings.security.fields.mfaPolicy")} name="mfaPolicy">
          <Select
            options={[
              { value: "off", label: t("systemSettings.security.mfaOptions.off") },
              { value: "admins_only", label: t("systemSettings.security.mfaOptions.adminsOnly") },
              { value: "all_users", label: t("systemSettings.security.mfaOptions.allUsers") },
            ]}
          />
        </Form.Item>

        <Button type="primary" htmlType="submit" loading={saving}>
          {t("common.saveChanges")}
        </Button>
      </Form>

      <section className="flex flex-col gap-3">
        <SectionHeader title={t("systemSettings.security.oidc.title")} rule />
        <Typography.Paragraph type="secondary">
          {t("systemSettings.security.oidc.description")}
        </Typography.Paragraph>
        <Alert
          type={oidcConfig.enabled ? "success" : "info"}
          showIcon
          message={t(
            oidcConfig.enabled
              ? oidcConfig.hasClientSecret
                ? "systemSettings.security.oidc.status.enabled"
                : "systemSettings.security.oidc.status.enabledMissingSecret"
              : "systemSettings.security.oidc.status.disabled",
          )}
        />
        <Form form={oidcForm} layout="vertical" onFinish={handleOidcSubmit}>
          <Form.Item name="enabled" valuePropName="checked" label={t("systemSettings.security.oidc.fields.enabled")}>
            <Switch />
          </Form.Item>
          <Form.Item label={t("systemSettings.security.oidc.fields.issuerUrl")} name="issuerUrl" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t("systemSettings.security.oidc.fields.discoveryUrl")} name="discoveryUrl">
            <Input />
          </Form.Item>
          <Form.Item label={t("systemSettings.security.oidc.fields.clientId")} name="clientId" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            label={t(oidcConfig.hasClientSecret ? "systemSettings.security.oidc.fields.clientSecretKeep" : "systemSettings.security.oidc.fields.clientSecret")}
            name="clientSecret"
          >
            <Input.Password />
          </Form.Item>
          <Form.Item label={t("systemSettings.security.oidc.fields.scopes")} name="scopes">
            <Select
              mode="tags"
              tokenSeparators={[",", " "]}
              placeholder={t("systemSettings.security.oidc.scopesPlaceholder")}
            />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.security.oidc.fields.requireEmailVerified")}
            name="requireEmailVerified"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(previous, current) =>
              previous.requireEmailVerified !== current.requireEmailVerified
            }
          >
            {({ getFieldValue }) =>
              getFieldValue("requireEmailVerified") === false ? (
                <Alert
                  type="warning"
                  showIcon
                  className="!mb-4"
                  message={t("systemSettings.security.oidc.unverifiedEmailWarning")}
                />
              ) : null
            }
          </Form.Item>
          <Form.Item label={t("systemSettings.security.oidc.fields.buttonLabel")} name="buttonLabel">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={savingOidc}>
            {t("systemSettings.security.oidc.save")}
          </Button>
        </Form>
      </section>
    </div>
  );
}
