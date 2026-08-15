"use client";

import {
  Alert,
  Button,
  Card,
  Form,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { GlobalToken } from "antd/es/theme/interface";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { captureClientError } from "@/lib/client-telemetry";

import {
  useLlmGatewayGovernanceView,
  type LlmGatewayGovernanceView,
} from "./llm-gateway-governance.view";
import {
  clampPercent,
  formatApiErrorMessage,
  formatObservedCurrency,
  formatObservedLatency,
  formatObservedPercent,
  formatObservedTokens,
  getPressureStatusColor,
  normalizeObservedUsageSummary,
} from "./llm-gateway.formatters";
import {
  EMPTY_OBSERVED_USAGE_SUMMARY,
  GOVERNANCE_DAY_WINDOW_MS,
  GOVERNANCE_MONTH_WINDOW_MS,
} from "./llm-gateway.types";
import type {
  LiteLlmProxyGovernanceFormValues,
  LiteLlmProxyGovernancePreflightResponse,
  LiteLlmProxyGovernanceSettingsResponse,
  LlmGatewayProfile,
  LlmGatewaySettingsResponse,
  ObservedUsageSummaryResponse,
} from "./llm-gateway.types";
import type { LlmGatewaySettingsController } from "./use-llm-gateway-settings";

type ApiClient = LlmGatewaySettingsController["apiClient"];

export interface LlmGatewayProxyGovernanceDeps {
  t: TFunction;
  token: GlobalToken;
  apiClient: ApiClient;
  messageApi: MessageInstance;
  screensMd: boolean | undefined;
  settings: LlmGatewaySettingsResponse;
  resolvedCompletionProfile: LlmGatewayProfile | null;
  resolvedEmbeddingProfile: LlmGatewayProfile | null;
  resolvedRerankProfile: LlmGatewayProfile | null;
}

export type LlmGatewayProxyGovernanceController = LlmGatewayGovernanceView & {
  proxyGovernanceOpen: boolean;
  setProxyGovernanceOpen: (open: boolean) => void;
  proxyGovernanceForm: ReturnType<
    typeof Form.useForm<LiteLlmProxyGovernanceFormValues>
  >[0];
  proxyGovernanceSettings: LiteLlmProxyGovernanceSettingsResponse | null;
  proxyGovernanceLoading: boolean;
  proxyGovernanceSaving: boolean;
  proxyGovernanceResetting: boolean;
  proxyGovernanceRotating: boolean;
  proxyGovernanceErrorMessage: string | null;
  setProxyGovernanceErrorMessage: (value: string | null) => void;
  proxyGovernancePreflight: LiteLlmProxyGovernancePreflightResponse | null;
  proxyGovernancePreflightLoading: boolean;
  proxyGovernancePreflightErrorMessage: string | null;
  governanceUsageLoading: boolean;
  governanceUsageErrorMessage: string | null;
  governanceUsage24h: ObservedUsageSummaryResponse;
  governanceUsage30d: ObservedUsageSummaryResponse;
  proxyGovernanceEnabled: boolean;
  selectedGovernanceTargetProfileId: string | null;
  governedTargetProfile: LlmGatewayProfile | null;
  governanceTargetProfiles: { value: string; label: string }[];
  defaultGovernanceTargetProfileId: string | undefined;
  selectedGovernanceProfile: LlmGatewayProfile | null;
  governedProfileLockedId: string | null;
  governanceManagedRuntimeKeyReadable: boolean;
  loadProxyGovernanceSettings: () => Promise<void>;
  loadProxyGovernancePreflight: (
    targetProfileId: string | null,
  ) => Promise<void>;
  loadGovernanceUsageSummary: (profileId: string | null) => Promise<void>;
  openProxyGovernanceWizard: () => void;
  saveProxyGovernanceSettings: (
    values: LiteLlmProxyGovernanceFormValues,
  ) => Promise<void>;
  resetProxyGovernanceSettings: () => void;
  rotateProxyGovernanceKey: () => void;
};

export function useLlmGatewayProxyGovernance(
  deps: LlmGatewayProxyGovernanceDeps,
): LlmGatewayProxyGovernanceController {
  const {
    t,
    token,
    apiClient,
    messageApi,
    screensMd,
    settings,
    resolvedCompletionProfile,
    resolvedEmbeddingProfile,
    resolvedRerankProfile,
  } = deps;

  const [proxyGovernanceOpen, setProxyGovernanceOpen] = useState(false);
  const [proxyGovernanceForm] =
    Form.useForm<LiteLlmProxyGovernanceFormValues>();
  const [proxyGovernanceSettings, setProxyGovernanceSettings] =
    useState<LiteLlmProxyGovernanceSettingsResponse | null>(null);
  const [proxyGovernanceLoading, setProxyGovernanceLoading] = useState(false);
  const [proxyGovernanceSaving, setProxyGovernanceSaving] = useState(false);
  const [proxyGovernanceResetting, setProxyGovernanceResetting] =
    useState(false);
  const [proxyGovernanceRotating, setProxyGovernanceRotating] = useState(false);
  const [proxyGovernanceErrorMessage, setProxyGovernanceErrorMessage] =
    useState<string | null>(null);
  const [proxyGovernancePreflight, setProxyGovernancePreflight] =
    useState<LiteLlmProxyGovernancePreflightResponse | null>(null);
  const [proxyGovernancePreflightLoading, setProxyGovernancePreflightLoading] =
    useState(false);
  const [
    proxyGovernancePreflightErrorMessage,
    setProxyGovernancePreflightErrorMessage,
  ] = useState<string | null>(null);
  const [governanceUsageLoading, setGovernanceUsageLoading] = useState(false);
  const [governanceUsageErrorMessage, setGovernanceUsageErrorMessage] =
    useState<string | null>(null);
  const [governanceUsageProfileId, setGovernanceUsageProfileId] = useState<
    string | null
  >(null);
  const [governanceUsage24h, setGovernanceUsage24h] =
    useState<ObservedUsageSummaryResponse>(EMPTY_OBSERVED_USAGE_SUMMARY);
  const [governanceUsage30d, setGovernanceUsage30d] =
    useState<ObservedUsageSummaryResponse>(EMPTY_OBSERVED_USAGE_SUMMARY);
  const proxyGovernanceEnabled =
    Form.useWatch("enabled", proxyGovernanceForm) ?? false;
  const selectedGovernanceTargetProfileId =
    (Form.useWatch("targetProfileId", proxyGovernanceForm) as
      | string
      | undefined) ?? null;
  const governedTargetProfile = useMemo(() => {
    const targetProfileId = proxyGovernanceSettings?.targetProfileId;
    if (!targetProfileId) {
      return null;
    }
    return (
      settings.profiles.find((profile) => profile.id === targetProfileId) ??
      null
    );
  }, [proxyGovernanceSettings?.targetProfileId, settings.profiles]);
  const governanceTargetProfiles = useMemo(
    () =>
      settings.profiles
        .filter((profile) => profile.enabled)
        .map((profile) => ({
          value: profile.id,
          label: `${profile.name} (${profile.apiBase})`,
        })),
    [settings.profiles],
  );

  const defaultGovernanceTargetProfileId = useMemo(() => {
    if (settings.activeId) {
      return settings.activeId;
    }
    return settings.profiles.find((profile) => profile.enabled)?.id;
  }, [settings.activeId, settings.profiles]);

  const selectedGovernanceProfile = useMemo(() => {
    const targetProfileId =
      selectedGovernanceTargetProfileId ??
      proxyGovernanceSettings?.targetProfileId ??
      defaultGovernanceTargetProfileId ??
      null;
    if (!targetProfileId) {
      return null;
    }
    return (
      settings.profiles.find((profile) => profile.id === targetProfileId) ??
      null
    );
  }, [
    defaultGovernanceTargetProfileId,
    proxyGovernanceSettings?.targetProfileId,
    selectedGovernanceTargetProfileId,
    settings.profiles,
  ]);
  const governedProfileLockedId =
    proxyGovernanceSettings?.enabled === true
      ? proxyGovernanceSettings.targetProfileId
      : null;
  const governanceManagedRuntimeKeyReadable =
    proxyGovernanceSettings?.managedRuntimeKeyState === "available";

  const governanceView = useLlmGatewayGovernanceView({
    t,
    token,
    screensMd,
    selectedGovernanceProfile,
    resolvedCompletionProfile,
    resolvedEmbeddingProfile,
    resolvedRerankProfile,
    governedTargetProfile,
    proxyGovernanceSettings,
    proxyGovernancePreflight,
    governanceUsage24h,
    governanceUsage30d,
  });
  const { governanceNoneLabel } = governanceView;

  const loadProxyGovernanceSettings = useCallback(async () => {
    setProxyGovernanceLoading(true);
    setProxyGovernanceErrorMessage(null);
    try {
      const response =
        await apiClient.get<LiteLlmProxyGovernanceSettingsResponse>(
          "system-settings/llm-gateways/proxy-governance",
        );
      const data = response.data ?? null;
      setProxyGovernanceSettings(data);
      setGovernanceUsageProfileId(null);
      proxyGovernanceForm.setFieldsValue({
        enabled: data?.enabled ?? false,
        targetProfileId:
          data?.targetProfileId ?? defaultGovernanceTargetProfileId,
        dailyBudgetUsd: data?.dailyBudgetUsd ?? 25,
        monthlyBudgetUsd: data?.monthlyBudgetUsd ?? 500,
        maxParallelRequests: data?.maxParallelRequests ?? 16,
      });
    } catch (error) {
      captureClientError(
        "Failed to load LiteLLM proxy governance settings",
        error,
      );
      const messageText = formatApiErrorMessage(error);
      setProxyGovernanceErrorMessage(
        messageText
          ? messageText
          : t("settings.llmGateway.proxyGovernance.errors.loadFailed"),
      );
    } finally {
      setProxyGovernanceLoading(false);
    }
  }, [apiClient, defaultGovernanceTargetProfileId, proxyGovernanceForm, t]);

  const loadProxyGovernancePreflight = useCallback(
    async (targetProfileId: string | null) => {
      setProxyGovernancePreflightLoading(true);
      setProxyGovernancePreflightErrorMessage(null);
      try {
        const response =
          await apiClient.post<LiteLlmProxyGovernancePreflightResponse>(
            "system-settings/llm-gateways/proxy-governance/preflight",
            {
              targetProfileId,
            },
          );
        setProxyGovernancePreflight(response.data ?? null);
      } catch (error) {
        captureClientError(
          "Failed to load LiteLLM proxy governance preflight",
          error,
        );
        setProxyGovernancePreflight(null);
        setProxyGovernancePreflightErrorMessage(
          formatApiErrorMessage(error) ??
            "Failed to load LiteLLM governance preflight",
        );
      } finally {
        setProxyGovernancePreflightLoading(false);
      }
    },
    [apiClient],
  );

  const loadGovernanceUsageSummary = useCallback(
    async (profileId: string | null) => {
      if (!profileId) {
        setGovernanceUsageProfileId(null);
        setGovernanceUsage24h(EMPTY_OBSERVED_USAGE_SUMMARY);
        setGovernanceUsage30d(EMPTY_OBSERVED_USAGE_SUMMARY);
        setGovernanceUsageErrorMessage(null);
        return;
      }

      const now = new Date();
      const end = now.toISOString();
      const start24h = new Date(
        now.getTime() - GOVERNANCE_DAY_WINDOW_MS,
      ).toISOString();
      const start30d = new Date(
        now.getTime() - GOVERNANCE_MONTH_WINDOW_MS,
      ).toISOString();

      setGovernanceUsageLoading(true);
      setGovernanceUsageErrorMessage(null);
      try {
        const [usage24h, usage30d] = await Promise.all([
          apiClient.get<ObservedUsageSummaryResponse>("llm-logs/summary", {
            params: {
              profileId,
              start: start24h,
              end,
            },
          }),
          apiClient.get<ObservedUsageSummaryResponse>("llm-logs/summary", {
            params: {
              profileId,
              start: start30d,
              end,
            },
          }),
        ]);
        setGovernanceUsage24h(normalizeObservedUsageSummary(usage24h.data));
        setGovernanceUsage30d(normalizeObservedUsageSummary(usage30d.data));
        setGovernanceUsageProfileId(profileId);
      } catch (error) {
        captureClientError(
          "Failed to load governance observed usage summary",
          error,
        );
        setGovernanceUsage24h(EMPTY_OBSERVED_USAGE_SUMMARY);
        setGovernanceUsage30d(EMPTY_OBSERVED_USAGE_SUMMARY);
        setGovernanceUsageProfileId(profileId);
        setGovernanceUsageErrorMessage(
          formatApiErrorMessage(error) ??
            t("settings.llmGateway.proxyGovernance.errors.usageFailed"),
        );
      } finally {
        setGovernanceUsageLoading(false);
      }
    },
    [apiClient, t],
  );

  const openProxyGovernanceWizard = useCallback(() => {
    setProxyGovernanceOpen(true);
    if (!proxyGovernanceSettings) {
      void loadProxyGovernanceSettings();
    }
  }, [loadProxyGovernanceSettings, proxyGovernanceSettings]);

  useEffect(() => {
    void loadProxyGovernanceSettings();
  }, [loadProxyGovernanceSettings]);

  useEffect(() => {
    const profileId = proxyGovernanceOpen
      ? (selectedGovernanceProfile?.id ?? null)
      : (proxyGovernanceSettings?.targetProfileId ?? null);
    if (profileId === governanceUsageProfileId) {
      return;
    }
    void loadGovernanceUsageSummary(profileId);
  }, [
    governanceUsageProfileId,
    loadGovernanceUsageSummary,
    proxyGovernanceOpen,
    proxyGovernanceSettings?.targetProfileId,
    selectedGovernanceProfile?.id,
  ]);

  useEffect(() => {
    if (!proxyGovernanceOpen) {
      return;
    }
    void loadProxyGovernancePreflight(selectedGovernanceProfile?.id ?? null);
  }, [
    loadProxyGovernancePreflight,
    proxyGovernanceOpen,
    resolvedCompletionProfile?.id,
    resolvedEmbeddingProfile?.id,
    resolvedRerankProfile?.id,
    selectedGovernanceProfile?.id,
  ]);

  const saveProxyGovernanceSettings = useCallback(
    async (values: LiteLlmProxyGovernanceFormValues) => {
      if (
        values.enabled &&
        proxyGovernancePreflight &&
        !proxyGovernancePreflight.canEnable
      ) {
        setProxyGovernanceErrorMessage(
          proxyGovernancePreflight.blockingIssues.join(" "),
        );
        return;
      }
      setProxyGovernanceSaving(true);
      setProxyGovernanceErrorMessage(null);
      try {
        const response =
          await apiClient.put<LiteLlmProxyGovernanceSettingsResponse>(
            "system-settings/llm-gateways/proxy-governance",
            {
              enabled: Boolean(values.enabled),
              targetProfileId: values.targetProfileId?.trim() || null,
              dailyBudgetUsd: Number(values.dailyBudgetUsd),
              monthlyBudgetUsd: Number(values.monthlyBudgetUsd),
              maxParallelRequests: Number(values.maxParallelRequests),
            },
          );
        const data = response.data ?? null;
        setProxyGovernanceSettings(data);
        setProxyGovernancePreflight(null);
        setGovernanceUsageProfileId(null);
        proxyGovernanceForm.setFieldsValue({
          enabled: data?.enabled ?? false,
          targetProfileId:
            data?.targetProfileId ?? defaultGovernanceTargetProfileId,
          dailyBudgetUsd: data?.dailyBudgetUsd ?? 25,
          monthlyBudgetUsd: data?.monthlyBudgetUsd ?? 500,
          maxParallelRequests: data?.maxParallelRequests ?? 16,
        });
        messageApi.success(
          t("settings.llmGateway.proxyGovernance.messages.saved"),
        );
      } catch (error) {
        captureClientError(
          "Failed to save LiteLLM proxy governance settings",
          error,
        );
        const messageText = formatApiErrorMessage(error);
        setProxyGovernanceErrorMessage(
          messageText
            ? messageText
            : t("settings.llmGateway.proxyGovernance.errors.saveFailed"),
        );
      } finally {
        setProxyGovernanceSaving(false);
      }
    },
    [
      apiClient,
      defaultGovernanceTargetProfileId,
      messageApi,
      proxyGovernancePreflight,
      proxyGovernanceForm,
      t,
    ],
  );

  const resetProxyGovernanceSettings = useCallback(() => {
    Modal.confirm({
      title: t("settings.llmGateway.proxyGovernance.reset.modal.title"),
      content: (
        <Space direction="vertical" size={8} style={{ display: "flex" }}>
          <Typography.Text>
            {t("settings.llmGateway.proxyGovernance.reset.modal.content")}
          </Typography.Text>
          <Space wrap>
            <Tag color="geekblue">
              {t("settings.llmGateway.proxyGovernance.reset.targetProfile", {
                value:
                  proxyGovernanceSettings?.targetProfileName ??
                  proxyGovernanceSettings?.targetProfileId ??
                  governanceNoneLabel,
              })}
            </Tag>
            <Tag color="blue">
              {t("settings.llmGateway.proxyGovernance.reset.team", {
                value:
                  proxyGovernanceSettings?.managedTeamId ?? governanceNoneLabel,
              })}
            </Tag>
            <Tag color="purple">
              {t("settings.llmGateway.proxyGovernance.reset.key", {
                value:
                  proxyGovernanceSettings?.managedRuntimeKeyAlias ??
                  governanceNoneLabel,
              })}
            </Tag>
          </Space>
        </Space>
      ),
      okText: t("common.reset"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setProxyGovernanceResetting(true);
        setProxyGovernanceErrorMessage(null);
        try {
          const response =
            await apiClient.delete<LiteLlmProxyGovernanceSettingsResponse>(
              "system-settings/llm-gateways/proxy-governance",
            );
          const data = response.data ?? null;
          setProxyGovernanceSettings(data);
          setGovernanceUsageProfileId(null);
          proxyGovernanceForm.setFieldsValue({
            enabled: data?.enabled ?? false,
            targetProfileId:
              data?.targetProfileId ?? defaultGovernanceTargetProfileId,
            dailyBudgetUsd: data?.dailyBudgetUsd ?? 25,
            monthlyBudgetUsd: data?.monthlyBudgetUsd ?? 500,
            maxParallelRequests: data?.maxParallelRequests ?? 16,
          });
          messageApi.success(
            t("settings.llmGateway.proxyGovernance.reset.messages.done"),
          );
        } catch (error) {
          captureClientError(
            "Failed to reset LiteLLM proxy governance settings",
            error,
          );
          const messageText = formatApiErrorMessage(error);
          setProxyGovernanceErrorMessage(
            messageText
              ? messageText
              : t("settings.llmGateway.proxyGovernance.reset.errors.failed"),
          );
        } finally {
          setProxyGovernanceResetting(false);
        }
      },
    });
  }, [
    apiClient,
    defaultGovernanceTargetProfileId,
    messageApi,
    proxyGovernanceForm,
    proxyGovernanceSettings?.managedRuntimeKeyAlias,
    proxyGovernanceSettings?.managedTeamId,
    proxyGovernanceSettings?.targetProfileId,
    proxyGovernanceSettings?.targetProfileName,
    t,
    governanceNoneLabel,
  ]);

  const rotateProxyGovernanceKey = useCallback(() => {
    Modal.confirm({
      title: t("settings.llmGateway.proxyGovernance.rotate.title"),
      content: (
        <Space direction="vertical" size={8} style={{ display: "flex" }}>
          <Typography.Text>
            {t("settings.llmGateway.proxyGovernance.rotate.confirm")}
          </Typography.Text>
          <Space wrap>
            <Tag color="geekblue">
              {t("settings.llmGateway.proxyGovernance.rotate.targetProfile", {
                value:
                  selectedGovernanceProfile?.name ??
                  proxyGovernanceSettings?.targetProfileName ??
                  proxyGovernanceSettings?.targetProfileId ??
                  governanceNoneLabel,
              })}
            </Tag>
            <Tag color="blue">
              {t("settings.llmGateway.proxyGovernance.rotate.team", {
                value:
                  proxyGovernanceSettings?.managedTeamId ?? governanceNoneLabel,
              })}
            </Tag>
            <Tag color="purple">
              {t("settings.llmGateway.proxyGovernance.rotate.key", {
                value:
                  proxyGovernanceSettings?.managedRuntimeKeyAlias ??
                  governanceNoneLabel,
              })}
            </Tag>
          </Space>
        </Space>
      ),
      okText: t("settings.llmGateway.proxyGovernance.actions.rotate"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setProxyGovernanceRotating(true);
        setProxyGovernanceErrorMessage(null);
        try {
          const response =
            await apiClient.post<LiteLlmProxyGovernanceSettingsResponse>(
              "system-settings/llm-gateways/proxy-governance/rotate-key",
            );
          const data = response.data ?? null;
          setProxyGovernanceSettings(data);
          setGovernanceUsageProfileId(null);
          proxyGovernanceForm.setFieldsValue({
            enabled: data?.enabled ?? false,
            targetProfileId:
              data?.targetProfileId ?? defaultGovernanceTargetProfileId,
            dailyBudgetUsd: data?.dailyBudgetUsd ?? 25,
            monthlyBudgetUsd: data?.monthlyBudgetUsd ?? 500,
            maxParallelRequests: data?.maxParallelRequests ?? 16,
          });
          messageApi.success(
            t("settings.llmGateway.proxyGovernance.rotate.messages.done"),
          );
        } catch (error) {
          captureClientError(
            "Failed to rotate LiteLLM managed runtime key",
            error,
          );
          const messageText = formatApiErrorMessage(error);
          setProxyGovernanceErrorMessage(
            messageText
              ? messageText
              : t("settings.llmGateway.proxyGovernance.rotate.errors.failed"),
          );
        } finally {
          setProxyGovernanceRotating(false);
        }
      },
    });
  }, [
    apiClient,
    defaultGovernanceTargetProfileId,
    messageApi,
    proxyGovernanceForm,
    proxyGovernanceSettings?.managedRuntimeKeyAlias,
    proxyGovernanceSettings?.managedTeamId,
    proxyGovernanceSettings?.targetProfileId,
    proxyGovernanceSettings?.targetProfileName,
    selectedGovernanceProfile?.name,
    t,
    governanceNoneLabel,
  ]);

  return {
    ...governanceView,
    proxyGovernanceOpen,
    setProxyGovernanceOpen,
    proxyGovernanceForm,
    proxyGovernanceSettings,
    proxyGovernanceLoading,
    proxyGovernanceSaving,
    proxyGovernanceResetting,
    proxyGovernanceRotating,
    proxyGovernanceErrorMessage,
    setProxyGovernanceErrorMessage,
    proxyGovernancePreflight,
    proxyGovernancePreflightLoading,
    proxyGovernancePreflightErrorMessage,
    governanceUsageLoading,
    governanceUsageErrorMessage,
    governanceUsage24h,
    governanceUsage30d,
    proxyGovernanceEnabled,
    selectedGovernanceTargetProfileId,
    governedTargetProfile,
    governanceTargetProfiles,
    defaultGovernanceTargetProfileId,
    selectedGovernanceProfile,
    governedProfileLockedId,
    governanceManagedRuntimeKeyReadable,
    loadProxyGovernanceSettings,
    loadProxyGovernancePreflight,
    loadGovernanceUsageSummary,
    openProxyGovernanceWizard,
    saveProxyGovernanceSettings,
    resetProxyGovernanceSettings,
    rotateProxyGovernanceKey,
  };
}

export function LlmGatewayProxyGovernancePanel({
  s,
  g,
}: {
  s: LlmGatewaySettingsController;
  g: LlmGatewayProxyGovernanceController;
}): ReactElement {
  const { t, screens } = s;
  const {
    proxyGovernanceOpen,
    setProxyGovernanceOpen,
    setProxyGovernanceErrorMessage,
    proxyGovernanceSaving,
    proxyGovernanceResetting,
    proxyGovernanceRotating,
    proxyGovernanceLoading,
    loadProxyGovernanceSettings,
    resetProxyGovernanceSettings,
    rotateProxyGovernanceKey,
    saveProxyGovernanceSettings,
    proxyGovernanceForm,
    proxyGovernanceErrorMessage,
    proxyGovernanceSettings,
    selectedGovernanceProfile,
    proxyGovernanceEnabled,
    governanceCanBindCompletion,
    governanceCanBindEmbedding,
    governanceCanBindRerank,
    proxyGovernancePreflightLoading,
    proxyGovernancePreflight,
    proxyGovernancePreflightErrorMessage,
    governanceTargetProfiles,
    governanceRecommendedActions,
    governanceNoneLabel,
    governanceUsageLoading,
    governanceUsageErrorMessage,
    governanceUsage24h,
    governanceUsage30d,
    governanceObservedGovernedRatio,
    governanceObservedDirectRatio,
    governanceObservedDayBudgetRatio,
    governanceObservedMonthBudgetRatio,
    governanceMetricGridStyle,
    governanceMetricCardStyle,
    governanceAttentionItems,
    governanceNotSelectedLabel,
    governanceReadyLabel,
    governanceKeyStateMeta,
    governanceKeyStateLabel,
    governanceOverviewCards,
    loadProxyGovernancePreflight,
    loadGovernanceUsageSummary,
    governancePreflightBlockingCount,
    governancePreflightWarningCount,
    governanceTrafficBindings,
    governanceObservedZeroGoverned,
    governanceObservedDirectRequests,
  } = g;
  const {
    handleActivate,
    handleActivateEmbedding,
    handleActivateRerank,
    activatingProfileId,
    embeddingActivating,
    rerankActivating,
  } = s;

  return (
    <Modal
      title={t("settings.llmGateway.proxyGovernance.modal.title")}
      open={proxyGovernanceOpen}
      onCancel={() => {
        setProxyGovernanceOpen(false);
        setProxyGovernanceErrorMessage(null);
      }}
      width={screens.md ? 680 : "100%"}
      destroyOnHidden
      footer={[
        <Button
          key="close"
          onClick={() => {
            setProxyGovernanceOpen(false);
            setProxyGovernanceErrorMessage(null);
          }}
        >
          {t("common.close")}
        </Button>,
        <Button
          key="refresh"
          onClick={() => void loadProxyGovernanceSettings()}
          loading={proxyGovernanceLoading}
        >
          {t("common.refresh")}
        </Button>,
        <Button
          key="rotate"
          onClick={() => void rotateProxyGovernanceKey()}
          loading={proxyGovernanceRotating}
          disabled={
            proxyGovernanceLoading ||
            proxyGovernanceSaving ||
            proxyGovernanceResetting ||
            !proxyGovernanceSettings?.enabled
          }
        >
          {t("settings.llmGateway.proxyGovernance.actions.rotate")}
        </Button>,
        <Button
          key="reset"
          danger
          onClick={resetProxyGovernanceSettings}
          loading={proxyGovernanceResetting}
          disabled={proxyGovernanceSaving || proxyGovernanceRotating}
        >
          {t("common.reset")}
        </Button>,
        <Button
          key="save"
          type="primary"
          onClick={() => proxyGovernanceForm.submit()}
          loading={proxyGovernanceSaving}
          disabled={
            proxyGovernanceLoading ||
            proxyGovernanceResetting ||
            (proxyGovernanceEnabled === true &&
              proxyGovernancePreflight?.canEnable === false)
          }
        >
          {t("common.save")}
        </Button>,
      ]}
    >
      <Spin spinning={proxyGovernanceLoading}>
        <Space direction="vertical" size="middle" style={{ display: "flex" }}>
          <Typography.Text type="secondary">
            {t("settings.llmGateway.proxyGovernance.hint")}
          </Typography.Text>

          {proxyGovernanceSettings ? (
            <Alert
              type={
                governanceAttentionItems.some((item) => item.type === "error")
                  ? "warning"
                  : proxyGovernanceSettings.enabled
                    ? "success"
                    : "info"
              }
              showIcon
              message={t("settings.llmGateway.proxyGovernance.status.title")}
              description={
                <Space direction="vertical" size="middle">
                  <Typography.Text type="secondary">
                    {t("settings.llmGateway.proxyGovernance.status.apiBase", {
                      value:
                        proxyGovernanceSettings.apiBase ??
                        governanceNotSelectedLabel,
                    })}
                  </Typography.Text>
                  <Space wrap>
                    <Tag>{proxyGovernanceSettings.source}</Tag>
                    <Tag
                      color={
                        proxyGovernanceSettings.targetProfileEnabled
                          ? "geekblue"
                          : "orange"
                      }
                    >
                      {t(
                        "settings.llmGateway.proxyGovernance.status.targetProfile",
                        {
                          value:
                            proxyGovernanceSettings.targetProfileName ??
                            proxyGovernanceSettings.targetProfileId ??
                            governanceNoneLabel,
                        },
                      )}
                    </Tag>
                    <Tag color="blue">
                      {t("settings.llmGateway.proxyGovernance.status.team", {
                        value:
                          proxyGovernanceSettings.managedTeamId ??
                          governanceNoneLabel,
                      })}
                    </Tag>
                    <Tag color="purple">
                      {t("settings.llmGateway.proxyGovernance.status.key", {
                        value:
                          proxyGovernanceSettings.managedRuntimeKeyAlias ??
                          (proxyGovernanceSettings.hasManagedRuntimeKey
                            ? governanceReadyLabel
                            : governanceNoneLabel),
                      })}
                    </Tag>
                    <Tag color={governanceKeyStateMeta.color}>
                      {governanceKeyStateLabel}
                    </Tag>
                  </Space>
                  <div style={governanceMetricGridStyle}>
                    {governanceOverviewCards.map((card) => (
                      <div key={card.key} style={governanceMetricCardStyle}>
                        <Typography.Text type="secondary">
                          {card.title}
                        </Typography.Text>
                        <Typography.Title
                          level={5}
                          style={{ margin: "8px 0 4px" }}
                        >
                          {card.value}
                        </Typography.Title>
                        <Typography.Text type="secondary">
                          {card.description}
                        </Typography.Text>
                        {card.tagLabel ? (
                          <div style={{ marginTop: 8 }}>
                            <Tag color={card.tagColor}>{card.tagLabel}</Tag>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {governanceAttentionItems.length > 0 ? (
                    <Space
                      direction="vertical"
                      size={8}
                      style={{ display: "flex" }}
                    >
                      {governanceAttentionItems.map((item) => (
                        <Alert
                          key={item.key}
                          type={item.type}
                          showIcon
                          message={item.title}
                          description={item.description}
                        />
                      ))}
                    </Space>
                  ) : null}
                  {proxyGovernanceSettings.lastSyncedAt ? (
                    <Typography.Text type="secondary">
                      {t(
                        "settings.llmGateway.proxyGovernance.status.syncedAt",
                        {
                          value: new Date(
                            proxyGovernanceSettings.lastSyncedAt,
                          ).toLocaleString(),
                        },
                      )}
                    </Typography.Text>
                  ) : null}
                  {!proxyGovernanceSettings.adminKeyConfigured ? (
                    <Typography.Text type="warning">
                      {t(
                        "settings.llmGateway.proxyGovernance.status.adminMissing",
                      )}
                    </Typography.Text>
                  ) : null}
                  {proxyGovernanceSettings.lastSyncError ? (
                    <Typography.Text type="danger">
                      {proxyGovernanceSettings.lastSyncError}
                    </Typography.Text>
                  ) : null}
                </Space>
              }
            />
          ) : null}

          {proxyGovernanceErrorMessage ? (
            <Alert
              type="error"
              showIcon
              message={proxyGovernanceErrorMessage}
            />
          ) : null}

          <Card
            size="small"
            title={t("settings.llmGateway.proxyGovernance.preflight.title")}
            extra={
              <Button
                size="small"
                onClick={() =>
                  void loadProxyGovernancePreflight(
                    selectedGovernanceProfile?.id ?? null,
                  )
                }
                loading={proxyGovernancePreflightLoading}
              >
                {t("common.refresh")}
              </Button>
            }
          >
            <Space
              direction="vertical"
              size="small"
              style={{ display: "flex" }}
            >
              <Typography.Text type="secondary">
                {t("settings.llmGateway.proxyGovernance.preflight.hint")}
              </Typography.Text>
              <Space wrap>
                <Tag
                  color={selectedGovernanceProfile ? "geekblue" : "default"}
                >
                  {t(
                    "settings.llmGateway.proxyGovernance.preflight.targetProfile",
                    {
                      value:
                        selectedGovernanceProfile?.name ??
                        governanceNoneLabel,
                    },
                  )}
                </Tag>
                <Tag color={selectedGovernanceProfile ? "blue" : "default"}>
                  {t(
                    "settings.llmGateway.proxyGovernance.preflight.apiBase",
                    {
                      value:
                        proxyGovernancePreflight?.apiBase ??
                        selectedGovernanceProfile?.apiBase ??
                        governanceNotSelectedLabel,
                    },
                  )}
                </Tag>
                <Tag
                  color={
                    proxyGovernancePreflight?.trafficBindings.completion ||
                    proxyGovernancePreflight?.trafficBindings.embedding ||
                    proxyGovernancePreflight?.trafficBindings.rerank
                      ? "green"
                      : "orange"
                  }
                >
                  {t(
                    "settings.llmGateway.proxyGovernance.preflight.bindings",
                    {
                      value:
                        proxyGovernancePreflight?.trafficBindings
                          .completion ||
                        proxyGovernancePreflight?.trafficBindings.embedding ||
                        proxyGovernancePreflight?.trafficBindings.rerank
                          ? [
                              proxyGovernancePreflight?.trafficBindings
                                .completion
                                ? t(
                                    "settings.llmGateway.proxyGovernance.bindings.completion",
                                  )
                                : null,
                              proxyGovernancePreflight?.trafficBindings
                                .embedding
                                ? t(
                                    "settings.llmGateway.proxyGovernance.bindings.embedding",
                                  )
                                : null,
                              proxyGovernancePreflight?.trafficBindings.rerank
                                ? t(
                                    "settings.llmGateway.proxyGovernance.bindings.rerank",
                                  )
                                : null,
                            ]
                              .filter((value): value is string =>
                                Boolean(value),
                              )
                              .join(", ")
                          : governanceNoneLabel,
                    },
                  )}
                </Tag>
              </Space>
              {proxyGovernancePreflight ? (
                <Alert
                  type={
                    proxyGovernancePreflight.canEnable ? "success" : "error"
                  }
                  showIcon
                  message={
                    proxyGovernancePreflight.canEnable
                      ? t(
                          "settings.llmGateway.proxyGovernance.preflight.summary.ready",
                        )
                      : t(
                          "settings.llmGateway.proxyGovernance.preflight.summary.blocked",
                        )
                  }
                  description={t(
                    "settings.llmGateway.proxyGovernance.preflight.summary.counts",
                    {
                      blocking: governancePreflightBlockingCount,
                      warnings: governancePreflightWarningCount,
                    },
                  )}
                />
              ) : null}
              <Space wrap>
                <Tooltip
                  title={
                    governanceCanBindCompletion
                      ? undefined
                      : t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindCompletionDisabled",
                        )
                  }
                >
                  <Button
                    size="small"
                    type={
                      governanceTrafficBindings.completion
                        ? "default"
                        : "primary"
                    }
                    disabled={
                      !selectedGovernanceProfile ||
                      governanceTrafficBindings.completion
                    }
                    loading={
                      selectedGovernanceProfile
                        ? activatingProfileId === selectedGovernanceProfile.id
                        : false
                    }
                    onClick={() => {
                      if (!selectedGovernanceProfile) {
                        return;
                      }
                      void handleActivate(selectedGovernanceProfile.id);
                    }}
                  >
                    {governanceTrafficBindings.completion
                      ? t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindCompletionDone",
                        )
                      : t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindCompletion",
                        )}
                  </Button>
                </Tooltip>
                <Tooltip
                  title={
                    governanceCanBindEmbedding
                      ? undefined
                      : t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindEmbeddingDisabled",
                        )
                  }
                >
                  <Button
                    size="small"
                    type={
                      governanceTrafficBindings.embedding
                        ? "default"
                        : "primary"
                    }
                    disabled={
                      !selectedGovernanceProfile ||
                      !governanceCanBindEmbedding ||
                      governanceTrafficBindings.embedding
                    }
                    loading={embeddingActivating}
                    onClick={() => {
                      if (!selectedGovernanceProfile) {
                        return;
                      }
                      void handleActivateEmbedding(
                        selectedGovernanceProfile.id,
                      );
                    }}
                  >
                    {governanceTrafficBindings.embedding
                      ? t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindEmbeddingDone",
                        )
                      : t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindEmbedding",
                        )}
                  </Button>
                </Tooltip>
                <Tooltip
                  title={
                    governanceCanBindRerank
                      ? undefined
                      : t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindRerankDisabled",
                        )
                  }
                >
                  <Button
                    size="small"
                    type={
                      governanceTrafficBindings.rerank ? "default" : "primary"
                    }
                    disabled={
                      !selectedGovernanceProfile ||
                      !governanceCanBindRerank ||
                      governanceTrafficBindings.rerank
                    }
                    loading={rerankActivating}
                    onClick={() => {
                      if (!selectedGovernanceProfile) {
                        return;
                      }
                      void handleActivateRerank(selectedGovernanceProfile.id);
                    }}
                  >
                    {governanceTrafficBindings.rerank
                      ? t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindRerankDone",
                        )
                      : t(
                          "settings.llmGateway.proxyGovernance.preflight.actions.bindRerank",
                        )}
                  </Button>
                </Tooltip>
              </Space>
              {proxyGovernancePreflightLoading ? (
                <Typography.Text type="secondary">
                  {t(
                    "settings.llmGateway.proxyGovernance.preflight.loading",
                  )}
                </Typography.Text>
              ) : null}
              {proxyGovernancePreflightErrorMessage ? (
                <Alert
                  type="error"
                  showIcon
                  message={proxyGovernancePreflightErrorMessage}
                />
              ) : null}
              {proxyGovernancePreflight?.health ? (
                <Space wrap>
                  <Tag
                    color={
                      proxyGovernancePreflight.health.liveliness.ok
                        ? "green"
                        : "red"
                    }
                  >
                    {t(
                      "settings.llmGateway.proxyGovernance.preflight.liveliness",
                      {
                        value: proxyGovernancePreflight.health.liveliness.ok
                          ? "ok"
                          : "failed",
                      },
                    )}
                  </Tag>
                  <Tag
                    color={
                      proxyGovernancePreflight.health.readiness.ok
                        ? "green"
                        : "red"
                    }
                  >
                    {t(
                      "settings.llmGateway.proxyGovernance.preflight.readiness",
                      {
                        value: proxyGovernancePreflight.health.readiness.ok
                          ? "ok"
                          : "failed",
                      },
                    )}
                  </Tag>
                  <Tag>
                    {t(
                      "settings.llmGateway.proxyGovernance.preflight.checkedAt",
                      {
                        value: new Date(
                          proxyGovernancePreflight.health.checkedAt,
                        ).toLocaleString(),
                      },
                    )}
                  </Tag>
                </Space>
              ) : null}
              {proxyGovernancePreflight?.checks.map((check) => (
                <Alert
                  key={check.key}
                  type={
                    check.ok
                      ? "success"
                      : check.required
                        ? "error"
                        : "warning"
                  }
                  showIcon
                  message={check.message}
                />
              ))}
              {governanceRecommendedActions.length > 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message={t(
                    "settings.llmGateway.proxyGovernance.preflight.nextActions",
                  )}
                  description={
                    <Space
                      direction="vertical"
                      size={4}
                      style={{ display: "flex" }}
                    >
                      {governanceRecommendedActions.map((action) => (
                        <Typography.Text
                          key={action}
                        >{`• ${action}`}</Typography.Text>
                      ))}
                    </Space>
                  }
                />
              ) : null}
            </Space>
          </Card>

          <Card
            size="small"
            title={t("settings.llmGateway.proxyGovernance.observed.title")}
            extra={
              <Button
                size="small"
                onClick={() =>
                  void loadGovernanceUsageSummary(
                    proxyGovernanceOpen
                      ? (selectedGovernanceProfile?.id ?? null)
                      : (proxyGovernanceSettings?.targetProfileId ?? null),
                  )
                }
                loading={governanceUsageLoading}
              >
                {t("common.refresh")}
              </Button>
            }
          >
            <Space
              direction="vertical"
              size="small"
              style={{ display: "flex" }}
            >
              <Typography.Text type="secondary">
                {t("settings.llmGateway.proxyGovernance.observed.hint")}
              </Typography.Text>
              <Space wrap>
                <Tag color="blue">
                  {t(
                    "settings.llmGateway.proxyGovernance.observed.daySpend",
                    {
                      value: formatObservedCurrency(
                        governanceUsage24h.governanceBreakdown
                          .governedCostUsd,
                      ),
                    },
                  )}
                </Tag>
                <Tag color="orange">
                  {t(
                    "settings.llmGateway.proxyGovernance.observed.dayDirect",
                    {
                      value: formatObservedCurrency(
                        governanceUsage24h.governanceBreakdown.directCostUsd,
                      ),
                    },
                  )}
                </Tag>
                <Tag color="purple">
                  {t(
                    "settings.llmGateway.proxyGovernance.observed.monthSpend",
                    {
                      value: formatObservedCurrency(
                        governanceUsage30d.governanceBreakdown
                          .governedCostUsd,
                      ),
                    },
                  )}
                </Tag>
                <Tag color="orange">
                  {t(
                    "settings.llmGateway.proxyGovernance.observed.monthDirect",
                    {
                      value: formatObservedCurrency(
                        governanceUsage30d.governanceBreakdown.directCostUsd,
                      ),
                    },
                  )}
                </Tag>
              </Space>
              <div style={governanceMetricGridStyle}>
                <div style={governanceMetricCardStyle}>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.governedRatio",
                    )}
                  </Typography.Text>
                  <Typography.Title level={5} style={{ margin: "8px 0 4px" }}>
                    {formatObservedPercent(governanceObservedGovernedRatio)}
                  </Typography.Title>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.governedRatioDetail",
                      {
                        governed:
                          governanceUsage24h.governanceBreakdown.governedRequestCount.toLocaleString(),
                        total:
                          governanceUsage24h.totals.requestCount.toLocaleString(),
                      },
                    )}
                  </Typography.Text>
                </div>
                <div style={governanceMetricCardStyle}>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.managedKeyRequests",
                    )}
                  </Typography.Text>
                  <Typography.Title level={5} style={{ margin: "8px 0 4px" }}>
                    {governanceUsage24h.governanceBreakdown.managedRuntimeKeyRequestCount.toLocaleString()}
                  </Typography.Title>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.managedKeyRequestsDetail",
                    )}
                  </Typography.Text>
                </div>
                <div style={governanceMetricCardStyle}>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.profileKeyRequests",
                    )}
                  </Typography.Text>
                  <Typography.Title level={5} style={{ margin: "8px 0 4px" }}>
                    {governanceUsage24h.governanceBreakdown.profileKeyRequestCount.toLocaleString()}
                  </Typography.Title>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.profileKeyRequestsDetail",
                    )}
                  </Typography.Text>
                </div>
                <div style={governanceMetricCardStyle}>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.successRate",
                    )}
                  </Typography.Text>
                  <Typography.Title level={5} style={{ margin: "8px 0 4px" }}>
                    {formatObservedPercent(
                      governanceUsage24h.statusBreakdown.successRate * 100,
                      2,
                    )}
                  </Typography.Title>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.cards.successRateDetail",
                      {
                        count: governanceUsage24h.statusBreakdown.error,
                      },
                    )}
                  </Typography.Text>
                </div>
              </div>
              <Card
                size="small"
                type="inner"
                title={t(
                  "settings.llmGateway.proxyGovernance.observed.budgetPressure",
                )}
              >
                <Space
                  direction="vertical"
                  size="small"
                  style={{ display: "flex" }}
                >
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.observed.budgetPressureHint",
                    )}
                  </Typography.Text>
                  <div>
                    <Space
                      align="center"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <Typography.Text>
                        {t(
                          "settings.llmGateway.proxyGovernance.observed.dayBudgetProgress",
                        )}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {`${formatObservedCurrency(
                          governanceUsage24h.governanceBreakdown
                            .governedCostUsd,
                        )} / ${formatObservedCurrency(
                          proxyGovernanceSettings?.dailyBudgetUsd ?? null,
                        )}`}
                      </Typography.Text>
                    </Space>
                    <Progress
                      percent={clampPercent(governanceObservedDayBudgetRatio)}
                      strokeColor={getPressureStatusColor(
                        governanceObservedDayBudgetRatio,
                      )}
                      format={(value) => formatObservedPercent(value)}
                    />
                  </div>
                  <div>
                    <Space
                      align="center"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <Typography.Text>
                        {t(
                          "settings.llmGateway.proxyGovernance.observed.monthBudgetProgress",
                        )}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {`${formatObservedCurrency(
                          governanceUsage30d.governanceBreakdown
                            .governedCostUsd,
                        )} / ${formatObservedCurrency(
                          proxyGovernanceSettings?.monthlyBudgetUsd ?? null,
                        )}`}
                      </Typography.Text>
                    </Space>
                    <Progress
                      percent={clampPercent(
                        governanceObservedMonthBudgetRatio,
                      )}
                      strokeColor={getPressureStatusColor(
                        governanceObservedMonthBudgetRatio,
                      )}
                      format={(value) => formatObservedPercent(value)}
                    />
                  </div>
                  <div>
                    <Space
                      align="center"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <Typography.Text>
                        {t(
                          "settings.llmGateway.proxyGovernance.observed.directLeakage",
                        )}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {`${governanceUsage24h.governanceBreakdown.directRequestCount.toLocaleString()} direct / ${governanceUsage24h.totals.requestCount.toLocaleString()} total`}
                      </Typography.Text>
                    </Space>
                    <Progress
                      percent={clampPercent(governanceObservedDirectRatio)}
                      strokeColor={getPressureStatusColor(
                        governanceObservedDirectRatio,
                      )}
                      format={(value) => formatObservedPercent(value)}
                    />
                  </div>
                </Space>
              </Card>
              <Typography.Text type="secondary">
                {t(
                  "settings.llmGateway.proxyGovernance.observed.dayDetails",
                  {
                    requests:
                      governanceUsage24h.totals.requestCount.toLocaleString(),
                    tokens: formatObservedTokens(
                      governanceUsage24h.totals.totalTokens,
                    ),
                    successRate: (
                      governanceUsage24h.statusBreakdown.successRate * 100
                    ).toFixed(2),
                    errors:
                      governanceUsage24h.statusBreakdown.error.toLocaleString(),
                    latency: formatObservedLatency(
                      governanceUsage24h.latency.p95Ms,
                    ),
                  },
                )}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t(
                  "settings.llmGateway.proxyGovernance.observed.monthDetails",
                  {
                    requests:
                      governanceUsage30d.totals.requestCount.toLocaleString(),
                    tokens: formatObservedTokens(
                      governanceUsage30d.totals.totalTokens,
                    ),
                    successRate: (
                      governanceUsage30d.statusBreakdown.successRate * 100
                    ).toFixed(2),
                    errors:
                      governanceUsage30d.statusBreakdown.error.toLocaleString(),
                    latency: formatObservedLatency(
                      governanceUsage30d.latency.avgMs,
                    ),
                  },
                )}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t(
                  "settings.llmGateway.proxyGovernance.observed.authModeDetails",
                  {
                    managed:
                      governanceUsage24h.governanceBreakdown.managedRuntimeKeyRequestCount.toLocaleString(),
                    direct:
                      governanceUsage24h.governanceBreakdown.profileKeyRequestCount.toLocaleString(),
                  },
                )}
              </Typography.Text>
              {proxyGovernanceSettings?.managedRuntimeKeyState ===
              "unreadable" ? (
                <Alert
                  type="error"
                  showIcon
                  message={t(
                    "settings.llmGateway.proxyGovernance.observed.runtimeKeyUnreadable",
                  )}
                />
              ) : null}
              {governanceObservedZeroGoverned ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t(
                    "settings.llmGateway.proxyGovernance.observed.zeroGoverned",
                  )}
                />
              ) : null}
              {governanceObservedDirectRequests ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t(
                    "settings.llmGateway.proxyGovernance.observed.directRequests",
                  )}
                  description={t(
                    "settings.llmGateway.proxyGovernance.observed.directRequestsDetails",
                    {
                      count:
                        governanceUsage24h.governanceBreakdown
                          .directRequestCount,
                      governed:
                        governanceUsage24h.governanceBreakdown
                          .governedRequestCount,
                    },
                  )}
                />
              ) : null}
              {governanceUsage24h.leadingError ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t(
                    "settings.llmGateway.proxyGovernance.observed.leadingErrorTitle",
                  )}
                  description={`${governanceUsage24h.leadingError.message} (${governanceUsage24h.leadingError.count.toLocaleString()} requests in the last 24h)`}
                />
              ) : null}
              {governanceUsageLoading ? (
                <Typography.Text type="secondary">
                  {t("settings.llmGateway.proxyGovernance.observed.loading")}
                </Typography.Text>
              ) : null}
              {governanceUsageErrorMessage ? (
                <Typography.Text type="danger">
                  {governanceUsageErrorMessage}
                </Typography.Text>
              ) : null}
            </Space>
          </Card>

          <Form
            name="llm-gateway-proxy-governance"
            form={proxyGovernanceForm}
            layout="vertical"
            onFinish={(values) => {
              void saveProxyGovernanceSettings(values);
            }}
          >
            <Form.Item
              name="enabled"
              valuePropName="checked"
              label={t("settings.llmGateway.proxyGovernance.fields.enabled")}
            >
              <Switch />
            </Form.Item>

            <Space wrap style={{ display: "flex" }}>
              <Form.Item
                label={t(
                  "settings.llmGateway.proxyGovernance.fields.targetProfileId",
                )}
                name="targetProfileId"
                style={{ minWidth: 280, flex: 1 }}
                rules={[
                  {
                    required: proxyGovernanceEnabled,
                    message: t(
                      "settings.llmGateway.proxyGovernance.validation.targetProfileRequired",
                    ),
                  },
                ]}
              >
                <Select
                  allowClear={!proxyGovernanceEnabled}
                  options={governanceTargetProfiles}
                  placeholder={t(
                    "settings.llmGateway.proxyGovernance.placeholders.targetProfileId",
                  )}
                />
              </Form.Item>
              <Form.Item
                label={t(
                  "settings.llmGateway.proxyGovernance.fields.dailyBudgetUsd",
                )}
                name="dailyBudgetUsd"
                style={{ minWidth: 200, flex: 1 }}
                rules={[{ required: true }]}
              >
                <InputNumber
                  min={0}
                  max={1_000_000}
                  step={0.1}
                  precision={4}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item
                label={t(
                  "settings.llmGateway.proxyGovernance.fields.monthlyBudgetUsd",
                )}
                name="monthlyBudgetUsd"
                style={{ minWidth: 200, flex: 1 }}
                rules={[{ required: true }]}
              >
                <InputNumber
                  min={0}
                  max={1_000_000}
                  step={1}
                  precision={4}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item
                label={t(
                  "settings.llmGateway.proxyGovernance.fields.maxParallelRequests",
                )}
                name="maxParallelRequests"
                style={{ minWidth: 200, flex: 1 }}
                rules={[{ required: true }]}
                extra={t(
                  "settings.llmGateway.proxyGovernance.hints.maxParallelRequests",
                )}
              >
                <InputNumber
                  min={1}
                  max={1_024}
                  step={1}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Space>
          </Form>
        </Space>
      </Spin>
    </Modal>

  );
}
