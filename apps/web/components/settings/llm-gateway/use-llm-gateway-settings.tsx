"use client";

import {
  Form,
  Grid,
  Modal,
  Space,
  Typography,
  message,
  theme,
} from "antd";
import type { FormInstance, Rule } from "antd/es/form";
import type { MessageInstance } from "antd/es/message/interface";
import type { GlobalToken } from "antd/es/theme/interface";
import type { TFunction } from "i18next";
import { useSession } from "next-auth/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

import {
  openLlmGatewayModelsModal,
  openLlmGatewayProxyModelInfoModal,
} from "./llm-gateway-models-modals";
import { LlmGatewayTestResult } from "./llm-gateway-test-result";
import {
  formatApiErrorMessage,
  resolveDefaultGatewayProfile,
  toFallbackModels,
  toFallbackModelsText,
  toRerankDocuments,
} from "./llm-gateway.formatters";
import {
  DEFAULT_LLM_GATEWAY_API_BASE,
  DRAFT_CREATE_KEY,
  DRAFT_EDIT_KEY,
  EMPTY_SETTINGS,
  FOLLOW_COMPLETION_KEY,
  USE_DEFAULT_KEY,
} from "./llm-gateway.types";
import type {
  LlmGatewayApiSurface,
  LlmGatewayEmbeddingMode,
  LlmGatewayFormValues,
  LlmGatewayModelsResponse,
  LlmGatewayModelsSnapshot,
  LlmGatewayProfile,
  LlmGatewayProxyHealthResponse,
  LlmGatewayProxyModelInfoResponse,
  LlmGatewayProxyModelInfoSnapshot,
  LlmGatewayRerankMode,
  LlmGatewaySettingsResponse,
  LlmGatewayTestFormValues,
  LlmGatewayTestResponse,
} from "./llm-gateway.types";

type ApiClient = ReturnType<typeof createApiClient>;

