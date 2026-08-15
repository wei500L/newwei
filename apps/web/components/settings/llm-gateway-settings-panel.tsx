"use client";

import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import type { ReactElement } from "react";

import { LlmGatewayEmbeddingRerankPanel } from "./llm-gateway/llm-gateway-embedding-rerank-panel";
import { LlmGatewayProfileModals } from "./llm-gateway/llm-gateway-profile-modals";
import { LlmGatewayProfilesPanel } from "./llm-gateway/llm-gateway-profiles-panel";
import {
  LlmGatewayProxyGovernancePanel,
  useLlmGatewayProxyGovernance,
} from "./llm-gateway/llm-gateway-proxy-governance-panel";
import {
  LlmGatewayProxyLbPanel,
  useLlmGatewayProxyLb,
} from "./llm-gateway/llm-gateway-proxy-lb-panel";
import {
  formatObservedCurrency,
  formatObservedLatency,
  formatObservedTokens,
} from "./llm-gateway/llm-gateway.formatters";
import { useLlmGatewaySettings } from "./llm-gateway/use-llm-gateway-settings";

export function LlmGatewaySettingsPanel(): ReactElement {
  const s = useLlmGatewaySettings();
  const g = useLlmGatewayProxyGovernance({
    t: s.t,
    token: s.token,
    apiClient: s.apiClient,
    messageApi: s.messageApi,
    screensMd: s.screens.md,
    settings: s.settings,
    resolvedCompletionProfile: s.resolvedCompletionProfile,
    resolvedEmbeddingProfile: s.resolvedEmbeddingProfile,
    resolvedRerankProfile: s.resolvedRerankProfile,
  });
  const lb = useLlmGatewayProxyLb({
    t: s.t,
    apiClient: s.apiClient,
    messageApi: s.messageApi,
  });

  s.bindGovernedProfileLockedId(g.governedProfileLockedId);

  const { t, contextHolder } = s;
  const governedTargetProfile = g.governedTargetProfile;
  const resolvedCompletionProfile = s.resolvedCompletionProfile;
  const statusProfile =
    governedTargetProfile ??
    resolvedCompletionProfile ??
    s.settings.profiles[0] ??
    null;
  const statusProfileProxyModelInfo =
    statusProfile && s.proxyModelInfoSnapshot?.profileId === statusProfile.id
      ? s.proxyModelInfoSnapshot
      : null;
  const statusProfileProxyLbTest =
    statusProfile && lb.proxyLbTestSnapshot?.profileId === statusProfile.id
      ? lb.proxyLbTestSnapshot
      : null;

  const {
    handleCheckProxyHealth,
    checkingProxyHealth,
    handleProxyModelInfo,
    loadingProxyModelInfo,
    handleListModels,
    loadingModels,
    proxyHealthProfileId,
    proxyHealth,
    modelsSnapshot,
    proxyHealthErrorMessage,
  } = s;
  const { openProxyLbWizard, openProxyLbTest } = lb;
  const { openProxyGovernanceWizard } = g;
  const {
    proxyGovernanceSettings,
    governanceAttentionItems,
    governanceMetricGridStyle,
    governanceOverviewCards,
    governanceMetricCardStyle,
    governanceNoneLabel,
    governanceKeyStateMeta,
    governanceKeyStateLabel,
    governanceHasTrafficBindings,
    governanceTrafficLabels,
    governanceUsage24h,
    governanceUsageLoading,
    governanceUsageErrorMessage,
  } = g;

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size="middle" style={{ display: "flex" }}>
    <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
      {t("settings.llmGateway.description")}
    </Typography.Paragraph>

    <Card size="small" title={t("settings.llmGateway.guardrails.title")}>
      <Space direction="vertical" size="small" style={{ display: "flex" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.guardrails.scope")}
        </Typography.Paragraph>

        <Alert
          type="info"
          showIcon
          message={t("settings.llmGateway.guardrails.howItWorks.title")}
          description={
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0 }}
            >
              {t("settings.llmGateway.guardrails.howItWorks.body")}
            </Typography.Paragraph>
          }
        />

        <Typography.Text strong>
          {t("settings.llmGateway.guardrails.setup.title")}
        </Typography.Text>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <Typography.Text type="secondary">
              {t("settings.llmGateway.guardrails.setup.proxyConfigPrefix")}{" "}
              <Typography.Text code>
                infra/litellm/litellm-config.yaml
              </Typography.Text>{" "}
              {t("settings.llmGateway.guardrails.setup.proxyConfigSuffix")}{" "}
              <Typography.Text code>openai-moderation-pre</Typography.Text>
            </Typography.Text>
          </li>
          <li>
            <Typography.Text type="secondary">
              {t("settings.llmGateway.guardrails.setup.apiEnvPrefix")}{" "}
              <Typography.Text code>ASSISTANT_GUARDRAILS</Typography.Text>=
              <Typography.Text code>openai-moderation-pre</Typography.Text>{" "}
              {t("settings.llmGateway.guardrails.setup.apiEnvSuffix")}
            </Typography.Text>
          </li>
          <li>
            <Typography.Text type="secondary">
              {t("settings.llmGateway.guardrails.setup.verify")}
            </Typography.Text>
          </li>
        </ul>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.guardrails.notes")}
        </Typography.Paragraph>
      </Space>
    </Card>

    <Card size="small" title={t("settings.llmGateway.proxyStatus.title")}>
      {statusProfile ? (
        <Space
          direction="vertical"
          size="small"
          style={{ display: "flex" }}
        >
          <Typography.Text type="secondary">
            {t("settings.llmGateway.proxyStatus.target", {
              name: statusProfile.name,
            })}
          </Typography.Text>

          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: 0 }}
          >
            {t("settings.llmGateway.fields.apiBase")}:{" "}
            <Typography.Text code copyable>
              {(proxyHealthProfileId === statusProfile.id
                ? proxyHealth?.apiBase
                : undefined) ??
                (modelsSnapshot?.profileId === statusProfile.id
                  ? modelsSnapshot.apiBase
                  : undefined) ??
                statusProfile.apiBase}
            </Typography.Text>
          </Typography.Paragraph>

          <Space wrap>
            <Button
              size="small"
              onClick={() => void handleCheckProxyHealth(statusProfile)}
              loading={checkingProxyHealth === statusProfile.id}
            >
              {t("settings.llmGateway.proxyStatus.actions.checkHealth")}
            </Button>
            <Button
              size="small"
              onClick={() => void handleProxyModelInfo(statusProfile)}
              loading={loadingProxyModelInfo === statusProfile.id}
            >
              {t("settings.llmGateway.proxyStatus.actions.modelInfo")}
            </Button>
            <Button
              size="small"
              onClick={() => void handleListModels(statusProfile)}
              loading={loadingModels === statusProfile.id}
            >
              {t("settings.llmGateway.proxyStatus.actions.models")}
            </Button>
            <Button size="small" onClick={openProxyLbWizard}>
              {t("settings.llmGateway.proxyStatus.actions.loadBalancing")}
            </Button>
            <Button size="small" onClick={openProxyGovernanceWizard}>
              {t("settings.llmGateway.proxyStatus.actions.governance")}
            </Button>
            <Button
              size="small"
              onClick={() => openProxyLbTest(statusProfile)}
            >
              {t("settings.llmGateway.proxyStatus.actions.lbTest")}
            </Button>
          </Space>

          {proxyHealthProfileId === statusProfile.id && proxyHealth ? (
            <>
              <Space wrap>
                <Tag color={proxyHealth.liveliness.ok ? "green" : "red"}>
                  {t("settings.llmGateway.proxyStatus.liveliness")}{" "}
                  {proxyHealth.liveliness.ok
                    ? t("common.success")
                    : t("common.failed")}
                  {proxyHealth.liveliness.status
                    ? ` (HTTP ${proxyHealth.liveliness.status})`
                    : ""}
                </Tag>
                <Tag color={proxyHealth.readiness.ok ? "green" : "red"}>
                  {t("settings.llmGateway.proxyStatus.readiness")}{" "}
                  {proxyHealth.readiness.ok
                    ? t("common.success")
                    : t("common.failed")}
                  {proxyHealth.readiness.status
                    ? ` (HTTP ${proxyHealth.readiness.status})`
                    : ""}
                </Tag>
              </Space>

              <Typography.Text type="secondary">
                {t("settings.llmGateway.proxyStatus.checkedAt", {
                  time: new Date(proxyHealth.checkedAt).toLocaleString(),
                })}
              </Typography.Text>

              {!proxyHealth.liveliness.ok &&
              proxyHealth.liveliness.message ? (
                <Typography.Text type="secondary">
                  {proxyHealth.liveliness.message}
                </Typography.Text>
              ) : null}
              {!proxyHealth.readiness.ok &&
              proxyHealth.readiness.message ? (
                <Typography.Text type="secondary">
                  {proxyHealth.readiness.message}
                </Typography.Text>
              ) : null}
            </>
          ) : (
            <Typography.Text type="secondary">
              {t("settings.llmGateway.proxyStatus.hint")}
            </Typography.Text>
          )}

          {proxyGovernanceSettings ? (
            <Alert
              type={
                governanceAttentionItems.some(
                  (item) => item.type === "error",
                )
                  ? "warning"
                  : !proxyGovernanceSettings.adminKeyConfigured
                    ? "warning"
                    : proxyGovernanceSettings.enabled
                      ? "success"
                      : "info"
              }
              showIcon
              message={t(
                "settings.llmGateway.proxyGovernance.summary.title",
              )}
              description={
                <Space
                  direction="vertical"
                  size="middle"
                  style={{ display: "flex" }}
                >
                  <Typography.Text type="secondary">
                    {t("settings.llmGateway.proxyGovernance.summary.body")}
                  </Typography.Text>
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
                  <Space wrap>
                    <Tag
                      color={
                        proxyGovernanceSettings.enabled
                          ? "green"
                          : "default"
                      }
                    >
                      {proxyGovernanceSettings.enabled
                        ? t(
                            "settings.llmGateway.proxyGovernance.summary.enabled",
                          )
                        : t(
                            "settings.llmGateway.proxyGovernance.summary.disabled",
                          )}
                    </Tag>
                    <Tag color="blue">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.targetProfile",
                        {
                          value:
                            proxyGovernanceSettings.targetProfileName ??
                            proxyGovernanceSettings.targetProfileId ??
                            governanceNoneLabel,
                        },
                      )}
                    </Tag>
                    <Tag color={governanceKeyStateMeta.color}>
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.key",
                        {
                          value:
                            proxyGovernanceSettings.managedRuntimeKeyAlias ??
                            governanceKeyStateLabel,
                        },
                      )}
                    </Tag>
                    <Tag color="cyan">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.parallel",
                        {
                          value:
                            proxyGovernanceSettings.maxParallelRequests,
                        },
                      )}
                    </Tag>
                    <Tag color="blue">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.dayBudget",
                        {
                          value:
                            proxyGovernanceSettings.dailyBudgetUsd.toFixed(
                              4,
                            ),
                        },
                      )}
                    </Tag>
                    <Tag color="purple">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.monthBudget",
                        {
                          value:
                            proxyGovernanceSettings.monthlyBudgetUsd.toFixed(
                              4,
                            ),
                        },
                      )}
                    </Tag>
                  </Space>
                  <Space wrap>
                    {governanceHasTrafficBindings ? (
                      governanceTrafficLabels.map((label) => (
                        <Tag color="geekblue" key={label}>
                          {t(
                            "settings.llmGateway.proxyGovernance.summary.binding",
                            {
                              value: label,
                            },
                          )}
                        </Tag>
                      ))
                    ) : (
                      <Tag color="orange">
                        {t(
                          "settings.llmGateway.proxyGovernance.summary.bindingMissing",
                        )}
                      </Tag>
                    )}
                  </Space>
                  <Typography.Text type="secondary">
                    {t(
                      "settings.llmGateway.proxyGovernance.summary.observedDetails",
                      {
                        governed: formatObservedCurrency(
                          governanceUsage24h.governanceBreakdown
                            .governedCostUsd,
                        ),
                        direct: formatObservedCurrency(
                          governanceUsage24h.governanceBreakdown
                            .directCostUsd,
                        ),
                        requests:
                          governanceUsage24h.totals.requestCount.toLocaleString(),
                        tokens: formatObservedTokens(
                          governanceUsage24h.totals.totalTokens,
                        ),
                        latency: formatObservedLatency(
                          governanceUsage24h.latency.p95Ms,
                        ),
                      },
                    )}
                  </Typography.Text>
                  {governanceUsage24h.leadingError ? (
                    <Typography.Text type="secondary">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.leadingError",
                        {
                          message: governanceUsage24h.leadingError.message,
                          count: governanceUsage24h.leadingError.count,
                        },
                      )}
                    </Typography.Text>
                  ) : null}
                  {governanceAttentionItems.slice(0, 2).map((item) => (
                    <Alert
                      key={item.key}
                      type={item.type}
                      showIcon
                      message={item.title}
                      description={item.description}
                    />
                  ))}
                  {governanceUsageLoading ? (
                    <Typography.Text type="secondary">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.observedLoading",
                      )}
                    </Typography.Text>
                  ) : null}
                  {governanceUsageErrorMessage ? (
                    <Typography.Text type="danger">
                      {governanceUsageErrorMessage}
                    </Typography.Text>
                  ) : null}
                  {proxyGovernanceSettings.lastSyncedAt ? (
                    <Typography.Text type="secondary">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.syncedAt",
                        {
                          value: new Date(
                            proxyGovernanceSettings.lastSyncedAt,
                          ).toLocaleString(),
                        },
                      )}
                    </Typography.Text>
                  ) : null}
                  {proxyGovernanceSettings.lastSyncError ? (
                    <Typography.Text type="danger">
                      {proxyGovernanceSettings.lastSyncError}
                    </Typography.Text>
                  ) : null}
                  {!proxyGovernanceSettings.adminKeyConfigured ? (
                    <Typography.Text type="warning">
                      {t(
                        "settings.llmGateway.proxyGovernance.summary.adminMissing",
                      )}
                    </Typography.Text>
                  ) : null}
                </Space>
              }
            />
          ) : null}

          {statusProfileProxyModelInfo ? (
            <Space
              direction="vertical"
              size={4}
              style={{ display: "flex" }}
            >
              <Space wrap>
                <Tag
                  color={
                    statusProfileProxyModelInfo.loadBalancedGroups > 0
                      ? "green"
                      : "default"
                  }
                >
                  {t("settings.llmGateway.proxyStatus.loadBalancing")}
                  :{" "}
                  {statusProfileProxyModelInfo.loadBalancedGroups > 0
                    ? t("common.enabled")
                    : t("common.disabled")}
                </Tag>
                <Tag>
                  {t("settings.llmGateway.proxyStatus.modelGroups")}
                  : {statusProfileProxyModelInfo.groups}
                </Tag>
                <Tag>
                  {t("settings.llmGateway.proxyStatus.deployments")}
                  : {statusProfileProxyModelInfo.deployments}
                </Tag>
                {statusProfileProxyModelInfo.loadBalancedGroups > 0 ? (
                  <Tag color="green">
                    {t(
                      "settings.llmGateway.proxyStatus.loadBalancedGroups",
                    )}
                    : {statusProfileProxyModelInfo.loadBalancedGroups}
                  </Tag>
                ) : null}
              </Space>
              <Typography.Text type="secondary">
                {t("settings.llmGateway.proxyModelInfo.checkedAt", {
                  time: new Date(
                    statusProfileProxyModelInfo.checkedAt,
                  ).toLocaleString(),
                })}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {t("settings.llmGateway.proxyModelInfo.notChecked")}
            </Typography.Text>
          )}

          {statusProfileProxyLbTest ? (
            <Space
              direction="vertical"
              size={4}
              style={{ display: "flex" }}
            >
              <Space wrap>
                <Tag
                  color={
                    statusProfileProxyLbTest.failed > 0 ? "red" : "green"
                  }
                >
                  {t("settings.llmGateway.proxyLbTest.summary.title")}
                  :{" "}
                  {statusProfileProxyLbTest.failed > 0
                    ? t("common.failed")
                    : t("common.success")}
                </Tag>
                <Tag>
                  {t("settings.llmGateway.proxyLbTest.summary.succeeded")}
                  : {statusProfileProxyLbTest.succeeded}
                </Tag>
                <Tag
                  color={
                    statusProfileProxyLbTest.failed > 0 ? "red" : "default"
                  }
                >
                  {t("settings.llmGateway.proxyLbTest.summary.failed")}
                  : {statusProfileProxyLbTest.failed}
                </Tag>
                <Tag>
                  {t("settings.llmGateway.proxyLbTest.summary.modelIds")}
                  : {statusProfileProxyLbTest.modelIds}
                </Tag>
                <Tag>
                  {t("settings.llmGateway.proxyLbTest.summary.apiBases")}
                  : {statusProfileProxyLbTest.apiBases}
                </Tag>
                <Tag>
                  {t("settings.llmGateway.proxyLbTest.summary.duration")}
                  : {statusProfileProxyLbTest.durationMs}ms
                </Tag>
              </Space>
              <Typography.Text type="secondary">
                {t("settings.llmGateway.proxyLbTest.checkedAt", {
                  time: new Date(
                    statusProfileProxyLbTest.checkedAt,
                  ).toLocaleString(),
                })}
              </Typography.Text>
            </Space>
          ) : null}

          <Typography.Text type="secondary">
            {modelsSnapshot?.profileId === statusProfile.id
              ? t("settings.llmGateway.models.count", {
                  count: modelsSnapshot.count,
                })
              : t("settings.llmGateway.proxyStatus.models.notChecked")}
          </Typography.Text>

          {proxyHealthProfileId === statusProfile.id &&
          proxyHealthErrorMessage ? (
            <Alert
              type="error"
              showIcon
              message={proxyHealthErrorMessage}
            />
          ) : null}
        </Space>
      ) : (
        <Typography.Text type="secondary">
          {t("settings.llmGateway.proxyStatus.empty")}
        </Typography.Text>
      )}
    </Card>

        <LlmGatewayEmbeddingRerankPanel s={s} />
        <LlmGatewayProfilesPanel s={s} />
      </Space>
      <LlmGatewayProfileModals s={s} g={g} />
      <LlmGatewayProxyGovernancePanel s={s} g={g} />
      <LlmGatewayProxyLbPanel s={s} lb={lb} />
    </>
  );
}
