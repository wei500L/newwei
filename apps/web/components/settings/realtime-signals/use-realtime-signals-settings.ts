"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import {
  REALTIME_SIGNALS_SECRET_FIELD_NAMES,
  applyRealtimeSignalsSecretFields,
  type RealtimeSignalsSecretFieldName,
} from "@/lib/realtime-signals-settings-payload";

import {
  REALTIME_SIGNALS_SETTINGS_URL,
  mergeSettingsDefaults,
  toFormValues,
} from "./realtime-signals-constants";
import type {
  RealtimeSignalsFormInstance,
  RealtimeSignalsLoadState,
  RealtimeSignalsSettingsFormValues,
  RealtimeSignalsSettingsResponse,
} from "./realtime-signals-types";

export type RealtimeSignalsOperation = "save" | "reset" | null;

type RealtimeSignalsApiClient = ReturnType<typeof createApiClient>;

export interface RealtimeSignalsOperationGate {
  operation: RealtimeSignalsOperation;
  begin: (operation: Exclude<RealtimeSignalsOperation, null>) => boolean;
  end: () => void;
}

/**
 * handler 层写操作门禁（FE-RT-02）：同一时刻最多一个 PUT / DELETE，
 * 不依赖按钮 disabled。请求结束后可靠释放（finally）。
 */
export function useRealtimeSignalsOperationGate(): RealtimeSignalsOperationGate {
  const [operation, setOperation] =
    useState<RealtimeSignalsOperation>(null);
  const operationRef = useRef<RealtimeSignalsOperation>(null);

  const begin = useCallback(
    (next: Exclude<RealtimeSignalsOperation, null>) => {
      if (operationRef.current !== null) {
        return false;
      }
      operationRef.current = next;
      setOperation(next);
      return true;
    },
    [],
  );

  const end = useCallback(() => {
    operationRef.current = null;
    setOperation(null);
  }, []);

  return { operation, begin, end };
}

export interface UseRealtimeSignalsSettingsResult {
  settings: RealtimeSignalsSettingsResponse | null;
  loadState: RealtimeSignalsLoadState;
  /** 已有真实数据后的刷新失败（非阻断，保留旧数据）。 */
  refreshError: string | null;
  saving: boolean;
  resetting: boolean;
  operation: RealtimeSignalsOperation;
  save: (values: RealtimeSignalsSettingsFormValues) => Promise<void>;
  reset: (confirm: (onOk: () => Promise<void>, onCancel: () => void) => void) => void;
  retry: () => void;
}

interface UseRealtimeSignalsSettingsOptions {
  apiClient: RealtimeSignalsApiClient;
  form: RealtimeSignalsFormInstance;
  t: (key: string, options?: Record<string, unknown>) => string;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  onSaved: () => void;
  /** 保存/重置成功后刷新 diagnostics（不 await）。 */
  onDiagnosticsRefresh: () => void;
}

