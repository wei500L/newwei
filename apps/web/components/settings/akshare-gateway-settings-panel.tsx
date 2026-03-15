"use client";

import {
  Alert,
  Button,
  Card,
  Modal,
  Select,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  EconomicDataFrequency,
  useEconomicDataRefreshPresetStatusQuery,
  useEconomicFetchConfigsQuery,
  useTriggerEconomicDataRefreshPresetMutation,
  useUpdateEconomicFetchConfigMutation,
} from "@/graphql/generated";
import type {
  TriggerEconomicDataRefreshPresetMutationVariables,
} from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG,
  ECONOMIC_DASHBOARD_REFRESH_PRESET_ORDER,
  type EconomicDashboardRefreshPreset as EconomicDashboardRefreshPresetKey,
} from "@modular/utils";

interface AkshareGatewayVersionResponse {
  akshareVersion: string;
  pythonVersion: string;
}

interface AkshareGatewayUpgradeAcceptedResponse {
  status: "accepted";
  requestId: string;
  beforeVersion: string;
}

interface AkshareGatewayUpgradeStatusResponse {
  inProgress: boolean;
  stage: "idle" | "queued" | "running" | "restarting" | "failed";
  requestId: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  restartScheduledAt: string | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  error: string | null;
  pipStdout: string | null;
  pipStderr: string | null;
  pid?: number;
  upgradeEnabled?: boolean;
  disabledReason?: string;
}

interface EconomicProviderMetadata {
  providerKind?: "akshare" | "finnhub" | "fred" | "yfinance";
  requiresSecret?: "finnhubApiKey" | "fredApiKey" | null;
  mainlineRole?: string | null;
  snapshot?: {
    group?: string;
    bucket?: string;
    symbol?: string;
    name?: string;
  } | null;
}

interface EconomicProviderSecretStatusResponse {
  hasFinnhubApiKey: boolean;
  hasFredApiKey: boolean;
}

