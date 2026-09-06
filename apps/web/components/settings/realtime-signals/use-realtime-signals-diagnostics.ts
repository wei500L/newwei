"use client";

import { useCallback, useEffect, useState } from "react";

import type { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

import { REALTIME_SIGNALS_RUNTIME_URL } from "./realtime-signals-constants";
import type { RealtimeSignalsRuntimeDiagnosticsResponse } from "./realtime-signals-types";

type RealtimeSignalsApiClient = ReturnType<typeof createApiClient>;

/**
 * 运行时诊断状态域：与 settings 独立加载/失败（FE-RT-03）。
 * 失败不清空已加载的设置表单，只暴露独立 error + refresh。
 */
export function useRealtimeSignalsDiagnostics(
  apiClient: RealtimeSignalsApiClient,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const [diagnostics, setDiagnostics] =
    useState<RealtimeSignalsRuntimeDiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response =
        await apiClient.get<RealtimeSignalsRuntimeDiagnosticsResponse>(
          REALTIME_SIGNALS_RUNTIME_URL,
        );
      setDiagnostics(response.data ?? null);
    } catch (loadError) {
      captureClientError(
        "Failed to load realtime signals diagnostics",
        loadError,
      );
      setError(t("systemSettings.realtimeSignals.runtime.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    diagnostics,
    loading,
    error,
    refresh: load,
  };
}
