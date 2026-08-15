"use client";

import type { GlobalToken } from "antd/es/theme/interface";
import type { TFunction } from "i18next";
import type { CSSProperties } from "react";
import { useMemo } from "react";

import {
  formatObservedPercent,
  getManagedRuntimeKeyStateMeta,
} from "./llm-gateway.formatters";
import type {
  GovernanceAttentionItem,
  GovernanceOverviewCard,
  LiteLlmProxyGovernancePreflightResponse,
  LiteLlmProxyGovernanceSettingsResponse,
  LlmGatewayProfile,
  ObservedUsageSummaryResponse,
} from "./llm-gateway.types";

export interface LlmGatewayGovernanceViewInput {
  t: TFunction;
  token: GlobalToken;
  screensMd: boolean | undefined;
  selectedGovernanceProfile: LlmGatewayProfile | null;
  resolvedCompletionProfile: LlmGatewayProfile | null;
  resolvedEmbeddingProfile: LlmGatewayProfile | null;
  resolvedRerankProfile: LlmGatewayProfile | null;
  governedTargetProfile: LlmGatewayProfile | null;
  proxyGovernanceSettings: LiteLlmProxyGovernanceSettingsResponse | null;
  proxyGovernancePreflight: LiteLlmProxyGovernancePreflightResponse | null;
  governanceUsage24h: ObservedUsageSummaryResponse;
  governanceUsage30d: ObservedUsageSummaryResponse;
}

export interface LlmGatewayGovernanceView {
  governanceTrafficBindings: {
    completion: boolean;
    embedding: boolean;
    rerank: boolean;
  };
  governanceTrafficLabels: string[];
  governanceHasTrafficBindings: boolean;
  governanceCanBindCompletion: boolean;
  governanceCanBindEmbedding: boolean;
  governanceCanBindRerank: boolean;
  governanceObservedZeroGoverned: boolean;
  governanceObservedDirectRequests: boolean;
  governanceKeyStateMeta: { color: string };
  governanceKeyStateLabel: string;
  governanceNoneLabel: string;
  governanceReadyLabel: string;
  governanceNotSelectedLabel: string;
  governancePreflightBlockingCount: number;
  governancePreflightWarningCount: number;
  governanceObservedGovernedRatio: number;
  governanceObservedDirectRatio: number;
  governanceObservedDayBudgetRatio: number;
  governanceObservedMonthBudgetRatio: number;
  governanceRecommendedActions: string[];
  governancePreflightStatusMeta: {
    color: string;
    label: string;
    description: string;
  };
  governanceRuntimeStatusMeta: {
    color: string;
    label: string;
    description: string;
  };
  governanceOverviewCards: GovernanceOverviewCard[];
  governanceAttentionItems: GovernanceAttentionItem[];
  governanceMetricGridStyle: CSSProperties;
  governanceMetricCardStyle: CSSProperties;
}

