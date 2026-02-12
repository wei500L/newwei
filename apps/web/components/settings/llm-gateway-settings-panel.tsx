"use client";

import {
  Alert,
  Button,
  Card,
  Form,
  type FormInstance,
  Grid,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import {
  buildAutoRecommendationPatch,
  DEFAULT_LLM_GATEWAY_AUTO_RECOMMENDATION_CONFIG,
  detectPresetRecommendationByApiBase,
  type LlmGatewayAutoRecommendationConfig,
  type LlmGatewayPresetKey,
} from "@/lib/llm-gateway-profile-recommendation";

type LlmGatewayResponseFormatMode = "json_schema" | "json_object" | "none";

interface LlmGatewayProfile {
  id: string;
  name: string;
  apiBase: string;
  model: string;
  assistantModel?: string | null;
  embeddingModel?: string | null;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  fallbackModels: string[];
  requestsPerMinute: number;
  sendMetadata: boolean;
  responseFormatMode: LlmGatewayResponseFormatMode;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

type LlmGatewayEmbeddingMode = "follow_completion" | "use_default";

interface LlmGatewaySettingsResponse {
  activeId: string | null;
  embeddingActiveId: string | null;
  embeddingMode: LlmGatewayEmbeddingMode;
  profiles: LlmGatewayProfile[];
}

interface LlmGatewayTestResponse {
  apiBase: string;
  apiSurfaceUsed?: "chat_completions" | "responses";
  compatibilityError?: {
    code: string;
    incompatibleField: string;
    hint: string;
    upstreamMessage: string;
    status?: number;
  };
  completion?: {
    model: string;
    content: string | null;
    finishReason?: string;
    latencyMs: number;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    costUsd?: number;
    keySpendUsd?: number;
  };
  completionError?: {
    message: string;
    status?: number;
    axiosCode?: string;
    requestId?: string;
    upstreamType?: string;
    upstreamCode?: string;
    compatibilityError?: {
      code: string;
      incompatibleField: string;
      hint: string;
      upstreamMessage: string;
      status?: number;
    };
  };
  embedding?: {
    model: string;
    dimensions: number;
    latencyMs: number;
    usage?: { prompt_tokens: number; total_tokens: number };
    costUsd?: number;
    keySpendUsd?: number;
  };
  embeddingError?: {
    message: string;
    status?: number;
    axiosCode?: string;
    requestId?: string;
    upstreamType?: string;
    upstreamCode?: string;
    compatibilityError?: {
      code: string;
      incompatibleField: string;
      hint: string;
      upstreamMessage: string;
      status?: number;
    };
  };
}

interface LlmGatewayModelsResponse {
  apiBase: string;
  models: string[];
}

interface LlmGatewayProxyEndpointCheck {
  ok: boolean;
  status?: number;
  message?: string;
  data?: unknown;
}

interface LlmGatewayProxyHealthResponse {
  apiBase: string;
  checkedAt: string;
  liveliness: LlmGatewayProxyEndpointCheck;
  readiness: LlmGatewayProxyEndpointCheck;
}

interface LlmGatewayProxyModelInfoEntry {
  modelName: string;
  litellmParams?: Record<string, unknown>;
  modelInfo?: Record<string, unknown>;
}

interface LlmGatewayProxyModelInfoResponse {
  apiBase: string;
  checkedAt: string;
  models: LlmGatewayProxyModelInfoEntry[];
}

interface LlmGatewayProxyLoadBalancingTestResponse {
  apiBase: string;
  model: string;
  attempts: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  checkedAt: string;
  modelIdDistribution: Record<string, number>;
  modelApiBaseDistribution: Record<string, number>;
  callIdSamples: string[];
  errors: {
    message: string;
    status?: number;
    axiosCode?: string;
    requestId?: string;
    upstreamType?: string;
    upstreamCode?: string;
  }[];
}

interface LlmGatewayProxyLoadBalancingTestFormValues {
  model?: string;
  attempts?: number;
  concurrency?: number;
  prompt?: string;
}

interface LlmGatewayTestFormValues {
  includeCompletion: boolean;
  model?: string;
  prompt?: string;
  apiSurface?: "chat_completions" | "responses";
  responseFormatMode?: LlmGatewayResponseFormatMode;
  includeMetadataProbe?: boolean;
  includeEmbeddings: boolean;
  embeddingModel?: string;
  embeddingInput?: string;
}

interface LlmGatewayFormValues {
  preset?: LlmGatewayPresetKey;
  name: string;
  apiBase: string;
  apiKey?: string;
  model?: string;
  assistantModel?: string;
  embeddingModel?: string;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  requestsPerMinute: number;
  fallbackModels?: string;
  sendMetadata: boolean;
  responseFormatMode: LlmGatewayResponseFormatMode;
  clearApiKey?: boolean;
  enabled: boolean;
}

interface LlmGatewayPresetOption {
  key: LlmGatewayPresetKey;
  label: string;
  apiBase: string;
  model: string;
  embeddingModel?: string;
  fallbackModels?: string[];
  sendMetadata: boolean;
  responseFormatMode: LlmGatewayResponseFormatMode;
}

interface LlmGatewayRecommendationConfigFormValues {
  defaultPresetKey: LlmGatewayPresetKey;
  localGatewayHosts: string[];
  domainRules: Array<{
    hostname: string;
    presetKey: LlmGatewayPresetKey;
  }>;
}

interface LiteLlmProxyLbFormValues {
  enabled: boolean;
  openaiKeys?: string;
  anthropicKeys?: string;
  clearAnthropicKeys?: boolean;
  routingStrategy?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  deploymentRpm?: number;
  deploymentTpm?: number;
}

interface OpenAiKeysSettingsResponse {
  source: "none" | "db";
  keysCount: number;
  hasKeys: boolean;
  keyFingerprints: string[];
  internalTokenConfigured: boolean;
  appliedAt: string | null;
  appliedSource: "db" | "env" | "none" | null;
  appliedKeyFingerprints: string[];
  restartRequired: boolean;
}

interface LiteLlmProxyLoadBalancingSettingsResponse {
  source: "none" | "db";
  enabled: boolean;
  openai: OpenAiKeysSettingsResponse;
  anthropicKeysCount: number;
  anthropicKeyFingerprints: string[];
  routingStrategy: string;
  redisHost: string;
  redisPort: number;
  hasRedisPassword: boolean;
  deploymentRpm: number | null;
  deploymentTpm: number | null;
}

const EMPTY_SETTINGS: LlmGatewaySettingsResponse = {
  activeId: null,
  embeddingActiveId: null,
  embeddingMode: "follow_completion",
  profiles: [],
};
const DRAFT_CREATE_KEY = "__draft_create__";
const DRAFT_EDIT_KEY = "__draft_edit__";
const FOLLOW_COMPLETION_KEY = "__follow_completion__";
const USE_DEFAULT_KEY = "__use_default__";
const DEFAULT_LLM_GATEWAY_API_BASE =
  (process.env.NEXT_PUBLIC_LLM_GATEWAY_DEFAULT_API_BASE ?? "").trim() ||
  "http://localhost:4001";
const MAX_LLM_GATEWAY_OUTPUT_TOKENS = 1_000_000;
const LLM_GATEWAY_AUTO_RECOMMEND_ENABLED_STORAGE_KEY =
  "llm_gateway_auto_recommend_enabled";
const LLM_GATEWAY_AUTO_RECOMMEND_NOTICE_STORAGE_KEY =
  "llm_gateway_auto_recommend_notice_enabled";

function readBooleanPreferenceFromStorage(
  storageKey: string,
  fallbackValue: boolean,
): boolean {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "1" || stored === "true") {
      return true;
    }
    if (stored === "0" || stored === "false") {
      return false;
    }
  } catch {
    return fallbackValue;
  }
  return fallbackValue;
}

function writeBooleanPreferenceToStorage(
  storageKey: string,
  value: boolean,
): void {
  try {
    localStorage.setItem(storageKey, value ? "1" : "0");
  } catch {
    return;
  }
}

function toFallbackModels(input: string | undefined) {
  if (!input) {
    return undefined;
  }
  const models = input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(models));
}

function toFallbackModelsText(models: string[]) {
  return (models ?? []).join(", ");
}

function renderGatewayErrorMeta(error: {
  status?: number;
  axiosCode?: string;
  requestId?: string;
  upstreamType?: string;
  upstreamCode?: string;
  compatibilityError?: {
    code: string;
    incompatibleField: string;
    hint: string;
    upstreamMessage: string;
    status?: number;
  };
}) {
  return (
    <Space wrap>
      {typeof error.status === "number" ? (
        <Tag color="red">HTTP {error.status}</Tag>
      ) : null}
      {error.upstreamType ? <Tag>type: {error.upstreamType}</Tag> : null}
      {error.upstreamCode ? <Tag>code: {error.upstreamCode}</Tag> : null}
      {error.axiosCode ? <Tag>axios: {error.axiosCode}</Tag> : null}
      {error.requestId ? (
        <Typography.Text type="secondary">
          request-id:{" "}
          <Typography.Text code copyable>
            {error.requestId}
          </Typography.Text>
        </Typography.Text>
      ) : null}
      {error.compatibilityError?.code ? (
        <Tag color="gold">compat: {error.compatibilityError.code}</Tag>
      ) : null}
    </Space>
  );
}

function formatApiErrorMessage(error: unknown): string | null {
  const info = extractApiError(error);
  return info.message?.trim() ? info.message.trim() : null;
}