function parseEconomicProviderMetadata(
  metadata: unknown,
): EconomicProviderMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const record = metadata as Record<string, unknown>;
  const snapshot =
    record.snapshot &&
    typeof record.snapshot === "object" &&
    !Array.isArray(record.snapshot)
      ? (record.snapshot as EconomicProviderMetadata["snapshot"])
      : null;
  return {
    providerKind:
      record.providerKind === "finnhub" ||
      record.providerKind === "fred" ||
      record.providerKind === "yfinance" ||
      record.providerKind === "akshare"
        ? record.providerKind
        : undefined,
    requiresSecret:
      record.requiresSecret === "finnhubApiKey" ||
      record.requiresSecret === "fredApiKey"
        ? record.requiresSecret
        : null,
    mainlineRole:
      typeof record.mainlineRole === "string" ? record.mainlineRole : null,
    snapshot,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ECONOMIC_FREQUENCY_OPTIONS = [
  EconomicDataFrequency.Realtime,
  EconomicDataFrequency.Hourly,
  EconomicDataFrequency.Daily,
  EconomicDataFrequency.Weekly,
  EconomicDataFrequency.Monthly,
];

export function AkshareGatewaySettingsPanel() {
  const { t, i18n } = useTranslation();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageEconomicData = permissions.includes("economicdata.manage");
  const locale = resolveLocale(i18n.language);
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [refreshSubmitting, setRefreshSubmitting] = useState(false);
  const [statusPolling, setStatusPolling] = useState(false);
  const [selectedPreset, setSelectedPreset] =
    useState<EconomicDashboardRefreshPresetKey>();
  const [version, setVersion] = useState<AkshareGatewayVersionResponse | null>(
    null,
  );
  const [status, setStatus] =
    useState<AkshareGatewayUpgradeStatusResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [providerSecretStatus, setProviderSecretStatus] =
    useState<EconomicProviderSecretStatusResponse | null>(null);
  const [updatingProviderSlug, setUpdatingProviderSlug] = useState<
    string | null
  >(null);
  const [triggerEconomicDataRefreshPreset] =
    useTriggerEconomicDataRefreshPresetMutation();
  const [updateEconomicFetchConfig] = useUpdateEconomicFetchConfigMutation();
  const presetStatusBaselineRef = useRef<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const fetchVersion = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<AkshareGatewayVersionResponse>(
        "admin/akshare/version",
        {
          timeout: 10_000,
        },
      );
      setVersion(response.data);
    } catch (error) {
      captureClientError("Failed to load akshare gateway version", error);
      setErrorMessage(t("systemSettings.akshare.errors.loadVersion"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, t]);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await apiClient.get<AkshareGatewayUpgradeStatusResponse>(
        "admin/akshare/status",
        {
          timeout: 10_000,
        },
      );
      setStatus(response.data);
      return response.data;
    } catch (error) {
      captureClientError("Failed to load akshare gateway status", error);
      setStatus(null);
      setErrorMessage(t("systemSettings.akshare.errors.loadStatus"));
      return null;
    }
  }, [apiClient, t]);

  const fetchProviderSecretStatus = useCallback(async () => {
    if (!canManageEconomicData) {
      setProviderSecretStatus(null);
      return;
    }
    try {
      const response =
        await apiClient.get<EconomicProviderSecretStatusResponse>(
          "system-settings/situation-monitor",
          {
            timeout: 10_000,
          },
        );
      setProviderSecretStatus({
        hasFinnhubApiKey: Boolean(response.data?.hasFinnhubApiKey),
        hasFredApiKey: Boolean(response.data?.hasFredApiKey),
      });
    } catch (error) {
      captureClientError(
        "Failed to load financial provider secret status",
        error,
      );
      setProviderSecretStatus(null);
    }
  }, [apiClient, canManageEconomicData]);

  useEffect(() => {
    void fetchVersion();
    void fetchStatus();
    void fetchProviderSecretStatus();
  }, [fetchProviderSecretStatus, fetchStatus, fetchVersion]);

  const {
    data: fetchConfigsData,
    loading: fetchConfigsLoading,
    refetch: refetchFetchConfigs,
  } = useEconomicFetchConfigsQuery({
    skip: !canManageEconomicData,
    fetchPolicy: "cache-and-network",
    notifyOnNetworkStatusChange: true,
  });

  const presetQueryVariables = selectedPreset
    ? {
        preset:
          selectedPreset as TriggerEconomicDataRefreshPresetMutationVariables["preset"],
      }
    : undefined;
  const {
    data: presetStatusData,
    loading: presetStatusLoading,
    error: presetStatusError,
    refetch: refetchPresetStatus,
  } = useEconomicDataRefreshPresetStatusQuery({
    variables: presetQueryVariables as NonNullable<typeof presetQueryVariables>,
    skip: !canManageEconomicData || !presetQueryVariables,
    fetchPolicy: "network-only",
    notifyOnNetworkStatusChange: true,
    pollInterval: statusPolling ? 2000 : 0,
  });

  useEffect(() => {
    if (!statusPolling) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setStatusPolling(false);
    }, 30_000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [statusPolling]);

  const handleUpgrade = useCallback(() => {
    if (status?.upgradeEnabled === false) {
      const reason =
        status.disabledReason ??
        t("systemSettings.akshare.errors.upgradeDisabled");
      messageApi.warning(reason);
      return;
    }

    Modal.confirm({
      title: t("systemSettings.akshare.modal.title"),
      content: t("systemSettings.akshare.modal.content"),
      okText: t("systemSettings.akshare.modal.confirm"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setUpgrading(true);
        setErrorMessage(null);
        try {
          const response =
            await apiClient.post<AkshareGatewayUpgradeAcceptedResponse>(
              "admin/akshare/upgrade",
              {},
              { timeout: 30_000 },
            );
          messageApi.success(
            t("systemSettings.akshare.upgradeStarted", {
              version: response.data.beforeVersion,
            }),
          );

          const requestId = response.data.requestId;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const currentStatus = await fetchStatus();
            if (currentStatus?.requestId === requestId) {
              if (currentStatus.stage === "failed") {
                const detail = currentStatus.error
                  ? `: ${currentStatus.error}`
                  : "";
                throw new Error(
                  t("systemSettings.akshare.errors.upgradeFailed") + detail,
                );
              }
              if (currentStatus.stage === "restarting") {
                break;
              }
            }
            await sleep(2000);
          }

          await sleep(2000);
          for (let attempt = 0; attempt < 30; attempt += 1) {
            try {
              await fetchVersion();
              break;
            } catch {
              // gateway may be restarting
            }
            await sleep(2000);
          }
        } catch (error) {
          const statusCode =
            typeof error === "object" && error && "response" in error
              ? (error as { response?: { status?: number } }).response?.status
              : undefined;
          if (statusCode === 409) {
            messageApi.info(t("systemSettings.akshare.errors.inProgress"));
            void fetchStatus();
            return;
          }
          if (statusCode === 503) {
            messageApi.error(t("systemSettings.akshare.errors.missingToken"));
            setErrorMessage(t("systemSettings.akshare.errors.missingToken"));
            return;
          }
          if (statusCode === 404) {
            messageApi.error(t("systemSettings.akshare.errors.noAdmin"));
            setErrorMessage(t("systemSettings.akshare.errors.noAdmin"));
            return;
          }

          captureClientError("Failed to upgrade akshare gateway", error);
          messageApi.error(t("systemSettings.akshare.errors.upgradeFailed"));
          setErrorMessage(t("systemSettings.akshare.errors.upgradeFailed"));
          throw error;
        } finally {
          setUpgrading(false);
        }
      },
    });
  }, [apiClient, fetchStatus, fetchVersion, messageApi, status, t]);

  const currentVersion = version?.akshareVersion ?? "-";
  const pythonVersion = version?.pythonVersion ?? "-";
  const stage = status?.stage ?? "unknown";
  const presetStatus =
    presetStatusData?.economicDataRefreshPresetStatus ?? null;
  const selectedPresetConfig = selectedPreset
    ? ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG[selectedPreset]
    : null;
  const selectedPresetLabel = selectedPresetConfig
    ? t(selectedPresetConfig.labelKey)
    : "";
  const upgradeDisabledReason =
    status?.upgradeEnabled === false
      ? (status.disabledReason ??
        t("systemSettings.akshare.errors.upgradeDisabled"))
      : null;
  const stageColor =
    stage === "failed"
      ? "red"
      : stage === "restarting" || stage === "running" || stage === "queued"
        ? "orange"
        : stage === "idle"
          ? "green"
          : "default";

  useEffect(() => {
    if (!statusPolling || !presetStatus) {
      return;
    }
    const latestRunAt = presetStatus.lastRunAt ?? null;
    if (latestRunAt && latestRunAt !== presetStatusBaselineRef.current) {
      setStatusPolling(false);
    }
  }, [presetStatus, statusPolling]);

  const handleTriggerManualRefresh = useCallback(() => {
    if (!canManageEconomicData) {
      messageApi.error(
        t("systemSettings.akshare.manualRefresh.errors.permissionRequired"),
      );
      return;
    }
    if (!selectedPreset) {
      messageApi.warning(
        t("systemSettings.akshare.manualRefresh.errors.presetRequired"),
      );
      return;
    }

    Modal.confirm({
      title: t("systemSettings.akshare.manualRefresh.modal.title"),
      content: t("systemSettings.akshare.manualRefresh.modal.content", {
        preset: selectedPresetLabel,
      }),
      okText: t("systemSettings.akshare.manualRefresh.modal.confirm"),
      onOk: async () => {
        setRefreshSubmitting(true);
        try {
          presetStatusBaselineRef.current = presetStatus?.lastRunAt ?? null;
          await triggerEconomicDataRefreshPreset({
            variables: {
              preset:
                selectedPreset as TriggerEconomicDataRefreshPresetMutationVariables["preset"],
            },
          });
          await refetchPresetStatus();
          setStatusPolling(true);
          messageApi.success(
            t("systemSettings.akshare.manualRefresh.messages.started", {
              preset: selectedPresetLabel,
            }),
          );
        } catch (error) {
          captureClientError(
            "Failed to trigger economic refresh preset",
            error,
          );
          messageApi.error(
            error instanceof Error && error.message
              ? error.message
              : t("systemSettings.akshare.manualRefresh.errors.triggerFailed"),
          );
        } finally {
          setRefreshSubmitting(false);
        }
      },
    });
  }, [
    canManageEconomicData,
    messageApi,
    selectedPreset,
    selectedPresetLabel,
    presetStatus?.lastRunAt,
    refetchPresetStatus,
    t,
    triggerEconomicDataRefreshPreset,
  ]);

  const handlePresetChange = useCallback(
    (value: EconomicDashboardRefreshPresetKey) => {
      setSelectedPreset(value);
      setStatusPolling(false);
      presetStatusBaselineRef.current = null;
    },
    [],
  );

  const formattedPresetLastRunAt = presetStatus?.lastRunAt
    ? formatDateTime(presetStatus.lastRunAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : t("common.never");
  const presetStatusLabel = presetStatus?.lastStatus
    ? t(`common.${presetStatus.lastStatus}`, {
        defaultValue: presetStatus.lastStatus,
      })
    : t("common.notAvailable");
  const presetStatusColor =
    presetStatus?.lastStatus === "success"
      ? "green"
      : presetStatus?.lastStatus === "failed"
        ? "red"
        : "default";

  const providerRows = useMemo(() => {
    const configs = fetchConfigsData?.economicDataFetchConfigs ?? [];
    return configs
      .map((config) => {
        const metadata = parseEconomicProviderMetadata(config.item.metadata);
        if (!metadata.providerKind || metadata.providerKind === "akshare") {
          return null;
        }

        const secretConfigured =
          metadata.requiresSecret === "finnhubApiKey"
            ? (providerSecretStatus?.hasFinnhubApiKey ?? false)
            : metadata.requiresSecret === "fredApiKey"
              ? (providerSecretStatus?.hasFredApiKey ?? false)
              : true;

        return {
          key: config.id,
          slug: config.item.slug,
          displayName: config.item.displayName,
          providerKind: metadata.providerKind,
          requiresSecret: metadata.requiresSecret,
          secretConfigured,
          mainlineRole: metadata.mainlineRole ?? "canonical",
          snapshotBucket: metadata.snapshot?.bucket ?? "mainline",
          snapshotSymbol:
            metadata.snapshot?.symbol ??
            metadata.snapshot?.name ??
            config.item.slug,
          isEnabled: config.isEnabled,
          frequency: config.frequency,
          lastStatus: config.lastStatus ?? null,
          lastError: config.lastError ?? null,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((left, right) => {
        const providerOrder = left.providerKind.localeCompare(
          right.providerKind,
        );
        if (providerOrder !== 0) {
          return providerOrder;
        }
        const bucketOrder = left.snapshotBucket.localeCompare(
          right.snapshotBucket,
        );
        if (bucketOrder !== 0) {
          return bucketOrder;
        }
        return left.displayName.localeCompare(right.displayName);
      });
  }, [fetchConfigsData?.economicDataFetchConfigs, providerSecretStatus]);

  const handleUpdateProviderConfig = useCallback(
    async (
      slug: string,
      patch: {
        isEnabled?: boolean;
        frequency?: EconomicDataFrequency;
      },
    ) => {
      setUpdatingProviderSlug(slug);
      try {
        await updateEconomicFetchConfig({
          variables: {
            slug,
            isEnabled: patch.isEnabled,
            frequency: patch.frequency,
          },
        });
        await refetchFetchConfigs();
        messageApi.success(
          t("systemSettings.akshare.providers.updated", {
            defaultValue: "Provider item updated.",
          }),
        );
      } catch (error) {
        captureClientError("Failed to update economic provider config", error);
        messageApi.error(
          error instanceof Error && error.message
            ? error.message
            : t("systemSettings.akshare.providers.updateFailed", {
                defaultValue: "Failed to update provider item.",
              }),
        );
      } finally {
        setUpdatingProviderSlug(null);
      }
    },
    [messageApi, refetchFetchConfigs, t, updateEconomicFetchConfig],
  );

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary">
        {t("systemSettings.akshare.description")}
      </Typography.Paragraph>

      {errorMessage ? (
        <Alert
          style={{ marginBottom: "1rem" }}
          type="error"
          message={errorMessage}
          showIcon
        />
      ) : null}

      {upgradeDisabledReason ? (
        <Alert
          style={{ marginBottom: "1rem" }}
          type="warning"
          message={upgradeDisabledReason}
          showIcon
        />
      ) : null}

      <Card
        size="small"
        title={t("systemSettings.akshare.title")}
        style={{ marginBottom: "1rem" }}
      >
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Typography.Text>{t("systemSettings.akshare.label")}</Typography.Text>
          <Tag color="blue">{currentVersion}</Tag>
          <Typography.Text type="secondary">
            {t("systemSettings.akshare.python", { version: pythonVersion })}
          </Typography.Text>
          <Tag color={stageColor}>
            {t(`systemSettings.akshare.stage.${stage}`, {
              defaultValue: stage,
            })}
          </Tag>
          <Button onClick={() => void fetchVersion()} loading={loading}>
            {t("common.refresh")}
          </Button>
          <Button onClick={() => void fetchStatus()} disabled={loading}>
            {t("systemSettings.akshare.refreshStatus")}
          </Button>
          <Button
            type="primary"
            danger
            onClick={handleUpgrade}
            loading={upgrading}
            disabled={
              loading ||
              upgrading ||
              Boolean(status?.inProgress) ||
              status?.upgradeEnabled === false
            }
          >
            {t("systemSettings.akshare.upgrade")}
          </Button>
        </div>
        {status?.requestId ? (
          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: "0.75rem", marginBottom: 0 }}
          >
            {t("systemSettings.akshare.request", {
              requestId: status.requestId,
              before: status.beforeVersion ?? null,
              after: status.afterVersion ?? null,
            })}
          </Typography.Paragraph>
        ) : null}
        {status?.error ? (
          <Typography.Paragraph
            type="danger"
            style={{ marginTop: "0.75rem", marginBottom: 0 }}
          >
            {status.error}
          </Typography.Paragraph>
        ) : null}
      </Card>

      <Card
        size="small"
        title={t("systemSettings.akshare.manualRefresh.title")}
      >
        <Typography.Paragraph type="secondary">
          {t("systemSettings.akshare.manualRefresh.description")}
        </Typography.Paragraph>
        {!canManageEconomicData ? (
          <Alert
            style={{ marginBottom: "1rem" }}
            type="warning"
            showIcon
            message={t(
              "systemSettings.akshare.manualRefresh.permissionRequired",
            )}
          />
        ) : null}
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 280, flex: "1 1 320px" }}>
            <Typography.Text style={{ display: "block", marginBottom: 8 }}>
              {t("systemSettings.akshare.manualRefresh.fields.preset")}
            </Typography.Text>
            <Select
              value={selectedPreset}
              placeholder={t(
                "systemSettings.akshare.manualRefresh.fields.presetPlaceholder",
              )}
              onChange={(value) =>
                handlePresetChange(value as EconomicDashboardRefreshPresetKey)
              }
              disabled={!canManageEconomicData || refreshSubmitting}
              options={ECONOMIC_DASHBOARD_REFRESH_PRESET_ORDER.map(
                (preset) => ({
                  value: preset,
                  label: t(
                    ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG[preset].labelKey,
                  ),
                }),
              )}
            />
          </div>
          <Button
            type="primary"
            onClick={handleTriggerManualRefresh}
            loading={refreshSubmitting}
            disabled={
              !canManageEconomicData || refreshSubmitting || !selectedPreset
            }
          >
            {t("systemSettings.akshare.manualRefresh.actions.trigger")}
          </Button>
        </div>
        {selectedPreset ? (
          <div style={{ marginTop: "1rem" }}>
            <Typography.Text strong>
              {t("systemSettings.akshare.manualRefresh.summary.title")}
            </Typography.Text>
            {presetStatusError ? (
              <Alert
                style={{ marginTop: "0.75rem" }}
                type="error"
                showIcon
                message={
                  presetStatusError.message ||
                  t(
                    "systemSettings.akshare.manualRefresh.errors.statusLoadFailed",
                  )
                }
              />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: "0.75rem",
                  marginTop: "0.75rem",
                }}
              >
                <Card size="small">
                  <Typography.Text type="secondary">
                    {t(
                      "systemSettings.akshare.manualRefresh.summary.totalItems",
                    )}
                  </Typography.Text>
                  <div>{presetStatus?.totalItems ?? "-"}</div>
                </Card>
                <Card size="small">
                  <Typography.Text type="secondary">
                    {t(
                      "systemSettings.akshare.manualRefresh.summary.enabledItems",
                    )}
                  </Typography.Text>
                  <div>{presetStatus?.enabledItems ?? "-"}</div>
                </Card>
                <Card size="small">
                  <Typography.Text type="secondary">
                    {t(
                      "systemSettings.akshare.manualRefresh.summary.lastRunAt",
                    )}
                  </Typography.Text>
                  <div>
                    {presetStatusLoading
                      ? t("common.loading", { defaultValue: "Loading..." })
                      : formattedPresetLastRunAt}
                  </div>
                </Card>
                <Card size="small">
                  <Typography.Text type="secondary">
                    {t(
                      "systemSettings.akshare.manualRefresh.summary.lastStatus",
                    )}
                  </Typography.Text>
                  <div>
                    <Tag color={presetStatusColor}>{presetStatusLabel}</Tag>
                  </div>
                </Card>
              </div>
            )}
            {presetStatus?.lastError ? (
              <Alert
                style={{ marginTop: "0.75rem" }}
                type="warning"
                showIcon
                message={t(
                  "systemSettings.akshare.manualRefresh.summary.lastError",
                )}
                description={presetStatus.lastError}
              />
            ) : null}
            {statusPolling ? (
              <Typography.Paragraph
                type="secondary"
                style={{ marginTop: "0.75rem", marginBottom: 0 }}
              >
                {t("systemSettings.akshare.manualRefresh.summary.polling")}
              </Typography.Paragraph>
            ) : null}
          </div>
        ) : null}
      </Card>

      {canManageEconomicData ? (
        <Card
          size="small"
          title={t("systemSettings.akshare.providers.title", {
            defaultValue: "Financial data providers",
          })}
          style={{ marginTop: "1rem" }}
          extra={
            <Button
              onClick={() => {
                void refetchFetchConfigs();
                void fetchProviderSecretStatus();
              }}
              loading={fetchConfigsLoading}
            >
              {t("common.refresh")}
            </Button>
          }
        >
          <Typography.Paragraph type="secondary">
            {t("systemSettings.akshare.providers.description", {
              defaultValue:
                "Shows non-Akshare provider items now managed by the economic data mainline, including API key readiness and latest fetch status.",
            })}
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey="key"
            loading={fetchConfigsLoading}
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={providerRows}
            columns={[
              {
                title: t("common.name", { defaultValue: "Name" }),
                dataIndex: "displayName",
                key: "displayName",
                render: (value: string, row) => (
                  <div>
                    <div>{value}</div>
                    <Typography.Text type="secondary">
                      {row.slug}
                    </Typography.Text>
                  </div>
                ),
              },
              {
                title: t("systemSettings.akshare.providers.provider", {
                  defaultValue: "Provider",
                }),
                dataIndex: "providerKind",
                key: "providerKind",
                width: 120,
                render: (value: string) => (
                  <Tag color="blue">{value.toUpperCase()}</Tag>
                ),
              },
              {
                title: t("systemSettings.akshare.providers.scope", {
                  defaultValue: "Mainline role",
                }),
                key: "scope",
                width: 180,
                render: (_: unknown, row) => (
                  <>
                    <Tag>{row.mainlineRole}</Tag>
                    <Tag color="default">{row.snapshotBucket}</Tag>
                  </>
                ),
              },
              {
                title: t("systemSettings.akshare.providers.secret", {
                  defaultValue: "Secret",
                }),
                key: "secret",
                width: 180,
                render: (_: unknown, row) => {
                  if (!row.requiresSecret) {
                    return (
                      <Tag color="default">
                        {t("systemSettings.akshare.providers.notRequired", {
                          defaultValue: "Not required",
                        })}
                      </Tag>
                    );
                  }
                  return (
                    <Tag color={row.secretConfigured ? "green" : "orange"}>
                      {row.requiresSecret}
                      {" · "}
                      {row.secretConfigured
                        ? t("systemSettings.akshare.providers.configured", {
                            defaultValue: "configured",
                          })
                        : t("systemSettings.akshare.providers.missing", {
                            defaultValue: "missing",
                          })}
                    </Tag>
                  );
                },
              },
              {
                title: t("systemSettings.akshare.providers.schedule", {
                  defaultValue: "Schedule",
                }),
                key: "schedule",
                width: 220,
                render: (_: unknown, row) => (
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <Switch
                      size="small"
                      checked={row.isEnabled}
                      loading={updatingProviderSlug === row.slug}
                      onChange={(checked) => {
                        void handleUpdateProviderConfig(row.slug, {
                          isEnabled: checked,
                        });
                      }}
                    />
                    <Select
                      size="small"
                      style={{ minWidth: 110 }}
                      value={row.frequency}
                      disabled={updatingProviderSlug === row.slug}
                      onChange={(value) => {
                        void handleUpdateProviderConfig(row.slug, {
                          frequency: value as EconomicDataFrequency,
                        });
                      }}
                      options={ECONOMIC_FREQUENCY_OPTIONS.map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                  </div>
                ),
              },
              {
                title: t("systemSettings.akshare.providers.latestStatus", {
                  defaultValue: "Latest status",
                }),
                key: "latestStatus",
                width: 240,
                render: (_: unknown, row) => (
                  <div>
                    <Tag
                      color={
                        row.lastStatus === "success"
                          ? "green"
                          : row.lastStatus === "failed"
                            ? "red"
                            : "default"
                      }
                    >
                      {row.lastStatus ?? t("common.notAvailable")}
                    </Tag>
                    {row.lastError ? (
                      <Typography.Text type="secondary">
                        {row.lastError}
                      </Typography.Text>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}
