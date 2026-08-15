import { extractApiError } from "@/lib/api-error";
import { PRESSURE_STATUS_COLORS } from "@/lib/status-tokens";

import type {
  LiteLlmManagedRuntimeKeyState,
  LlmGatewayProfile,
  LlmGatewaySettingsResponse,
  ObservedUsageSummaryResponse,
} from "./llm-gateway.types";

export function toFallbackModels(input: string | undefined): string[] | undefined {
  if (!input) {
    return undefined;
  }
  const models = input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(models));
}

export function normalizeObservedUsageSummary(
  payload: ObservedUsageSummaryResponse | null | undefined,
): ObservedUsageSummaryResponse {
  const topErrors = Array.isArray(payload?.topErrors)
    ? payload.topErrors
        .filter(
          (entry): entry is { message: string; count: number } =>
            typeof entry?.message === "string" &&
            entry.message.trim().length > 0 &&
            typeof entry.count === "number" &&
            Number.isFinite(entry.count),
        )
        .map((entry) => ({
          message: entry.message.trim(),
          count: entry.count,
        }))
    : [];

  const leadingError =
    payload?.leadingError &&
    typeof payload.leadingError.message === "string" &&
    payload.leadingError.message.trim().length > 0 &&
    typeof payload.leadingError.count === "number" &&
    Number.isFinite(payload.leadingError.count)
      ? {
          message: payload.leadingError.message.trim(),
          count: payload.leadingError.count,
        }
      : (topErrors[0] ?? null);

  return {
    totals: {
      requestCount:
        typeof payload?.totals?.requestCount === "number" &&
        Number.isFinite(payload.totals.requestCount)
          ? payload.totals.requestCount
          : 0,
      totalTokens:
        typeof payload?.totals?.totalTokens === "number" &&
        Number.isFinite(payload.totals.totalTokens)
          ? payload.totals.totalTokens
          : 0,
      costUsd:
        typeof payload?.totals?.costUsd === "number" &&
        Number.isFinite(payload.totals.costUsd)
          ? payload.totals.costUsd
          : 0,
      avgLatencyMs:
        typeof payload?.totals?.avgLatencyMs === "number" &&
        Number.isFinite(payload.totals.avgLatencyMs)
          ? payload.totals.avgLatencyMs
          : 0,
    },
    statusBreakdown: {
      success:
        typeof payload?.statusBreakdown?.success === "number" &&
        Number.isFinite(payload.statusBreakdown.success)
          ? payload.statusBreakdown.success
          : 0,
      error:
        typeof payload?.statusBreakdown?.error === "number" &&
        Number.isFinite(payload.statusBreakdown.error)
          ? payload.statusBreakdown.error
          : 0,
      successRate:
        typeof payload?.statusBreakdown?.successRate === "number" &&
        Number.isFinite(payload.statusBreakdown.successRate)
          ? payload.statusBreakdown.successRate
          : 0,
      errorRate:
        typeof payload?.statusBreakdown?.errorRate === "number" &&
        Number.isFinite(payload.statusBreakdown.errorRate)
          ? payload.statusBreakdown.errorRate
          : 0,
    },
    governanceBreakdown: {
      governedRequestCount:
        typeof payload?.governanceBreakdown?.governedRequestCount ===
          "number" &&
        Number.isFinite(payload.governanceBreakdown.governedRequestCount)
          ? payload.governanceBreakdown.governedRequestCount
          : 0,
      directRequestCount:
        typeof payload?.governanceBreakdown?.directRequestCount === "number" &&
        Number.isFinite(payload.governanceBreakdown.directRequestCount)
          ? payload.governanceBreakdown.directRequestCount
          : 0,
      governedCostUsd:
        typeof payload?.governanceBreakdown?.governedCostUsd === "number" &&
        Number.isFinite(payload.governanceBreakdown.governedCostUsd)
          ? payload.governanceBreakdown.governedCostUsd
          : 0,
      directCostUsd:
        typeof payload?.governanceBreakdown?.directCostUsd === "number" &&
        Number.isFinite(payload.governanceBreakdown.directCostUsd)
          ? payload.governanceBreakdown.directCostUsd
          : 0,
      managedRuntimeKeyRequestCount:
        typeof payload?.governanceBreakdown?.managedRuntimeKeyRequestCount ===
          "number" &&
        Number.isFinite(
          payload.governanceBreakdown.managedRuntimeKeyRequestCount,
        )
          ? payload.governanceBreakdown.managedRuntimeKeyRequestCount
          : 0,
      profileKeyRequestCount:
        typeof payload?.governanceBreakdown?.profileKeyRequestCount ===
          "number" &&
        Number.isFinite(payload.governanceBreakdown.profileKeyRequestCount)
          ? payload.governanceBreakdown.profileKeyRequestCount
          : 0,
    },
    latency: {
      avgMs:
        typeof payload?.latency?.avgMs === "number" &&
        Number.isFinite(payload.latency.avgMs)
          ? payload.latency.avgMs
          : 0,
      p95Ms:
        typeof payload?.latency?.p95Ms === "number" &&
        Number.isFinite(payload.latency.p95Ms)
          ? payload.latency.p95Ms
          : null,
    },
    topErrors,
    leadingError,
  };
}

export function toFallbackModelsText(models: string[]): string {
  return (models ?? []).join(", ");
}

export function toRerankDocuments(input: string | undefined): string[] | undefined {
  if (!input) {
    return undefined;
  }
  const documents = input
    .split(/\n+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (documents.length === 0) {
    return undefined;
  }
  return Array.from(new Set(documents));
}

export function formatApiErrorMessage(error: unknown): string | null {
  const info = extractApiError(error);
  return info.message?.trim() ? info.message.trim() : null;
}

export function formatObservedCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `$${value.toFixed(4)}`;
}

export function formatObservedTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return value.toLocaleString();
}

export function formatObservedLatency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${Math.round(value)} ms`;
}

export function formatObservedPercent(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(fractionDigits)}%`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

export function getPressureStatusColor(value: number): string {
  if (value >= 100) {
    return PRESSURE_STATUS_COLORS.critical;
  }
  if (value >= 80) {
    return PRESSURE_STATUS_COLORS.warning;
  }
  return PRESSURE_STATUS_COLORS.normal;
}

export function getManagedRuntimeKeyStateMeta(
  state: LiteLlmManagedRuntimeKeyState | null | undefined,
): { color: string } {
  if (state === "available") {
    return { color: "green" };
  }
  if (state === "unreadable") {
    return { color: "red" };
  }
  return { color: "default" };
}

export function normalizeCommaOrLineSeparatedTokens(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function shortenFingerprint(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 12) {
    return normalized;
  }
  return `${normalized.slice(0, 6)}...${normalized.slice(-6)}`;
}

export function resolveDefaultGatewayProfile(
  settings: LlmGatewaySettingsResponse,
  kind: "completion" | "embedding" | "rerank",
): LlmGatewayProfile | null {
  for (const profile of settings.profiles) {
    if (!profile.enabled) {
      continue;
    }
    if (kind === "completion") {
      return profile;
    }
    if (kind === "embedding" && profile.embeddingModel) {
      return profile;
    }
    if (kind === "rerank" && profile.rerankModel) {
      return profile;
    }
  }
  return null;
}