function normalizeCommaOrLineSeparatedTokens(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function shortenFingerprint(value: string) {
  const normalized = value.trim();
  if (normalized.length <= 12) {
    return normalized;
  }
  return `${normalized.slice(0, 6)}...${normalized.slice(-6)}`;
}

export function LlmGatewaySettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [settings, setSettings] =
    useState<LlmGatewaySettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [activatingProfileId, setActivatingProfileId] = useState<string | null>(
    null,
  );
  const [embeddingActivating, setEmbeddingActivating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState<string | null>(null);
  const [loadingProxyModelInfo, setLoadingProxyModelInfo] = useState<
    string | null
  >(null);
  const [checkingProxyHealth, setCheckingProxyHealth] = useState<string | null>(
    null,
  );
  const [proxyHealthProfileId, setProxyHealthProfileId] = useState<
    string | null
  >(null);
  const [proxyHealth, setProxyHealth] =
    useState<LlmGatewayProxyHealthResponse | null>(null);
  const [proxyHealthErrorMessage, setProxyHealthErrorMessage] = useState<
    string | null
  >(null);
  const [proxyModelInfoSnapshot, setProxyModelInfoSnapshot] = useState<{
    profileId: string;
    apiBase: string;
    groups: number;
    deployments: number;
    loadBalancedGroups: number;
    checkedAt: string;
  } | null>(null);
  const [modelsSnapshot, setModelsSnapshot] = useState<{
    profileId: string;
    apiBase: string;
    count: number;
    checkedAt: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<LlmGatewayProfile | null>(null);
  const [createForm] = Form.useForm<LlmGatewayFormValues>();
  const [editForm] = Form.useForm<LlmGatewayFormValues>();
  const [autoRecommendationConfig, setAutoRecommendationConfig] =
    useState<LlmGatewayAutoRecommendationConfig | null>(null);
  const [recommendationConfigOpen, setRecommendationConfigOpen] =
    useState(false);
  const [recommendationConfigSaving, setRecommendationConfigSaving] =
    useState(false);
  const [recommendationConfigForm] =
    Form.useForm<LlmGatewayRecommendationConfigFormValues>();
  const [autoRecommendEnabled, setAutoRecommendEnabled] = useState(true);
  const [autoRecommendNoticeEnabled, setAutoRecommendNoticeEnabled] =
    useState(true);
  const [createInitialApiBase, setCreateInitialApiBase] = useState("");
  const [editInitialApiBase, setEditInitialApiBase] = useState("");
  const [testProfile, setTestProfile] = useState<LlmGatewayProfile | null>(
    null,
  );
  const [testResult, setTestResult] = useState<LlmGatewayTestResponse | null>(
    null,
  );
  const [testErrorMessage, setTestErrorMessage] = useState<string | null>(null);
  const [testForm] = Form.useForm<LlmGatewayTestFormValues>();
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
  const [proxyLbTestSnapshot, setProxyLbTestSnapshot] = useState<{
    profileId: string;
    apiBase: string;
    model: string;
    succeeded: number;
    failed: number;
    durationMs: number;
    modelIds: number;
    apiBases: number;
    checkedAt: string;
  } | null>(null);
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
  const screens = Grid.useBreakpoint();
  const includeCompletion =
    Form.useWatch("includeCompletion", testForm) ?? true;
  const includeEmbeddings =
    Form.useWatch("includeEmbeddings", testForm) ?? false;
  const editClearApiKey = Form.useWatch("clearApiKey", editForm) ?? false;

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const handleAutoRecommendEnabledChange = useCallback((checked: boolean) => {
    setAutoRecommendEnabled(checked);
    writeBooleanPreferenceToStorage(
      LLM_GATEWAY_AUTO_RECOMMEND_ENABLED_STORAGE_KEY,
      checked,
    );
  }, []);

  const handleAutoRecommendNoticeEnabledChange = useCallback(
    (checked: boolean) => {
      setAutoRecommendNoticeEnabled(checked);
      writeBooleanPreferenceToStorage(
        LLM_GATEWAY_AUTO_RECOMMEND_NOTICE_STORAGE_KEY,
        checked,
      );
    },
    [],
  );

  const openRecommendationConfigModal = useCallback(() => {
    const config =
      autoRecommendationConfig ??
      DEFAULT_LLM_GATEWAY_AUTO_RECOMMENDATION_CONFIG;
    recommendationConfigForm.setFieldsValue({
      defaultPresetKey: config.defaultPresetKey,
      localGatewayHosts: config.localGatewayHosts,
      domainRules: config.domainRules.map((rule) => ({
        hostname: rule.hostname,
        presetKey: rule.presetKey,
      })),
    });
    setRecommendationConfigOpen(true);
  }, [autoRecommendationConfig, recommendationConfigForm]);

  const handleSaveRecommendationConfig = useCallback(
    async (values: LlmGatewayRecommendationConfigFormValues) => {
      setRecommendationConfigSaving(true);
      try {
        const localGatewayHosts = Array.from(
          new Set(
            (values.localGatewayHosts ?? [])
              .map((entry) => entry.trim().toLowerCase())
              .filter((entry) => entry.length > 0 && !/\s/.test(entry)),
          ),
        );

        const dedupedRules = new Map<string, LlmGatewayPresetKey>();
        (values.domainRules ?? []).forEach((rule) => {
          const hostname = rule.hostname?.trim().toLowerCase();
          if (!hostname || /\s/.test(hostname)) {
            return;
          }
          dedupedRules.set(hostname, rule.presetKey);
        });

        const domainRules = Array.from(dedupedRules.entries()).map(
          ([hostname, presetKey]) => ({
            hostname,
            presetKey,
          }),
        );

        const payload = {
          defaultPresetKey: values.defaultPresetKey,
          localGatewayHosts,
          domainRules,
        };

        const response =
          await apiClient.put<LlmGatewayAutoRecommendationConfig>(
            "system-settings/llm-gateways/recommendation-config",
            payload,
          );

        setAutoRecommendationConfig(response.data ?? null);
        setRecommendationConfigOpen(false);
        messageApi.success(
          t("settings.llmGateway.messages.recommendationConfigUpdated", {
            defaultValue: "Auto recommendation mapping saved",
          }),
        );
      } catch (error) {
        captureClientError(
          "Failed to save LLM gateway recommendation config",
          error,
        );
        const messageText = formatApiErrorMessage(error);
        messageApi.error(
          messageText
            ? messageText
            : t("settings.llmGateway.errors.recommendationConfigSaveFailed", {
                defaultValue: "Failed to save recommendation mapping",
              }),
        );
      } finally {
        setRecommendationConfigSaving(false);
      }
    },
    [apiClient, messageApi, t],
  );

  const statusProfile = useMemo(() => {
    if (settings.activeId) {
      const active = settings.profiles.find(
        (profile) => profile.id === settings.activeId,
      );
      if (active) {
        return active;
      }
    }
    return settings.profiles[0] ?? null;
  }, [settings.activeId, settings.profiles]);

  const statusProfileProxyModelInfo = useMemo(() => {
    if (!statusProfile) {
      return null;
    }
    if (proxyModelInfoSnapshot?.profileId !== statusProfile.id) {
      return null;
    }
    return proxyModelInfoSnapshot;
  }, [proxyModelInfoSnapshot, statusProfile]);

  const statusProfileProxyLbTest = useMemo(() => {
    if (!statusProfile) {
      return null;
    }
    if (proxyLbTestSnapshot?.profileId !== statusProfile.id) {
      return null;
    }
    return proxyLbTestSnapshot;
  }, [proxyLbTestSnapshot, statusProfile]);

  const completionActiveProfile = useMemo(() => {
    if (!settings.activeId) {
      return null;
    }
    return (
      settings.profiles.find((profile) => profile.id === settings.activeId) ??
      null
    );
  }, [settings.activeId, settings.profiles]);

  const embeddingResolved = useMemo(() => {
    if (settings.embeddingActiveId) {
      return { kind: "profile" as const, id: settings.embeddingActiveId };
    }
    if (settings.embeddingMode === "use_default") {
      return { kind: "default" as const };
    }
    if (settings.activeId) {
      return { kind: "follow_completion" as const, id: settings.activeId };
    }
    return { kind: "default" as const };
  }, [settings.activeId, settings.embeddingActiveId, settings.embeddingMode]);

  const embeddingSelectValue = useMemo(() => {
    if (settings.embeddingActiveId) {
      return settings.embeddingActiveId;
    }
    return settings.embeddingMode === "use_default"
      ? USE_DEFAULT_KEY
      : FOLLOW_COMPLETION_KEY;
  }, [settings.embeddingActiveId, settings.embeddingMode]);

  const embeddingActiveProfile = useMemo(() => {
    if (embeddingResolved.kind === "default") {
      return null;
    }
    return (
      settings.profiles.find(
        (profile) => profile.id === embeddingResolved.id,
      ) ?? null
    );
  }, [embeddingResolved, settings.profiles]);

  const presets = useMemo<LlmGatewayPresetOption[]>(
    () => [
      {
        key: "litellmDocker",
        label: t("settings.llmGateway.presets.litellmDocker"),
        apiBase: "http://litellm:4000",
        model: "openai/gpt-4o-mini",
        embeddingModel: "openai/text-embedding-3-small",
        fallbackModels: ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"],
        sendMetadata: true,
        responseFormatMode: "json_schema",
      },
      {
        key: "litellmLocal",
        label: t("settings.llmGateway.presets.litellmLocal"),
        apiBase: "http://localhost:4001",
        model: "openai/gpt-4o-mini",
        embeddingModel: "openai/text-embedding-3-small",
        fallbackModels: ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"],
        sendMetadata: true,
        responseFormatMode: "json_schema",
      },
      {
        key: "openaiOfficial",
        label: t("settings.llmGateway.presets.openaiOfficial", {
          defaultValue: "OpenAI (Official)",
        }),
        apiBase: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        embeddingModel: "text-embedding-3-small",
        sendMetadata: true,
        responseFormatMode: "json_schema",
      },
      {
        key: "openrouter",
        label: t("settings.llmGateway.presets.openrouter", {
          defaultValue: "OpenRouter (Compatible)",
        }),
        apiBase: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
        sendMetadata: false,
        responseFormatMode: "json_object",
      },
      {
        key: "externalConservative",
        label: t("settings.llmGateway.presets.externalConservative", {
          defaultValue: "External Gateway (Conservative)",
        }),
        apiBase: "https://your-openai-compatible-gateway.example.com/v1",
        model: "openai/gpt-4o-mini",
        sendMetadata: false,
        responseFormatMode: "none",
      },
      {
        key: "glm",
        label: t("settings.llmGateway.presets.glm"),
        apiBase: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-4-plus",
        sendMetadata: false,
        responseFormatMode: "json_object",
      },
      {
        key: "kimi",
        label: t("settings.llmGateway.presets.kimi"),
        apiBase: "https://api.moonshot.cn/v1",
        model: "moonshot-v1-8k",
        sendMetadata: false,
        responseFormatMode: "json_object",
      },
      {
        key: "deepseek",
        label: t("settings.llmGateway.presets.deepseek"),
        apiBase: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        sendMetadata: false,
        responseFormatMode: "json_object",
      },
      {
        key: "qwen",
        label: t("settings.llmGateway.presets.qwen"),
        apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-turbo",
        sendMetadata: false,
        responseFormatMode: "json_object",
      },
    ],
    [t],
  );

  const apiBaseRules = useMemo(
    () => [
      {
        required: true,
        message: t("settings.llmGateway.validation.apiBaseRequired"),
      },
      {
        validator: (_: unknown, value: unknown) => {
          if (typeof value !== "string" || value.trim().length === 0) {
            return Promise.resolve();
          }
          try {
            const parsed = new URL(value);
            if (!["http:", "https:"].includes(parsed.protocol)) {
              throw new Error("invalid protocol");
            }
            return Promise.resolve();
          } catch {
            return Promise.reject(
              new Error(t("settings.llmGateway.validation.apiBaseUrl")),
            );
          }
        },
      },
    ],
    [t],
  );

  const testProfileRecommendation = useMemo(() => {
    if (!testProfile) {
      return null;
    }
    const detected = detectPresetRecommendationByApiBase(
      testProfile.apiBase,
      autoRecommendationConfig ?? undefined,
    );
    if (!detected) {
      return null;
    }
    const preset = presets.find((entry) => entry.key === detected.presetKey);
    if (!preset) {
      return null;
    }
    return { detected, preset };
  }, [autoRecommendationConfig, presets, testProfile]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<LlmGatewaySettingsResponse>(
        "system-settings/llm-gateways",
      );
      setSettings(response.data ?? EMPTY_SETTINGS);

      try {
        const recommendationResponse =
          await apiClient.get<LlmGatewayAutoRecommendationConfig>(
            "system-settings/llm-gateways/recommendation-config",
          );
        setAutoRecommendationConfig(recommendationResponse.data ?? null);
      } catch (error) {
        captureClientError(
          "Failed to load LLM gateway recommendation config",
          error,
        );
        setAutoRecommendationConfig(null);
      }
    } catch (error) {
      captureClientError("Failed to load LLM gateway settings", error);
      setAutoRecommendationConfig(null);
      setErrorMessage(t("settings.llmGateway.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, t]);

  const applyApiBaseRecommendation = useCallback(
    (form: FormInstance<LlmGatewayFormValues>, source: "create" | "edit") => {
      if (!autoRecommendEnabled) {
        return;
      }

      const baselineApiBase =
        source === "create" ? createInitialApiBase : editInitialApiBase;
      const recommendation = buildAutoRecommendationPatch({
        apiBase: String(form.getFieldValue("apiBase") ?? ""),
        baselineApiBase,
        presets,
        recommendationConfig: autoRecommendationConfig ?? undefined,
        currentValues: {
          preset: form.getFieldValue("preset"),
          sendMetadata: form.getFieldValue("sendMetadata"),
          responseFormatMode: form.getFieldValue("responseFormatMode"),
        },
        touchedFields: {
          preset: form.isFieldTouched("preset"),
          sendMetadata: form.isFieldTouched("sendMetadata"),
          responseFormatMode: form.isFieldTouched("responseFormatMode"),
        },
      });

      if (!recommendation.hasChanges || !recommendation.recommendedPreset) {
        return;
      }

      form.setFieldsValue(recommendation.nextValues);
      if (autoRecommendNoticeEnabled) {
        messageApi.info(
          t("settings.llmGateway.messages.autoRecommended", {
            defaultValue:
              "Detected API base domain {{domain}} and auto-applied compatibility template: {{name}}",
            domain: recommendation.detected?.hostname ?? "-",
            name: recommendation.recommendedPreset.label,
          }),
        );
      }
    },
    [
      autoRecommendationConfig,
      autoRecommendEnabled,
      autoRecommendNoticeEnabled,
      createInitialApiBase,
      editInitialApiBase,
      messageApi,
      presets,
      t,
    ],
  );

  useEffect(() => {
    setAutoRecommendEnabled(
      readBooleanPreferenceFromStorage(
        LLM_GATEWAY_AUTO_RECOMMEND_ENABLED_STORAGE_KEY,
        true,
      ),
    );
    setAutoRecommendNoticeEnabled(
      readBooleanPreferenceFromStorage(
        LLM_GATEWAY_AUTO_RECOMMEND_NOTICE_STORAGE_KEY,
        true,
      ),
    );
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!editing) {
      setEditInitialApiBase("");
      return;
    }
    setEditInitialApiBase(editing.apiBase);
    editForm.setFieldsValue({
      preset: undefined,
      name: editing.name,
      apiBase: editing.apiBase,
      model: editing.model,
      assistantModel: editing.assistantModel ?? undefined,
      embeddingModel: editing.embeddingModel ?? undefined,
      timeoutMs: editing.timeoutMs,
      temperature: editing.temperature,
      topP: editing.topP,
      maxOutputTokens: editing.maxOutputTokens,
      maxRetries: editing.maxRetries,
      requestsPerMinute: editing.requestsPerMinute,
      fallbackModels: toFallbackModelsText(editing.fallbackModels),
      sendMetadata: editing.sendMetadata,
      responseFormatMode: editing.responseFormatMode,
      enabled: editing.enabled,
      apiKey: "",
      clearApiKey: false,
    });
  }, [editing, editForm]);

  const openCreate = () => {
    const template =
      settings.profiles.find((profile) => profile.id === settings.activeId) ??
      settings.profiles[0] ??
      null;
    const templateFallbackModels = template
      ? toFallbackModelsText(template.fallbackModels)
      : "";
    const initialApiBase = template?.apiBase ?? DEFAULT_LLM_GATEWAY_API_BASE;

    createForm.setFieldsValue({
      preset: undefined,
      name: "",
      apiBase: initialApiBase,
      model: template?.model ?? "openai/gpt-4o-mini",
      assistantModel: template?.assistantModel ?? "",
      embeddingModel: template?.embeddingModel ?? "",
      timeoutMs: template?.timeoutMs ?? 60_000,
      temperature: template?.temperature ?? 0.2,
      topP: template?.topP ?? 0.9,
      maxOutputTokens: template?.maxOutputTokens ?? 1_200,
      maxRetries: template?.maxRetries ?? 3,
      requestsPerMinute: template?.requestsPerMinute ?? 60,
      fallbackModels: templateFallbackModels,
      sendMetadata: template?.sendMetadata ?? true,
      responseFormatMode: template?.responseFormatMode ?? "json_schema",
      enabled: true,
    });
    setCreateInitialApiBase(initialApiBase);
    setCreateOpen(true);
  };

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
          : t("settings.llmGateway.proxyLoadBalancing.errors.loadFailed", {
              defaultValue: "Failed to load balancing settings",
            }),
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
          t("settings.llmGateway.proxyLoadBalancing.messages.saved", {
            defaultValue: "Load balancing settings saved",
          }),
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
            : t("settings.llmGateway.proxyLoadBalancing.errors.saveFailed", {
                defaultValue: "Failed to save load balancing settings",
              }),
        );
      } finally {
        setProxyLbSaving(false);
      }
    },
    [apiClient, messageApi, proxyLbForm, t],
  );

  const resetProxyLbSettings = useCallback(() => {
    Modal.confirm({
      title: t("settings.llmGateway.proxyLoadBalancing.reset.modal.title", {
        defaultValue: "Reset load balancing settings?",
      }),
      content: t("settings.llmGateway.proxyLoadBalancing.reset.modal.content", {
        defaultValue:
          "This removes DB-managed load balancing config. LiteLLM startup will keep load balancing disabled until you save settings again.",
      }),
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
            t("settings.llmGateway.proxyLoadBalancing.reset.messages.done", {
              defaultValue: "Load balancing settings reset",
            }),
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
                  {
                    defaultValue: "Failed to reset load balancing settings",
                  },
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
            : t("settings.llmGateway.proxyStatus.errors.lbTestFailed", {
                defaultValue: "负载均衡测试失败",
              }),
        );
      } finally {
        setProxyLbTesting((current) =>
          current === profile.id ? null : current,
        );
      }
    },
    [apiClient, t],
  );

  const handleCreate = async (values: LlmGatewayFormValues) => {
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        apiBase: values.apiBase.trim(),
        apiKey: values.apiKey?.trim() ? values.apiKey.trim() : undefined,
        ...(values.model?.trim() ? { model: values.model.trim() } : {}),
        assistantModel: values.assistantModel?.trim()
          ? values.assistantModel.trim()
          : null,
        embeddingModel: values.embeddingModel?.trim()
          ? values.embeddingModel.trim()
          : null,
        timeoutMs: values.timeoutMs,
        temperature: values.temperature,
        topP: values.topP,
        maxOutputTokens: values.maxOutputTokens,
        maxRetries: values.maxRetries,
        requestsPerMinute: values.requestsPerMinute,
        fallbackModels: toFallbackModels(values.fallbackModels),
        sendMetadata: values.sendMetadata,
        responseFormatMode: values.responseFormatMode,
        enabled: values.enabled,
      };
      await apiClient.post("system-settings/llm-gateways", payload);
      await loadSettings();
      setCreateOpen(false);
      setCreateInitialApiBase("");
      createForm.resetFields();
      messageApi.success(t("settings.llmGateway.messages.created"));
    } catch (error) {
      captureClientError("Failed to create LLM gateway profile", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(
          extractApiError(error).message ??
            t("settings.llmGateway.errors.badRequest"),
        );
      } else {
        const messageText = formatApiErrorMessage(error);
        messageApi.error(
          messageText
            ? messageText
            : t("settings.llmGateway.errors.createFailed"),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (values: LlmGatewayFormValues) => {
    if (!editing) {
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: values.name.trim(),
        apiBase: values.apiBase.trim(),
        ...(values.model?.trim() ? { model: values.model.trim() } : {}),
        assistantModel: values.assistantModel?.trim()
          ? values.assistantModel.trim()
          : null,
        embeddingModel: values.embeddingModel?.trim()
          ? values.embeddingModel.trim()
          : null,
        timeoutMs: values.timeoutMs,
        temperature: values.temperature,
        topP: values.topP,
        maxOutputTokens: values.maxOutputTokens,
        maxRetries: values.maxRetries,
        requestsPerMinute: values.requestsPerMinute,
        fallbackModels: toFallbackModels(values.fallbackModels),
        sendMetadata: values.sendMetadata,
        responseFormatMode: values.responseFormatMode,
        enabled: values.enabled,
      };

      if (values.clearApiKey) {
        payload.apiKey = "";
      } else if (values.apiKey?.trim()) {
        payload.apiKey = values.apiKey.trim();
      }

      await apiClient.put(
        `system-settings/llm-gateways/${editing.id}`,
        payload,
      );
      await loadSettings();
      setEditing(null);
      setEditInitialApiBase("");
      editForm.resetFields();
      messageApi.success(t("settings.llmGateway.messages.updated"));
    } catch (error) {
      captureClientError("Failed to update LLM gateway profile", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(
          extractApiError(error).message ??
            t("settings.llmGateway.errors.badRequest"),
        );
      } else {
        const messageText = formatApiErrorMessage(error);
        messageApi.error(
          messageText
            ? messageText
            : t("settings.llmGateway.errors.updateFailed"),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (
    profile: LlmGatewayProfile,
    nextEnabled: boolean,
  ) => {
    const wasCompletionActive = settings.activeId === profile.id;
    const wasEmbeddingActive = settings.embeddingActiveId === profile.id;
    if (!nextEnabled && (wasCompletionActive || wasEmbeddingActive)) {
      const shouldDisable = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: t("settings.llmGateway.modal.disableTitle", {
            defaultValue: "确认禁用该 Profile？",
          }),
          okButtonProps: { danger: true },
          okText: t("common.disable", { defaultValue: "禁用" }),
          cancelText: t("common.cancel"),
          content: (
            <Space
              direction="vertical"
              size="small"
              style={{ display: "flex" }}
            >
              <Typography.Text>
                {t("settings.llmGateway.modal.disableContent", {
                  defaultValue: "即将禁用：{{name}}",
                  name: profile.name,
                })}
              </Typography.Text>
              {wasCompletionActive ? (
                <Typography.Text type="secondary">
                  {t("settings.llmGateway.modal.disableActiveHint", {
                    defaultValue:
                      "该 Profile 当前为对话/补全的 Active 配置。禁用后将自动取消 Active Profile，并回退到默认配置。",
                  })}
                </Typography.Text>
              ) : null}
              {wasEmbeddingActive ? (
                <Typography.Text type="secondary">
                  {t("settings.llmGateway.modal.disableEmbeddingHint", {
                    defaultValue:
                      "该 Profile 当前为 Embeddings 的 Active 配置。禁用后将自动取消 Embeddings Active，并回退到 follow_completion 或默认配置。",
                  })}
                </Typography.Text>
              ) : null}
            </Space>
          ),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!shouldDisable) {
        return;
      }
    }

    setToggling(profile.id);
    try {
      await apiClient.put(`system-settings/llm-gateways/${profile.id}`, {
        enabled: nextEnabled,
      });
      await loadSettings();
      messageApi.success(
        nextEnabled ? t("common.enabled") : t("common.disabled"),
      );
    } catch (error) {
      captureClientError("Failed to toggle LLM gateway profile", error);
      const messageText = formatApiErrorMessage(error);
      messageApi.error(
        messageText
          ? messageText
          : t("settings.llmGateway.errors.toggleFailed"),
      );
    } finally {
      setToggling((current) => (current === profile.id ? null : current));
    }
  };

  const handleActivate = async (profileId: string) => {
    setActivatingProfileId(profileId);
    try {
      await apiClient.put("system-settings/llm-gateways/active", {
        activeId: profileId,
      });
      await loadSettings();
      messageApi.success(t("settings.llmGateway.messages.activated"));
    } catch (error) {
      captureClientError("Failed to activate LLM gateway profile", error);
      const messageText = formatApiErrorMessage(error);
      messageApi.error(
        messageText
          ? messageText
          : t("settings.llmGateway.errors.activateFailed"),
      );
    } finally {
      setActivatingProfileId((current) =>
        current === profileId ? null : current,
      );
    }
  };

  const handleActivateEmbedding = async (
    profileId: string | null,
    mode?: LlmGatewayEmbeddingMode,
  ) => {
    setEmbeddingActivating(true);
    try {
      await apiClient.put("system-settings/llm-gateways/embedding-active", {
        activeId: profileId,
        ...(!profileId && mode ? { mode } : {}),
      });
      await loadSettings();
      messageApi.success(
        t("settings.llmGateway.embeddingActive.messages.activated", {
          defaultValue: "Embeddings 配置已更新",
        }),
      );
    } catch (error) {
      captureClientError(
        "Failed to activate embeddings gateway profile",
        error,
      );
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(
          extractApiError(error).message ??
            t("settings.llmGateway.errors.badRequest"),
        );
      } else {
        const messageText = formatApiErrorMessage(error);
        messageApi.error(
          messageText
            ? messageText
            : t("settings.llmGateway.embeddingActive.errors.activateFailed", {
                defaultValue: "更新 Embeddings 配置失败",
              }),
        );
      }
    } finally {
      setEmbeddingActivating(false);
    }
  };

  const handleDelete = async (profile: LlmGatewayProfile) => {
    const wasCompletionActive = settings.activeId === profile.id;
    const wasEmbeddingActive = settings.embeddingActiveId === profile.id;
    Modal.confirm({
      title: t("settings.llmGateway.modal.deleteTitle"),
      content: (
        <Space direction="vertical" size="small" style={{ display: "flex" }}>
          <Typography.Text>
            {t("settings.llmGateway.modal.deleteContent", {
              name: profile.name,
            })}
          </Typography.Text>
          {wasCompletionActive || wasEmbeddingActive ? (
            <Typography.Text type="secondary">
              {t("settings.llmGateway.modal.deleteActiveHint", {
                defaultValue:
                  "该 Profile 当前正在使用中（Active）。删除后将取消相应的 Active 配置，并回退到默认策略。",
              })}
            </Typography.Text>
          ) : null}
        </Space>
      ),
      okButtonProps: { danger: true },
      okText: t("common.delete"),
      onOk: async () => {
        try {
          await apiClient.delete(`system-settings/llm-gateways/${profile.id}`);
          await loadSettings();
          messageApi.success(t("settings.llmGateway.messages.deleted"));
        } catch (error) {
          captureClientError("Failed to delete LLM gateway profile", error);
          const messageText = formatApiErrorMessage(error);
          messageApi.error(
            messageText
              ? messageText
              : t("settings.llmGateway.errors.deleteFailed"),
          );
        }
      },
    });
  };

  const applyPreset = useCallback(
    (form: typeof createForm, presetKey: string | undefined) => {
      if (!presetKey) {
        return;
      }
      const preset = presets.find((entry) => entry.key === presetKey);
      if (!preset) {
        return;
      }
      const nextValues: Partial<LlmGatewayFormValues> = {
        apiBase: preset.apiBase,
        model: preset.model,
        embeddingModel: preset.embeddingModel ?? "",
        fallbackModels: preset.fallbackModels
          ? toFallbackModelsText(preset.fallbackModels)
          : "",
        sendMetadata: preset.sendMetadata,
        responseFormatMode: preset.responseFormatMode,
      };
      const currentName = form.getFieldValue("name");
      if (!currentName) {
        nextValues.name = preset.label;
      }
      form.setFieldsValue(nextValues);
    },
    [presets],
  );

  const openModelsModal = useCallback(
    (title: string, apiBase: string, models: string[]) => {
      interface ModelRow {
        id: string;
      }
      const rows: ModelRow[] = models.map((id) => ({ id }));
      const columns: ColumnsType<ModelRow> = [
        {
          title: t("settings.llmGateway.models.columns.id"),
          dataIndex: "id",
          key: "id",
          render: (value: string) => (
            <Typography.Text code copyable>
              {value}
            </Typography.Text>
          ),
        },
      ];

      Modal.info({
        title,
        width: screens.md ? 720 : "100%",
        content: (
          <Space direction="vertical" size="small" style={{ display: "flex" }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("settings.llmGateway.fields.apiBase")}:{" "}
              <Typography.Text code copyable>
                {apiBase}
              </Typography.Text>
            </Typography.Paragraph>
            <Typography.Text type="secondary">
              {t("settings.llmGateway.models.count", { count: models.length })}
            </Typography.Text>
            <Table<ModelRow>
              size="small"
              rowKey="id"
              dataSource={rows}
              columns={columns}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              scroll={{ y: 360 }}
              locale={{ emptyText: t("common.empty") }}
            />
          </Space>
        ),
      });
    },
    [screens.md, t],
  );

  const openProxyModelInfoModal = useCallback(
    (
      title: string,
      apiBase: string,
      result: LlmGatewayProxyModelInfoResponse,
    ) => {
      type ModelInfoRow = {
        id: string;
        modelName: string;
        deployments: number;
        providerModels: string[];
        apiBases: string[];
        rpms: number[];
        tpms: number[];
      };

      const groups = new Map<string, LlmGatewayProxyModelInfoEntry[]>();
      for (const model of result.models ?? []) {
        const key = model.modelName;
        const next = groups.get(key) ?? [];
        next.push(model);
        groups.set(key, next);
      }

      const rows: ModelInfoRow[] = Array.from(groups.entries()).map(
        ([modelName, entries]) => {
          const providerModels = Array.from(
            new Set(
              entries
                .map((entry) => entry.litellmParams?.["model"])
                .filter(
                  (value): value is string =>
                    typeof value === "string" && value.trim().length > 0,
                )
                .map((value) => value.trim()),
            ),
          );
          const apiBases = Array.from(
            new Set(
              entries
                .map((entry) => entry.litellmParams?.["api_base"])
                .filter(
                  (value): value is string =>
                    typeof value === "string" && value.trim().length > 0,
                )
                .map((value) => value.trim()),
            ),
          );
          const rpms = Array.from(
            new Set(
              entries
                .map((entry) => entry.litellmParams?.["rpm"])
                .filter(
                  (value): value is number =>
                    typeof value === "number" && Number.isFinite(value),
                ),
            ),
          ).sort((a, b) => a - b);
          const tpms = Array.from(
            new Set(
              entries
                .map((entry) => entry.litellmParams?.["tpm"])
                .filter(
                  (value): value is number =>
                    typeof value === "number" && Number.isFinite(value),
                ),
            ),
          ).sort((a, b) => a - b);

          return {
            id: modelName,
            modelName,
            deployments: entries.length,
            providerModels,
            apiBases,
            rpms,
            tpms,
          };
        },
      );

      const totalDeployments = rows.reduce(
        (acc, row) => acc + row.deployments,
        0,
      );

      const columns: ColumnsType<ModelInfoRow> = [
        {
          title: t("settings.llmGateway.proxyModelInfo.columns.model", {
            defaultValue: "模型",
          }),
          dataIndex: "modelName",
          key: "modelName",
          render: (value: string) => (
            <Typography.Text code copyable>
              {value}
            </Typography.Text>
          ),
        },
        {
          title: t("settings.llmGateway.proxyModelInfo.columns.deployments", {
            defaultValue: "Deployments",
          }),
          dataIndex: "deployments",
          key: "deployments",
          width: 140,
          render: (value: number) => (
            <Tag color={value > 1 ? "green" : "default"}>{value}</Tag>
          ),
        },
        {
          title: t("settings.llmGateway.proxyModelInfo.columns.details", {
            defaultValue: "详情",
          }),
          key: "details",
          render: (_: unknown, record: ModelInfoRow) => {
            const parts: string[] = [];
            if (record.providerModels.length > 0) {
              parts.push(`model: ${record.providerModels.join(", ")}`);
            }
            if (record.apiBases.length > 0) {
              parts.push(`api_base: ${record.apiBases.join(", ")}`);
            }
            if (record.rpms.length > 0) {
              parts.push(`rpm: ${record.rpms.join(", ")}`);
            }
            if (record.tpms.length > 0) {
              parts.push(`tpm: ${record.tpms.join(", ")}`);
            }
            return (
              <Typography.Text type="secondary">
                {parts.length > 0 ? parts.join(" | ") : "-"}
              </Typography.Text>
            );
          },
        },
      ];

      Modal.info({
        title,
        width: screens.md ? 860 : "100%",
        content: (
          <Space direction="vertical" size="small" style={{ display: "flex" }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t("settings.llmGateway.fields.apiBase")}:{" "}
              <Typography.Text code copyable>
                {apiBase}
              </Typography.Text>
            </Typography.Paragraph>

            <Typography.Text type="secondary">
              {t("settings.llmGateway.proxyModelInfo.summary", {
                defaultValue:
                  "模型组：{{groups}}，Deployments：{{deployments}}",
                groups: rows.length,
                deployments: totalDeployments,
              })}
            </Typography.Text>

            <Typography.Text type="secondary">
              {t("settings.llmGateway.proxyModelInfo.hint", {
                defaultValue:
                  "同一个模型出现多个 Deployments 时，LiteLLM Proxy 会在它们之间自动分发请求。",
              })}
            </Typography.Text>

            <Table<ModelInfoRow>
              size="small"
              rowKey="id"
              dataSource={rows}
              columns={columns}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              scroll={{ y: 420 }}
              locale={{ emptyText: t("common.empty") }}
            />
          </Space>
        ),
      });
    },
    [screens.md, t],
  );

  const handleCheckProxyHealth = async (profile: LlmGatewayProfile) => {
    setCheckingProxyHealth(profile.id);
    setProxyHealthErrorMessage(null);
    setProxyHealthProfileId(profile.id);
    try {
      const response = await apiClient.get<LlmGatewayProxyHealthResponse>(
        `system-settings/llm-gateways/${profile.id}/proxy-health`,
      );
      setProxyHealth(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to check LLM gateway proxy health", error);
      const messageText = formatApiErrorMessage(error);
      setProxyHealth(null);
      setProxyHealthErrorMessage(
        messageText
          ? messageText
          : t("settings.llmGateway.proxyStatus.errors.failed"),
      );
    } finally {
      setCheckingProxyHealth((current) =>
        current === profile.id ? null : current,
      );
    }
  };

  const handleProxyModelInfo = async (profile: LlmGatewayProfile) => {
    setLoadingProxyModelInfo(profile.id);
    try {
      const response = await apiClient.get<LlmGatewayProxyModelInfoResponse>(
        `system-settings/llm-gateways/${profile.id}/proxy-model-info`,
      );
      const result = response.data;
      const models = Array.isArray(result?.models) ? result.models : [];
      const groups = new Map<string, number>();
      for (const entry of models) {
        const key = entry?.modelName;
        if (typeof key !== "string" || key.trim().length === 0) {
          continue;
        }
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      const groupEntries = Array.from(groups.values());
      const groupCount = groupEntries.length;
      const deployments = groupEntries.reduce((acc, count) => acc + count, 0);
      const loadBalancedGroups = groupEntries.filter(
        (count) => count > 1,
      ).length;

      setProxyModelInfoSnapshot({
        profileId: profile.id,
        apiBase: result?.apiBase ?? profile.apiBase,
        groups: groupCount,
        deployments,
        loadBalancedGroups,
        checkedAt: result?.checkedAt ?? new Date().toISOString(),
      });

      openProxyModelInfoModal(
        t("settings.llmGateway.proxyModelInfo.modal.title", {
          defaultValue: "LiteLLM Proxy 模型详情：{{name}}",
          name: profile.name,
        }),
        result?.apiBase ?? profile.apiBase,
        result ?? {
          apiBase: profile.apiBase,
          checkedAt: new Date().toISOString(),
          models: [],
        },
      );
    } catch (error) {
      captureClientError("Failed to fetch LiteLLM proxy model info", error);
      const messageText = formatApiErrorMessage(error);
      messageApi.error(
        messageText
          ? messageText
          : t("settings.llmGateway.proxyStatus.errors.modelInfoFailed", {
              defaultValue: "获取 Proxy 模型详情失败",
            }),
      );
    } finally {
      setLoadingProxyModelInfo((current) =>
        current === profile.id ? null : current,
      );
    }
  };

  const handleListModels = async (profile: LlmGatewayProfile) => {
    setLoadingModels(profile.id);
    try {
      const response = await apiClient.get<LlmGatewayModelsResponse>(
        `system-settings/llm-gateways/${profile.id}/models`,
      );
      const result = response.data;
      const models = result?.models ?? [];
      setModelsSnapshot({
        profileId: profile.id,
        apiBase: result?.apiBase ?? profile.apiBase,
        count: models.length,
        checkedAt: new Date().toISOString(),
      });
      openModelsModal(
        t("settings.llmGateway.models.modal.title", { name: profile.name }),
        result?.apiBase ?? profile.apiBase,
        models,
      );
    } catch (error) {
      captureClientError("Failed to list LLM gateway models", error);
      const messageText = formatApiErrorMessage(error);
      messageApi.error(
        messageText
          ? messageText
          : t("settings.llmGateway.models.errors.failed"),
      );
    } finally {
      setLoadingModels((current) => (current === profile.id ? null : current));
    }
  };

  const renderTestResult = useCallback(
    (result: LlmGatewayTestResponse) => (
      <Space direction="vertical" size="small" style={{ display: "flex" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.fields.apiBase")}:{" "}
          <Typography.Text code copyable>
            {result.apiBase}
          </Typography.Text>
        </Typography.Paragraph>

        {result.apiSurfaceUsed ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("settings.llmGateway.test.labels.apiSurface", {
              defaultValue: "API surface",
            })}
            : <Typography.Text code>{result.apiSurfaceUsed}</Typography.Text>
          </Typography.Paragraph>
        ) : null}

        {result.compatibilityError ? (
          <Alert
            type="warning"
            showIcon
            message={`${t("settings.llmGateway.test.labels.compatibility", {
              defaultValue: "Compatibility",
            })}: ${result.compatibilityError.code}`}
            description={
              <Space direction="vertical" size={2} style={{ width: "100%" }}>
                <Typography.Text>
                  {t("settings.llmGateway.test.labels.field", {
                    defaultValue: "field",
                  })}
                  :{" "}
                  <Typography.Text code>
                    {result.compatibilityError.incompatibleField}
                  </Typography.Text>
                </Typography.Text>
                <Typography.Text>
                  {result.compatibilityError.hint}
                </Typography.Text>
                <Typography.Text
                  type="secondary"
                  style={{ whiteSpace: "pre-wrap" }}
                >
                  {result.compatibilityError.upstreamMessage}
                </Typography.Text>
              </Space>
            }
          />
        ) : null}

        <Typography.Title level={5} style={{ marginBottom: 0 }}>
          {t("settings.llmGateway.test.sections.completion")}
        </Typography.Title>
        {result.completion ? (
          <>
            <Space wrap>
              <Tag color="blue">{result.completion.model}</Tag>
              <Tag>{result.completion.latencyMs}ms</Tag>
              {result.completion.finishReason ? (
                <Tag>{result.completion.finishReason}</Tag>
              ) : null}
              {result.completion.usage ? (
                <Tag>
                  {t("settings.llmGateway.test.tokens", {
                    total: result.completion.usage.total_tokens,
                  })}
                </Tag>
              ) : null}
              {typeof result.completion.costUsd === "number" ? (
                <Tag color="geekblue">
                  {t("settings.llmGateway.test.cost", {
                    cost: result.completion.costUsd.toFixed(6),
                  })}
                </Tag>
              ) : null}
            </Space>
            <Typography.Paragraph
              style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}
            >
              {result.completion.content ?? "-"}
            </Typography.Paragraph>
          </>
        ) : result.completionError ? (
          <>
            {renderGatewayErrorMeta(result.completionError)}
            <Alert
              type="error"
              showIcon
              message={result.completionError.message}
            />
            {result.completionError.compatibilityError ? (
              <Alert
                type="warning"
                showIcon
                message={`${t("settings.llmGateway.test.labels.compatibility", {
                  defaultValue: "Compatibility",
                })}: ${result.completionError.compatibilityError.code}`}
                description={result.completionError.compatibilityError.hint}
              />
            ) : null}
          </>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        )}

        {result.embedding ? (
          <>
            <Typography.Title
              level={5}
              style={{ marginBottom: 0, marginTop: 8 }}
            >
              {t("settings.llmGateway.test.sections.embedding")}
            </Typography.Title>
            <Space wrap>
              <Tag color="blue">{result.embedding.model}</Tag>
              <Tag>
                {t("settings.llmGateway.test.dimensions", {
                  n: result.embedding.dimensions,
                })}
              </Tag>
              <Tag>{result.embedding.latencyMs}ms</Tag>
              {typeof result.embedding.costUsd === "number" ? (
                <Tag color="geekblue">
                  {t("settings.llmGateway.test.cost", {
                    cost: result.embedding.costUsd.toFixed(6),
                  })}
                </Tag>
              ) : null}
            </Space>
          </>
        ) : result.embeddingError ? (
          <>
            <Typography.Title
              level={5}
              style={{ marginBottom: 0, marginTop: 8 }}
            >
              {t("settings.llmGateway.test.sections.embedding")}
            </Typography.Title>
            {renderGatewayErrorMeta(result.embeddingError)}
            <Alert
              type="error"
              showIcon
              message={result.embeddingError.message}
            />
            {result.embeddingError.compatibilityError ? (
              <Alert
                type="warning"
                showIcon
                message={`${t("settings.llmGateway.test.labels.compatibility", {
                  defaultValue: "Compatibility",
                })}: ${result.embeddingError.compatibilityError.code}`}
                description={result.embeddingError.compatibilityError.hint}
              />
            ) : null}
          </>
        ) : null}
      </Space>
    ),
    [t],
  );

  const renderProxyLbTestResult = useCallback(
    (result: LlmGatewayProxyLoadBalancingTestResponse) => {
      const total = Math.max(1, result.succeeded + result.failed);
      const modelIdRows = Object.entries(result.modelIdDistribution ?? {})
        .map(([key, count]) => ({
          id: key,
          count,
          ratio: Math.round((count / total) * 1000) / 10,
        }))
        .sort((a, b) => b.count - a.count);
      const apiBaseRows = Object.entries(result.modelApiBaseDistribution ?? {})
        .map(([key, count]) => ({
          id: key,
          count,
          ratio: Math.round((count / total) * 1000) / 10,
        }))
        .sort((a, b) => b.count - a.count);

      return (
        <Space direction="vertical" size="small" style={{ display: "flex" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("settings.llmGateway.fields.apiBase")}:{" "}
            <Typography.Text code copyable>
              {result.apiBase}
            </Typography.Text>
          </Typography.Paragraph>

          <Space wrap>
            <Tag color="blue">{result.model}</Tag>
            <Tag color={result.failed > 0 ? "red" : "green"}>
              {t("settings.llmGateway.proxyLbTest.summary.success", {
                defaultValue: "Success",
                n: result.succeeded,
              })}
              : {result.succeeded}
            </Tag>
            <Tag color={result.failed > 0 ? "red" : "default"}>
              {t("settings.llmGateway.proxyLbTest.summary.failed", {
                defaultValue: "Failed",
              })}
              : {result.failed}
            </Tag>
            <Tag>
              {t("settings.llmGateway.proxyLbTest.summary.duration", {
                defaultValue: "Duration",
              })}
              : {result.durationMs}ms
            </Tag>
            <Tag>
              {t("settings.llmGateway.proxyLbTest.summary.deployments", {
                defaultValue: "Model IDs",
              })}
              : {Object.keys(result.modelIdDistribution ?? {}).length}
            </Tag>
            <Tag>
              {t("settings.llmGateway.proxyLbTest.summary.apiBases", {
                defaultValue: "API bases",
              })}
              : {Object.keys(result.modelApiBaseDistribution ?? {}).length}
            </Tag>
          </Space>

          <Typography.Text type="secondary">
            {t("settings.llmGateway.proxyLbTest.sections.modelIds", {
              defaultValue: "Model ID distribution",
            })}
          </Typography.Text>
          <Table
            size="small"
            rowKey="id"
            dataSource={modelIdRows}
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            columns={[
              {
                title: t("settings.llmGateway.proxyLbTest.columns.id", {
                  defaultValue: "ID",
                }),
                dataIndex: "id",
                key: "id",
                render: (value: string) => (
                  <Typography.Text code copyable>
                    {value}
                  </Typography.Text>
                ),
              },
              {
                title: t("settings.llmGateway.proxyLbTest.columns.count", {
                  defaultValue: "Count",
                }),
                dataIndex: "count",
                key: "count",
                width: 100,
              },
              {
                title: t("settings.llmGateway.proxyLbTest.columns.ratio", {
                  defaultValue: "Share",
                }),
                dataIndex: "ratio",
                key: "ratio",
                width: 120,
                render: (value: number) => `${value}%`,
              },
            ]}
          />

          <Typography.Text type="secondary">
            {t("settings.llmGateway.proxyLbTest.sections.apiBases", {
              defaultValue: "API base distribution",
            })}
          </Typography.Text>
          <Table
            size="small"
            rowKey="id"
            dataSource={apiBaseRows}
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            columns={[
              {
                title: t("settings.llmGateway.proxyLbTest.columns.apiBase", {
                  defaultValue: "API base",
                }),
                dataIndex: "id",
                key: "id",
                render: (value: string) => (
                  <Typography.Text code copyable>
                    {value}
                  </Typography.Text>
                ),
              },
              {
                title: t("settings.llmGateway.proxyLbTest.columns.count", {
                  defaultValue: "Count",
                }),
                dataIndex: "count",
                key: "count",
                width: 100,
              },
              {
                title: t("settings.llmGateway.proxyLbTest.columns.ratio", {
                  defaultValue: "Share",
                }),
                dataIndex: "ratio",
                key: "ratio",
                width: 120,
                render: (value: number) => `${value}%`,
              },
            ]}
          />

          {result.callIdSamples?.length ? (
            <>
              <Typography.Text type="secondary">
                {t("settings.llmGateway.proxyLbTest.sections.callIds", {
                  defaultValue: "Call ID samples",
                })}
              </Typography.Text>
              <Space wrap>
                {result.callIdSamples.map((value) => (
                  <Tag key={value}>
                    <Typography.Text code copyable>
                      {value}
                    </Typography.Text>
                  </Tag>
                ))}
              </Space>
            </>
          ) : null}

          {result.errors?.length ? (
            <>
              <Typography.Text type="secondary">
                {t("settings.llmGateway.proxyLbTest.sections.errors", {
                  defaultValue: "Errors",
                })}
              </Typography.Text>
              <Space
                direction="vertical"
                size="small"
                style={{ display: "flex" }}
              >
                {result.errors.map((error, idx) => (
                  <Alert
                    key={`${idx}-${error.message}`}
                    type="error"
                    showIcon
                    message={error.message}
                    description={renderGatewayErrorMeta(error)}
                  />
                ))}
              </Space>
            </>
          ) : null}
        </Space>
      );
    },
    [t],
  );

  const testUnsavedConfig = useCallback(
    async (source: "create" | "edit") => {
      const form = source === "create" ? createForm : editForm;
      const draftKey = source === "create" ? DRAFT_CREATE_KEY : DRAFT_EDIT_KEY;
      const profileId = source === "edit" && editing ? editing.id : undefined;

      setTesting(draftKey);
      try {
        const values = await form.validateFields(
          source === "edit"
            ? [
                "apiBase",
                "apiKey",
                "clearApiKey",
                "model",
                "embeddingModel",
                "timeoutMs",
                "temperature",
                "topP",
                "maxOutputTokens",
                "fallbackModels",
                "sendMetadata",
                "responseFormatMode",
              ]
            : [
                "apiBase",
                "apiKey",
                "model",
                "embeddingModel",
                "timeoutMs",
                "temperature",
                "topP",
                "maxOutputTokens",
                "fallbackModels",
                "sendMetadata",
                "responseFormatMode",
              ],
        );

        const apiKeyValue =
          typeof values.apiKey === "string" ? values.apiKey.trim() : "";
        const includeApiKey = apiKeyValue.length > 0;
        const clearApiKey = Boolean(values.clearApiKey);

        const completionModel = values.model?.trim();
        const embeddingModel = values.embeddingModel?.trim();
        const hasCompletionModel = Boolean(completionModel);
        const hasEmbeddingModel = Boolean(embeddingModel);

        const payload: Record<string, unknown> = {
          ...(profileId ? { profileId } : {}),
          apiBase: values.apiBase.trim(),
          ...(completionModel ? { model: completionModel } : {}),
          includeCompletion: hasCompletionModel,
          timeoutMs: values.timeoutMs,
          temperature: values.temperature,
          topP: values.topP,
          maxOutputTokens: values.maxOutputTokens,
          fallbackModels: toFallbackModels(values.fallbackModels),
          ...(embeddingModel ? { embeddingModel } : {}),
          includeEmbeddings: hasEmbeddingModel,
          includeMetadataProbe: values.sendMetadata !== false,
          responseFormatMode: values.responseFormatMode ?? "json_schema",
        };

        if (includeApiKey) {
          payload.apiKey = apiKeyValue;
        } else if (profileId && clearApiKey) {
          payload.apiKey = "";
        }

        const response = await apiClient.post<LlmGatewayTestResponse>(
          "system-settings/llm-gateways/test-config",
          payload,
        );
        const result = response.data;
        if (
          !result ||
          (!result.completion &&
            !result.completionError &&
            !result.embedding &&
            !result.embeddingError)
        ) {
          messageApi.error(t("settings.llmGateway.testUnsaved.errors.failed"));
          return;
        }

        Modal.info({
          title: t("settings.llmGateway.testUnsaved.modal.title"),
          width: screens.md ? 720 : "100%",
          content: renderTestResult(result),
        });
      } catch (error) {
        if (typeof error === "object" && error && "errorFields" in error) {
          return;
        }
        captureClientError("Failed to test unsaved LLM gateway config", error);
        const messageText = formatApiErrorMessage(error);
        messageApi.error(
          messageText
            ? messageText
            : t("settings.llmGateway.testUnsaved.errors.failed"),
        );
      } finally {
        setTesting((current) => (current === draftKey ? null : current));
      }
    },
    [
      apiClient,
      createForm,
      editForm,
      editing,
      messageApi,
      renderTestResult,
      screens.md,
      t,
    ],
  );

  const listModelsUnsavedConfig = useCallback(
    async (source: "create" | "edit") => {
      const form = source === "create" ? createForm : editForm;
      const draftKey = source === "create" ? DRAFT_CREATE_KEY : DRAFT_EDIT_KEY;
      const profileId = source === "edit" && editing ? editing.id : undefined;

      setLoadingModels(draftKey);
      try {
        const values = await form.validateFields(
          source === "edit"
            ? ["apiBase", "apiKey", "clearApiKey", "timeoutMs"]
            : ["apiBase", "apiKey", "timeoutMs"],
        );
        const apiKeyValue =
          typeof values.apiKey === "string" ? values.apiKey.trim() : "";
        const includeApiKey = apiKeyValue.length > 0;
        const clearApiKey = Boolean(values.clearApiKey);

        const payload: Record<string, unknown> = {
          ...(profileId ? { profileId } : {}),
          apiBase: values.apiBase.trim(),
          timeoutMs: values.timeoutMs,
        };

        if (includeApiKey) {
          payload.apiKey = apiKeyValue;
        } else if (profileId && clearApiKey) {
          payload.apiKey = "";
        }

        const response = await apiClient.post<LlmGatewayModelsResponse>(
          "system-settings/llm-gateways/models-config",
          payload,
        );
        const result = response.data;
        const models = result?.models ?? [];

        openModelsModal(
          t("settings.llmGateway.modelsUnsaved.modal.title"),
          result?.apiBase ?? values.apiBase.trim(),
          models,
        );
      } catch (error) {
        if (typeof error === "object" && error && "errorFields" in error) {
          return;
        }
        captureClientError("Failed to list unsaved LLM gateway models", error);
        const messageText = formatApiErrorMessage(error);
        messageApi.error(
          messageText
            ? messageText
            : t("settings.llmGateway.models.errors.failed"),
        );
      } finally {
        setLoadingModels((current) => (current === draftKey ? null : current));
      }
    },
    [apiClient, createForm, editForm, editing, messageApi, openModelsModal, t],
  );

  const closeTest = () => {
    setTestProfile(null);
    setTestResult(null);
    setTestErrorMessage(null);
    testForm.resetFields();
  };

  const runTest = async (
    profileId: string,
    values: LlmGatewayTestFormValues,
  ) => {
    setTesting(profileId);
    setTestErrorMessage(null);
    try {
      const shouldTestCompletion = values.includeCompletion !== false;
      const payload = {
        includeCompletion: shouldTestCompletion,
        ...(values.model?.trim() ? { model: values.model.trim() } : {}),
        ...(values.prompt?.trim() ? { prompt: values.prompt.trim() } : {}),
        apiSurface: values.apiSurface ?? "chat_completions",
        responseFormatMode: values.responseFormatMode ?? "json_schema",
        includeMetadataProbe: values.includeMetadataProbe !== false,
        includeEmbeddings: values.includeEmbeddings,
        ...(values.embeddingModel?.trim()
          ? { embeddingModel: values.embeddingModel.trim() }
          : {}),
        ...(values.embeddingInput?.trim()
          ? { embeddingInput: values.embeddingInput.trim() }
          : {}),
      };
      const response = await apiClient.post<LlmGatewayTestResponse>(
        `system-settings/llm-gateways/${profileId}/test`,
        payload,
      );
      const result = response.data;
      if (
        !result ||
        (!result.completion &&
          !result.completionError &&
          !result.embedding &&
          !result.embeddingError)
      ) {
        setTestResult(null);
        setTestErrorMessage(t("settings.llmGateway.test.errors.failed"));
        return;
      }
      setTestResult(result);
      setTestErrorMessage(
        result.completionError?.message ??
          result.embeddingError?.message ??
          null,
      );
    } catch (error) {
      captureClientError("Failed to test LLM gateway profile", error);
      const messageText = formatApiErrorMessage(error);
      setTestResult(null);
      setTestErrorMessage(
        messageText ? messageText : t("settings.llmGateway.test.errors.failed"),
      );
    } finally {
      setTesting((current) => (current === profileId ? null : current));
    }
  };

  const openTest = (profile: LlmGatewayProfile) => {
    const initialValues: LlmGatewayTestFormValues = {
      includeCompletion: true,
      model: "",
      prompt: "",
      apiSurface: "chat_completions",
      responseFormatMode: profile.responseFormatMode ?? "json_schema",
      includeMetadataProbe: profile.sendMetadata ?? true,
      includeEmbeddings: Boolean(profile.embeddingModel),
      embeddingModel: "",
      embeddingInput: "",
    };

    setTestProfile(profile);
    setTestResult(null);
    setTestErrorMessage(null);
    testForm.setFieldsValue(initialValues);
    void runTest(profile.id, initialValues);
  };

  const columns: ColumnsType<LlmGatewayProfile> = [
    {
      title: t("settings.llmGateway.columns.name"),
      dataIndex: "name",
      key: "name",
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          <Space size={6} wrap>
            <Typography.Text strong>{record.name}</Typography.Text>
            {settings.activeId === record.id && record.enabled ? (
              <Tag color="blue">{t("settings.llmGateway.active")}</Tag>
            ) : null}
            {settings.embeddingActiveId === record.id && record.enabled ? (
              <Tag color="purple">
                {t("settings.llmGateway.embeddingActive.tag", {
                  defaultValue: "Embeddings",
                })}
              </Tag>
            ) : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Typography.Text code copyable>
              {record.apiBase}
            </Typography.Text>
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("settings.llmGateway.columns.model"),
      dataIndex: "model",
      key: "model",
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: t("settings.llmGateway.columns.assistantModel", {
        defaultValue: "Assistant model",
      }),
      dataIndex: "assistantModel",
      key: "assistantModel",
      responsive: ["xl"],
      render: (value?: string | null) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t("settings.llmGateway.columns.embeddingModel"),
      dataIndex: "embeddingModel",
      key: "embeddingModel",
      responsive: ["lg"],
      render: (value?: string | null) =>
        value ? (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t("settings.llmGateway.columns.compatibility", {
        defaultValue: "Compatibility",
      }),
      key: "compatibility",
      responsive: ["xl"],
      render: (_: unknown, record) => (
        <Space wrap>
          <Tag>{`response_format:${record.responseFormatMode}`}</Tag>
          <Tag color={record.sendMetadata ? "green" : "default"}>
            {record.sendMetadata
              ? t("settings.llmGateway.columns.metadataOn", {
                  defaultValue: "metadata:on",
                })
              : t("settings.llmGateway.columns.metadataOff", {
                  defaultValue: "metadata:off",
                })}
          </Tag>
        </Space>
      ),
    },
    {
      title: t("settings.llmGateway.columns.rpm"),
      dataIndex: "requestsPerMinute",
      key: "requestsPerMinute",
      responsive: ["md"],
      render: (value: number) => <Typography.Text>{value}</Typography.Text>,
    },
    {
      title: t("settings.llmGateway.columns.status"),
      dataIndex: "enabled",
      key: "enabled",
      render: (value: boolean) => (
        <Tag color={value ? "green" : "red"}>
          {value ? t("common.enabled") : t("common.disabled")}
        </Tag>
      ),
    },
    {
      title: t("settings.llmGateway.columns.apiKey"),
      dataIndex: "hasApiKey",
      key: "hasApiKey",
      responsive: ["md"],
      render: (value: boolean) => (
        <Tag color={value ? "green" : "default"}>
          {value
            ? t("settings.llmGateway.keySet")
            : t("settings.llmGateway.keyMissing")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, record) => (
        <Space wrap>
          <Button
            size="small"
            onClick={() => openTest(record)}
            loading={testing === record.id}
          >
            {t("settings.llmGateway.actions.test")}
          </Button>
          <Button
            size="small"
            onClick={() => void handleListModels(record)}
            loading={loadingModels === record.id}
          >
            {t("settings.llmGateway.actions.models")}
          </Button>
          <Button
            size="small"
            type="primary"
            disabled={
              settings.activeId === record.id ||
              !record.enabled ||
              (activatingProfileId !== null &&
                activatingProfileId !== record.id)
            }
            loading={activatingProfileId === record.id}
            onClick={() => void handleActivate(record.id)}
          >
            {t("settings.llmGateway.actions.activate")}
          </Button>
          <Button size="small" onClick={() => setEditing(record)}>
            {t("common.edit")}
          </Button>
          <Button size="small" danger onClick={() => handleDelete(record)}>
            {t("common.delete")}
          </Button>
          <Switch
            size="small"
            checked={record.enabled}
            loading={toggling === record.id}
            onChange={(checked) => void handleToggle(record, checked)}
          />
        </Space>
      ),
    },
  ];

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
                  {t("settings.llmGateway.proxyStatus.actions.modelInfo", {
                    defaultValue: "模型详情",
                  })}
                </Button>
                <Button
                  size="small"
                  onClick={() => void handleListModels(statusProfile)}
                  loading={loadingModels === statusProfile.id}
                >
                  {t("settings.llmGateway.proxyStatus.actions.models")}
                </Button>
                <Button size="small" onClick={openProxyLbWizard}>
                  {t("settings.llmGateway.proxyStatus.actions.loadBalancing", {
                    defaultValue: "负载均衡配置",
                  })}
                </Button>
                <Button
                  size="small"
                  onClick={() => openProxyLbTest(statusProfile)}
                >
                  {t("settings.llmGateway.proxyStatus.actions.lbTest", {
                    defaultValue: "负载均衡测试",
                  })}
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
                      {t("settings.llmGateway.proxyStatus.loadBalancing", {
                        defaultValue: "Load balancing",
                      })}
                      :{" "}
                      {statusProfileProxyModelInfo.loadBalancedGroups > 0
                        ? t("common.enabled")
                        : t("common.disabled")}
                    </Tag>
                    <Tag>
                      {t("settings.llmGateway.proxyStatus.modelGroups", {
                        defaultValue: "Model groups",
                      })}
                      : {statusProfileProxyModelInfo.groups}
                    </Tag>
                    <Tag>
                      {t("settings.llmGateway.proxyStatus.deployments", {
                        defaultValue: "Deployments",
                      })}
                      : {statusProfileProxyModelInfo.deployments}
                    </Tag>
                    {statusProfileProxyModelInfo.loadBalancedGroups > 0 ? (
                      <Tag color="green">
                        {t(
                          "settings.llmGateway.proxyStatus.loadBalancedGroups",
                          {
                            defaultValue: "Balanced groups",
                          },
                        )}
                        : {statusProfileProxyModelInfo.loadBalancedGroups}
                      </Tag>
                    ) : null}
                  </Space>
                  <Typography.Text type="secondary">
                    {t("settings.llmGateway.proxyModelInfo.checkedAt", {
                      defaultValue: "模型详情检测时间：{{time}}",
                      time: new Date(
                        statusProfileProxyModelInfo.checkedAt,
                      ).toLocaleString(),
                    })}
                  </Typography.Text>
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {t("settings.llmGateway.proxyModelInfo.notChecked", {
                    defaultValue:
                      "尚未检测模型 Deployments，点击“模型详情”查看负载均衡情况。",
                  })}
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
                      {t("settings.llmGateway.proxyLbTest.summary.title", {
                        defaultValue: "LB test",
                      })}
                      :{" "}
                      {statusProfileProxyLbTest.failed > 0
                        ? t("common.failed")
                        : t("common.success")}
                    </Tag>
                    <Tag>
                      {t("settings.llmGateway.proxyLbTest.summary.succeeded", {
                        defaultValue: "Succeeded",
                      })}
                      : {statusProfileProxyLbTest.succeeded}
                    </Tag>
                    <Tag
                      color={
                        statusProfileProxyLbTest.failed > 0 ? "red" : "default"
                      }
                    >
                      {t("settings.llmGateway.proxyLbTest.summary.failed", {
                        defaultValue: "Failed",
                      })}
                      : {statusProfileProxyLbTest.failed}
                    </Tag>
                    <Tag>
                      {t("settings.llmGateway.proxyLbTest.summary.modelIds", {
                        defaultValue: "Model IDs",
                      })}
                      : {statusProfileProxyLbTest.modelIds}
                    </Tag>
                    <Tag>
                      {t("settings.llmGateway.proxyLbTest.summary.apiBases", {
                        defaultValue: "API bases",
                      })}
                      : {statusProfileProxyLbTest.apiBases}
                    </Tag>
                    <Tag>
                      {t("settings.llmGateway.proxyLbTest.summary.duration", {
                        defaultValue: "Duration",
                      })}
                      : {statusProfileProxyLbTest.durationMs}ms
                    </Tag>
                  </Space>
                  <Typography.Text type="secondary">
                    {t("settings.llmGateway.proxyLbTest.checkedAt", {
                      defaultValue: "负载均衡测试时间：{{time}}",
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

        <Card
          size="small"
          title={t("settings.llmGateway.embeddingActive.title", {
            defaultValue: "Embeddings 网关",
          })}
        >
          <Space direction="vertical" size="small" style={{ display: "flex" }}>
            <Typography.Text type="secondary">
              {t("settings.llmGateway.embeddingActive.hint", {
                defaultValue:
                  "用于 Embeddings / 向量化请求（可与对话模型使用不同的网关和模型）。",
              })}
            </Typography.Text>

            <Typography.Text type="secondary">
              {t("settings.llmGateway.embeddingActive.currentCompletion", {
                defaultValue: "当前对话模型配置",
              })}
              :{" "}
              {completionActiveProfile ? (
                <Typography.Text>
                  {completionActiveProfile.name}{" "}
                  <Typography.Text code copyable>
                    {completionActiveProfile.model}
                  </Typography.Text>
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">-</Typography.Text>
              )}
            </Typography.Text>

            <Typography.Text type="secondary">
              {t("settings.llmGateway.embeddingActive.currentEmbedding", {
                defaultValue: "当前 Embeddings 配置",
              })}
              :{" "}
              {embeddingResolved.kind === "default" ? (
                <Space size={6} wrap>
                  <Typography.Text>
                    {t("settings.llmGateway.embeddingActive.default", {
                      defaultValue: "默认配置（config/env）",
                    })}
                  </Typography.Text>
                  <Tag>
                    {t("settings.llmGateway.embeddingActive.defaultTag", {
                      defaultValue: "默认",
                    })}
                  </Tag>
                </Space>
              ) : embeddingActiveProfile ? (
                <Space size={6} wrap>
                  <Typography.Text>
                    {embeddingActiveProfile.name}
                  </Typography.Text>
                  {settings.embeddingActiveId ? (
                    settings.embeddingActiveId === settings.activeId ? (
                      <Tag color="purple">
                        {t("settings.llmGateway.embeddingActive.lockedSame", {
                          defaultValue: "显式锁定（当前与对话一致）",
                        })}
                      </Tag>
                    ) : (
                      <Tag color="purple">
                        {t("settings.llmGateway.embeddingActive.independent", {
                          defaultValue: "独立配置",
                        })}
                      </Tag>
                    )
                  ) : completionActiveProfile ? (
                    <Tag>
                      {t("settings.llmGateway.embeddingActive.following", {
                        defaultValue: "跟随对话模型",
                      })}
                    </Tag>
                  ) : (
                    <Tag>
                      {t("settings.llmGateway.embeddingActive.default", {
                        defaultValue: "默认配置",
                      })}
                    </Tag>
                  )}
                  {embeddingActiveProfile.embeddingModel ? (
                    <Typography.Text code copyable>
                      {embeddingActiveProfile.embeddingModel}
                    </Typography.Text>
                  ) : embeddingResolved.kind === "follow_completion" ? (
                    <Tag>
                      {t(
                        "settings.llmGateway.embeddingActive.inheritEmbeddingModel",
                        {
                          defaultValue: "继承默认 Embedding 模型",
                        },
                      )}
                    </Tag>
                  ) : (
                    <Tag color="red">
                      {t(
                        "settings.llmGateway.embeddingActive.missingEmbeddingModel",
                        {
                          defaultValue: "未配置 Embedding 模型",
                        },
                      )}
                    </Tag>
                  )}
                </Space>
              ) : (
                <Typography.Text type="secondary">-</Typography.Text>
              )}
            </Typography.Text>

            <Form layout="inline" style={{ width: "100%" }}>
              <Form.Item
                label={t("settings.llmGateway.embeddingActive.selectLabel", {
                  defaultValue: "切换 Embeddings 网关",
                })}
                style={{ flex: 1, minWidth: 260 }}
              >
                <Select
                  value={embeddingSelectValue}
                  placeholder={t(
                    "settings.llmGateway.embeddingActive.selectPlaceholder",
                    {
                      defaultValue: "选择用于 Embeddings 的网关 Profile",
                    },
                  )}
                  loading={loading || embeddingActivating}
                  options={[
                    {
                      value: FOLLOW_COMPLETION_KEY,
                      label: (
                        <Space size={6} wrap>
                          <Typography.Text>
                            {completionActiveProfile
                              ? t(
                                  "settings.llmGateway.embeddingActive.followCompletion",
                                  {
                                    defaultValue: "跟随对话模型（{{name}}）",
                                    name: completionActiveProfile.name,
                                  },
                                )
                              : t(
                                  "settings.llmGateway.embeddingActive.followCompletionEmpty",
                                  {
                                    defaultValue: "跟随对话模型（当前未启用）",
                                  },
                                )}
                          </Typography.Text>
                          <Tag>
                            {t(
                              "settings.llmGateway.embeddingActive.followTag",
                              { defaultValue: "跟随" },
                            )}
                          </Tag>
                        </Space>
                      ),
                    },
                    {
                      value: USE_DEFAULT_KEY,
                      label: (
                        <Space size={6} wrap>
                          <Typography.Text>
                            {t(
                              "settings.llmGateway.embeddingActive.useDefault",
                              {
                                defaultValue: "使用默认配置（config/env）",
                              },
                            )}
                          </Typography.Text>
                          <Tag>
                            {t(
                              "settings.llmGateway.embeddingActive.defaultTag",
                              {
                                defaultValue: "默认",
                              },
                            )}
                          </Tag>
                        </Space>
                      ),
                    },
                    ...settings.profiles.map((profile) => ({
                      value: profile.id,
                      disabled: !profile.enabled || !profile.embeddingModel,
                      label: (
                        <Space size={6} wrap>
                          <Typography.Text>{profile.name}</Typography.Text>
                          {!profile.enabled ? (
                            <Tag color="red">{t("common.disabled")}</Tag>
                          ) : !profile.embeddingModel ? (
                            <Tag color="red">
                              {t(
                                "settings.llmGateway.embeddingActive.missingEmbeddingModelShort",
                                {
                                  defaultValue: "缺少 Embedding 模型",
                                },
                              )}
                            </Tag>
                          ) : (
                            <Tag color="purple">
                              {t("settings.llmGateway.embeddingActive.tag", {
                                defaultValue: "Embeddings",
                              })}
                            </Tag>
                          )}
                        </Space>
                      ),
                    })),
                  ]}
                  onChange={(value) => {
                    if (value === FOLLOW_COMPLETION_KEY) {
                      void handleActivateEmbedding(null, "follow_completion");
                      return;
                    }
                    if (value === USE_DEFAULT_KEY) {
                      void handleActivateEmbedding(null, "use_default");
                      return;
                    }
                    void handleActivateEmbedding(value);
                  }}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Form>

            {embeddingActiveProfile ? (
              <>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 0 }}
                >
                  {t("settings.llmGateway.fields.apiBase")}:{" "}
                  <Typography.Text code copyable>
                    {embeddingActiveProfile.apiBase}
                  </Typography.Text>
                </Typography.Paragraph>
                <Space wrap>
                  <Tag color={embeddingActiveProfile.enabled ? "green" : "red"}>
                    {embeddingActiveProfile.enabled
                      ? t("common.enabled")
                      : t("common.disabled")}
                  </Tag>
                  <Tag
                    color={
                      embeddingActiveProfile.hasApiKey ? "green" : "default"
                    }
                  >
                    {embeddingActiveProfile.hasApiKey
                      ? t("settings.llmGateway.keySet")
                      : t("settings.llmGateway.keyMissing")}
                  </Tag>
                </Space>
              </>
            ) : null}

            {!settings.profiles.some(
              (profile) => profile.enabled && profile.embeddingModel,
            ) ? (
              <Alert
                type="warning"
                showIcon
                message={t(
                  "settings.llmGateway.embeddingActive.noEligibleProfiles",
                  {
                    defaultValue:
                      "暂无可用的 Embeddings Profile：请先在某个 Profile 中填写 Embedding 模型并启用。",
                  },
                )}
              />
            ) : null}
          </Space>
        </Card>

        {errorMessage ? (
          <Alert type="error" showIcon message={errorMessage} />
        ) : null}

        <Space wrap>
          <Button type="primary" onClick={openCreate}>
            {t("settings.llmGateway.actions.new")}
          </Button>
          <Button onClick={() => void loadSettings()} loading={loading}>
            {t("common.refresh")}
          </Button>
        </Space>

        <Space wrap>
          <Space size={8}>
            <Switch
              checked={autoRecommendEnabled}
              onChange={handleAutoRecommendEnabledChange}
            />
            <Typography.Text>
              {t("settings.llmGateway.autoRecommend.fields.enabled", {
                defaultValue: "按场景自动推荐兼容模板",
              })}
            </Typography.Text>
          </Space>
          <Space size={8}>
            <Switch
              checked={autoRecommendNoticeEnabled}
              onChange={handleAutoRecommendNoticeEnabledChange}
              disabled={!autoRecommendEnabled}
            />
            <Typography.Text type="secondary">
              {t("settings.llmGateway.autoRecommend.fields.noticeEnabled", {
                defaultValue: "自动推荐后显示提示",
              })}
            </Typography.Text>
          </Space>
          <Button onClick={openRecommendationConfigModal}>
            {t("settings.llmGateway.autoRecommend.actions.editConfig", {
              defaultValue: "编辑推荐映射",
            })}
          </Button>
        </Space>

        <Table<LlmGatewayProfile>
          rowKey="id"
          size={screens.lg ? "middle" : "small"}
          loading={loading}
          dataSource={settings.profiles}
          columns={columns}
          pagination={false}
          locale={{ emptyText: t("common.empty") }}
        />
      </Space>

      <Modal
        title={t("settings.llmGateway.autoRecommend.modal.title", {
          defaultValue: "编辑自动推荐映射",
        })}
        open={recommendationConfigOpen}
        onCancel={() => setRecommendationConfigOpen(false)}
        width={screens.md ? 760 : "100%"}
        footer={[
          <Button
            key="cancel"
            onClick={() => setRecommendationConfigOpen(false)}
          >
            {t("common.cancel")}
          </Button>,
          <Button
            key="save"
            type="primary"
            onClick={() => recommendationConfigForm.submit()}
            loading={recommendationConfigSaving}
          >
            {t("common.save")}
          </Button>,
        ]}
      >
        <Form
          form={recommendationConfigForm}
          layout="vertical"
          onFinish={(values) => {
            void handleSaveRecommendationConfig(values);
          }}
        >
          <Form.Item
            label={t(
              "settings.llmGateway.autoRecommend.fields.defaultPresetKey",
              {
                defaultValue: "默认模板",
              },
            )}
            name="defaultPresetKey"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.autoRecommend.validation.defaultPresetKey",
                  {
                    defaultValue: "请选择默认模板",
                  },
                ),
              },
            ]}
          >
            <Select
              options={presets.map((preset) => ({
                value: preset.key,
                label: preset.label,
              }))}
            />
          </Form.Item>

          <Form.Item
            label={t(
              "settings.llmGateway.autoRecommend.fields.localGatewayHosts",
              {
                defaultValue: "本地网关域名",
              },
            )}
            name="localGatewayHosts"
            extra={t(
              "settings.llmGateway.autoRecommend.hints.localGatewayHosts",
              {
                defaultValue:
                  "这些域名会自动映射到 LiteLLM Local 模板（可输入多个）。",
              },
            )}
          >
            <Select
              mode="tags"
              open={false}
              tokenSeparators={[",", "\n"]}
              placeholder={t(
                "settings.llmGateway.autoRecommend.placeholders.localGatewayHosts",
                {
                  defaultValue: "例如 localhost, host.docker.internal",
                },
              )}
            />
          </Form.Item>

          <Typography.Text strong>
            {t("settings.llmGateway.autoRecommend.fields.domainRules", {
              defaultValue: "域名匹配规则",
            })}
          </Typography.Text>

          <Form.List name="domainRules">
            {(fields, { add, remove }) => (
              <Space
                direction="vertical"
                size="small"
                style={{ display: "flex", marginTop: 8 }}
              >
                {fields.map((field) => (
                  <Space
                    key={field.key}
                    align="start"
                    wrap
                    style={{ display: "flex" }}
                  >
                    <Form.Item
                      name={[field.name, "hostname"]}
                      rules={[
                        {
                          required: true,
                          message: t(
                            "settings.llmGateway.autoRecommend.validation.hostnameRequired",
                            {
                              defaultValue: "请输入域名",
                            },
                          ),
                        },
                        {
                          validator: (_: unknown, value: unknown) => {
                            if (typeof value !== "string") {
                              return Promise.reject(
                                new Error(
                                  t(
                                    "settings.llmGateway.autoRecommend.validation.hostnameRequired",
                                    {
                                      defaultValue: "请输入域名",
                                    },
                                  ),
                                ),
                              );
                            }
                            const trimmed = value.trim();
                            if (!trimmed || /\s/.test(trimmed)) {
                              return Promise.reject(
                                new Error(
                                  t(
                                    "settings.llmGateway.autoRecommend.validation.hostname",
                                    {
                                      defaultValue:
                                        "域名不能为空且不能包含空格",
                                    },
                                  ),
                                ),
                              );
                            }
                            return Promise.resolve();
                          },
                        },
                      ]}
                      style={{ minWidth: 280, flex: 1 }}
                    >
                      <Input
                        placeholder={t(
                          "settings.llmGateway.autoRecommend.placeholders.ruleHostname",
                          {
                            defaultValue: "例如 api.openai.com",
                          },
                        )}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "presetKey"]}
                      rules={[
                        {
                          required: true,
                          message: t(
                            "settings.llmGateway.autoRecommend.validation.presetKey",
                            {
                              defaultValue: "请选择模板",
                            },
                          ),
                        },
                      ]}
                      style={{ minWidth: 240 }}
                    >
                      <Select
                        options={presets.map((preset) => ({
                          value: preset.key,
                          label: preset.label,
                        }))}
                      />
                    </Form.Item>
                    <Button danger onClick={() => remove(field.name)}>
                      {t("common.delete")}
                    </Button>
                  </Space>
                ))}
                <Button
                  onClick={() =>
                    add({
                      hostname: "",
                      presetKey: "externalConservative",
                    })
                  }
                >
                  {t("settings.llmGateway.autoRecommend.actions.addRule", {
                    defaultValue: "新增规则",
                  })}
                </Button>
              </Space>
            )}
          </Form.List>

          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: 12, marginBottom: 0 }}
          >
            {t("settings.llmGateway.autoRecommend.hints.domainRules", {
              defaultValue:
                "按顺序匹配 hostname；未命中规则时使用默认模板。保存后会即时生效。",
            })}
          </Typography.Paragraph>
        </Form>
      </Modal>

      <Modal
        title={t("settings.llmGateway.modal.createTitle")}
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          setCreateInitialApiBase("");
        }}
        width={screens.md ? 720 : "100%"}
        footer={[
          <Button
            key="test"
            onClick={() => void testUnsavedConfig("create")}
            loading={testing === DRAFT_CREATE_KEY}
          >
            {t("settings.llmGateway.actions.testUnsaved")}
          </Button>,
          <Button
            key="models"
            onClick={() => void listModelsUnsavedConfig("create")}
            loading={loadingModels === DRAFT_CREATE_KEY}
          >
            {t("settings.llmGateway.actions.models")}
          </Button>,
          <Button
            key="cancel"
            onClick={() => {
              setCreateOpen(false);
              setCreateInitialApiBase("");
            }}
          >
            {t("common.cancel")}
          </Button>,
          <Button
            key="submit"
            type="primary"
            onClick={() => createForm.submit()}
            loading={saving}
          >
            {t("common.submit")}
          </Button>,
        ]}
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item
            label={t("settings.llmGateway.fields.preset")}
            name="preset"
          >
            <Select
              allowClear
              placeholder={t("settings.llmGateway.placeholders.preset")}
              options={presets.map((preset) => ({
                value: preset.key,
                label: preset.label,
              }))}
              onChange={(value) => applyPreset(createForm, value)}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.name")}
            name="name"
            rules={[
              {
                required: true,
                message: t(
                  "settings.llmGateway.autoRecommend.validation.presetKey",
                  {
                    defaultValue: "请选择模板",
                  },
                ),
              },
            ]}
          >
            <Input placeholder={t("settings.llmGateway.placeholders.name")} />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiBase")}
            name="apiBase"
            extra={t("settings.llmGateway.hints.apiBase")}
            rules={apiBaseRules}
          >
            <Input
              placeholder={DEFAULT_LLM_GATEWAY_API_BASE}
              onBlur={() => applyApiBaseRecommendation(createForm, "create")}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiKey")}
            name="apiKey"
            extra={t("settings.llmGateway.hints.apiKey")}
          >
            <Input.Password
              placeholder={t("settings.llmGateway.placeholders.apiKey")}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.model")}
            name="model"
            extra={t("settings.llmGateway.hints.modelOptional", {
              defaultValue:
                "可选：仅用于对话/补全请求；只配置 Embeddings 网关时可以留空。",
            })}
          >
            <Input allowClear placeholder="openai/gpt-4o-mini" />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.assistantModel", {
              defaultValue: "Assistant model",
            })}
            name="assistantModel"
            extra={t("settings.llmGateway.hints.assistantModel", {
              defaultValue:
                "Optional: used only by AI Assistant (/assistant), and does not affect news pipeline model routing.",
            })}
          >
            <Input allowClear placeholder="openai/gpt-4.1-mini" />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.embeddingModel")}
            name="embeddingModel"
          >
            <Input placeholder="openai/text-embedding-3-small" />
          </Form.Item>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.timeoutMs")}
              name="timeoutMs"
              rules={[
                {
                  required: true,
                  message: t("settings.llmGateway.validation.timeoutRequired"),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={1_000}
                max={900_000}
                step={1_000}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxRetries")}
              name="maxRetries"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.llmGateway.validation.maxRetriesRequired",
                  ),
                },
              ]}
              style={{ minWidth: 160, flex: 1 }}
            >
              <InputNumber
                min={1}
                max={20}
                step={1}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.requestsPerMinute")}
              name="requestsPerMinute"
              rules={[
                {
                  required: true,
                  message: t("settings.llmGateway.validation.rpmRequired"),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={1}
                max={100_000}
                step={1}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Space>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.temperature")}
              name="temperature"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.llmGateway.validation.temperatureRequired",
                  ),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={0}
                max={2}
                step={0.1}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.topP")}
              name="topP"
              rules={[
                {
                  required: true,
                  message: t("settings.llmGateway.validation.topPRequired"),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={0}
                max={1}
                step={0.05}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxOutputTokens")}
              name="maxOutputTokens"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.llmGateway.validation.maxOutputTokensRequired",
                  ),
                },
              ]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber
                min={1}
                max={MAX_LLM_GATEWAY_OUTPUT_TOKENS}
                step={50}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Space>

          <Form.Item
            label={t("settings.llmGateway.fields.fallbackModels")}
            name="fallbackModels"
            extra={t("settings.llmGateway.hints.fallbackModels")}
          >
            <Input
              placeholder={t("settings.llmGateway.placeholders.fallbackModels")}
            />
          </Form.Item>

          <Form.Item
            label={
              <span>
                {t("settings.llmGateway.fields.responseFormatMode", {
                  defaultValue: "response_format mode",
                })}
                <Tooltip
                  title={t("settings.llmGateway.tooltips.responseFormatMode", {
                    defaultValue:
                      "json_schema: 发送完整 JSON Schema 结构，支持结构化输出（OpenAI/Claude等）。json_object: 仅要求返回 JSON，不指定结构（Gemini等）。none: 不发送 response_format（兼容旧模型）。",
                  })}
                >
                  <QuestionCircleOutlined
                    style={{ marginLeft: 8, color: "#999" }}
                  />
                </Tooltip>
              </span>
            }
            name="responseFormatMode"
            extra={t("settings.llmGateway.hints.responseFormatMode", {
              defaultValue:
                "Controls runtime response_format strategy: json_schema, json_object, or none.",
            })}
          >
            <Select
              options={[
                { label: "json_schema", value: "json_schema" },
                { label: "json_object", value: "json_object" },
                { label: "none", value: "none" },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="sendMetadata"
            valuePropName="checked"
            label={
              <span>
                {t("settings.llmGateway.fields.sendMetadata", {
                  defaultValue: "Send metadata",
                })}
                <Tooltip
                  title={t("settings.llmGateway.tooltips.sendMetadata", {
                    defaultValue:
                      "开启时，请求会携带 metadata 字段用于追踪（适合 LiteLLM Proxy）。关闭后，请求将不包含 metadata（提高与 OpenAI/Gemini 等直连的兼容性）。",
                  })}
                >
                  <QuestionCircleOutlined
                    style={{ marginLeft: 8, color: "#999" }}
                  />
                </Tooltip>
              </span>
            }
            extra={t("settings.llmGateway.hints.sendMetadata", {
              defaultValue:
                "When disabled, metadata will be omitted from upstream requests.",
            })}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="enabled"
            valuePropName="checked"
            label={t("settings.llmGateway.fields.enabled")}
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t("settings.llmGateway.modal.editTitle")}
        open={Boolean(editing)}
        onCancel={() => {
          setEditing(null);
          setEditInitialApiBase("");
        }}
        width={screens.md ? 720 : "100%"}
        footer={[
          <Button
            key="test"
            onClick={() => void testUnsavedConfig("edit")}
            disabled={!editing}
            loading={testing === DRAFT_EDIT_KEY}
          >
            {t("settings.llmGateway.actions.testUnsaved")}
          </Button>,
          <Button
            key="models"
            onClick={() => void listModelsUnsavedConfig("edit")}
            disabled={!editing}
            loading={loadingModels === DRAFT_EDIT_KEY}
          >
            {t("settings.llmGateway.actions.models")}
          </Button>,
          <Button
            key="cancel"
            onClick={() => {
              setEditing(null);
              setEditInitialApiBase("");
            }}
          >
            {t("common.cancel")}
          </Button>,
          <Button
            key="save"
            type="primary"
            onClick={() => editForm.submit()}
            loading={saving}
          >
            {t("common.save")}
          </Button>,
        ]}
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdate}>
          <Form.Item
            label={t("settings.llmGateway.fields.preset")}
            name="preset"
          >
            <Select
              allowClear
              placeholder={t("settings.llmGateway.placeholders.preset")}
              options={presets.map((preset) => ({
                value: preset.key,
                label: preset.label,
              }))}
              onChange={(value) => applyPreset(editForm, value)}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.name")}
            name="name"
            rules={[
              {
                required: true,
                message: t("settings.llmGateway.validation.nameRequired"),
              },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiBase")}
            name="apiBase"
            extra={t("settings.llmGateway.hints.apiBase")}
            rules={apiBaseRules}
          >
            <Input
              onBlur={() => applyApiBaseRecommendation(editForm, "edit")}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.apiKey")}
            name="apiKey"
            extra={t("settings.llmGateway.hints.apiKeyEdit")}
          >
            <Input.Password
              placeholder={t("settings.llmGateway.placeholders.apiKeyEdit")}
              disabled={Boolean(editClearApiKey)}
            />
          </Form.Item>
          <Form.Item name="clearApiKey" valuePropName="checked">
            <Switch
              checkedChildren={t("settings.llmGateway.actions.clearKey")}
              unCheckedChildren={t("settings.llmGateway.actions.keepKey")}
              onChange={(checked) => {
                if (checked) {
                  editForm.setFieldsValue({ apiKey: "" });
                }
              }}
            />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.model")}
            name="model"
            extra={t("settings.llmGateway.hints.modelOptional", {
              defaultValue:
                "可选：仅用于对话/补全请求；只配置 Embeddings 网关时可以留空。",
            })}
          >
            <Input allowClear />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.assistantModel", {
              defaultValue: "Assistant model",
            })}
            name="assistantModel"
            extra={t("settings.llmGateway.hints.assistantModel", {
              defaultValue:
                "Optional: used only by AI Assistant (/assistant), and does not affect news pipeline model routing.",
            })}
          >
            <Input allowClear />
          </Form.Item>
          <Form.Item
            label={t("settings.llmGateway.fields.embeddingModel")}
            name="embeddingModel"
          >
            <Input allowClear />
          </Form.Item>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.timeoutMs")}
              name="timeoutMs"
              rules={[
                {
                  required: true,
                  message: t("settings.llmGateway.validation.timeoutRequired"),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={1_000}
                max={900_000}
                step={1_000}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxRetries")}
              name="maxRetries"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.llmGateway.validation.maxRetriesRequired",
                  ),
                },
              ]}
              style={{ minWidth: 160, flex: 1 }}
            >
              <InputNumber
                min={1}
                max={20}
                step={1}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.requestsPerMinute")}
              name="requestsPerMinute"
              rules={[
                {
                  required: true,
                  message: t("settings.llmGateway.validation.rpmRequired"),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={1}
                max={100_000}
                step={1}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Space>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.fields.temperature")}
              name="temperature"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.llmGateway.validation.temperatureRequired",
                  ),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={0}
                max={2}
                step={0.1}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.topP")}
              name="topP"
              rules={[
                {
                  required: true,
                  message: t("settings.llmGateway.validation.topPRequired"),
                },
              ]}
              style={{ minWidth: 200, flex: 1 }}
            >
              <InputNumber
                min={0}
                max={1}
                step={0.05}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.llmGateway.fields.maxOutputTokens")}
              name="maxOutputTokens"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.llmGateway.validation.maxOutputTokensRequired",
                  ),
                },
              ]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber
                min={1}
                max={MAX_LLM_GATEWAY_OUTPUT_TOKENS}
                step={50}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Space>

          <Form.Item
            label={t("settings.llmGateway.fields.fallbackModels")}
            name="fallbackModels"
            extra={t("settings.llmGateway.hints.fallbackModels")}
          >
            <Input />
          </Form.Item>

          <Form.Item
            label={
              <span>
                {t("settings.llmGateway.fields.responseFormatMode", {
                  defaultValue: "response_format mode",
                })}
                <Tooltip
                  title={t("settings.llmGateway.tooltips.responseFormatMode", {
                    defaultValue:
                      "json_schema: 发送完整 JSON Schema 结构，支持结构化输出（OpenAI/Claude等）。json_object: 仅要求返回 JSON，不指定结构（Gemini等）。none: 不发送 response_format（兼容旧模型）。",
                  })}
                >
                  <QuestionCircleOutlined
                    style={{ marginLeft: 8, color: "#999" }}
                  />
                </Tooltip>
              </span>
            }
            name="responseFormatMode"
            extra={t("settings.llmGateway.hints.responseFormatMode", {
              defaultValue:
                "Controls runtime response_format strategy: json_schema, json_object, or none.",
            })}
          >
            <Select
              options={[
                { label: "json_schema", value: "json_schema" },
                { label: "json_object", value: "json_object" },
                { label: "none", value: "none" },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="sendMetadata"
            valuePropName="checked"
            label={
              <span>
                {t("settings.llmGateway.fields.sendMetadata", {
                  defaultValue: "Send metadata",
                })}
                <Tooltip
                  title={t("settings.llmGateway.tooltips.sendMetadata", {
                    defaultValue:
                      "开启时，请求会携带 metadata 字段用于追踪（适合 LiteLLM Proxy）。关闭后，请求将不包含 metadata（提高与 OpenAI/Gemini 等直连的兼容性）。",
                  })}
                >
                  <QuestionCircleOutlined
                    style={{ marginLeft: 8, color: "#999" }}
                  />
                </Tooltip>
              </span>
            }
            extra={t("settings.llmGateway.hints.sendMetadata", {
              defaultValue:
                "When disabled, metadata will be omitted from upstream requests.",
            })}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="enabled"
            valuePropName="checked"
            label={t("settings.llmGateway.fields.enabled")}
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          testProfile
            ? t("settings.llmGateway.test.modal.title", {
                name: testProfile.name,
              })
            : undefined
        }
        open={Boolean(testProfile)}
        onCancel={closeTest}
        width={screens.md ? 720 : "100%"}
        footer={[
          <Button
            key="models"
            onClick={() => {
              if (testProfile) {
                void handleListModels(testProfile);
              }
            }}
            disabled={!testProfile}
            loading={testProfile ? loadingModels === testProfile.id : false}
          >
            {t("settings.llmGateway.actions.models")}
          </Button>,
          <Button
            key="recommended-retest"
            onClick={() => {
              if (!testProfile || !testProfileRecommendation) {
                return;
              }
              const nextValues: LlmGatewayTestFormValues = {
                ...testForm.getFieldsValue(),
                responseFormatMode:
                  testProfileRecommendation.preset.responseFormatMode,
                includeMetadataProbe:
                  testProfileRecommendation.preset.sendMetadata,
              };
              testForm.setFieldsValue({
                responseFormatMode:
                  testProfileRecommendation.preset.responseFormatMode,
                includeMetadataProbe:
                  testProfileRecommendation.preset.sendMetadata,
              });
              messageApi.info(
                t(
                  "settings.llmGateway.messages.recommendedTestStrategyApplied",
                  {
                    defaultValue:
                      "Applied recommended strategy for {{domain}}: {{name}}",
                    domain: testProfileRecommendation.detected.hostname,
                    name: testProfileRecommendation.preset.label,
                  },
                ),
              );
              void runTest(testProfile.id, nextValues);
            }}
            disabled={!testProfileRecommendation}
            loading={testProfile ? testing === testProfile.id : false}
          >
            {t("settings.llmGateway.test.actions.applyRecommendedAndRun", {
              defaultValue: "按推荐策略重测",
            })}
          </Button>,
          <Button key="close" onClick={closeTest}>
            {t("common.close")}
          </Button>,
          <Button
            key="run"
            type="primary"
            onClick={() => testForm.submit()}
            disabled={!testProfile}
            loading={testProfile ? testing === testProfile.id : false}
          >
            {t("settings.llmGateway.test.actions.run")}
          </Button>,
        ]}
      >
        <Form
          form={testForm}
          layout="vertical"
          onFinish={(values) => {
            if (!testProfile) {
              return;
            }
            void runTest(testProfile.id, values);
          }}
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            {t("settings.llmGateway.fields.apiBase")}:{" "}
            <Typography.Text code copyable>
              {testProfile?.apiBase ?? "-"}
            </Typography.Text>
          </Typography.Paragraph>

          {testProfileRecommendation ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {t("settings.llmGateway.test.hints.recommendedStrategy", {
                defaultValue:
                  "Detected domain {{domain}}, recommended template: {{name}}",
                domain: testProfileRecommendation.detected.hostname,
                name: testProfileRecommendation.preset.label,
              })}
            </Typography.Paragraph>
          ) : null}

          <Form.Item
            label={t("settings.llmGateway.test.fields.includeCompletion", {
              defaultValue: "测试对话/补全",
            })}
            name="includeCompletion"
            valuePropName="checked"
            extra={t("settings.llmGateway.test.hints.includeCompletion", {
              defaultValue: "关闭后仅测试 Embeddings。",
            })}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.model")}
            name="model"
            extra={t("settings.llmGateway.test.hints.model")}
          >
            <Input
              allowClear
              disabled={!includeCompletion}
              placeholder={testProfile?.model ?? ""}
            />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.prompt")}
            name="prompt"
          >
            <Input.TextArea
              placeholder={t("settings.llmGateway.test.placeholders.prompt")}
              autoSize={{ minRows: 2, maxRows: 6 }}
              disabled={!includeCompletion}
            />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.apiSurface", {
              defaultValue: "API Surface",
            })}
            name="apiSurface"
          >
            <Select
              options={[
                { label: "chat_completions", value: "chat_completions" },
                { label: "responses", value: "responses" },
              ]}
              disabled={!includeCompletion}
            />
          </Form.Item>

          <Form.Item
            label={
              <span>
                {t("settings.llmGateway.test.fields.responseFormatMode", {
                  defaultValue: "response_format probe",
                })}
                <Tooltip
                  title={t("settings.llmGateway.tooltips.responseFormatMode", {
                    defaultValue:
                      "json_schema: 发送完整 JSON Schema 结构，支持结构化输出（OpenAI/Claude等）。json_object: 仅要求返回 JSON，不指定结构（Gemini等）。none: 不发送 response_format（兼容旧模型）。",
                  })}
                >
                  <QuestionCircleOutlined
                    style={{ marginLeft: 8, color: "#999" }}
                  />
                </Tooltip>
              </span>
            }
            name="responseFormatMode"
          >
            <Select
              options={[
                { label: "none", value: "none" },
                { label: "json_object", value: "json_object" },
                { label: "json_schema", value: "json_schema" },
              ]}
              disabled={!includeCompletion}
            />
          </Form.Item>

          <Form.Item
            label={
              <span>
                {t("settings.llmGateway.test.fields.includeMetadataProbe", {
                  defaultValue: "Include metadata probe",
                })}
                <Tooltip
                  title={t("settings.llmGateway.tooltips.sendMetadata", {
                    defaultValue:
                      "开启时，请求会携带 metadata 字段用于追踪（适合 LiteLLM Proxy）。关闭后，请求将不包含 metadata（提高与 OpenAI/Gemini 等直连的兼容性）。",
                  })}
                >
                  <QuestionCircleOutlined
                    style={{ marginLeft: 8, color: "#999" }}
                  />
                </Tooltip>
              </span>
            }
            name="includeMetadataProbe"
            valuePropName="checked"
          >
            <Switch disabled={!includeCompletion} />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.includeEmbeddings")}
            name="includeEmbeddings"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.embeddingModel")}
            name="embeddingModel"
            extra={t("settings.llmGateway.test.hints.embeddingModel")}
          >
            <Input
              allowClear
              disabled={!includeEmbeddings}
              placeholder={testProfile?.embeddingModel ?? ""}
            />
          </Form.Item>

          <Form.Item
            label={t("settings.llmGateway.test.fields.embeddingInput")}
            name="embeddingInput"
          >
            <Input
              disabled={!includeEmbeddings}
              placeholder={t(
                "settings.llmGateway.test.placeholders.embeddingInput",
              )}
            />
          </Form.Item>
        </Form>

        {testErrorMessage ? (
          <Alert
            type="error"
            showIcon
            message={testErrorMessage}
            style={{ marginTop: 12 }}
          />
        ) : null}

        {testResult ? (
          <div style={{ marginTop: 12 }}>{renderTestResult(testResult)}</div>
        ) : null}
      </Modal>

      <Modal
        title={
          proxyLbTestProfile
            ? t("settings.llmGateway.proxyLbTest.modal.title", {
                defaultValue: "LiteLLM Proxy 负载均衡测试：{{name}}",
                name: proxyLbTestProfile.name,
              })
            : undefined
        }
        open={Boolean(proxyLbTestProfile)}
        onCancel={closeProxyLbTest}
        width={screens.md ? 720 : "100%"}
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
            {t("settings.llmGateway.proxyLbTest.actions.run", {
              defaultValue: "运行测试",
            })}
          </Button>,
        ]}
      >
        <Form
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
            label={t("settings.llmGateway.proxyLbTest.fields.model", {
              defaultValue: "模型覆盖",
            })}
            name="model"
            extra={t("settings.llmGateway.proxyLbTest.hints.model", {
              defaultValue: "留空则使用 Profile 的默认模型。",
            })}
          >
            <Input allowClear placeholder={proxyLbTestProfile?.model ?? ""} />
          </Form.Item>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("settings.llmGateway.proxyLbTest.fields.attempts", {
                defaultValue: "请求次数",
              })}
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
              label={t("settings.llmGateway.proxyLbTest.fields.concurrency", {
                defaultValue: "并发",
              })}
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
            label={t("settings.llmGateway.proxyLbTest.fields.prompt", {
              defaultValue: "Prompt",
            })}
            name="prompt"
            extra={t("settings.llmGateway.proxyLbTest.hints.prompt", {
              defaultValue: '留空会使用默认的 "Say \\"OK\\" and nothing else."',
            })}
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
            {renderProxyLbTestResult(proxyLbTestResult)}
          </div>
        ) : null}
      </Modal>

      <Modal
        title={t("settings.llmGateway.proxyLoadBalancing.modal.title", {
          defaultValue: "LiteLLM Proxy 负载均衡配置",
        })}
        open={proxyLbOpen}
        onCancel={() => {
          setProxyLbOpen(false);
          setProxyLbErrorMessage(null);
        }}
        width={screens.md ? 720 : "100%"}
        footer={[
          <Button key="close" onClick={() => setProxyLbOpen(false)}>
            {t("common.close")}
          </Button>,
          <Button
            key="refresh"
            onClick={() => void loadProxyLbSettings()}
            loading={proxyLbLoading}
          >
            {t("common.refresh", { defaultValue: "刷新" })}
          </Button>,
          <Button
            key="reset"
            danger
            onClick={resetProxyLbSettings}
            loading={proxyLbResetting}
            disabled={proxyLbSaving}
          >
            {t("common.reset", { defaultValue: "重置" })}
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
              {t("settings.llmGateway.proxyLoadBalancing.hint", {
                defaultValue:
                  "Store load-balancing settings in MySQL. Restart the litellm service after saving to apply changes.",
              })}
            </Typography.Text>

            {proxyLbSettings ? (
              <Alert
                type={proxyLbSettings.enabled ? "success" : "warning"}
                showIcon
                message={
                  proxyLbSettings.enabled
                    ? t(
                        "settings.llmGateway.proxyLoadBalancing.status.enabled",
                        {
                          defaultValue: "DB-managed load balancing enabled",
                        },
                      )
                    : t(
                        "settings.llmGateway.proxyLoadBalancing.status.disabled",
                        {
                          defaultValue: "DB-managed load balancing disabled",
                        },
                      )
                }
                description={
                  <Space wrap>
                    <Tag>
                      {t(
                        "settings.llmGateway.proxyLoadBalancing.status.openaiKeys",
                        {
                          defaultValue: "OpenAI keys: {{count}}",
                          count: proxyLbSettings.openai.keysCount,
                        },
                      )}
                    </Tag>
                    <Tag>
                      {t(
                        "settings.llmGateway.proxyLoadBalancing.status.anthropicKeys",
                        {
                          defaultValue: "Anthropic keys: {{count}}",
                          count: proxyLbSettings.anthropicKeysCount,
                        },
                      )}
                    </Tag>
                    {proxyLbSettings.openai.restartRequired ? (
                      <Tag color="orange">
                        {t(
                          "settings.llmGateway.proxyLoadBalancing.status.restartRequired",
                          {
                            defaultValue: "Restart required",
                          },
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
                      {
                        defaultValue: "Enable DB load balancing",
                      },
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.enabled",
                        {
                          defaultValue:
                            "When enabled, LiteLLM startup reads and applies load-balancing settings from MySQL.",
                        },
                      )}
                    >
                      <QuestionCircleOutlined
                        style={{ marginLeft: 8, color: "#999" }}
                      />
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
                      {
                        defaultValue: "OPENAI_API_KEYS",
                      },
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.openaiKeys",
                        {
                          defaultValue:
                            "OpenAI upstream keys stored in MySQL. Leave empty to keep existing keys. Inputting values replaces the stored list.",
                        },
                      )}
                    >
                      <QuestionCircleOutlined
                        style={{ marginLeft: 8, color: "#999" }}
                      />
                    </Tooltip>
                  </span>
                }
                name="openaiKeys"
                extra={t(
                  "settings.llmGateway.proxyLoadBalancing.hints.openaiKeys",
                  {
                    defaultValue:
                      "Comma/newline separated. Leave empty to keep existing OpenAI keys. Manage fingerprints in Assistant Safety panel.",
                  },
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
                      {
                        defaultValue: "ANTHROPIC_API_KEYS",
                      },
                    )}
                    <Tooltip
                      title={t(
                        "settings.llmGateway.proxyLoadBalancing.tooltips.anthropicKeys",
                        {
                          defaultValue:
                            "Anthropic upstream keys stored in MySQL. Input values to replace. Use clear switch below to remove all stored Anthropic keys.",
                        },
                      )}
                    >
                      <QuestionCircleOutlined
                        style={{ marginLeft: 8, color: "#999" }}
                      />
                    </Tooltip>
                  </span>
                }
                name="anthropicKeys"
                extra={t(
                  "settings.llmGateway.proxyLoadBalancing.hints.anthropicKeys",
                  {
                    defaultValue:
                      "Comma/newline separated. Leave empty to keep current Anthropic keys.",
                  },
                )}
              >
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
              </Form.Item>

              <Form.Item
                name="clearAnthropicKeys"
                valuePropName="checked"
                label={t(
                  "settings.llmGateway.proxyLoadBalancing.fields.clearAnthropicKeys",
                  {
                    defaultValue: "Clear stored Anthropic keys",
                  },
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
                        {
                          defaultValue: "routing_strategy",
                        },
                      )}
                      <Tooltip
                        title={t(
                          "settings.llmGateway.proxyLoadBalancing.tooltips.routingStrategy",
                          {
                            defaultValue:
                              "simple-shuffle randomizes deployments. least-busy prefers lower in-flight load. usage-based-routing balances by token usage. latency-based-routing prefers lower-latency deployments.",
                          },
                        )}
                      >
                        <QuestionCircleOutlined
                          style={{ marginLeft: 8, color: "#999" }}
                        />
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
                        {
                          defaultValue: "LITELLM_DEPLOYMENT_RPM",
                        },
                      )}
                      <Tooltip
                        title={t(
                          "settings.llmGateway.proxyLoadBalancing.tooltips.deploymentRpm",
                          {
                            defaultValue:
                              "Default per-deployment RPM injected into generated config when deployment-level rpm is not set.",
                          },
                        )}
                      >
                        <QuestionCircleOutlined
                          style={{ marginLeft: 8, color: "#999" }}
                        />
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
                        {
                          defaultValue: "LITELLM_DEPLOYMENT_TPM",
                        },
                      )}
                      <Tooltip
                        title={t(
                          "settings.llmGateway.proxyLoadBalancing.tooltips.deploymentTpm",
                          {
                            defaultValue:
                              "Default per-deployment TPM injected into generated config when deployment-level tpm is not set.",
                          },
                        )}
                      >
                        <QuestionCircleOutlined
                          style={{ marginLeft: 8, color: "#999" }}
                        />
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
                        {
                          defaultValue: "LITELLM_REDIS_HOST",
                        },
                      )}
                      <Tooltip
                        title={t(
                          "settings.llmGateway.proxyLoadBalancing.tooltips.redisHost",
                          {
                            defaultValue:
                              "Redis host used by LiteLLM router to share runtime state across workers/instances.",
                          },
                        )}
                      >
                        <QuestionCircleOutlined
                          style={{ marginLeft: 8, color: "#999" }}
                        />
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
                        {
                          defaultValue: "Redis host is required",
                        },
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
                        {
                          defaultValue: "LITELLM_REDIS_PORT",
                        },
                      )}
                      <Tooltip
                        title={t(
                          "settings.llmGateway.proxyLoadBalancing.tooltips.redisPort",
                          {
                            defaultValue:
                              "Redis TCP port used by LiteLLM router.",
                          },
                        )}
                      >
                        <QuestionCircleOutlined
                          style={{ marginLeft: 8, color: "#999" }}
                        />
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
                        {
                          defaultValue: "LITELLM_REDIS_PASSWORD",
                        },
                      )}
                      <Tooltip
                        title={t(
                          "settings.llmGateway.proxyLoadBalancing.tooltips.redisPassword",
                          {
                            defaultValue:
                              "Redis password stored in MySQL. Leave empty to clear or keep unchanged depending on current value and your save action.",
                          },
                        )}
                      >
                        <QuestionCircleOutlined
                          style={{ marginLeft: 8, color: "#999" }}
                        />
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