export function useRealtimeSignalsSettings({
  apiClient,
  form,
  t,
  onSuccess,
  onError,
  onSaved,
  onDiagnosticsRefresh,
}: UseRealtimeSignalsSettingsOptions): UseRealtimeSignalsSettingsResult {
  const [settings, setSettings] =
    useState<RealtimeSignalsSettingsResponse | null>(null);
  const [loadState, setLoadState] = useState<RealtimeSignalsLoadState>({
    kind: "initialLoading",
  });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const gate = useRealtimeSignalsOperationGate();

  const applySettings = useCallback(
    (data: RealtimeSignalsSettingsResponse) => {
      setSettings(data);
      form.setFieldsValue(toFormValues(data));
    },
    [form],
  );

  const load = useCallback(async () => {
    // 首次加载（无真实数据）失败 → 阻断错误态，不渲染可提交表单。
    setRefreshError(null);
    try {
      const response =
        await apiClient.get<RealtimeSignalsSettingsResponse>(
          REALTIME_SIGNALS_SETTINGS_URL,
        );
      applySettings(mergeSettingsDefaults(response.data));
      setLoadState({ kind: "ready" });
    } catch (error) {
      captureClientError("Failed to load realtime signals settings", error);
      if (settings === null) {
        setLoadState({ kind: "blockingError" });
      } else {
        // 已有真实数据：保留旧数据，展示非阻断错误。
        setRefreshError(t("systemSettings.realtimeSignals.errors.loadFailed"));
      }
    }
  }, [apiClient, applySettings, settings, t]);

  useEffect(() => {
    void load();
    // 仅在挂载时执行首次加载；Retry 由 retry() 显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = useCallback(() => {
    if (settings === null) {
      setLoadState({ kind: "initialLoading" });
    }
    void load();
  }, [load, settings]);

  const save = useCallback(
    async (values: RealtimeSignalsSettingsFormValues) => {
      if (!gate.begin("save")) {
        return;
      }
      setSaving(true);
      setRefreshError(null);
      try {
        const payload: Record<string, unknown> = {
          enabled: values.enabled,
          requestTimeoutMs: values.requestTimeoutMs,
          maxRetries: values.maxRetries,
          openskyEnabled: values.openskyEnabled,
          openskyIntervalSec: values.openskyIntervalSec,
          openskyDailyCreditBudget: values.openskyDailyCreditBudget,
          openskyDayIntervalSec: values.openskyDayIntervalSec,
          openskyNightIntervalSec: values.openskyNightIntervalSec,
          openskyDayStartHourHkt: values.openskyDayStartHourHkt,
          openskyNightStartHourHkt: values.openskyNightStartHourHkt,
          openskyWarningRemainingPct: values.openskyWarningRemainingPct,
          openskyCriticalRemainingPct: values.openskyCriticalRemainingPct,
          aisEnabled: values.aisEnabled,
          aisIntervalSec: values.aisIntervalSec,
          unrestEnabled: values.unrestEnabled,
          unrestIntervalSec: values.unrestIntervalSec,
          outagesEnabled: values.outagesEnabled,
          outagesIntervalSec: values.outagesIntervalSec,
          keywordSpikeEnabled: values.keywordSpikeEnabled,
          keywordSpikeIntervalSec: values.keywordSpikeIntervalSec,
          pizzintEnabled: values.pizzintEnabled,
          pizzintIntervalSec: values.pizzintIntervalSec,
          gdeltTensionEnabled: values.gdeltTensionEnabled,
          gdeltTensionIntervalSec: values.gdeltTensionIntervalSec,
          polymarketLeadsEnabled: values.polymarketLeadsEnabled,
          polymarketLeadsIntervalSec: values.polymarketLeadsIntervalSec,
          keywordSpikeMinCount: values.keywordSpikeMinCount,
          keywordSpikeMultiplier: values.keywordSpikeMultiplier,
          predictionShiftThreshold: values.predictionShiftThreshold,
          predictionNewsActivityThreshold:
            values.predictionNewsActivityThreshold,
          openskyBaseUrl: values.openskyBaseUrl?.trim()
            ? values.openskyBaseUrl.trim()
            : null,
          openskyTokenUrl: values.openskyTokenUrl?.trim()
            ? values.openskyTokenUrl.trim()
            : null,
          aisRelayBaseUrl: values.aisRelayBaseUrl?.trim()
            ? values.aisRelayBaseUrl.trim()
            : null,
          polymarketProxyUrl: values.polymarketProxyUrl?.trim()
            ? values.polymarketProxyUrl.trim()
            : null,
          openskyClientId: values.openskyClientId?.trim()
            ? values.openskyClientId.trim()
            : null,
        };

        if (settings?.acledApiEnabled) {
          payload.acledOauthUsername = values.acledOauthUsername?.trim()
            ? values.acledOauthUsername.trim()
            : null;
          payload.acledOauthClientId = values.acledOauthClientId?.trim()
            ? values.acledOauthClientId.trim()
            : null;
        }

        const touchedSecrets = Object.fromEntries(
          REALTIME_SIGNALS_SECRET_FIELD_NAMES.map((fieldName) => [
            fieldName,
            form.isFieldTouched(fieldName),
          ]),
        ) as Partial<Record<RealtimeSignalsSecretFieldName, boolean>>;

        applyRealtimeSignalsSecretFields(payload, values, touchedSecrets);

        const response =
          await apiClient.put<RealtimeSignalsSettingsResponse>(
            REALTIME_SIGNALS_SETTINGS_URL,
            payload,
          );
        applySettings(mergeSettingsDefaults(response.data));
        onSuccess(t("systemSettings.realtimeSignals.messages.saved"));
        onSaved();
        onDiagnosticsRefresh();
      } catch (error) {
        captureClientError("Failed to save realtime signals settings", error);
        const statusCode =
          typeof error === "object" && error && "response" in error
            ? (error as { response?: { status?: number } }).response?.status
            : undefined;
        if (statusCode === 400) {
          onError(
            extractApiError(error).message ??
              t("systemSettings.realtimeSignals.errors.badRequest"),
          );
        } else {
          onError(
            t("systemSettings.realtimeSignals.errors.saveFailed"),
          );
        }
      } finally {
        setSaving(false);
        gate.end();
      }
    },
    [
      apiClient,
      applySettings,
      form,
      gate,
      onError,
      onSaved,
      onDiagnosticsRefresh,
      onSuccess,
      settings,
      t,
    ],
  );

  const reset = useCallback(
    (confirm: (onOk: () => Promise<void>, onCancel: () => void) => void) => {
      if (!gate.begin("reset")) {
        return;
      }
      // 确认弹窗取消时必须释放门禁，否则 Reset 永久锁死。
      confirm(
        async () => {
          setResetting(true);
          setRefreshError(null);
          try {
            const response =
              await apiClient.delete<RealtimeSignalsSettingsResponse>(
                REALTIME_SIGNALS_SETTINGS_URL,
              );
            applySettings(mergeSettingsDefaults(response.data));
            onSuccess(t("systemSettings.realtimeSignals.messages.reset"));
            onDiagnosticsRefresh();
          } catch (error) {
            captureClientError(
              "Failed to reset realtime signals settings",
              error,
            );
            onError(t("systemSettings.realtimeSignals.errors.resetFailed"));
          } finally {
            setResetting(false);
            gate.end();
          }
        },
        () => gate.end(),
      );
    },
    [
      apiClient,
      applySettings,
      gate,
      onDiagnosticsRefresh,
      onError,
      onSuccess,
      t,
    ],
  );

  return {
    settings,
    loadState,
    refreshError,
    saving,
    resetting,
    operation: gate.operation,
    save,
    reset,
    retry,
  };
}