export function useLlmGatewayGovernanceView(
  input: LlmGatewayGovernanceViewInput,
): LlmGatewayGovernanceView {
  const {
    t,
    token,
    selectedGovernanceProfile,
    resolvedCompletionProfile,
    resolvedEmbeddingProfile,
    resolvedRerankProfile,
    governedTargetProfile,
    proxyGovernanceSettings,
    proxyGovernancePreflight,
    governanceUsage24h,
    governanceUsage30d,
  } = input;
  const screens = { md: input.screensMd };

  const governanceTrafficBindings = useMemo(() => {
    const targetProfileId = selectedGovernanceProfile?.id;
    if (!targetProfileId) {
      return {
        completion: false,
        embedding: false,
        rerank: false,
      };
    }
    return {
      completion: resolvedCompletionProfile?.id === targetProfileId,
      embedding: resolvedEmbeddingProfile?.id === targetProfileId,
      rerank: resolvedRerankProfile?.id === targetProfileId,
    };
  }, [
    resolvedCompletionProfile?.id,
    resolvedEmbeddingProfile?.id,
    resolvedRerankProfile?.id,
    selectedGovernanceProfile?.id,
  ]);

  const governanceTrafficLabels = useMemo(() => {
    const labels: string[] = [];
    if (governanceTrafficBindings.completion) {
      labels.push(
        t("settings.llmGateway.proxyGovernance.bindings.completion"),
      );
    }
    if (governanceTrafficBindings.embedding) {
      labels.push(
        t("settings.llmGateway.proxyGovernance.bindings.embedding"),
      );
    }
    if (governanceTrafficBindings.rerank) {
      labels.push(
        t("settings.llmGateway.proxyGovernance.bindings.rerank"),
      );
    }
    return labels;
  }, [governanceTrafficBindings, t]);
  const governanceHasTrafficBindings = governanceTrafficLabels.length > 0;
  const governanceCanBindCompletion = Boolean(selectedGovernanceProfile);
  const governanceCanBindEmbedding = Boolean(
    selectedGovernanceProfile?.embeddingModel,
  );
  const governanceCanBindRerank = Boolean(
    selectedGovernanceProfile?.rerankModel,
  );
  const governanceObservedZeroGoverned =
    proxyGovernanceSettings?.enabled === true &&
    governanceUsage24h.governanceBreakdown.governedRequestCount === 0;
  const governanceObservedDirectRequests =
    governanceUsage24h.governanceBreakdown.directRequestCount > 0;
  const governanceKeyStateMeta = useMemo(
    () =>
      getManagedRuntimeKeyStateMeta(
        proxyGovernanceSettings?.managedRuntimeKeyState ?? null,
      ),
    [proxyGovernanceSettings?.managedRuntimeKeyState],
  );
  const governanceKeyStateLabel = useMemo(() => {
    if (proxyGovernanceSettings?.managedRuntimeKeyState === "available") {
      return t(
        "settings.llmGateway.proxyGovernance.status.keyStates.available",
      );
    }
    if (proxyGovernanceSettings?.managedRuntimeKeyState === "unreadable") {
      return t(
        "settings.llmGateway.proxyGovernance.status.keyStates.unreadable",
      );
    }
    return t("settings.llmGateway.proxyGovernance.status.keyStates.missing");
  }, [proxyGovernanceSettings?.managedRuntimeKeyState, t]);
  const governanceNoneLabel = t(
    "settings.llmGateway.proxyGovernance.status.tags.noneLowercase",
  );
  const governanceReadyLabel = t(
    "settings.llmGateway.proxyGovernance.status.tags.readyLowercase",
  );
  const governanceNotSelectedLabel = t(
    "settings.llmGateway.proxyGovernance.status.tags.notSelected",
  );
  const governancePreflightBlockingCount =
    proxyGovernancePreflight?.blockingIssues.length ?? 0;
  const governancePreflightWarningCount =
    proxyGovernancePreflight?.warnings.length ?? 0;
  const governanceObservedGovernedRatio =
    governanceUsage24h.totals.requestCount > 0
      ? (governanceUsage24h.governanceBreakdown.governedRequestCount /
          governanceUsage24h.totals.requestCount) *
        100
      : 0;
  const governanceObservedDirectRatio =
    governanceUsage24h.totals.requestCount > 0
      ? (governanceUsage24h.governanceBreakdown.directRequestCount /
          governanceUsage24h.totals.requestCount) *
        100
      : 0;
  const governanceObservedDayBudgetRatio =
    proxyGovernanceSettings?.dailyBudgetUsd &&
    proxyGovernanceSettings.dailyBudgetUsd > 0
      ? (governanceUsage24h.governanceBreakdown.governedCostUsd /
          proxyGovernanceSettings.dailyBudgetUsd) *
        100
      : 0;
  const governanceObservedMonthBudgetRatio =
    proxyGovernanceSettings?.monthlyBudgetUsd &&
    proxyGovernanceSettings.monthlyBudgetUsd > 0
      ? (governanceUsage30d.governanceBreakdown.governedCostUsd /
          proxyGovernanceSettings.monthlyBudgetUsd) *
        100
      : 0;
  const governanceRecommendedActions = useMemo(() => {
    const actions: string[] = [];
    if (proxyGovernanceSettings?.enabled !== true) {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.enableAfterPreflight",
        ),
      );
    }
    if (governancePreflightBlockingCount > 0) {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.resolveBlocking",
        ),
      );
    }
    if (
      proxyGovernancePreflight &&
      !proxyGovernancePreflight.trafficBindings.completion
    ) {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.bindCompletion",
        ),
      );
    }
    if (
      selectedGovernanceProfile?.embeddingModel &&
      proxyGovernancePreflight &&
      !proxyGovernancePreflight.trafficBindings.embedding
    ) {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.bindEmbedding",
        ),
      );
    }
    if (
      selectedGovernanceProfile?.rerankModel &&
      proxyGovernancePreflight &&
      !proxyGovernancePreflight.trafficBindings.rerank
    ) {
      actions.push(
        t("settings.llmGateway.proxyGovernance.recommendedActions.bindRerank"),
      );
    }
    if (proxyGovernanceSettings?.managedRuntimeKeyState === "unreadable") {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.restoreSecretDecryption",
        ),
      );
    }
    if (governanceObservedZeroGoverned) {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.verifyRuntimeTraffic",
        ),
      );
    }
    if (governanceObservedDirectRequests) {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.removeProfileKeyCallers",
        ),
      );
    }
    if (governanceObservedDayBudgetRatio >= 80) {
      actions.push(
        t(
          "settings.llmGateway.proxyGovernance.recommendedActions.reviewDailyBudget",
        ),
      );
    }
    return actions.slice(0, 4);
  }, [
    governanceObservedDayBudgetRatio,
    governanceObservedDirectRequests,
    governanceObservedZeroGoverned,
    proxyGovernancePreflight,
    governancePreflightBlockingCount,
    proxyGovernanceSettings?.enabled,
    proxyGovernanceSettings?.managedRuntimeKeyState,
    selectedGovernanceProfile?.embeddingModel,
    selectedGovernanceProfile?.rerankModel,
    t,
  ]);
  const governancePreflightStatusMeta = useMemo(() => {
    if (!selectedGovernanceProfile) {
      return {
        color: "default",
        label: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.noTargetSelected.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.noTargetSelected.description",
        ),
      };
    }
    if (!proxyGovernancePreflight) {
      return {
        color: "default",
        label: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.notChecked.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.notChecked.description",
        ),
      };
    }
    if (!proxyGovernancePreflight.canEnable) {
      return {
        color: "red",
        label: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.blocked.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.blocked.description",
          {
            blocking: governancePreflightBlockingCount,
            warnings: governancePreflightWarningCount,
          },
        ),
      };
    }
    if (governancePreflightWarningCount > 0) {
      return {
        color: "gold",
        label: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.readyWithWarnings.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.preflightStates.readyWithWarnings.description",
          {
            warnings: governancePreflightWarningCount,
          },
        ),
      };
    }
    return {
      color: "green",
      label: t(
        "settings.llmGateway.proxyGovernance.status.preflightStates.ready.label",
      ),
      description: t(
        "settings.llmGateway.proxyGovernance.status.preflightStates.ready.description",
      ),
    };
  }, [
    governancePreflightBlockingCount,
    governancePreflightWarningCount,
    proxyGovernancePreflight,
    selectedGovernanceProfile,
    t,
  ]);
  const governanceRuntimeStatusMeta = useMemo(() => {
    if (proxyGovernanceSettings?.enabled !== true) {
      return {
        color: "default",
        label: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.directMode.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.directMode.description",
        ),
      };
    }
    if (proxyGovernanceSettings.managedRuntimeKeyState === "unreadable") {
      return {
        color: "red",
        label: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.failClosed.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.failClosed.description",
        ),
      };
    }
    if (governanceUsage24h.totals.requestCount === 0) {
      return {
        color: "default",
        label: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.noRecentTraffic.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.noRecentTraffic.description",
        ),
      };
    }
    if (governanceObservedZeroGoverned) {
      return {
        color: "gold",
        label: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.noGovernedTraffic.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.noGovernedTraffic.description",
        ),
      };
    }
    if (governanceObservedDirectRequests) {
      return {
        color: "gold",
        label: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.mixedTraffic.label",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.status.runtimeStates.mixedTraffic.description",
        ),
      };
    }
    return {
      color: "green",
      label: t(
        "settings.llmGateway.proxyGovernance.status.runtimeStates.governedTrafficObserved.label",
      ),
      description: t(
        "settings.llmGateway.proxyGovernance.status.runtimeStates.governedTrafficObserved.description",
      ),
    };
  }, [
    governanceObservedDirectRequests,
    governanceObservedZeroGoverned,
    governanceUsage24h.totals.requestCount,
    proxyGovernanceSettings,
    t,
  ]);
  const governanceOverviewCards = useMemo<GovernanceOverviewCard[]>(
    () => [
      {
        key: "enforcement",
        title: t(
          "settings.llmGateway.proxyGovernance.status.cards.enforcement",
        ),
        value:
          proxyGovernanceSettings?.enabled === true
            ? t("settings.llmGateway.proxyGovernance.summary.enabled")
            : t("settings.llmGateway.proxyGovernance.summary.disabled"),
        description:
          proxyGovernanceSettings?.enabled === true
            ? t(
                "settings.llmGateway.proxyGovernance.status.cards.enforcementEnabledDescription",
              )
            : t(
                "settings.llmGateway.proxyGovernance.status.cards.enforcementDisabledDescription",
              ),
        tagColor:
          proxyGovernanceSettings?.enabled === true ? "green" : "default",
        tagLabel:
          proxyGovernanceSettings?.adminKeyConfigured === true
            ? t(
                "settings.llmGateway.proxyGovernance.status.tags.adminKeyReady",
              )
            : t(
                "settings.llmGateway.proxyGovernance.status.tags.adminKeyMissing",
              ),
      },
      {
        key: "target",
        title: t("settings.llmGateway.proxyGovernance.status.cards.target"),
        value:
          selectedGovernanceProfile?.name ??
          proxyGovernanceSettings?.targetProfileName ??
          proxyGovernanceSettings?.targetProfileId ??
          t("settings.llmGateway.proxyGovernance.status.tags.none"),
        description:
          selectedGovernanceProfile?.apiBase ??
          proxyGovernanceSettings?.apiBase ??
          t(
            "settings.llmGateway.proxyGovernance.status.cards.targetDescriptionEmpty",
          ),
        tagColor:
          (selectedGovernanceProfile ?? governedTargetProfile)?.enabled ===
          false
            ? "orange"
            : "geekblue",
        tagLabel: governanceHasTrafficBindings
          ? t(
              "settings.llmGateway.proxyGovernance.status.tags.trafficBindings",
              {
                value: governanceTrafficLabels.join(", "),
              },
            )
          : t(
              "settings.llmGateway.proxyGovernance.status.tags.noRuntimeBindings",
            ),
      },
      {
        key: "preflight",
        title: t("settings.llmGateway.proxyGovernance.status.cards.preflight"),
        value: governancePreflightStatusMeta.label,
        description: governancePreflightStatusMeta.description,
        tagColor: governancePreflightStatusMeta.color,
        tagLabel: t(
          "settings.llmGateway.proxyGovernance.status.tags.preflightCounts",
          {
            blocking: governancePreflightBlockingCount,
            warnings: governancePreflightWarningCount,
          },
        ),
      },
      {
        key: "runtime",
        title: t("settings.llmGateway.proxyGovernance.status.cards.runtime"),
        value: governanceRuntimeStatusMeta.label,
        description: governanceRuntimeStatusMeta.description,
        tagColor: governanceRuntimeStatusMeta.color,
        tagLabel: t(
          "settings.llmGateway.proxyGovernance.status.tags.runtimeCounts",
          {
            governed:
              governanceUsage24h.governanceBreakdown.governedRequestCount.toLocaleString(),
            direct:
              governanceUsage24h.governanceBreakdown.directRequestCount.toLocaleString(),
          },
        ),
      },
    ],
    [
      governedTargetProfile,
      governanceHasTrafficBindings,
      governancePreflightBlockingCount,
      governancePreflightStatusMeta.color,
      governancePreflightStatusMeta.description,
      governancePreflightStatusMeta.label,
      governancePreflightWarningCount,
      governanceRuntimeStatusMeta.color,
      governanceRuntimeStatusMeta.description,
      governanceRuntimeStatusMeta.label,
      governanceTrafficLabels,
      governanceUsage24h.governanceBreakdown.directRequestCount,
      governanceUsage24h.governanceBreakdown.governedRequestCount,
      proxyGovernanceSettings,
      selectedGovernanceProfile,
      t,
    ],
  );
  const governanceAttentionItems = useMemo<GovernanceAttentionItem[]>(() => {
    const items: GovernanceAttentionItem[] = [];
    if (proxyGovernancePreflight && governancePreflightBlockingCount > 0) {
      items.push({
        key: "preflight-blocked",
        type: "error",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.preflightBlocked.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.preflightBlocked.description",
          {
            count: governancePreflightBlockingCount,
          },
        ),
      });
    }
    if (proxyGovernanceSettings?.managedRuntimeKeyState === "unreadable") {
      items.push({
        key: "managed-key-unreadable",
        type: "error",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.managedKeyUnreadable.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.managedKeyUnreadable.description",
        ),
      });
    }
    if (
      proxyGovernanceSettings?.enabled === true &&
      !governanceHasTrafficBindings
    ) {
      items.push({
        key: "no-bindings",
        type: "error",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.noBindings.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.noBindings.description",
        ),
      });
    }
    if (governanceObservedZeroGoverned) {
      items.push({
        key: "zero-governed",
        type: "warning",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.zeroGoverned.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.zeroGoverned.description",
        ),
      });
    }
    if (governanceObservedDirectRequests) {
      items.push({
        key: "direct-traffic",
        type: "warning",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.directTraffic.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.directTraffic.description",
          {
            count: governanceUsage24h.governanceBreakdown.directRequestCount,
          },
        ),
      });
    }
    if (governanceObservedDayBudgetRatio >= 80) {
      items.push({
        key: "day-budget",
        type: "warning",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.dayBudget.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.dayBudget.description",
          {
            value: formatObservedPercent(governanceObservedDayBudgetRatio),
          },
        ),
      });
    }
    if (governanceObservedMonthBudgetRatio >= 80) {
      items.push({
        key: "month-budget",
        type: "warning",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.monthBudget.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.monthBudget.description",
          {
            value: formatObservedPercent(governanceObservedMonthBudgetRatio),
          },
        ),
      });
    }
    if (
      proxyGovernanceSettings?.enabled !== true &&
      proxyGovernancePreflight?.canEnable
    ) {
      items.push({
        key: "ready-to-enable",
        type: "success",
        title: t(
          "settings.llmGateway.proxyGovernance.attention.readyToEnable.title",
        ),
        description: t(
          "settings.llmGateway.proxyGovernance.attention.readyToEnable.description",
        ),
      });
    }
    return items;
  }, [
    governanceHasTrafficBindings,
    governanceObservedDayBudgetRatio,
    governanceObservedDirectRequests,
    governanceObservedMonthBudgetRatio,
    governanceObservedZeroGoverned,
    governancePreflightBlockingCount,
    governanceUsage24h.governanceBreakdown.directRequestCount,
    proxyGovernancePreflight,
    proxyGovernanceSettings?.enabled,
    proxyGovernanceSettings?.managedRuntimeKeyState,
    t,
  ]);
  const governanceMetricGridStyle = useMemo(
    () => ({
      display: "grid",
      gap: 12,
      gridTemplateColumns: screens.md
        ? "repeat(4, minmax(0, 1fr))"
        : "repeat(2, minmax(0, 1fr))",
    }),
    [screens.md],
  );
  const governanceMetricCardStyle = useMemo(
    () => ({
      border: `1px solid ${token.colorBorderSecondary}`,
      borderRadius: token.borderRadiusLG,
      background: token.colorFillAlter,
      padding: 12,
      minHeight: 96,
    }),
    [token.borderRadiusLG, token.colorBorderSecondary, token.colorFillAlter],
  );

  return {
    governanceTrafficBindings,
    governanceTrafficLabels,
    governanceHasTrafficBindings,
    governanceCanBindCompletion,
    governanceCanBindEmbedding,
    governanceCanBindRerank,
    governanceObservedZeroGoverned,
    governanceObservedDirectRequests,
    governanceKeyStateMeta,
    governanceKeyStateLabel,
    governanceNoneLabel,
    governanceReadyLabel,
    governanceNotSelectedLabel,
    governancePreflightBlockingCount,
    governancePreflightWarningCount,
    governanceObservedGovernedRatio,
    governanceObservedDirectRatio,
    governanceObservedDayBudgetRatio,
    governanceObservedMonthBudgetRatio,
    governanceRecommendedActions,
    governancePreflightStatusMeta,
    governanceRuntimeStatusMeta,
    governanceOverviewCards,
    governanceAttentionItems,
    governanceMetricGridStyle,
    governanceMetricCardStyle,
  };
}
