"use client";

import { Alert, Button, Form, Modal, Spin, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";

import { buildSourceStatusRows } from "./realtime-signals/realtime-signals-constants";
import { RealtimeSignalsOverview } from "./realtime-signals/realtime-signals-overview";
import { formatTimestampValue } from "./realtime-signals/realtime-signals-runtime-model";
import { RealtimeSignalsRuntimePanel } from "./realtime-signals/realtime-signals-runtime-panel";
import { RealtimeSignalsSettingsForm } from "./realtime-signals/realtime-signals-settings-form";
import type {
  RealtimeSignalSourceKey,
  RealtimeSignalsSettingsFormValues,
} from "./realtime-signals/realtime-signals-types";
import { useRealtimeSignalsDiagnostics } from "./realtime-signals/use-realtime-signals-diagnostics";
import { useRealtimeSignalsSettings } from "./realtime-signals/use-realtime-signals-settings";

/**
 * Realtime Signals 设置与运行诊断面板（编排层）。
 *
 * 状态分派（FE-RT-01 / FE-RT-03）：
 * - settings 初次加载失败 → 阻断错误态 + Retry，不渲染可提交表单。
 * - diagnostics 加载失败 → 仅诊断区域错误，不破坏已加载的设置表单。
 * - Save/Reset 由 useRealtimeSignalsSettings 的 handler 层门禁互斥（FE-RT-02）。
 */
export function RealtimeSignalsSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<RealtimeSignalsSettingsFormValues>();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const diagnostics = useRealtimeSignalsDiagnostics(apiClient, t);

  const settings = useRealtimeSignalsSettings({
    apiClient,
    form,
    t,
    onSuccess: (msg: string) => messageApi.success(msg),
    onError: (msg: string) => messageApi.error(msg),
    onSaved: () => undefined,
    onDiagnosticsRefresh: () => void diagnostics.refresh(),
  });

  const openskySourceName = t(
    "systemSettings.realtimeSignals.sources.opensky",
  );
  const formatTimestamp = (value?: string) => formatTimestampValue(t, value);

  const sourceStatusRows = useMemo(
    () =>
      settings.settings
        ? buildSourceStatusRows(t, settings.settings, openskySourceName)
        : [],
    [openskySourceName, settings.settings, t],
  );
  const sourceNameByKey: Record<RealtimeSignalSourceKey, string> =
    buildSourceNameByKey(sourceStatusRows);

  const secretStatusRows = useMemo(() => {
    const current = settings.settings;
    const rows = [
      {
        key: "aisRelaySharedSecret",
        label: t("systemSettings.realtimeSignals.status.aisRelaySharedSecret"),
        has: current?.hasAisRelaySharedSecret ?? false,
        source: current?.aisRelaySharedSecretSource ?? "none",
      },
      {
        key: "openskyClientSecret",
        label: t("systemSettings.realtimeSignals.status.openskyClientSecret"),
        has: current?.hasOpenskyClientSecret ?? false,
        source: current?.openskyClientSecretSource ?? "none",
      },
      ...(current?.acledApiEnabled
        ? [
            {
              key: "acledOauthPassword",
              label: t(
                "systemSettings.realtimeSignals.status.acledOauthPassword",
              ),
              has: current.hasAcledOauthPassword,
              source: current.acledOauthPasswordSource,
            },
          ]
        : []),
      {
        key: "cloudflareApiToken",
        label: t("systemSettings.realtimeSignals.status.cloudflareApiToken"),
        has: current?.hasCloudflareApiToken ?? false,
        source: current?.cloudflareApiTokenSource ?? "none",
      },
      {
        key: "wingbitsApiKey",
        label: t("systemSettings.realtimeSignals.status.wingbitsApiKey"),
        has: current?.hasWingbitsApiKey ?? false,
        source: current?.wingbitsApiKeySource ?? "none",
      },
    ];
    return rows;
  }, [settings.settings, t]);

  const handleReset = () => {
    settings.reset((onOk, onCancel) => {
      Modal.confirm({
        title: t("systemSettings.realtimeSignals.modal.resetTitle"),
        content: t("systemSettings.realtimeSignals.modal.resetContent"),
        okText: t("systemSettings.realtimeSignals.modal.confirm"),
        cancelText: t("systemSettings.realtimeSignals.modal.cancel"),
        okButtonProps: { danger: true },
        onOk,
        onCancel,
      });
    });
  };

  const handleSubmit = (values: RealtimeSignalsSettingsFormValues) => {
    void settings.save(values);
  };

  if (settings.loadState.kind === "initialLoading") {
    return (
      <>
        {contextHolder}
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
        >
          <Spin />
        </div>
      </>
    );
  }

  if (settings.loadState.kind === "blockingError") {
    return (
      <>
        {contextHolder}
        <Alert
          type="error"
          showIcon
          message={t("systemSettings.realtimeSignals.errors.loadFailedTitle")}
          description={t(
            "systemSettings.realtimeSignals.errors.loadFailedDescription",
          )}
          action={
            <Button size="small" onClick={settings.retry}>
              {t("common.retry")}
            </Button>
          }
        />
      </>
    );
  }

  if (!settings.settings) {
    return (
      <>
        {contextHolder}
        <Alert
          type="error"
          showIcon
          message={t("systemSettings.realtimeSignals.errors.loadFailed")}
        />
      </>
    );
  }

  const acledApiDisabled = !settings.settings.acledApiEnabled;

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.realtimeSignals.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.realtimeSignals.notice.title")}
        description={t("systemSettings.realtimeSignals.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {settings.refreshError ? (
        <Alert
          type="warning"
          showIcon
          message={settings.refreshError}
          action={
            <Button size="small" onClick={settings.retry}>
              {t("common.retry")}
            </Button>
          }
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <RealtimeSignalsOverview
        settings={settings.settings}
        sourceStatusRows={sourceStatusRows}
        secretStatusRows={secretStatusRows}
        formatTimestamp={formatTimestamp}
      />

      <RealtimeSignalsRuntimePanel
        diagnostics={diagnostics.diagnostics}
        loading={diagnostics.loading}
        error={diagnostics.error}
        settings={settings.settings}
        sourceNameByKey={sourceNameByKey}
        formatTimestamp={formatTimestamp}
        onRefresh={() => void diagnostics.refresh()}
      />

      <RealtimeSignalsSettingsForm
        form={form}
        openskySourceName={openskySourceName}
        acledApiDisabled={acledApiDisabled}
        saving={settings.saving}
        resetting={settings.resetting}
        onSubmit={handleSubmit}
        onReset={handleReset}
      />
    </>
  );
}

function buildSourceNameByKey(
  rows: { sourceKey: RealtimeSignalSourceKey; sourceName: string }[],
): Record<RealtimeSignalSourceKey, string> {
  const result: Partial<Record<RealtimeSignalSourceKey, string>> = {};
  for (const row of rows) {
    result[row.sourceKey] = row.sourceName;
  }
  return result as Record<RealtimeSignalSourceKey, string>;
}
