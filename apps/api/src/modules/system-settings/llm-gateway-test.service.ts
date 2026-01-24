import { createLogger } from "@modular/utils";
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";

import { extractOpenAiTextFromChoice } from "../../common/openai-chat";

import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  response_cost?: unknown;
}

interface EmbeddingResponse {
  model?: string;
  data?: { embedding?: number[] }[];
  usage?: { prompt_tokens: number; total_tokens: number };
  response_cost?: unknown;
}

interface ModelsResponseEntry {
  id?: string;
}

interface ModelsResponse {
  data?: (ModelsResponseEntry | string)[];
}

export interface LlmGatewayChatTestResult {
  model: string;
  content: string | null;
  finishReason?: string;
  latencyMs: number;
  usage?: ChatCompletionResponse["usage"];
  costUsd?: number;
  keySpendUsd?: number;
}

export interface LlmGatewayEmbeddingTestResult {
  model: string;
  dimensions: number;
  latencyMs: number;
  usage?: EmbeddingResponse["usage"];
  costUsd?: number;
  keySpendUsd?: number;
}

export interface LlmGatewayTestError {
  message: string;
  status?: number;
}

export interface LlmGatewayTestResult {
  apiBase: string;
  completion: LlmGatewayChatTestResult;
  embedding?: LlmGatewayEmbeddingTestResult;
  embeddingError?: LlmGatewayTestError;
}

export interface LlmGatewayModelsResult {
  apiBase: string;
  models: string[];
}

export interface LlmGatewayProxyEndpointCheck {
  ok: boolean;
  status?: number;
  message?: string;
  data?: unknown;
}

export interface LlmGatewayProxyHealthResult {
  apiBase: string;
  checkedAt: string;
  liveliness: LlmGatewayProxyEndpointCheck;
  readiness: LlmGatewayProxyEndpointCheck;
}

export interface LlmGatewayModelsConfigInput {
  profileId?: string;
  apiBase: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface LlmGatewayTestConfigInput extends LlmGatewayModelsConfigInput {
  model: string;
  embeddingModel?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  fallbackModels?: string[];
  prompt?: string;
  includeEmbeddings?: boolean;
  embeddingInput?: string;
}

export interface LlmGatewayTestInput {
  model?: string;
  prompt?: string;
  includeEmbeddings?: boolean;
  embeddingModel?: string;
  embeddingInput?: string;
}

const DEFAULT_PROMPT = 'Say "OK" and nothing else.';
const DEFAULT_EMBEDDING_INPUT = "hello";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 0.9;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;

@Injectable()
export class LlmGatewayTestService {
  private readonly logger = createLogger({ name: "llm-gateway-test" });

  constructor(private readonly settings: LlmGatewaySettingsService) {}

  async checkProxyHealth(profileId: string): Promise<LlmGatewayProxyHealthResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw new NotFoundException("LLM gateway profile not found");
    }