export interface LlmGatewaySettingsController {
  t: TFunction;
  token: GlobalToken;
  helpIconStyle: CSSProperties;
  contextHolder: ReturnType<typeof message.useMessage>[1];
  messageApi: MessageInstance;
  apiClient: ApiClient;
  screens: ReturnType<typeof Grid.useBreakpoint>;
  settings: LlmGatewaySettingsResponse;
  setSettings: (value: LlmGatewaySettingsResponse) => void;
  loading: boolean;
  saving: boolean;
  toggling: string | null;
  activatingProfileId: string | null;
  embeddingActivating: boolean;
  rerankActivating: boolean;
  testing: string | null;
  loadingModels: string | null;
  loadingProxyModelInfo: string | null;
  checkingProxyHealth: string | null;
  proxyHealthProfileId: string | null;
  proxyHealth: LlmGatewayProxyHealthResponse | null;
  proxyHealthErrorMessage: string | null;
  proxyModelInfoSnapshot: LlmGatewayProxyModelInfoSnapshot | null;
  modelsSnapshot: LlmGatewayModelsSnapshot | null;
  errorMessage: string | null;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  editing: LlmGatewayProfile | null;
  setEditing: (profile: LlmGatewayProfile | null) => void;
  createForm: FormInstance<LlmGatewayFormValues>;
  editForm: FormInstance<LlmGatewayFormValues>;
  testProfile: LlmGatewayProfile | null;
  testResult: LlmGatewayTestResponse | null;
  testErrorMessage: string | null;
  testForm: FormInstance<LlmGatewayTestFormValues>;
  includeCompletion: boolean;
  includeEmbeddings: boolean;
  includeRerank: boolean;
  createApiSurface: LlmGatewayApiSurface;
  createAssistantWebSearchEnabled: boolean;
  editApiSurface: LlmGatewayApiSurface;
  editAssistantWebSearchEnabled: boolean;
  editClearApiKey: boolean;
  createAssistantWebSearchDisabled: boolean;
  editAssistantWebSearchDisabled: boolean;
  resolvedCompletionProfile: LlmGatewayProfile | null;
  completionActiveProfile: LlmGatewayProfile | null;
  embeddingResolved:
    | { kind: "profile"; id: string }
    | { kind: "default" }
    | { kind: "follow_completion"; id: string };
  embeddingSelectValue: string;
  embeddingActiveProfile: LlmGatewayProfile | null;
  resolvedEmbeddingProfile: LlmGatewayProfile | null;
  rerankResolved:
    | { kind: "profile"; id: string }
    | { kind: "default" }
    | { kind: "follow_completion"; id: string };
  rerankSelectValue: string;
  rerankActiveProfile: LlmGatewayProfile | null;
  resolvedRerankProfile: LlmGatewayProfile | null;
  apiBaseRules: Rule[];
  loadSettings: () => Promise<void>;
  openCreate: () => void;
  handleCreate: (values: LlmGatewayFormValues) => Promise<void>;
  handleUpdate: (values: LlmGatewayFormValues) => Promise<void>;
  handleToggle: (
    profile: LlmGatewayProfile,
    nextEnabled: boolean,
  ) => Promise<void>;
  handleActivate: (profileId: string) => Promise<void>;
  handleActivateEmbedding: (
    profileId: string | null,
    mode?: LlmGatewayEmbeddingMode,
  ) => Promise<void>;
  handleActivateRerank: (
    profileId: string | null,
    mode?: LlmGatewayRerankMode,
  ) => Promise<void>;
  handleDelete: (profile: LlmGatewayProfile) => Promise<void>;
  handleCheckProxyHealth: (profile: LlmGatewayProfile) => Promise<void>;
  handleProxyModelInfo: (profile: LlmGatewayProfile) => Promise<void>;
  handleListModels: (profile: LlmGatewayProfile) => Promise<void>;
  testUnsavedConfig: (source: "create" | "edit") => Promise<void>;
  listModelsUnsavedConfig: (source: "create" | "edit") => Promise<void>;
  closeTest: () => void;
  runTest: (
    profileId: string,
    values: LlmGatewayTestFormValues,
  ) => Promise<void>;
  openTest: (profile: LlmGatewayProfile) => void;
  renderTestResult: (result: LlmGatewayTestResponse) => ReactElement;
  bindGovernedProfileLockedId: (profileId: string | null) => void;
  isGovernedProfileLocked: (profileId: string) => boolean;
}

