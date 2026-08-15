"use client";

import { QuestionCircleOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { TFunction } from "i18next";
import { useCallback, useState, type ReactElement } from "react";

import { captureClientError } from "@/lib/client-telemetry";

import { LlmGatewayProxyLbTestResult } from "./llm-gateway-proxy-lb-test-result";
import {
  formatApiErrorMessage,
  normalizeCommaOrLineSeparatedTokens,
  shortenFingerprint,
} from "./llm-gateway.formatters";
import type {
  LiteLlmProxyLbFormValues,
  LiteLlmProxyLoadBalancingSettingsResponse,
  LlmGatewayProfile,
  LlmGatewayProxyLbTestSnapshot,
  LlmGatewayProxyLoadBalancingTestFormValues,
  LlmGatewayProxyLoadBalancingTestResponse,
} from "./llm-gateway.types";
import type { LlmGatewaySettingsController } from "./use-llm-gateway-settings";

type ApiClient = LlmGatewaySettingsController["apiClient"];

export interface LlmGatewayProxyLbDeps {
  t: TFunction;
  apiClient: ApiClient;
  messageApi: MessageInstance;
}

export interface LlmGatewayProxyLbController {
  proxyLbTestProfile: LlmGatewayProfile | null;
  proxyLbTestResult: LlmGatewayProxyLoadBalancingTestResponse | null;
  proxyLbTestErrorMessage: string | null;
  proxyLbTesting: string | null;
  proxyLbTestForm: ReturnType<
    typeof Form.useForm<LlmGatewayProxyLoadBalancingTestFormValues>
  >[0];
  proxyLbTestSnapshot: LlmGatewayProxyLbTestSnapshot | null;
  proxyLbOpen: boolean;
  setProxyLbOpen: (open: boolean) => void;
  proxyLbForm: ReturnType<typeof Form.useForm<LiteLlmProxyLbFormValues>>[0];
  proxyLbSettings: LiteLlmProxyLoadBalancingSettingsResponse | null;
  proxyLbLoading: boolean;
  proxyLbSaving: boolean;
  proxyLbResetting: boolean;
  proxyLbErrorMessage: string | null;
  setProxyLbErrorMessage: (value: string | null) => void;
  loadProxyLbSettings: () => Promise<void>;
  openProxyLbWizard: () => void;
  saveProxyLbSettings: (values: LiteLlmProxyLbFormValues) => Promise<void>;
  resetProxyLbSettings: () => void;
  openProxyLbTest: (profile: LlmGatewayProfile) => void;
  closeProxyLbTest: () => void;
  runProxyLbTest: (
    profile: LlmGatewayProfile,
    values: LlmGatewayProxyLoadBalancingTestFormValues,
  ) => Promise<void>;
}

export function useLlmGatewayProxyLb(
  deps: LlmGatewayProxyLbDeps,
): LlmGatewayProxyLbController {
  const { t, apiClient, messageApi } = deps;

  const [proxyLbTestProfile, setProxyLbTestProfile] =
    useState<LlmGatewayProfile | null>(null);
  const [proxyLbTestResult, setProxyLbTestResult] =
    useState<LlmGatewayProxyLoadBalancingTestResponse | null>(null);
  const [proxyLbTestErrorMessage, setProxyLbTestErrorMessage] = useState<
    string | null
  >(null);
  const [proxyLbTesting, setProxyLbTesting] = useState<string | null>(null);
  const [proxyLbTestForm] =
    Form.useForm<LlmGatewayProxyLoadBalancingTestFormValues>();
  const [proxyLbTestSnapshot, setProxyLbTestSnapshot] =
    useState<LlmGatewayProxyLbTestSnapshot | null>(null);
  const [proxyLbOpen, setProxyLbOpen] = useState(false);
  const [proxyLbForm] = Form.useForm<LiteLlmProxyLbFormValues>();
  const [proxyLbSettings, setProxyLbSettings] =
    useState<LiteLlmProxyLoadBalancingSettingsResponse | null>(null);
  const [proxyLbLoading, setProxyLbLoading] = useState(false);
  const [proxyLbSaving, setProxyLbSaving] = useState(false);
  const [proxyLbResetting, setProxyLbResetting] = useState(false);
  const [proxyLbErrorMessage, setProxyLbErrorMessage] = useState<string | null>(
    null,
  );
  const loadProxyLbSettings = useCallback(async () => {
    setProxyLbLoading(true);
    setProxyLbErrorMessage(null);
    try {
      const response =
        await apiClient.get<LiteLlmProxyLoadBalancingSettingsResponse>(
          "system-settings/llm-gateways/proxy-load-balancing",
        );
      const data = response.data ?? null;
      setProxyLbSettings(data);
      proxyLbForm.setFieldsValue({
        enabled: data?.enabled ?? false,
        openaiKeys: "",
        anthropicKeys: "",
        clearAnthropicKeys: false,
        routingStrategy: data?.routingStrategy ?? "simple-shuffle",
        redisHost: data?.redisHost ?? "redis",
        redisPort: data?.redisPort ?? 6379,
        redisPassword: "",
        deploymentRpm:
          typeof data?.deploymentRpm === "number"
            ? data.deploymentRpm
            : undefined,
        deploymentTpm:
          typeof data?.deploymentTpm === "number"
            ? data.deploymentTpm
            : undefined,
      });
    } catch (error) {
      captureClientError(
        "Failed to load LiteLLM proxy load balancing settings",
        error,
      );
      const messageText = formatApiErrorMessage(error);
      setProxyLbErrorMessage(
        messageText
          ? messageText
          : t("settings.llmGateway.proxyLoadBalancing.errors.loadFailed"),
      );
    } finally {
      setProxyLbLoading(false);
    }
  }, [apiClient, proxyLbForm, t]);

  const openProxyLbWizard = useCallback(() => {
    setProxyLbOpen(true);
    void loadProxyLbSettings();
  }, [loadProxyLbSettings]);
  const saveProxyLbSettings = useCallback(
    async (values: LiteLlmProxyLbFormValues) => {
      setProxyLbSaving(true);
      setProxyLbErrorMessage(null);
      try {
        const openaiKeys = normalizeCommaOrLineSeparatedTokens(
          values.openaiKeys,
        );
        if (openaiKeys.length > 0) {
          await apiClient.put("system-settings/openai-keys", {
            keys: openaiKeys,
          });
        }

        const anthropicKeys = normalizeCommaOrLineSeparatedTokens(
          values.anthropicKeys,
        );
        const payload: Record<string, unknown> = {
          enabled: Boolean(values.enabled),
          routingStrategy: String(values.routingStrategy || "simple-shuffle"),
          redisHost: String(values.redisHost || "redis").trim(),
          redisPort: Number(values.redisPort || 6379),
          deploymentRpm:
            typeof values.deploymentRpm === "number"
              ? values.deploymentRpm
              : null,
          deploymentTpm:
            typeof values.deploymentTpm === "number"
              ? values.deploymentTpm
              : null,
        };

        if (proxyLbForm.isFieldTouched("redisPassword")) {
          payload.redisPassword = String(values.redisPassword ?? "");
        }

        if (anthropicKeys.length > 0) {
          payload.anthropicApiKeys = anthropicKeys;
        } else if (values.clearAnthropicKeys) {
          payload.clearAnthropicApiKeys = true;
        }

        const response =
          await apiClient.put<LiteLlmProxyLoadBalancingSettingsResponse>(
            "system-settings/llm-gateways/proxy-load-balancing",
            payload,
          );

        const data = response.data ?? null;
        setProxyLbSettings(data);
        proxyLbForm.setFieldsValue({
          enabled: data?.enabled ?? false,
          openaiKeys: "",
          anthropicKeys: "",
          clearAnthropicKeys: false,
          routingStrategy: data?.routingStrategy ?? "simple-shuffle",
          redisHost: data?.redisHost ?? "redis",
          redisPort: data?.redisPort ?? 6379,
          redisPassword: "",
          deploymentRpm:
            typeof data?.deploymentRpm === "number"
              ? data.deploymentRpm
              : undefined,
          deploymentTpm:
            typeof data?.deploymentTpm === "number"
              ? data.deploymentTpm
              : undefined,
        });
        messageApi.success(
          t("settings.llmGateway.proxyLoadBalancing.messages.saved"),
        );
      } catch (error) {
        captureClientError(
          "Failed to save LiteLLM proxy load balancing settings",
          error,
        );
        const messageText = formatApiErrorMessage(error);
        setProxyLbErrorMessage(
          messageText
            ? messageText
            : t("settings.llmGateway.proxyLoadBalancing.errors.saveFailed"),
        );
      } finally {
        setProxyLbSaving(false);
      }
    },
    [apiClient, messageApi, proxyLbForm, t],
  );

  const resetProxyLbSettings = useCallback(() => {
    Modal.confirm({
      title: t("settings.llmGateway.proxyLoadBalancing.reset.modal.title"),
      content: t("settings.llmGateway.proxyLoadBalancing.reset.modal.content"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setProxyLbResetting(true);
        setProxyLbErrorMessage(null);
        try {
          const response =
            await apiClient.delete<LiteLlmProxyLoadBalancingSettingsResponse>(
              "system-settings/llm-gateways/proxy-load-balancing",
            );
          const data = response.data ?? null;
          setProxyLbSettings(data);
          proxyLbForm.setFieldsValue({
            enabled: data?.enabled ?? false,
            openaiKeys: "",
            anthropicKeys: "",
            clearAnthropicKeys: false,
            routingStrategy: data?.routingStrategy ?? "simple-shuffle",
            redisHost: data?.redisHost ?? "redis",
            redisPort: data?.redisPort ?? 6379,
            redisPassword: "",
            deploymentRpm:
              typeof data?.deploymentRpm === "number"
                ? data.deploymentRpm
                : undefined,
            deploymentTpm:
              typeof data?.deploymentTpm === "number"
                ? data.deploymentTpm
                : undefined,
          });
          messageApi.success(
            t("settings.llmGateway.proxyLoadBalancing.reset.messages.done"),
          );
        } catch (error) {
          captureClientError(
            "Failed to reset LiteLLM proxy load balancing settings",
            error,
          );
          const messageText = formatApiErrorMessage(error);
          setProxyLbErrorMessage(
            messageText
              ? messageText
              : t(
                  "settings.llmGateway.proxyLoadBalancing.reset.errors.failed",
                ),
          );
        } finally {
          setProxyLbResetting(false);
        }
      },
    });
  }, [apiClient, messageApi, proxyLbForm, t]);

  const openProxyLbTest = useCallback(
    (profile: LlmGatewayProfile) => {
      setProxyLbTestProfile(profile);
      setProxyLbTestResult(null);
      setProxyLbTestErrorMessage(null);
      proxyLbTestForm.setFieldsValue({
        model: "",
        attempts: 8,
        concurrency: 2,
        prompt: "",
      });
    },
    [proxyLbTestForm],
  );

  const closeProxyLbTest = useCallback(() => {
    setProxyLbTestProfile(null);
    setProxyLbTestResult(null);
    setProxyLbTestErrorMessage(null);
    proxyLbTestForm.resetFields();
  }, [proxyLbTestForm]);

  const runProxyLbTest = useCallback(
    async (
      profile: LlmGatewayProfile,
      values: LlmGatewayProxyLoadBalancingTestFormValues,
    ) => {
      setProxyLbTesting(profile.id);
      setProxyLbTestErrorMessage(null);
      setProxyLbTestResult(null);
      try {
        const payload: Record<string, unknown> = {};
        if (values.model?.trim()) {
          payload.model = values.model.trim();
        }
        if (typeof values.attempts === "number") {
          payload.attempts = values.attempts;
        }
        if (typeof values.concurrency === "number") {
          payload.concurrency = values.concurrency;
        }
        if (values.prompt?.trim()) {
          payload.prompt = values.prompt.trim();
        }
        const response =
          await apiClient.post<LlmGatewayProxyLoadBalancingTestResponse>(
            `system-settings/llm-gateways/${profile.id}/proxy-lb-test`,
            payload,
          );
        const result = response.data ?? null;
        setProxyLbTestResult(result);
        if (result) {
          const modelIds = Object.keys(result.modelIdDistribution ?? {}).length;
          const apiBases = Object.keys(
            result.modelApiBaseDistribution ?? {},
          ).length;
          setProxyLbTestSnapshot({
            profileId: profile.id,
            apiBase: result.apiBase ?? profile.apiBase,
            model: result.model ?? profile.model,
            succeeded: result.succeeded ?? 0,
            failed: result.failed ?? 0,
            durationMs: result.durationMs ?? 0,
            modelIds,
            apiBases,
            checkedAt: result.checkedAt ?? new Date().toISOString(),
          });
        }
      } catch (error) {
        captureClientError(
          "Failed to run LiteLLM proxy load balancing test",
          error,
        );
        const messageText = formatApiErrorMessage(error);
        setProxyLbTestErrorMessage(
          messageText
            ? messageText
            : t("settings.llmGateway.proxyStatus.errors.lbTestFailed"),
        );
      } finally {
        setProxyLbTesting((current) =>
          current === profile.id ? null : current,
        );
      }
    },
    [apiClient, t],
  );

  return {
    proxyLbTestProfile,
    proxyLbTestResult,
    proxyLbTestErrorMessage,
    proxyLbTesting,
    proxyLbTestForm,
    proxyLbTestSnapshot,
    proxyLbOpen,
    setProxyLbOpen,
    proxyLbForm,
    proxyLbSettings,
    proxyLbLoading,
    proxyLbSaving,
    proxyLbResetting,
    proxyLbErrorMessage,
    setProxyLbErrorMessage,
    loadProxyLbSettings,
    openProxyLbWizard,
    saveProxyLbSettings,
    resetProxyLbSettings,
    openProxyLbTest,
    closeProxyLbTest,
    runProxyLbTest,
  };
}

export function LlmGatewayProxyLbPanel({
  s,
  lb,
}: {
  s: LlmGatewaySettingsController;
  lb: LlmGatewayProxyLbController;
}): ReactElement {
  const { t, screens, helpIconStyle } = s;
  const {
    proxyLbTestProfile,
    closeProxyLbTest,
    proxyLbTestForm,
    runProxyLbTest,
    proxyLbTesting,
    proxyLbTestErrorMessage,
    proxyLbTestResult,
    proxyLbOpen,
    setProxyLbOpen,
    setProxyLbErrorMessage,
    loadProxyLbSettings,
    proxyLbLoading,
    resetProxyLbSettings,
    proxyLbResetting,
    saveProxyLbSettings,
    proxyLbSaving,
    proxyLbForm,
    proxyLbErrorMessage,
    proxyLbSettings,
  } = lb;

  return (
    <>
    <Modal
      title={
        proxyLbTestProfile
          ? t("settings.llmGateway.proxyLbTest.modal.title", {
              name: proxyLbTestProfile.name,
            })
          : undefined
      }
      open={Boolean(proxyLbTestProfile)}
      onCancel={closeProxyLbTest}
      width={screens.md ? 720 : "100%"}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={closeProxyLbTest}>
          {t("common.close")}
        </Button>,
        <Button
          key="run"
          type="primary"
          onClick={() => proxyLbTestForm.submit()}
          disabled={!proxyLbTestProfile}
          loading={
            proxyLbTestProfile
              ? proxyLbTesting === proxyLbTestProfile.id
              : false
          }
        >
          {t("settings.llmGateway.proxyLbTest.actions.run")}
        </Button>,
      ]}
    >
      <Form
        name="llm-gateway-proxy-lb-test"
        form={proxyLbTestForm}
        layout="vertical"
        onFinish={(values) => {
          if (!proxyLbTestProfile) {
            return;
          }
          void runProxyLbTest(proxyLbTestProfile, values);
        }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {t("settings.llmGateway.fields.apiBase")}:{" "}
          <Typography.Text code copyable>
            {proxyLbTestProfile?.apiBase ?? "-"}
          </Typography.Text>
        </Typography.Paragraph>

        <Form.Item
          label={t("settings.llmGateway.proxyLbTest.fields.model")}
          name="model"
          extra={t("settings.llmGateway.proxyLbTest.hints.model")}
        >
          <Input allowClear placeholder={proxyLbTestProfile?.model ?? ""} />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("settings.llmGateway.proxyLbTest.fields.attempts")}
            name="attempts"
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={1}
              max={50}
              step={1}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.proxyLbTest.fields.concurrency")}
            name="concurrency"
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber
              min={1}
              max={10}
              step={1}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Space>

        <Form.Item
          label={t("settings.llmGateway.proxyLbTest.fields.prompt")}
          name="prompt"
          extra={t("settings.llmGateway.proxyLbTest.hints.prompt")}
        >
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
        </Form.Item>
      </Form>

      {proxyLbTestErrorMessage ? (
        <Alert
          type="error"
          showIcon
          message={proxyLbTestErrorMessage}
          style={{ marginTop: 12 }}
        />
      ) : null}

      {proxyLbTestResult ? (
        <div style={{ marginTop: 12 }}>
          {<LlmGatewayProxyLbTestResult t={t} result={proxyLbTestResult} />}
        </div>
      ) : null}
    </Modal>

    <Modal
      title={t("settings.llmGateway.proxyLoadBalancing.modal.title")}
      open={proxyLbOpen}
      onCancel={() => {
        setProxyLbOpen(false);
        setProxyLbErrorMessage(null);
      }}
      width={screens.md ? 720 : "100%"}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={() => setProxyLbOpen(false)}>
          {t("common.close")}
        </Button>,
        <Button
          key="refresh"
          onClick={() => void loadProxyLbSettings()}
          loading={proxyLbLoading}
        >
          {t("common.refresh")}
        </Button>,
        <Button
          key="reset"
          danger
          onClick={resetProxyLbSettings}
          loading={proxyLbResetting}
          disabled={proxyLbSaving}
        >
          {t("common.reset")}
        </Button>,
        <Button
          key="save"
          type="primary"
          onClick={() => proxyLbForm.submit()}
          loading={proxyLbSaving}
          disabled={proxyLbLoading || proxyLbResetting}
        >
          {t("common.save")}
        </Button>,
      ]}
    >
      <Spin spinning={proxyLbLoading}>
        <Space direction="vertical" size="middle" style={{ display: "flex" }}>
          <Typography.Text type="secondary">
            {t("settings.llmGateway.proxyLoadBalancing.hint")}
          </Typography.Text>

          {proxyLbSettings ? (
            <Alert
              type={proxyLbSettings.enabled ? "success" : "warning"}
              showIcon
              message={
                proxyLbSettings.enabled
                  ? t(
                      "settings.llmGateway.proxyLoadBalancing.status.enabled",
                    )
                  : t(
                      "settings.llmGateway.proxyLoadBalancing.status.disabled",
                    )
              }
              description={
                <Space wrap>
                  <Tag>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.status.openaiKeys",
                      {
                        count: proxyLbSettings.openai.keysCount,
                      },
                    )}
                  </Tag>
                  <Tag>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.status.anthropicKeys",
                      {
                        count: proxyLbSettings.anthropicKeysCount,
                      },
                    )}
                  </Tag>
                  {proxyLbSettings.openai.restartRequired ? (
                    <Tag color="orange">
                      {t(
                        "settings.llmGateway.proxyLoadBalancing.status.restartRequired",
                      )}
                    </Tag>
                  ) : null}
                </Space>
              }
            />
          ) : null}

          {proxyLbErrorMessage ? (
            <Alert type="error" showIcon message={proxyLbErrorMessage} />
          ) : null}

          <Form
            name="llm-gateway-proxy-load-balancing"
            form={proxyLbForm}
            layout="vertical"
            onFinish={(values) => {
              void saveProxyLbSettings(values);
            }}
          >
            <Form.Item
              name="enabled"
              valuePropName="checked"
              label={
                <span>
                  {t(
                    "settings.llmGateway.proxyLoadBalancing.fields.enabled",
                  )}
                  <Tooltip
                    title={t(
                      "settings.llmGateway.proxyLoadBalancing.tooltips.enabled",
                    )}
                  >
                    <QuestionCircleOutlined style={helpIconStyle} />
                  </Tooltip>
                </span>
              }
            >
              <Switch />
            </Form.Item>

            <Form.Item
              label={
                <span>
                  {t(
                    "settings.llmGateway.proxyLoadBalancing.fields.openaiKeys",
                  )}
                  <Tooltip
                    title={t(
                      "settings.llmGateway.proxyLoadBalancing.tooltips.openaiKeys",
                    )}
                  >
                    <QuestionCircleOutlined style={helpIconStyle} />
                  </Tooltip>
                </span>
              }
              name="openaiKeys"
              extra={t(
                "settings.llmGateway.proxyLoadBalancing.hints.openaiKeys",
              )}
            >
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
            </Form.Item>

            {proxyLbSettings?.openai?.keyFingerprints?.length ? (
              <Space wrap style={{ marginBottom: 12 }}>
                {proxyLbSettings.openai.keyFingerprints.map((fingerprint) => (
                  <Tag key={fingerprint} color="blue">
                    {shortenFingerprint(fingerprint)}
                  </Tag>
                ))}
              </Space>
            ) : null}

            <Form.Item
              label={
                <span>
                  {t(
                    "settings.llmGateway.proxyLoadBalancing.fields.anthropicKeys",
                  )}
                  <Tooltip
                    title={t(
                      "settings.llmGateway.proxyLoadBalancing.tooltips.anthropicKeys",
                    )}
                  >
                    <QuestionCircleOutlined style={helpIconStyle} />
                  </Tooltip>
                </span>
              }
              name="anthropicKeys"
              extra={t(
                "settings.llmGateway.proxyLoadBalancing.hints.anthropicKeys",
              )}
            >
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
            </Form.Item>

            <Form.Item
              name="clearAnthropicKeys"
              valuePropName="checked"
              label={t(
                "settings.llmGateway.proxyLoadBalancing.fields.clearAnthropicKeys",
              )}
            >
              <Switch />
            </Form.Item>

            {proxyLbSettings?.anthropicKeyFingerprints?.length ? (
              <Space wrap style={{ marginBottom: 12 }}>
                {proxyLbSettings.anthropicKeyFingerprints.map(
                  (fingerprint) => (
                    <Tag key={fingerprint} color="purple">
                      {shortenFingerprint(fingerprint)}
                    </Tag>
                  ),
                )}
              </Space>
            ) : null}

            <Space wrap style={{ display: "flex" }}>
              <Form.Item
                label={
                  <span>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.fields.routingStrategy",
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.routingStrategy",
                      )}
                    >
                      <QuestionCircleOutlined style={helpIconStyle} />
                    </Tooltip>
                  </span>
                }
                name="routingStrategy"
                style={{ minWidth: 240, flex: 1 }}
              >
                <Select
                  options={[
                    { value: "simple-shuffle", label: "simple-shuffle" },
                    { value: "least-busy", label: "least-busy" },
                    {
                      value: "usage-based-routing",
                      label: "usage-based-routing",
                    },
                    {
                      value: "latency-based-routing",
                      label: "latency-based-routing",
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label={
                  <span>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.fields.deploymentRpm",
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.deploymentRpm",
                      )}
                    >
                      <QuestionCircleOutlined style={helpIconStyle} />
                    </Tooltip>
                  </span>
                }
                name="deploymentRpm"
                style={{ minWidth: 220, flex: 1 }}
              >
                <InputNumber
                  min={1}
                  max={1_000_000}
                  step={1}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item
                label={
                  <span>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.fields.deploymentTpm",
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.deploymentTpm",
                      )}
                    >
                      <QuestionCircleOutlined style={helpIconStyle} />
                    </Tooltip>
                  </span>
                }
                name="deploymentTpm"
                style={{ minWidth: 220, flex: 1 }}
              >
                <InputNumber
                  min={1}
                  max={10_000_000}
                  step={1}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Space>

            <Space wrap style={{ display: "flex" }}>
              <Form.Item
                label={
                  <span>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.fields.redisHost",
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.redisHost",
                      )}
                    >
                      <QuestionCircleOutlined style={helpIconStyle} />
                    </Tooltip>
                  </span>
                }
                name="redisHost"
                style={{ minWidth: 240, flex: 1 }}
                rules={[
                  {
                    required: true,
                    message: t(
                      "settings.llmGateway.proxyLoadBalancing.validation.redisHost",
                    ),
                  },
                ]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                label={
                  <span>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.fields.redisPort",
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.redisPort",
                      )}
                    >
                      <QuestionCircleOutlined style={helpIconStyle} />
                    </Tooltip>
                  </span>
                }
                name="redisPort"
                style={{ minWidth: 200, flex: 1 }}
              >
                <InputNumber
                  min={1}
                  max={65535}
                  step={1}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item
                label={
                  <span>
                    {t(
                      "settings.llmGateway.proxyLoadBalancing.fields.redisPassword",
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.redisPassword",
                      )}
                    >
                      <QuestionCircleOutlined style={helpIconStyle} />
                    </Tooltip>
                  </span>
                }
                name="redisPassword"
                style={{ minWidth: 240, flex: 1 }}
              >
                <Input.Password />
              </Form.Item>
            </Space>
          </Form>
        </Space>
      </Spin>
    </Modal>

    </>
  );
}