    const baseUrl = normalizeApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw new BadRequestException("apiBase is not configured");
    }

    const timeoutMs = Math.min(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000);
    const apiKey = normalizeApiKey(cfg.apiKey);
    const client = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      }
    });

    const context = { apiKeyConfigured: Boolean(apiKey) };

    const [liveliness, readiness] = await Promise.all([
      this.checkProxyEndpoint(client, "/health/liveliness", timeoutMs, context),
      this.checkProxyEndpoint(client, "/health/readiness", timeoutMs, context)
    ]);

    return {
      apiBase: baseUrl,
      checkedAt: new Date().toISOString(),
      liveliness,
      readiness
    };
  }

  async listModels(profileId: string): Promise<LlmGatewayModelsResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw new NotFoundException("LLM gateway profile not found");
    }

    const baseUrl = normalizeApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw new BadRequestException("apiBase is not configured");
    }

    const client = axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      }
    });

    try {
      const response = await getWithFallback<ModelsResponse>(
        client,
        "/v1/models",
        "/models",
        { timeout: cfg.timeoutMs }
      );

      const models = normalizeModels(response.data);
      return { apiBase: baseUrl, models };
    } catch (error) {
      this.throwGatewayError(error, { apiKeyConfigured: Boolean(cfg.apiKey) });
    }
  }

  async listModelsConfig(input: LlmGatewayModelsConfigInput): Promise<LlmGatewayModelsResult> {
    const stored = input.profileId ? await this.getStoredConfig(input.profileId) : null;
    const baseUrl = normalizeApiBase(input.apiBase);
    if (!baseUrl) {
      throw new BadRequestException("apiBase is not configured");
    }

    const apiKey =
      typeof input.apiKey === "string"
        ? normalizeApiKey(input.apiKey)
        : stored?.apiKey;
    const timeoutMs = input.timeoutMs ?? stored?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const client = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      }
    });

    try {
      const response = await getWithFallback<ModelsResponse>(
        client,
        "/v1/models",
        "/models",
        { timeout: timeoutMs }
      );

      const models = normalizeModels(response.data);
      return { apiBase: baseUrl, models };
    } catch (error) {
      this.throwGatewayError(error, { apiKeyConfigured: Boolean(apiKey) });
    }
  }

  async testProfile(profileId: string, input: LlmGatewayTestInput): Promise<LlmGatewayTestResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw new NotFoundException("LLM gateway profile not found");
    }

    const baseUrl = normalizeApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw new BadRequestException("apiBase is not configured");
    }

    const client = axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      }
    });

    const prompt = input.prompt?.trim() ? input.prompt.trim() : DEFAULT_PROMPT;
    const completionModelOverride = input.model?.trim() ? input.model.trim() : undefined;
    const completion = await this.testCompletion(client, cfg, prompt, completionModelOverride);

    const shouldTestEmbeddings =
      input.includeEmbeddings ??
      Boolean((input.embeddingModel?.trim() ? input.embeddingModel.trim() : undefined) ?? cfg.embeddingModel);
    let embedding: LlmGatewayEmbeddingTestResult | undefined;
    let embeddingError: LlmGatewayTestError | undefined;
    if (shouldTestEmbeddings) {
      const embeddingInput = input.embeddingInput?.trim()
        ? input.embeddingInput.trim()
        : DEFAULT_EMBEDDING_INPUT;
      try {
        const embeddingModelOverride = input.embeddingModel?.trim()
          ? input.embeddingModel.trim()
          : undefined;
        embedding = await this.testEmbeddings(client, cfg, embeddingInput, embeddingModelOverride);
      } catch (error) {
        const info = this.toGatewayErrorInfo(error, { apiKeyConfigured: Boolean(cfg.apiKey) });
        embeddingError = info;
        this.logger.warn(
          { profileId, status: info.status, message: info.message },
          "LLM gateway embedding test failed"
        );
      }
    }

    return {
      apiBase: baseUrl,
      completion,
      ...(embedding ? { embedding } : {}),
      ...(embeddingError ? { embeddingError } : {})
    };
  }

  async testConfig(input: LlmGatewayTestConfigInput): Promise<LlmGatewayTestResult> {
    const stored = input.profileId ? await this.getStoredConfig(input.profileId) : null;
    const baseUrl = normalizeApiBase(input.apiBase);
    if (!baseUrl) {
      throw new BadRequestException("apiBase is not configured");
    }

    const model = input.model?.trim();
    if (!model) {
      throw new BadRequestException("model is not configured");
    }

    const apiKey =
      typeof input.apiKey === "string"
        ? normalizeApiKey(input.apiKey)
        : stored?.apiKey;
    const timeoutMs = input.timeoutMs ?? stored?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const temperature = input.temperature ?? stored?.temperature ?? DEFAULT_TEMPERATURE;
    const topP = input.topP ?? stored?.topP ?? DEFAULT_TOP_P;
    const maxOutputTokens =
      input.maxOutputTokens ?? stored?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const fallbackModelsRaw = input.fallbackModels ?? stored?.fallbackModels ?? [];
    const fallbackModels = normalizeStringList(fallbackModelsRaw);

    const cfg = {
      model,
      embeddingModel: normalizeOptionalString(input.embeddingModel) ?? stored?.embeddingModel,
      apiBase: baseUrl,
      apiKey,
      timeoutMs,
      temperature,
      topP,
      maxOutputTokens,
      fallbackModels
    } satisfies {
      model: string;
      embeddingModel?: string;
      apiBase: string;
      apiKey?: string;
      timeoutMs: number;
      temperature: number;
      topP: number;
      maxOutputTokens: number;
      fallbackModels: string[];
    };

    const client = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      }
    });

    const prompt = input.prompt?.trim() ? input.prompt.trim() : DEFAULT_PROMPT;
    const completion = await this.testCompletion(client, cfg, prompt);

    const shouldTestEmbeddings = input.includeEmbeddings ?? Boolean(cfg.embeddingModel);
    let embedding: LlmGatewayEmbeddingTestResult | undefined;
    let embeddingError: LlmGatewayTestError | undefined;
    if (shouldTestEmbeddings) {
      const embeddingInput = input.embeddingInput?.trim()
        ? input.embeddingInput.trim()
        : DEFAULT_EMBEDDING_INPUT;
      try {
        embedding = await this.testEmbeddings(client, cfg, embeddingInput);
      } catch (error) {
        const info = this.toGatewayErrorInfo(error, { apiKeyConfigured: Boolean(apiKey) });
        embeddingError = info;
        this.logger.warn(
          { profileId: input.profileId, status: info.status, message: info.message },
          "LLM gateway embedding test failed"
        );
      }
    }

    return {
      apiBase: baseUrl,
      completion,
      ...(embedding ? { embedding } : {}),
      ...(embeddingError ? { embeddingError } : {})
    };
  }

  private async testCompletion(
    client: ReturnType<typeof axios.create>,
    cfg: {
      model: string;
      apiKey?: string;
      fallbackModels: string[];
      temperature: number;
      topP: number;
      maxOutputTokens: number;
      timeoutMs: number;
    },
    prompt: string,
    modelOverride?: string
  ): Promise<LlmGatewayChatTestResult> {
    const uniqueModels = Array.from(
      new Set(
        (
          modelOverride
            ? [modelOverride]
            : [cfg.model, ...(cfg.fallbackModels ?? [])]
        )
          .filter((model): model is string => typeof model === "string" && model.trim().length > 0)
          .map((model) => model.trim())
      )
    );
    if (uniqueModels.length === 0) {
      throw new BadRequestException("model is not configured");
    }

    let lastError: unknown;
    for (const model of uniqueModels) {
      try {
        const payload = {
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: cfg.temperature,
          top_p: cfg.topP,
          max_tokens: Math.min(Math.max(1, cfg.maxOutputTokens), 128),
          stream: false
        };
        const start = Date.now();
        const response = await postWithFallback<ChatCompletionResponse>(
          client,
          "/v1/chat/completions",
          "/chat/completions",
          payload,
          { timeout: cfg.timeoutMs }
        );
        const latencyMs = Date.now() - start;
        const choice = (response.data as unknown as { choices?: unknown[] })?.choices?.[0];
        const content = extractOpenAiTextFromChoice(choice);
        const finishReason =
          choice && typeof choice === "object" && typeof (choice as Record<string, unknown>).finish_reason === "string"
            ? ((choice as Record<string, unknown>).finish_reason as string)
            : undefined;

        return {
          model: response.data.model?.trim() || model,
          content,
          ...(finishReason ? { finishReason } : {}),
          latencyMs,
          ...(response.data.usage ? { usage: response.data.usage } : {}),
          ...this.extractCosts(response)
        };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error"
          },
          "LLM gateway completion test failed; evaluating fallback"
        );
      }
    }

    this.throwGatewayError(lastError, { apiKeyConfigured: Boolean(cfg.apiKey) });
  }

  private async testEmbeddings(
    client: ReturnType<typeof axios.create>,
    cfg: { model: string; embeddingModel?: string; timeoutMs: number },
    input: string,
    modelOverride?: string
  ): Promise<LlmGatewayEmbeddingTestResult> {
    const model = modelOverride?.trim() || cfg.embeddingModel?.trim() || cfg.model?.trim();
    if (!model) {
      throw new BadRequestException("embedding model is not configured");
    }

    const payload = {
      model,
      input
    };
    const start = Date.now();
    const response = await postWithFallback<EmbeddingResponse>(
      client,
      "/v1/embeddings",
      "/embeddings",
      payload,
      { timeout: cfg.timeoutMs }
    );
    const latencyMs = Date.now() - start;
    const firstEmbedding = response.data.data?.[0]?.embedding;
    if (!Array.isArray(firstEmbedding) || firstEmbedding.length === 0) {
      throw new BadGatewayException("Embedding response did not include an embedding vector");
    }

    return {
      model: response.data.model?.trim() || model,
      dimensions: firstEmbedding.length,
      latencyMs,
      ...(response.data.usage ? { usage: response.data.usage } : {}),
      ...this.extractCosts(response)
    };
  }

  private extractCosts(response: AxiosResponse<{ response_cost?: unknown }>) {
    const headerCost = extractNumber(
      response.headers?.["x-litellm-response-cost"] ??
        response.headers?.["x-litellm-cost"] ??
        response.headers?.["litellm-cost"]
    );
    const keySpendUsd = extractNumber(response.headers?.["x-litellm-key-spend"]);
    const payloadCost = extractNumber(response.data.response_cost);
    const costUsd = headerCost ?? payloadCost;

    return {
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(keySpendUsd !== undefined ? { keySpendUsd } : {})
    };
  }

  private async checkProxyEndpoint(
    client: ReturnType<typeof axios.create>,
    path: string,
    timeoutMs: number,
    context?: {
      apiKeyConfigured?: boolean;
    }
  ): Promise<LlmGatewayProxyEndpointCheck> {
    try {
      const response = await client.get(path, { timeout: timeoutMs });
      const status = response.status;
      const ok = status >= 200 && status < 300;

      const contentType = response.headers?.["content-type"];
      const hasHtmlContentType =
        typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
      const hasHtmlBody =
        typeof response.data === "string" && /<\\s*!doctype\\s+html|<\\s*html\\b/i.test(response.data);

      if (ok && (hasHtmlContentType || hasHtmlBody)) {
        return {
          ok: false,
          status,
          message: "Unexpected HTML response (not a LiteLLM Proxy health endpoint)."
        };
      }

      return {
        ok,
        status
      };
    } catch (error) {
      const info = this.toGatewayErrorInfo(error, context);
      const message = info.message.startsWith("LLM gateway request failed")
        ? info.message.replace(/^LLM gateway request failed\\s*/i, "").trim()
        : info.message;
      return {
        ok: false,
        ...(info.status ? { status: info.status } : {}),
        message
      };
    }
  }

  private throwGatewayError(
    error: unknown,
    context?: {
      apiKeyConfigured?: boolean;
    }
  ): never {
    if (error instanceof BadRequestException || error instanceof NotFoundException) {
      throw error;
    }

    if (error instanceof AxiosError) {
      const status = error.response?.status;
      let detail = extractAxiosDetail(error);
      if (status === 401 && detail && detail.toLowerCase() === "unauthorized") {
        detail = undefined;
      }
      if (status === 403 && detail && detail.toLowerCase() === "forbidden") {
        detail = undefined;
      }
      if (status === 401 || status === 403) {
        detail = detail ?? buildAuthHint(status ?? 401, context?.apiKeyConfigured);
      }
      const message = status
        ? `LLM gateway request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`
        : `LLM gateway request failed${detail ? `: ${detail}` : ""}`;

      if (!status) {
        throw new ServiceUnavailableException(message);
      }
      if (status >= 500) {
        throw new BadGatewayException(message);
      }
      throw new BadRequestException(message);
    }

      throw error instanceof Error
        ? new BadRequestException(error.message)
        : new BadRequestException("LLM gateway request failed");
  }

  private toGatewayErrorInfo(
    error: unknown,
    context?: {
      apiKeyConfigured?: boolean;
    }
  ): LlmGatewayTestError {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      let detail = extractAxiosDetail(error);
      if (status === 401 && detail && detail.toLowerCase() === "unauthorized") {
        detail = undefined;
      }
      if (status === 403 && detail && detail.toLowerCase() === "forbidden") {
        detail = undefined;
      }
      if (status === 401 || status === 403) {
        detail = detail ?? buildAuthHint(status ?? 401, context?.apiKeyConfigured);
      }
      const message = status
        ? `LLM gateway request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`
        : `LLM gateway request failed${detail ? `: ${detail}` : ""}`;
      return {
        message,
        ...(status ? { status } : {})
      };
    }

    if (error instanceof Error) {
      return { message: error.message };
    }

    return { message: "LLM gateway request failed" };
  }

  private async getStoredConfig(profileId: string) {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw new NotFoundException("LLM gateway profile not found");
    }
    return cfg;
  }
}