export function useLlmGatewaySettings(): LlmGatewaySettingsController {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const helpIconStyle = useMemo(
    () => ({ marginLeft: 8, color: token.colorTextSecondary }),
    [token.colorTextSecondary],
  );
  const governedProfileLockedIdRef = useRef<string | null>(null);
  const bindGovernedProfileLockedId = useCallback(
    (profileId: string | null) => {
      governedProfileLockedIdRef.current = profileId;
    },
    [],
  );
  const isGovernedProfileLocked = useCallback((profileId: string) => {
    return governedProfileLockedIdRef.current === profileId;
  }, []);
  const [settings, setSettings] =
    useState<LlmGatewaySettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [activatingProfileId, setActivatingProfileId] = useState<string | null>(
    null,
  );
  const [embeddingActivating, setEmbeddingActivating] = useState(false);
  const [rerankActivating, setRerankActivating] = useState(false);
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
  const [proxyModelInfoSnapshot, setProxyModelInfoSnapshot] =
    useState<LlmGatewayProxyModelInfoSnapshot | null>(null);
  const [modelsSnapshot, setModelsSnapshot] =
    useState<LlmGatewayModelsSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<LlmGatewayProfile | null>(null);
  const [createForm] = Form.useForm<LlmGatewayFormValues>();
  const [editForm] = Form.useForm<LlmGatewayFormValues>();
  const [testProfile, setTestProfile] = useState<LlmGatewayProfile | null>(
    null,
  );
  const [testResult, setTestResult] = useState<LlmGatewayTestResponse | null>(
    null,
  );
  const [testErrorMessage, setTestErrorMessage] = useState<string | null>(null);
  const [testForm] = Form.useForm<LlmGatewayTestFormValues>();
  const screens = Grid.useBreakpoint();
  const includeCompletion =
    Form.useWatch("includeCompletion", testForm) ?? true;
  const includeEmbeddings =
    Form.useWatch("includeEmbeddings", testForm) ?? false;
  const includeRerank = Form.useWatch("includeRerank", testForm) ?? false;
  const createApiSurface =
    (Form.useWatch("apiSurface", createForm) as
      | LlmGatewayApiSurface
      | undefined) ?? "chat_completions";
  const createAssistantWebSearchEnabled =
    Form.useWatch("assistantWebSearchEnabled", createForm) ?? false;
  const editApiSurface =
    (Form.useWatch("apiSurface", editForm) as
      | LlmGatewayApiSurface
      | undefined) ?? "chat_completions";
  const editAssistantWebSearchEnabled =
    Form.useWatch("assistantWebSearchEnabled", editForm) ?? false;
  const editClearApiKey = Form.useWatch("clearApiKey", editForm) ?? false;
  const createAssistantWebSearchDisabled = createApiSurface !== "responses";
  const editAssistantWebSearchDisabled = editApiSurface !== "responses";

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const resolvedCompletionProfile = useMemo(() => {
    if (settings.activeId) {
      const active = settings.profiles.find(
        (profile) => profile.id === settings.activeId && profile.enabled,
      );
      if (active) {
        return active;
      }
    }
    return resolveDefaultGatewayProfile(settings, "completion");
  }, [settings]);
  const completionActiveProfile = resolvedCompletionProfile;

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

  const resolvedEmbeddingProfile = useMemo(() => {
    if (settings.embeddingActiveId) {
      const explicit = settings.profiles.find(
        (profile) =>
          profile.id === settings.embeddingActiveId &&
          profile.enabled &&
          Boolean(profile.embeddingModel),
      );
      if (explicit) {
        return explicit;
      }
    }
    if (settings.embeddingMode === "use_default") {
      return resolveDefaultGatewayProfile(settings, "embedding");
    }
    if (!settings.activeId) {
      return resolveDefaultGatewayProfile(settings, "embedding");
    }
    const active = settings.profiles.find(
      (profile) => profile.id === settings.activeId && profile.enabled,
    );
    if (active?.embeddingModel) {
      return active;
    }
    return null;
  }, [settings]);

  const rerankResolved = useMemo(() => {
    if (settings.rerankActiveId) {
      return { kind: "profile" as const, id: settings.rerankActiveId };
    }
    if (settings.rerankMode === "use_default") {
      return { kind: "default" as const };
    }
    if (settings.activeId) {
      return { kind: "follow_completion" as const, id: settings.activeId };
    }
    return { kind: "default" as const };
  }, [settings.activeId, settings.rerankActiveId, settings.rerankMode]);

  const rerankSelectValue = useMemo(() => {
    if (settings.rerankActiveId) {
      return settings.rerankActiveId;
    }
    return settings.rerankMode === "use_default"
      ? USE_DEFAULT_KEY
      : FOLLOW_COMPLETION_KEY;
  }, [settings.rerankActiveId, settings.rerankMode]);

  const rerankActiveProfile = useMemo(() => {
    if (rerankResolved.kind === "default") {
      return null;
    }
    return (
      settings.profiles.find((profile) => profile.id === rerankResolved.id) ??
      null
    );
  }, [rerankResolved, settings.profiles]);

  const resolvedRerankProfile = useMemo(() => {
    if (settings.rerankActiveId) {
      const explicit = settings.profiles.find(
        (profile) =>
          profile.id === settings.rerankActiveId &&
          profile.enabled &&
          Boolean(profile.rerankModel),
      );
      if (explicit) {
        return explicit;
      }
    }
    if (settings.rerankMode === "use_default") {
      return resolveDefaultGatewayProfile(settings, "rerank");
    }
    if (!settings.activeId) {
      return resolveDefaultGatewayProfile(settings, "rerank");
    }
    const active = settings.profiles.find(
      (profile) => profile.id === settings.activeId && profile.enabled,
    );
    if (active?.rerankModel) {
      return active;
    }
    return null;
  }, [settings]);
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

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<LlmGatewaySettingsResponse>(
        "system-settings/llm-gateways",
      );
      const next = response.data;
      const normalizedProfiles = (next?.profiles ?? []).map((profile) => ({
        ...profile,
        assistantWebSearchEnabled: profile.assistantWebSearchEnabled ?? false,
        fallbackModels: profile.fallbackModels ?? [],
        rerankFallbackModels: profile.rerankFallbackModels ?? [],
      }));
      setSettings({
        ...EMPTY_SETTINGS,
        ...(next ?? {}),
        profiles: normalizedProfiles,
      });
    } catch (error) {
      captureClientError("Failed to load LLM gateway settings", error);
      setErrorMessage(t("settings.llmGateway.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!editing) {
      return;
    }
    editForm.setFieldsValue({
      name: editing.name,
      apiBase: editing.apiBase,
      model: editing.model,
      assistantModel: editing.assistantModel ?? undefined,
      assistantWebSearchEnabled: editing.assistantWebSearchEnabled ?? false,
      embeddingModel: editing.embeddingModel ?? undefined,
      rerankModel: editing.rerankModel ?? undefined,
      rerankFallbackModels: toFallbackModelsText(
        editing.rerankFallbackModels ?? [],
      ),
      apiSurface: editing.apiSurface ?? "chat_completions",
      timeoutMs: editing.timeoutMs,
      temperature: editing.temperature,
      topP: editing.topP,
      maxOutputTokens: editing.maxOutputTokens,
      maxRetries: editing.maxRetries,
      fallbackModels: toFallbackModelsText(editing.fallbackModels),
      sendMetadata: editing.sendMetadata,
      responseFormatMode: editing.responseFormatMode,
      enabled: editing.enabled,
      apiKey: "",
      clearApiKey: false,
    });
  }, [editing, editForm]);

  useEffect(() => {
    if (!createOpen || !createAssistantWebSearchDisabled) {
      return;
    }
    if (!createAssistantWebSearchEnabled) {
      return;
    }
    createForm.setFieldValue("assistantWebSearchEnabled", false);
  }, [
    createOpen,
    createAssistantWebSearchDisabled,
    createAssistantWebSearchEnabled,
    createForm,
  ]);

  useEffect(() => {
    if (!editing || !editAssistantWebSearchDisabled) {
      return;
    }
    if (!editAssistantWebSearchEnabled) {
      return;
    }
    editForm.setFieldValue("assistantWebSearchEnabled", false);
  }, [
    editing,
    editAssistantWebSearchDisabled,
    editAssistantWebSearchEnabled,
    editForm,
  ]);

  const openCreate = () => {
    const baselineProfile =
      settings.profiles.find((profile) => profile.id === settings.activeId) ??
      settings.profiles[0] ??
      null;
    const templateFallbackModels = baselineProfile
      ? toFallbackModelsText(baselineProfile.fallbackModels)
      : "";
    const templateRerankFallbackModels = baselineProfile
      ? toFallbackModelsText(baselineProfile.rerankFallbackModels ?? [])
      : "";
    const initialApiBase =
      baselineProfile?.apiBase ?? DEFAULT_LLM_GATEWAY_API_BASE;

    createForm.setFieldsValue({
      name: "",
      apiBase: initialApiBase,
      model: baselineProfile?.model ?? "openai/gpt-4o-mini",
      assistantModel: baselineProfile?.assistantModel ?? "",
      assistantWebSearchEnabled:
        baselineProfile?.assistantWebSearchEnabled ?? false,
      embeddingModel: baselineProfile?.embeddingModel ?? "",
      rerankModel: baselineProfile?.rerankModel ?? "",
      rerankFallbackModels: templateRerankFallbackModels,
      apiSurface: baselineProfile?.apiSurface ?? "chat_completions",
      timeoutMs: baselineProfile?.timeoutMs ?? 60_000,
      temperature: baselineProfile?.temperature ?? 0.2,
      topP: baselineProfile?.topP ?? 0.9,
      maxOutputTokens: baselineProfile?.maxOutputTokens ?? 1_200,
      maxRetries: baselineProfile?.maxRetries ?? 3,
      fallbackModels: templateFallbackModels,
      sendMetadata: baselineProfile?.sendMetadata ?? true,
      responseFormatMode: baselineProfile?.responseFormatMode ?? "json_schema",
      enabled: true,
    });
    setCreateOpen(true);
  };

  const openModelsModal = useCallback(
    (title: string, apiBase: string, models: string[]) => {
      openLlmGatewayModelsModal(t, screens.md, title, apiBase, models);
    },
    [screens.md, t],
  );

  const openProxyModelInfoModal = useCallback(
    (
      title: string,
      apiBase: string,
      result: LlmGatewayProxyModelInfoResponse,
    ) => {
      openLlmGatewayProxyModelInfoModal(
        t,
        screens.md,
        title,
        apiBase,
        result,
      );
    },
    [screens.md, t],
  );

  const renderTestResult = useCallback(
    (result: LlmGatewayTestResponse) => (
      <LlmGatewayTestResult t={t} result={result} />
    ),
    [t],
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
        assistantWebSearchEnabled: values.assistantWebSearchEnabled ?? false,
        embeddingModel: values.embeddingModel?.trim()
          ? values.embeddingModel.trim()
          : null,
        rerankModel: values.rerankModel?.trim()
          ? values.rerankModel.trim()
          : null,
        rerankFallbackModels: toFallbackModels(values.rerankFallbackModels),
        apiSurface: values.apiSurface ?? "chat_completions",
        timeoutMs: values.timeoutMs,
        temperature: values.temperature,
        topP: values.topP,
        maxOutputTokens: values.maxOutputTokens,
        maxRetries: values.maxRetries,
        fallbackModels: toFallbackModels(values.fallbackModels),
        sendMetadata: values.sendMetadata,
        responseFormatMode: values.responseFormatMode,
        enabled: values.enabled,
      };
      await apiClient.post("system-settings/llm-gateways", payload);
      await loadSettings();
      setCreateOpen(false);
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
      const rerankFallbackModels =
        values.rerankFallbackModels === undefined
          ? undefined
          : (toFallbackModels(values.rerankFallbackModels) ?? []);
      const payload: Record<string, unknown> = {
        name: values.name.trim(),
        apiBase: values.apiBase.trim(),
        ...(values.model?.trim() ? { model: values.model.trim() } : {}),
        assistantModel: values.assistantModel?.trim()
          ? values.assistantModel.trim()
          : null,
        assistantWebSearchEnabled: values.assistantWebSearchEnabled ?? false,
        embeddingModel: values.embeddingModel?.trim()
          ? values.embeddingModel.trim()
          : null,
        rerankModel: values.rerankModel?.trim()
          ? values.rerankModel.trim()
          : null,
        ...(rerankFallbackModels !== undefined ? { rerankFallbackModels } : {}),
        apiSurface: values.apiSurface ?? "chat_completions",
        timeoutMs: values.timeoutMs,
        temperature: values.temperature,
        topP: values.topP,
        maxOutputTokens: values.maxOutputTokens,
        maxRetries: values.maxRetries,
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
    if (isGovernedProfileLocked(profile.id)) {
      messageApi.warning(
        t("settings.llmGateway.proxyGovernance.table.lockedHint"),
      );
      return;
    }
    const wasCompletionActive = settings.activeId === profile.id;
    const wasEmbeddingActive = settings.embeddingActiveId === profile.id;
    const wasRerankActive = settings.rerankActiveId === profile.id;
    if (
      !nextEnabled &&
      (wasCompletionActive || wasEmbeddingActive || wasRerankActive)
    ) {
      const shouldDisable = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: t("settings.llmGateway.modal.disableTitle"),
          okButtonProps: { danger: true },
          okText: t("common.disable"),
          cancelText: t("common.cancel"),
          content: (
            <Space
              direction="vertical"
              size="small"
              style={{ display: "flex" }}
            >
              <Typography.Text>
                {t("settings.llmGateway.modal.disableContent", {
                  name: profile.name,
                })}
              </Typography.Text>
              {wasCompletionActive ? (
                <Typography.Text type="secondary">
                  {t("settings.llmGateway.modal.disableActiveHint")}
                </Typography.Text>
              ) : null}
              {wasEmbeddingActive ? (
                <Typography.Text type="secondary">
                  {t("settings.llmGateway.modal.disableEmbeddingHint")}
                </Typography.Text>
              ) : null}
              {wasRerankActive ? (
                <Typography.Text type="secondary">
                  {t("settings.llmGateway.modal.disableRerankHint")}
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
        t("settings.llmGateway.embeddingActive.messages.activated"),
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
            : t("settings.llmGateway.embeddingActive.errors.activateFailed"),
        );
      }
    } finally {
      setEmbeddingActivating(false);
    }
  };

  const handleActivateRerank = async (
    profileId: string | null,
    mode?: LlmGatewayRerankMode,
  ) => {
    setRerankActivating(true);
    try {
      await apiClient.put("system-settings/llm-gateways/rerank-active", {
        activeId: profileId,
        ...(!profileId && mode ? { mode } : {}),
      });
      await loadSettings();
      messageApi.success(
        t("settings.llmGateway.rerankActive.messages.activated"),
      );
    } catch (error) {
      captureClientError("Failed to activate rerank gateway profile", error);
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
            : t("settings.llmGateway.rerankActive.errors.activateFailed"),
        );
      }
    } finally {
      setRerankActivating(false);
    }
  };

  const handleDelete = async (profile: LlmGatewayProfile) => {
    if (isGovernedProfileLocked(profile.id)) {
      messageApi.warning(
        t("settings.llmGateway.proxyGovernance.table.lockedHint"),
      );
      return;
    }
    const wasCompletionActive = settings.activeId === profile.id;
    const wasEmbeddingActive = settings.embeddingActiveId === profile.id;
    const wasRerankActive = settings.rerankActiveId === profile.id;
    Modal.confirm({
      title: t("settings.llmGateway.modal.deleteTitle"),
      content: (
        <Space direction="vertical" size="small" style={{ display: "flex" }}>
          <Typography.Text>
            {t("settings.llmGateway.modal.deleteContent", {
              name: profile.name,
            })}
          </Typography.Text>
          {wasCompletionActive || wasEmbeddingActive || wasRerankActive ? (
            <Typography.Text type="secondary">
              {t("settings.llmGateway.modal.deleteActiveHint")}
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
  const handleCheckProxyHealth = useCallback(
    async (profile: LlmGatewayProfile) => {
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
    },
    [apiClient, t],
  );

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
          : t("settings.llmGateway.proxyStatus.errors.modelInfoFailed"),
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
                "rerankModel",
                "rerankFallbackModels",
                "apiSurface",
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
                "rerankModel",
                "rerankFallbackModels",
                "apiSurface",
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
        const rerankModel = values.rerankModel?.trim();
        const rerankFallbackModels =
          toFallbackModels(values.rerankFallbackModels) ?? [];
        const hasCompletionModel = Boolean(completionModel);
        const hasEmbeddingModel = Boolean(embeddingModel);
        const hasRerankModel =
          Boolean(rerankModel) || rerankFallbackModels.length > 0;

        const payload: Record<string, unknown> = {
          ...(profileId ? { profileId } : {}),
          apiBase: values.apiBase.trim(),
          ...(completionModel ? { model: completionModel } : {}),
          includeCompletion: hasCompletionModel,
          apiSurface: values.apiSurface ?? "chat_completions",
          timeoutMs: values.timeoutMs,
          temperature: values.temperature,
          topP: values.topP,
          maxOutputTokens: values.maxOutputTokens,
          fallbackModels: toFallbackModels(values.fallbackModels),
          ...(embeddingModel ? { embeddingModel } : {}),
          includeEmbeddings: hasEmbeddingModel,
          ...(rerankModel ? { rerankModel } : {}),
          ...(rerankFallbackModels.length > 0 ? { rerankFallbackModels } : {}),
          includeRerank: hasRerankModel,
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
            !result.embeddingError &&
            !result.rerank &&
            !result.rerankError)
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
        authMode: values.authMode ?? "profile_key",
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
        includeRerank: values.includeRerank,
        ...(values.rerankModel?.trim()
          ? { rerankModel: values.rerankModel.trim() }
          : {}),
        ...(values.rerankQuery?.trim()
          ? { rerankQuery: values.rerankQuery.trim() }
          : {}),
        ...(values.rerankDocuments?.trim()
          ? { rerankDocuments: toRerankDocuments(values.rerankDocuments) }
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
          !result.embeddingError &&
          !result.rerank &&
          !result.rerankError)
      ) {
        setTestResult(null);
        setTestErrorMessage(t("settings.llmGateway.test.errors.failed"));
        return;
      }
      setTestResult(result);
      setTestErrorMessage(
        result.completionError?.message ??
          result.embeddingError?.message ??
          result.rerankError?.message ??
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
      authMode: "profile_key",
      includeCompletion: true,
      model: "",
      prompt: "",
      apiSurface: profile.apiSurface ?? "chat_completions",
      responseFormatMode: profile.responseFormatMode ?? "json_schema",
      includeMetadataProbe: profile.sendMetadata ?? true,
      includeEmbeddings: Boolean(profile.embeddingModel),
      embeddingModel: "",
      embeddingInput: "",
      includeRerank: Boolean(
        profile.rerankModel || (profile.rerankFallbackModels ?? []).length > 0,
      ),
      rerankModel: "",
      rerankQuery: "",
      rerankDocuments: "",
    };

    setTestProfile(profile);
    setTestResult(null);
    setTestErrorMessage(null);
    testForm.setFieldsValue(initialValues);
    void runTest(profile.id, initialValues);
  };

  return {
    t,
    token,
    helpIconStyle,
    contextHolder,
    messageApi,
    apiClient,
    screens,
    settings,
    setSettings,
    loading,
    saving,
    toggling,
    activatingProfileId,
    embeddingActivating,
    rerankActivating,
    testing,
    loadingModels,
    loadingProxyModelInfo,
    checkingProxyHealth,
    proxyHealthProfileId,
    proxyHealth,
    proxyHealthErrorMessage,
    proxyModelInfoSnapshot,
    modelsSnapshot,
    errorMessage,
    createOpen,
    setCreateOpen,
    editing,
    setEditing,
    createForm,
    editForm,
    testProfile,
    testResult,
    testErrorMessage,
    testForm,
    includeCompletion,
    includeEmbeddings,
    includeRerank,
    createApiSurface,
    createAssistantWebSearchEnabled,
    editApiSurface,
    editAssistantWebSearchEnabled,
    editClearApiKey,
    createAssistantWebSearchDisabled,
    editAssistantWebSearchDisabled,
    resolvedCompletionProfile,
    completionActiveProfile,
    embeddingResolved,
    embeddingSelectValue,
    embeddingActiveProfile,
    resolvedEmbeddingProfile,
    rerankResolved,
    rerankSelectValue,
    rerankActiveProfile,
    resolvedRerankProfile,
    apiBaseRules,
    loadSettings,
    openCreate,
    handleCreate,
    handleUpdate,
    handleToggle,
    handleActivate,
    handleActivateEmbedding,
    handleActivateRerank,
    handleDelete,
    handleCheckProxyHealth,
    handleProxyModelInfo,
    handleListModels,
    testUnsavedConfig,
    listModelsUnsavedConfig,
    closeTest,
    runTest,
    openTest,
    renderTestResult,
    bindGovernedProfileLockedId,
    isGovernedProfileLocked,
  };
}