async function postWithFallback<T>(
  client: ReturnType<typeof axios.create>,
  primaryPath: string,
  fallbackPath: string,
  payload: unknown,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  try {
    return await client.post<T>(primaryPath, payload, config);
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return client.post<T>(fallbackPath, payload, config);
    }
    throw error;
  }
}

async function getWithFallback<T>(
  client: ReturnType<typeof axios.create>,
  primaryPath: string,
  fallbackPath: string,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  try {
    return await client.get<T>(primaryPath, config);
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return client.get<T>(fallbackPath, config);
    }
    throw error;
  }
}

function extractNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractAxiosDetail(error: AxiosError) {
  const status = error.response?.status;
  const axiosCode = normalizeOptionalString(error.code);
  const responseData = error.response?.data as unknown;
  const responseDetail = normalizeAxiosDetail(extractDetailFromResponseData(responseData), {
    status,
    axiosCode
  });
  if (responseDetail) {
    return redactSecrets(responseDetail).slice(0, 500);
  }

  const statusText = normalizeAxiosDetail(normalizeOptionalString(error.response?.statusText), {
    status,
    axiosCode
  });
  if (statusText) {
    return redactSecrets(statusText).slice(0, 500);
  }

  const message = normalizeAxiosDetail(normalizeOptionalString(error.message), { status, axiosCode });
  if (message) {
    return redactSecrets(message).slice(0, 500);
  }

  const code = normalizeAxiosDetail(axiosCode, { status, axiosCode });
  if (code) {
    return redactSecrets(code).slice(0, 500);
  }

  return undefined;
}

function extractDetailFromResponseData(data: unknown): string | undefined {
  if (!data) {
    return undefined;
  }

  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed ? trimmed : undefined;
  }

  if (Array.isArray(data)) {
    const messages = data
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (messages.length > 0) {
      return messages.join("; ");
    }
  }

  if (typeof data === "object") {
    const record = data as Record<string, unknown>;

    const openAiMessage = extractMessageLike(record.error);
    if (openAiMessage) {
      return openAiMessage;
    }

    const message = extractMessageLike(record.message);
    if (message) {
      return message;
    }

    const detail = extractMessageLike(record.detail);
    if (detail) {
      return detail;
    }

    const errorDescription = extractMessageLike(record.error_description);
    if (errorDescription) {
      return errorDescription;
    }

    try {
      const json = JSON.stringify(record);
      return json ? json : undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const text = String(data).trim();
    return text ? text : undefined;
  } catch {
    return undefined;
  }
}

function extractMessageLike(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const messages = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (messages.length > 0) {
      return messages.join("; ");
    }
    return undefined;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = extractMessageLike(record.message);
    if (message) {
      return message;
    }
    const detail = extractMessageLike(record.detail);
    if (detail) {
      return detail;
    }
    const error = extractMessageLike(record.error);
    if (error) {
      return error;
    }

    const title = extractMessageLike(record.title);
    if (title) {
      return title;
    }

    const statusText = extractMessageLike(record.statusText);
    if (statusText) {
      return statusText;
    }

    try {
      const json = JSON.stringify(record);
      return json ? json : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function redactSecrets(text: string): string {
  const bearerRedacted = text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  return bearerRedacted.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-[REDACTED]");
}

function buildAuthHint(status: number, apiKeyConfigured: boolean | undefined): string {
  const base = status === 403 ? "Forbidden" : "Unauthorized";
  if (apiKeyConfigured === false) {
    return `${base} (apiKey is not configured)`;
  }
  if (apiKeyConfigured === true) {
    return `${base} (check apiKey)`;
  }
  return base;
}

function normalizeAxiosDetail(
  detail: string | undefined,
  context: { status?: number; axiosCode?: string }
): string | undefined {
  const trimmed = detail?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (["{}", "[]", "[object Object]"].includes(trimmed)) {
    return undefined;
  }

  if (isGenericAxiosErrorCode(trimmed)) {
    return undefined;
  }

  if (
    context.status !== undefined &&
    new RegExp(`^Request failed with status code ${context.status}$`, "i").test(trimmed)
  ) {
    return undefined;
  }

  if (context.axiosCode && trimmed === context.axiosCode && isGenericAxiosErrorCode(trimmed)) {
    return undefined;
  }

  return trimmed;
}

function isGenericAxiosErrorCode(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (["ERR_BAD_REQUEST", "ERR_BAD_RESPONSE"].includes(trimmed)) {
    return true;
  }
  return /^ERR_[A-Z_]+$/.test(trimmed);
}

function normalizeApiBase(raw: string) {
  let base = raw.trim();
  if (base.length === 0) {
    return base;
  }

  base = base.replace(/\/+$/, "");

  const lower = base.toLowerCase();
  const stripSuffixes = [
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/embeddings",
    "/embeddings",
    "/v1/models",
    "/models"
  ];

  const matchedSuffix = stripSuffixes.find((suffix) => lower.endsWith(suffix));
  if (matchedSuffix) {
    base = base.slice(0, -matchedSuffix.length);
    base = base.replace(/\/+$/, "");
  }

  if (base.toLowerCase().endsWith("/v1")) {
    base = base.slice(0, -"/v1".length);
  }

  return base.replace(/\/+$/, "");
}

function normalizeApiKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^bearer\s+/i, "").trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(entries));
}

function normalizeModels(raw: unknown): string[] {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return normalizeModelsArray(raw);
  }

  if (typeof raw === "object") {
    const record = raw as Partial<ModelsResponse> & Record<string, unknown>;
    const data = record.data;
    if (Array.isArray(data)) {
      return normalizeModelsArray(data);
    }

    const models = record.models;
    if (Array.isArray(models)) {
      return normalizeModelsArray(models);
    }
  }

  return [];
}

function normalizeModelsArray(raw: unknown[]) {
  const models = raw
    .flatMap((entry): string[] => {
      if (typeof entry === "string") {
        return [entry];
      }
      if (entry && typeof entry === "object") {
        const id = (entry as ModelsResponseEntry).id;
        if (typeof id === "string") {
          return [id];
        }
      }
      return [];
    })
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(models));
}
