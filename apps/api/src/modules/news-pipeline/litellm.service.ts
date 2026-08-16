import { createLogger, asRecord } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
  AxiosInstance,
} from "axios";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import {
  detectOpenAiCompatibilityIssue,
  LlmCompatibilityError,
  normalizeOpenAiApiBase,
  normalizeOpenAiApiKey,
  sanitizeUpstreamErrorText,
} from "../../common/llm-openai-compat";
import { extractOpenAiTextFromChoice } from "../../common/openai-chat";
import { recordIntegrationEvent } from "../observability/prometheus-metrics";
import { AssistantSafetySettingsService } from "../system-settings/assistant-safety-settings.service";
import {
  LlmGatewaySettingsService,
  type LlmGatewayApiSurface,
  type LlmGatewayResolvedConfig,
  type LlmGatewayResponseFormatMode,
} from "../system-settings/llm-gateway-settings.service";

import {
  LlmRequestLogService,
  type LlmApiSurface,
  type LlmRequestType,
} from "./llm-request-log.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import type { JsonSchemaResponseFormat } from "./news-prompt.builder";
import { iterateSseDataFromReadable } from "./sse";

export type LiteLlmMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
    }
  | {
      role: "system" | "user" | "assistant";
      content: { type: string; text: string }[];
    };

export interface LiteLlmCompletionParams {
  orgId?: string;
  model?: string;
  messages: LiteLlmMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: JsonSchemaResponseFormat | Record<string, unknown>;
  /**
   * LiteLLM Proxy guardrail names to apply for this request.
   * These must be configured on the LiteLLM Proxy side (config.yaml -> `guardrails`).
   */
  guardrails?: string[];
  tools?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LiteLlmCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
  };
  finish_reason?: string;
}

export interface LiteLlmCompletionResponseUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LiteLlmCompletionResponse {
  id: string;
  model: string;
  created: number;
  choices: LiteLlmCompletionChoice[];
  usage?: LiteLlmCompletionResponseUsage;
  response_cost?: number;
  costUsd?: number;
  keySpendUsd?: number;
  latencyMs?: number;
  requestedModel?: string;
  fallbackUsed?: boolean;
}

export interface LiteLlmEmbeddingParams {
  orgId?: string;
  model?: string;
  input: string | string[];
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LiteLlmEmbeddingResponse {
  model: string;
  data: { index: number; embedding: number[] }[];
  usage?: { prompt_tokens: number; total_tokens: number };
  response_cost?: number;
  costUsd?: number;
  keySpendUsd?: number;
  latencyMs?: number;
}

export interface LiteLlmRerankParams {
  orgId?: string;
  model?: string;
  query: string;
  documents: string[];
  topN?: number;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LiteLlmRerankResult {
  index: number;
  score: number;
}

export interface LiteLlmRerankResponse {
  model: string;
  results: LiteLlmRerankResult[];
  response_cost?: number;
  costUsd?: number;
  keySpendUsd?: number;
  latencyMs?: number;
  requestedModel?: string;
  fallbackUsed?: boolean;
}

export interface LiteLlmStreamChunk {
  model: string;
  raw: unknown;
  delta?: string;
  finishReason?: string;
  requestedModel?: string;
  fallbackUsed?: boolean;
}

export interface LiteLlmResponsesParams {
  orgId?: string;
  model?: string;
  input: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LiteLlmResponsesResponse {
  id?: string;
  model?: string;
  output_text?: string;
  response_cost?: number;
  costUsd?: number;
  keySpendUsd?: number;
  latencyMs?: number;
  requestedModel?: string;
  fallbackUsed?: boolean;
  [key: string]: unknown;
}

interface LiteLlmTokenUsageSnapshot {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

interface LiteLlmRequestLogContext {
  feature: string | null;
  gatewayProfileId: string | null;
  governanceApplied: boolean | null;
  authMode: "profile_key" | "managed_runtime_key" | null;
  governanceTargetProfileId: string | null;
}

export type LiteLlmGuardrailViolationCode =
  | "GUARDRAIL_MISCONFIG"
  | "PROMPT_INJECTION"
  | "TRUST_SAFETY_VIOLATION"
  | "LANGUAGE_POLICY_VIOLATION"
  | "MODERATION_BLOCKED"
  | "GUARDRAIL_BLOCKED";

export class LiteLlmGuardrailViolationError extends Error {
  public readonly code: LiteLlmGuardrailViolationCode;
  public readonly appliedGuardrails: string[];
  public readonly upstreamStatus?: number;
  public readonly detail?: string;

  constructor(
    message: string,
    options?: {
      code?: LiteLlmGuardrailViolationCode;
      appliedGuardrails?: string[];
      upstreamStatus?: number;
      detail?: string;
      cause?: Error;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "LiteLlmGuardrailViolationError";
    this.code = options?.code ?? "GUARDRAIL_BLOCKED";
    this.appliedGuardrails = options?.appliedGuardrails ?? [];
    this.upstreamStatus = options?.upstreamStatus;
    this.detail = options?.detail;
  }
}

const DEFAULT_SEND_METADATA = true;
const DEFAULT_RESPONSE_FORMAT_MODE: LlmGatewayResponseFormatMode =
  "json_schema";
const ERROR_COMPLETION_MODEL_NOT_CONFIGURED =
  "LiteLLM completion model is not configured in MySQL gateway profiles";
const ERROR_EMBEDDING_MODEL_NOT_CONFIGURED =
  "LiteLLM embedding model is not configured in MySQL gateway profiles";
const ERROR_RERANK_MODEL_NOT_CONFIGURED =
  "LiteLLM rerank model is not configured in MySQL gateway profiles";
const UNKNOWN_ORG_ID = "_unknown_";
const MAX_LOG_ERROR_LENGTH = 1000;
const OPENAI_MODERATION_PRE_GUARDRAIL = "openai-moderation-pre";
const UNTRUSTED_CONTENT_FEATURE_TOKENS = new Set([
  "news-pipeline",
  "news-classifier",
  "clean",
  "crawl_article_repair",
]);
const GUARDRAIL_CLIENT_ERROR_STATUSES = new Set([400, 403, 422]);
const STRUCTURED_GUARDRAIL_SIGNAL =
  /guardrail|moderation|prompt.?injection|jailbreak|content.?policy|trust.?safety/;

@Injectable()
export class LiteLlmService {
  private readonly clients = new Map<string, AxiosInstance>();
  private readonly logger = createLogger({ name: "litellm-service" });
  private logOrgIdMismatchTotal = 0;

  constructor(
    private readonly configService: NewsPipelineConfigService,
    private readonly llmGatewaySettings: LlmGatewaySettingsService,
    private readonly llmRequestLogService: LlmRequestLogService,
    private readonly assistantSafety: AssistantSafetySettingsService,
  ) {}

  async getEmbeddingModel(): Promise<string | undefined> {
    try {
      const cfg = await this.resolveEmbeddingConfig();
      return cfg.embeddingModel;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === ERROR_EMBEDDING_MODEL_NOT_CONFIGURED
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async getRerankModel(): Promise<string | undefined> {
    try {
      const cfg = await this.resolveRerankConfig();
      return cfg.rerankModel;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === ERROR_RERANK_MODEL_NOT_CONFIGURED
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async getCompletionModels(): Promise<string[]> {
    const cfg = await this.resolveCompletionConfig();
    const models = [cfg.model, ...cfg.fallbackModels].filter(
      (model): model is string =>
        typeof model === "string" && model.trim().length > 0,
    );
    return Array.from(new Set(models.map((model) => model.trim())));
  }

  async getCompletionTimeoutMs(): Promise<number> {
    const cfg = await this.resolveCompletionConfig();
    return cfg.timeoutMs;
  }

  async acompletion(
    params: LiteLlmCompletionParams,
  ): Promise<LiteLlmCompletionResponse> {
    const requestParams = await this.withResolvedGuardrails(params);
    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("completion");
    const runtimeContext = await this.startRuntimeRequest(
      "completion",
      requestParams.metadata,
      cfg,
    );
    const apiSurface = this.resolveApiSurface(
      (cfg as { apiSurface?: unknown }).apiSurface,
    );
    const uniqueModels = this.uniqueModelList([
      params.model ?? cfg.model,
      ...cfg.fallbackModels,
    ]);
    const requestedModel = uniqueModels[0];
    let lastError: unknown;
    try {
      for (let index = 0; index < uniqueModels.length; index += 1) {
        const model = uniqueModels[index];
        if (!model) {
          continue;
        }
        try {
          const response =
            apiSurface === "responses"
              ? await this.executeResponsesCompletionWithRetry(
                  client,
                  cfg,
                  apiKeyConfigured,
                  model,
                  requestParams,
                  runtimeContext,
                )
              : await this.executeWithRetry(
                  client,
                  cfg,
                  apiKeyConfigured,
                  model,
                  requestParams,
                  runtimeContext,
                );
          return this.annotateSelectedModel(
            response,
            requestedModel,
            model,
          );
        } catch (error) {
          if (error instanceof LiteLlmGuardrailViolationError) {
            throw error;
          }
          if (error instanceof LlmCompatibilityError) {
            throw error;
          }
          lastError = error;
          this.recordModelFallbackOrWarn({
            operation: "completion_fallback",
            models: uniqueModels,
            failedIndex: index,
            error,
            exhaustedMessage: "LiteLLM completion failed; no fallback remaining",
          });
        }
      }
    } finally {
      await this.releaseRuntimeRequest(runtimeContext);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("LiteLLM completion failed");
  }

  async embedding(
    params: LiteLlmEmbeddingParams,
  ): Promise<LiteLlmEmbeddingResponse> {
    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("embedding");
    const runtimeContext = await this.startRuntimeRequest(
      "embedding",
      params.metadata,
      cfg,
    );
    const model = params.model ?? cfg.embeddingModel ?? cfg.model;
    if (!model) {
      await this.releaseRuntimeRequest(runtimeContext);
      throw new Error("LiteLLM embedding model is not configured");
    }
    try {
      return await this.executeEmbeddingWithRetry(
        client,
        cfg,
        apiKeyConfigured,
        model,
        params,
        runtimeContext,
      );
    } finally {
      await this.releaseRuntimeRequest(runtimeContext);
    }
  }

  async rerank(params: LiteLlmRerankParams): Promise<LiteLlmRerankResponse> {
    if (!Array.isArray(params.documents) || params.documents.length === 0) {
      throw new Error("LiteLLM rerank documents are required");
    }
    const query = params.query.trim();
    if (!query) {
      throw new Error("LiteLLM rerank query is required");
    }

    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("rerank");
    const runtimeContext = await this.startRuntimeRequest(
      "rerank",
      params.metadata,
      cfg,
    );
    const requestedModel =
      typeof params.model === "string" && params.model.trim().length > 0
        ? params.model.trim()
        : undefined;
    const models = requestedModel
      ? [requestedModel, ...(cfg.rerankFallbackModels ?? [])]
      : [cfg.rerankModel, ...(cfg.rerankFallbackModels ?? [])];
    const uniqueModels = Array.from(
      new Set(
        models
          .filter(
            (model): model is string =>
              typeof model === "string" && model.trim().length > 0,
          )
          .map((model) => model.trim()),
      ),
    );
    if (uniqueModels.length === 0) {
      await this.releaseRuntimeRequest(runtimeContext);
      throw new Error("LiteLLM rerank model is not configured");
    }

    const primaryModel = uniqueModels[0];
    let lastError: unknown;
    try {
      for (let index = 0; index < uniqueModels.length; index += 1) {
        const model = uniqueModels[index];
        if (!model) {
          continue;
        }
        try {
          const response = await this.executeRerankWithRetry(
            client,
            cfg,
            apiKeyConfigured,
            model,
            { ...params, query },
            runtimeContext,
          );
          return this.annotateSelectedModel(
            response,
            primaryModel,
            model,
          );
        } catch (error) {
          lastError = error;
          this.recordModelFallbackOrWarn({
            operation: "rerank_fallback",
            models: uniqueModels,
            failedIndex: index,
            error,
            exhaustedMessage: "LiteLLM rerank failed; no fallback remaining",
          });
        }
      }
    } finally {
      await this.releaseRuntimeRequest(runtimeContext);
    }

    const lastMessage =
      lastError instanceof Error ? lastError.message : "unknown upstream error";
    throw new Error(
      `LiteLLM rerank unavailable: all configured rerank models failed (${uniqueModels.join(", ")}). Last error: ${lastMessage}`,
    );
  }

  async *stream(
    params: LiteLlmCompletionParams,
  ): AsyncGenerator<LiteLlmStreamChunk> {
    const requestParams = await this.withResolvedGuardrails(params);
    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("completion");
    const runtimeContext = await this.startRuntimeRequest(
      "stream",
      requestParams.metadata,
      cfg,
    );
    const apiSurface = this.resolveApiSurface(
      (cfg as { apiSurface?: unknown }).apiSurface,
    );
    const uniqueModels = this.uniqueModelList([
      params.model ?? cfg.model,
      ...cfg.fallbackModels,
    ]);
    const requestedModel = uniqueModels[0];

    let lastError: unknown;
    try {
      for (let index = 0; index < uniqueModels.length; index += 1) {
        const model = uniqueModels[index];
        if (!model) {
          continue;
        }
        let started = false;
        try {
          const streamIterator =
            apiSurface === "responses"
              ? this.executeResponsesStream(
                  client,
                  cfg,
                  apiKeyConfigured,
                  model,
                  requestParams,
                  runtimeContext,
                )
              : this.executeStream(
                  client,
                  cfg,
                  apiKeyConfigured,
                  model,
                  requestParams,
                  runtimeContext,
                );

          for await (const chunk of streamIterator) {
            started = true;
            yield this.annotateSelectedModel(chunk, requestedModel, model);
          }
          return;
        } catch (error) {
          if (error instanceof LiteLlmGuardrailViolationError) {
            throw error;
          }
          if (error instanceof LlmCompatibilityError) {
            throw error;
          }
          if (started) {
            throw error;
          }
          lastError = error;
          this.recordModelFallbackOrWarn({
            operation: "stream_fallback",
            models: uniqueModels,
            failedIndex: index,
            error,
            exhaustedMessage: "LiteLLM stream failed; no fallback remaining",
          });
        }
      }
    } finally {
      await this.releaseRuntimeRequest(runtimeContext);
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("LiteLLM stream failed");
  }

  async aresponse(
    params: LiteLlmResponsesParams,
  ): Promise<LiteLlmResponsesResponse> {
    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("completion");
    const runtimeContext = await this.startRuntimeRequest(
      "responses",
      params.metadata,
      cfg,
    );
    const uniqueModels = this.uniqueModelList([
      params.model ?? cfg.model,
      ...cfg.fallbackModels,
    ]);
    const requestedModel = uniqueModels[0];

    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);

    let lastError: unknown;
    try {
      for (let index = 0; index < uniqueModels.length; index += 1) {
        const model = uniqueModels[index];
        if (!model) {
          continue;
        }
        let attempt = 0;
        let delayMs = 1_000;
        try {
          while (attempt < maxAttempts) {
            const attemptStartedAt = Date.now();
            try {
              const payload = {
                model,
                input: params.input,
                temperature: params.temperature ?? cfg.temperature,
                top_p: params.top_p ?? cfg.topP,
                max_output_tokens:
                  params.max_output_tokens ?? cfg.maxOutputTokens,
                metadata: this.resolveMetadata(params.metadata, cfg.sendMetadata),
              };
              const start = Date.now();
              const response =
                await this.postWithFallback<LiteLlmResponsesResponse>(
                  client,
                  "/v1/responses",
                  "/responses",
                  payload,
                  { timeout: params.timeoutMs ?? cfg.timeoutMs },
                );
              const latencyMs = Date.now() - start;
              const headerCost = this.extractHeaderCost(
                response.headers?.["x-litellm-response-cost"] ??
                  response.headers?.["x-litellm-cost"] ??
                  response.headers?.["litellm-cost"],
              );
              const keySpendUsd = this.extractHeaderCost(
                response.headers?.["x-litellm-key-spend"],
              );
              const payloadCost = this.extractHeaderCost(
                (response.data as Record<string, unknown>).response_cost,
              );
              const costUsd = headerCost ?? payloadCost;
              const normalizedResponse = {
                ...response.data,
                ...(typeof costUsd === "number" ? { costUsd } : {}),
                ...(typeof keySpendUsd === "number" ? { keySpendUsd } : {}),
                latencyMs,
              };
              this.logRequest({
                requestType: "responses",
                model:
                  typeof normalizedResponse.model === "string" &&
                  normalizedResponse.model.trim().length > 0
                    ? normalizedResponse.model.trim()
                    : model,
                status: "success",
                orgId: params.orgId,
                metadata: params.metadata,
                latencyMs,
                usage: this.normalizeResponsesUsage(normalizedResponse),
                costUsd,
                apiSurface: "responses",
                runtimeContext,
              });
              return this.annotateSelectedModel(
                normalizedResponse,
                requestedModel,
                model,
              );
            } catch (error) {
              let normalizedError: unknown = error;
              if (!(error instanceof LlmCompatibilityError)) {
                try {
                  this.decorateAxiosError(error, {
                    apiKeyConfigured,
                    apiSurface: "responses",
                  });
                } catch (decoratedError) {
                  normalizedError = decoratedError;
                }
              }
              this.logRequest({
                requestType: "responses",
                model,
                status: "error",
                orgId: params.orgId,
                metadata: params.metadata,
                latencyMs: Date.now() - attemptStartedAt,
                error: normalizedError,
                apiSurface: "responses",
                runtimeContext,
              });
              if (normalizedError instanceof LiteLlmGuardrailViolationError) {
                throw normalizedError;
              }
              if (normalizedError instanceof LlmCompatibilityError) {
                throw normalizedError;
              }
              lastError = normalizedError;
              attempt += 1;
              if (attempt >= maxAttempts || !this.isRetryable(normalizedError)) {
                throw normalizedError;
              }
              await sleep(delayMs);
              delayMs = Math.min(delayMs * 2, 10_000);
            }
          }
        } catch (error) {
          if (error instanceof LiteLlmGuardrailViolationError) {
            throw error;
          }
          if (error instanceof LlmCompatibilityError) {
            throw error;
          }
          lastError = error;
          this.recordModelFallbackOrWarn({
            operation: "responses_fallback",
            models: uniqueModels,
            failedIndex: index,
            error,
            exhaustedMessage:
              "LiteLLM responses request failed; no fallback remaining",
          });
        }
      }
    } finally {
      await this.releaseRuntimeRequest(runtimeContext);
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("LiteLLM responses request failed");
  }

  private async executeResponsesCompletionWithRetry(
    client: AxiosInstance,
    cfg: {
      timeoutMs: number;
      temperature: number;
      topP: number;
      maxOutputTokens: number;
      maxRetries: number;
      sendMetadata: boolean;
      responseFormatMode: LlmGatewayResponseFormatMode;
    },
    apiKeyConfigured: boolean,
    model: string,
    params: LiteLlmCompletionParams,
    runtimeContext: LiteLlmRequestLogContext | null,
  ): Promise<LiteLlmCompletionResponse> {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;
    const guardrails = this.normalizeGuardrails(params.guardrails);

    while (attempt < maxAttempts) {
      const attemptStartedAt = Date.now();
      try {
        const textFormat = this.resolveResponsesTextFormat(
          params.response_format,
          cfg.responseFormatMode,
        );
        const payload = {
          model,
          input: this.toResponsesInput(params.messages),
          temperature: params.temperature ?? cfg.temperature,
          top_p: params.top_p ?? cfg.topP,
          max_output_tokens: params.max_tokens ?? cfg.maxOutputTokens,
          ...(textFormat ? { text: { format: textFormat } } : {}),
          guardrails: guardrails.length > 0 ? guardrails : undefined,
          ...(Array.isArray(params.tools) && params.tools.length > 0
            ? { tools: params.tools }
            : {}),
          metadata: this.resolveMetadata(params.metadata, cfg.sendMetadata),
        };
        const start = Date.now();
        const response = await this.postWithFallback<LiteLlmResponsesResponse>(
          client,
          "/v1/responses",
          "/responses",
          payload,
          { timeout: params.timeoutMs ?? cfg.timeoutMs },
        );
        this.throwIfGuardrailsBlockedResponse(response);
        const latencyMs = Date.now() - start;
        const headerCost = this.extractHeaderCost(
          response.headers?.["x-litellm-response-cost"] ??
            response.headers?.["x-litellm-cost"] ??
            response.headers?.["litellm-cost"],
        );
        const keySpendUsd = this.extractHeaderCost(
          response.headers?.["x-litellm-key-spend"],
        );
        const payloadCost = this.extractHeaderCost(
          (response.data as Record<string, unknown>).response_cost,
        );
        const usageCost = this.extractHeaderCost(
          (response.data as Record<string, unknown>).usage &&
            typeof (response.data as Record<string, unknown>).usage === "object"
            ? (
                (response.data as Record<string, unknown>).usage as Record<
                  string,
                  unknown
                >
              ).response_cost
            : undefined,
        );
        const costUsd = headerCost ?? payloadCost ?? usageCost;
        const normalized = this.normalizeCompletionFromResponses(
          response.data,
          model,
        );
        const normalizedResponse = {
          ...normalized,
          costUsd: costUsd ?? undefined,
          keySpendUsd: keySpendUsd ?? undefined,
          latencyMs,
        } satisfies LiteLlmCompletionResponse;
        this.logRequest({
          requestType: "completion",
          model:
            typeof normalizedResponse.model === "string" &&
            normalizedResponse.model.trim().length > 0
              ? normalizedResponse.model.trim()
              : model,
          status: "success",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs,
          usage: this.normalizeCompletionUsage(normalizedResponse.usage),
          costUsd,
          apiSurface: "responses",
          runtimeContext,
        });
        return normalizedResponse;
      } catch (error) {
        if (error instanceof AxiosError) {
          const guardrailError =
            this.maybeConvertAxiosErrorToGuardrailViolation(error, guardrails);
          if (guardrailError) {
            this.logRequest({
              requestType: "completion",
              model,
              status: "error",
              orgId: params.orgId,
              metadata: params.metadata,
              latencyMs: Date.now() - attemptStartedAt,
              error: guardrailError,
              apiSurface: "responses",
              runtimeContext,
            });
            throw guardrailError;
          }
        }
        if (error instanceof LiteLlmGuardrailViolationError) {
          throw error;
        }
        let normalizedError: unknown = error;
        try {
          this.decorateAxiosError(error, {
            apiKeyConfigured,
            apiSurface: "responses",
          });
        } catch (decoratedError) {
          normalizedError = decoratedError;
        }
        this.logRequest({
          requestType: "completion",
          model,
          status: "error",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs: Date.now() - attemptStartedAt,
          error: normalizedError,
          apiSurface: "responses",
          runtimeContext,
        });
        if (normalizedError instanceof LlmCompatibilityError) {
          throw normalizedError;
        }
        lastError = normalizedError;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(normalizedError)) {
          throw normalizedError;
        }
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 10_000);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("LiteLLM responses completion exhausted retries");
  }

  private async *executeResponsesStream(
    client: AxiosInstance,
    cfg: {
      timeoutMs: number;
      temperature: number;
      topP: number;
      maxOutputTokens: number;
      sendMetadata: boolean;
      responseFormatMode: LlmGatewayResponseFormatMode;
    },
    apiKeyConfigured: boolean,
    model: string,
    params: LiteLlmCompletionParams,
    runtimeContext: LiteLlmRequestLogContext | null,
  ): AsyncGenerator<LiteLlmStreamChunk> {
    const requestStartedAt = Date.now();
    let streamUsage: LiteLlmTokenUsageSnapshot = {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
    let streamCostUsd: number | null = null;
    const guardrails = this.normalizeGuardrails(params.guardrails);
    const textFormat = this.resolveResponsesTextFormat(
      params.response_format,
      cfg.responseFormatMode,
    );
    const payload = {
      model,
      input: this.toResponsesInput(params.messages),
      temperature: params.temperature ?? cfg.temperature,
      top_p: params.top_p ?? cfg.topP,
      max_output_tokens: params.max_tokens ?? cfg.maxOutputTokens,
      ...(textFormat ? { text: { format: textFormat } } : {}),
      stream: true,
      guardrails: guardrails.length > 0 ? guardrails : undefined,
      ...(Array.isArray(params.tools) && params.tools.length > 0
        ? { tools: params.tools }
        : {}),
      metadata: this.resolveMetadata(params.metadata, cfg.sendMetadata),
    };

    let response: AxiosResponse;
    try {
      response = await this.postWithFallback(
        client,
        "/v1/responses",
        "/responses",
        payload,
        {
          responseType: "stream",
          timeout: params.timeoutMs ?? cfg.timeoutMs,
          headers: { Accept: "text/event-stream" },
        },
      );
    } catch (error) {
      if (error instanceof AxiosError) {
        const guardrailError =
          this.maybeConvertAxiosErrorToGuardrailViolation(error, guardrails);
        if (guardrailError) {
          this.logRequest({
            requestType: "stream",
            model,
            status: "error",
            orgId: params.orgId,
            metadata: params.metadata,
            latencyMs: Date.now() - requestStartedAt,
            error: guardrailError,
            apiSurface: "responses",
            runtimeContext,
          });
          throw guardrailError;
        }
      }
      let normalizedError: unknown = error;
      try {
        this.decorateAxiosError(error, {
          apiKeyConfigured,
          apiSurface: "responses",
        });
      } catch (decoratedError) {
        normalizedError = decoratedError;
      }
      this.logRequest({
        requestType: "stream",
        model,
        status: "error",
        orgId: params.orgId,
        metadata: params.metadata,
        latencyMs: Date.now() - requestStartedAt,
        error: normalizedError,
        apiSurface: "responses",
        runtimeContext,
      });
      throw normalizedError;
    }

    const stream = response.data as Readable;
    streamCostUsd =
      this.toNullableNumber(
        this.extractHeaderCost(
          response.headers?.["x-litellm-response-cost"] ??
            response.headers?.["x-litellm-cost"] ??
            response.headers?.["litellm-cost"],
        ),
      ) ?? streamCostUsd;
    const contentTypeRaw = response.headers?.["content-type"];
    const contentType =
      typeof contentTypeRaw === "string" ? contentTypeRaw.toLowerCase() : "";
    try {
      if (contentType && !contentType.includes("text/event-stream")) {
        const bodyText = await this.readReadableToString(stream, 128 * 1024);
        try {
          const parsed = JSON.parse(bodyText) as unknown;
          const message = this.extractGuardrailBlockedMessage(parsed);
          if (message) {
            const appliedGuardrails = this.getAppliedGuardrailsFromHeaders(
              response.headers,
            );
            const normalized = this.buildUserFacingGuardrailMessage(message);
            throw new LiteLlmGuardrailViolationError(normalized.message, {
              code: normalized.code,
              appliedGuardrails,
              upstreamStatus: response.status,
              detail:
                sanitizeUpstreamErrorText(bodyText, { maxLength: 500 }) ||
                undefined,
            });
          }
        } catch (error) {
          if (error instanceof LiteLlmGuardrailViolationError) {
            throw error;
          }
        }
        this.logger.warn(
          {
            model,
            contentType: contentTypeRaw,
            bodyPreview: sanitizeUpstreamErrorText(bodyText, {
              maxLength: 500,
            }),
          },
          "LiteLLM responses stream returned non-SSE response",
        );
        throw new Error(
          `LiteLLM responses stream returned non-SSE response (${typeof contentTypeRaw === "string" ? contentTypeRaw : "unknown content-type"})`,
        );
      }

      for await (const data of this.iterateSseData(stream)) {
        if (data.trim() === "[DONE]") {
          this.logRequest({
            requestType: "stream",
            model,
            status: "success",
            orgId: params.orgId,
            metadata: params.metadata,
            latencyMs: Date.now() - requestStartedAt,
            usage: streamUsage,
            costUsd: streamCostUsd,
            apiSurface: "responses",
            runtimeContext,
          });
          return;
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          continue;
        }

        const usageAndCost = this.extractStreamUsageAndCost(parsed);
        streamUsage = this.mergeUsage(streamUsage, usageAndCost.usage);
        if (usageAndCost.costUsd !== null) {
          streamCostUsd = usageAndCost.costUsd;
        }

        const responsesChunk = this.extractResponsesStreamChunk(parsed);
        if (responsesChunk?.error) {
          throw new Error(responsesChunk.error);
        }
        if (responsesChunk?.delta || responsesChunk?.finishReason) {
          yield {
            model,
            raw: parsed,
            ...(responsesChunk.delta ? { delta: responsesChunk.delta } : {}),
            ...(responsesChunk.finishReason
              ? { finishReason: responsesChunk.finishReason }
              : {}),
          };
          continue;
        }

        // Fallback for gateways that still stream chat-completions style chunks.
        if (parsed && typeof parsed === "object") {
          const parsedRecord = parsed as {
            choices?: {
              delta?: { content?: string | null };
              finish_reason?: string | null;
            }[];
          };
          const choice = parsedRecord.choices?.[0];
          const delta = choice?.delta?.content;
          const finishReason =
            typeof choice?.finish_reason === "string"
              ? choice.finish_reason
              : undefined;
          if (typeof delta === "string" && delta.length > 0) {
            yield { model, raw: parsed, delta, finishReason };
          } else if (
            typeof finishReason === "string" &&
            finishReason.length > 0
          ) {
            yield { model, raw: parsed, finishReason };
          }
        }
      }

      this.logRequest({
        requestType: "stream",
        model,
        status: "success",
        orgId: params.orgId,
        metadata: params.metadata,
        latencyMs: Date.now() - requestStartedAt,
        usage: streamUsage,
        costUsd: streamCostUsd,
        apiSurface: "responses",
        runtimeContext,
      });
    } catch (error) {
      this.logRequest({
        requestType: "stream",
        model,
        status: "error",
        orgId: params.orgId,
        metadata: params.metadata,
        latencyMs: Date.now() - requestStartedAt,
        error,
        usage: streamUsage,
        costUsd: streamCostUsd,
        apiSurface: "responses",
        runtimeContext,
      });
      throw error;
    }
  }

  private async executeWithRetry(
    client: AxiosInstance,
    cfg: {
      timeoutMs: number;
      temperature: number;
      topP: number;
      maxOutputTokens: number;
      maxRetries: number;
      sendMetadata: boolean;
      responseFormatMode: LlmGatewayResponseFormatMode;
    },
    apiKeyConfigured: boolean,
    model: string,
    params: LiteLlmCompletionParams,
    runtimeContext: LiteLlmRequestLogContext | null,
  ) {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;
    const guardrails = this.normalizeGuardrails(params.guardrails);

    while (attempt < maxAttempts) {
      const attemptStartedAt = Date.now();
      try {
        const payload = {
          model,
          messages: params.messages,
          temperature: params.temperature ?? cfg.temperature,
          top_p: params.top_p ?? cfg.topP,
          max_tokens: params.max_tokens ?? cfg.maxOutputTokens,
          response_format: this.resolveResponseFormat(
            params.response_format,
            cfg.responseFormatMode,
          ),
          stream: false,
          guardrails: guardrails.length > 0 ? guardrails : undefined,
          ...(Array.isArray(params.tools) && params.tools.length > 0
            ? { tools: params.tools }
            : {}),
          metadata: this.resolveMetadata(params.metadata, cfg.sendMetadata),
        };
        const start = Date.now();
        const response = await this.postWithFallback<LiteLlmCompletionResponse>(
          client,
          "/v1/chat/completions",
          "/chat/completions",
          payload,
          { timeout: params.timeoutMs ?? cfg.timeoutMs },
        );
        this.throwIfGuardrailsBlockedResponse(response);
        const latencyMs = Date.now() - start;
        const headerCost = this.extractHeaderCost(
          response.headers?.["x-litellm-response-cost"] ??
            response.headers?.["x-litellm-cost"] ??
            response.headers?.["litellm-cost"],
        );
        const keySpendUsd = this.extractHeaderCost(
          response.headers?.["x-litellm-key-spend"],
        );
        const payloadCost = this.extractHeaderCost(
          asRecord(response.data).response_cost,
        );
        const usageCost = this.extractHeaderCost(
          response.data.usage
            ? asRecord(response.data.usage)
                .response_cost
            : undefined,
        );
        const costUsd = headerCost ?? payloadCost ?? usageCost;
        const normalized = this.normalizeCompletionResponse(response.data);
        const normalizedResponse = {
          ...normalized,
          costUsd: costUsd ?? undefined,
          keySpendUsd: keySpendUsd ?? undefined,
          latencyMs,
        } satisfies LiteLlmCompletionResponse;
        this.logRequest({
          requestType: "completion",
          model:
            typeof normalizedResponse.model === "string" &&
            normalizedResponse.model.trim().length > 0
              ? normalizedResponse.model.trim()
              : model,
          status: "success",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs,
          usage: this.normalizeCompletionUsage(normalizedResponse.usage),
          costUsd,
          apiSurface: "chat_completions",
          runtimeContext,
        });
        return normalizedResponse;
      } catch (error) {
        if (error instanceof AxiosError) {
          const guardrailError =
            this.maybeConvertAxiosErrorToGuardrailViolation(error, guardrails);
          if (guardrailError) {
            this.logRequest({
              requestType: "completion",
              model,
              status: "error",
              orgId: params.orgId,
              metadata: params.metadata,
              latencyMs: Date.now() - attemptStartedAt,
              error: guardrailError,
              apiSurface: "chat_completions",
              runtimeContext,
            });
            throw guardrailError;
          }
        }
        if (error instanceof LiteLlmGuardrailViolationError) {
          throw error;
        }
        let normalizedError: unknown = error;
        try {
          this.decorateAxiosError(error, {
            apiKeyConfigured,
            apiSurface: "chat_completions",
          });
        } catch (decoratedError) {
          normalizedError = decoratedError;
        }
        this.logRequest({
          requestType: "completion",
          model,
          status: "error",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs: Date.now() - attemptStartedAt,
          error: normalizedError,
          apiSurface: "chat_completions",
          runtimeContext,
        });
        if (normalizedError instanceof LlmCompatibilityError) {
          throw normalizedError;
        }
        lastError = normalizedError;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(normalizedError)) {
          throw normalizedError;
        }
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 10_000);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("LiteLLM completion exhausted retries");
  }

  private async *executeStream(
    client: AxiosInstance,
    cfg: {
      timeoutMs: number;
      temperature: number;
      topP: number;
      maxOutputTokens: number;
      sendMetadata: boolean;
      responseFormatMode: LlmGatewayResponseFormatMode;
    },
    apiKeyConfigured: boolean,
    model: string,
    params: LiteLlmCompletionParams,
    runtimeContext: LiteLlmRequestLogContext | null,
  ): AsyncGenerator<LiteLlmStreamChunk> {
    const requestStartedAt = Date.now();
    let streamUsage: LiteLlmTokenUsageSnapshot = {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
    let streamCostUsd: number | null = null;
    const guardrails = this.normalizeGuardrails(params.guardrails);
    const payload = {
      model,
      messages: params.messages,
      temperature: params.temperature ?? cfg.temperature,
      top_p: params.top_p ?? cfg.topP,
      max_tokens: params.max_tokens ?? cfg.maxOutputTokens,
      response_format: this.resolveResponseFormat(
        params.response_format,
        cfg.responseFormatMode,
      ),
      stream: true,
      guardrails: guardrails.length > 0 ? guardrails : undefined,
      ...(Array.isArray(params.tools) && params.tools.length > 0
        ? { tools: params.tools }
        : {}),
      metadata: this.resolveMetadata(params.metadata, cfg.sendMetadata),
    };

    let response: AxiosResponse;
    try {
      response = await this.postWithFallback(
        client,
        "/v1/chat/completions",
        "/chat/completions",
        payload,
        {
          responseType: "stream",
          timeout: params.timeoutMs ?? cfg.timeoutMs,
          headers: { Accept: "text/event-stream" },
        },
      );
    } catch (error) {
      if (error instanceof AxiosError) {
        const guardrailError =
          this.maybeConvertAxiosErrorToGuardrailViolation(error, guardrails);
        if (guardrailError) {
          this.logRequest({
            requestType: "stream",
            model,
            status: "error",
            orgId: params.orgId,
            metadata: params.metadata,
            latencyMs: Date.now() - requestStartedAt,
            error: guardrailError,
            apiSurface: "chat_completions",
            runtimeContext,
          });
          throw guardrailError;
        }
      }
      let normalizedError: unknown = error;
      try {
        this.decorateAxiosError(error, {
          apiKeyConfigured,
          apiSurface: "chat_completions",
        });
      } catch (decoratedError) {
        normalizedError = decoratedError;
      }
      this.logRequest({
        requestType: "stream",
        model,
        status: "error",
        orgId: params.orgId,
        metadata: params.metadata,
        latencyMs: Date.now() - requestStartedAt,
        error: normalizedError,
        apiSurface: "chat_completions",
        runtimeContext,
      });
      throw normalizedError;
    }
    const stream = response.data as Readable;
    streamCostUsd =
      this.toNullableNumber(
        this.extractHeaderCost(
          response.headers?.["x-litellm-response-cost"] ??
            response.headers?.["x-litellm-cost"] ??
            response.headers?.["litellm-cost"],
        ),
      ) ?? streamCostUsd;
    const contentTypeRaw = response.headers?.["content-type"];
    const contentType =
      typeof contentTypeRaw === "string" ? contentTypeRaw.toLowerCase() : "";
    try {
      if (contentType && !contentType.includes("text/event-stream")) {
        const bodyText = await this.readReadableToString(stream, 128 * 1024);
        try {
          const parsed = JSON.parse(bodyText) as unknown;
          const message = this.extractGuardrailBlockedMessage(parsed);
          if (message) {
            const appliedGuardrails = this.getAppliedGuardrailsFromHeaders(
              response.headers,
            );
            const normalized = this.buildUserFacingGuardrailMessage(message);
            throw new LiteLlmGuardrailViolationError(normalized.message, {
              code: normalized.code,
              appliedGuardrails,
              upstreamStatus: response.status,
              detail:
                sanitizeUpstreamErrorText(bodyText, { maxLength: 500 }) ||
                undefined,
            });
          }
        } catch (error) {
          if (error instanceof LiteLlmGuardrailViolationError) {
            throw error;
          }
        }

        this.logger.warn(
          { model, contentType: contentTypeRaw },
          "LiteLLM stream returned non-SSE response",
        );
        throw new Error(
          `LiteLLM stream returned non-SSE response (${typeof contentTypeRaw === "string" ? contentTypeRaw : "unknown content-type"})`,
        );
      }

      for await (const data of this.iterateSseData(stream)) {
        if (data.trim() === "[DONE]") {
          this.logRequest({
            requestType: "stream",
            model,
            status: "success",
            orgId: params.orgId,
            metadata: params.metadata,
            latencyMs: Date.now() - requestStartedAt,
            usage: streamUsage,
            costUsd: streamCostUsd,
            apiSurface: "chat_completions",
            runtimeContext,
          });
          return;
        }
        let parsed: {
          choices?: {
            delta?: { content?: string | null };
            finish_reason?: string | null;
          }[];
        } | null = null;
        try {
          parsed = JSON.parse(data) as {
            choices?: {
              delta?: { content?: string | null };
              finish_reason?: string | null;
            }[];
          };
        } catch {
          continue;
        }

        const usageAndCost = this.extractStreamUsageAndCost(parsed);
        streamUsage = this.mergeUsage(streamUsage, usageAndCost.usage);
        if (usageAndCost.costUsd !== null) {
          streamCostUsd = usageAndCost.costUsd;
        }

        const choice = parsed?.choices?.[0];
        const delta = choice?.delta?.content;
        const finishReason =
          typeof choice?.finish_reason === "string"
            ? choice.finish_reason
            : undefined;
        if (typeof delta === "string" && delta.length > 0) {
          yield { model, raw: parsed, delta, finishReason };
        } else if (
          typeof finishReason === "string" &&
          finishReason.length > 0
        ) {
          yield { model, raw: parsed, finishReason };
        }
      }

      this.logRequest({
        requestType: "stream",
        model,
        status: "success",
        orgId: params.orgId,
        metadata: params.metadata,
        latencyMs: Date.now() - requestStartedAt,
        usage: streamUsage,
        costUsd: streamCostUsd,
        apiSurface: "chat_completions",
        runtimeContext,
      });
    } catch (error) {
      this.logRequest({
        requestType: "stream",
        model,
        status: "error",
        orgId: params.orgId,
        metadata: params.metadata,
        latencyMs: Date.now() - requestStartedAt,
        error,
        usage: streamUsage,
        costUsd: streamCostUsd,
        apiSurface: "chat_completions",
        runtimeContext,
      });
      throw error;
    }
  }

  private normalizeCompletionResponse(
    data: LiteLlmCompletionResponse,
  ): LiteLlmCompletionResponse {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const normalizedChoices = choices.map((choice) => {
      const content = extractOpenAiTextFromChoice(choice as unknown);
      const rawMessage =
        choice && typeof choice === "object"
          ? asRecord(choice).message
          : undefined;
      const role =
        rawMessage &&
        typeof rawMessage === "object" &&
        typeof asRecord(rawMessage).role === "string"
          ? (asRecord(rawMessage).role as string)
          : "assistant";

      const messageRecord =
        rawMessage && typeof rawMessage === "object"
          ? asRecord(rawMessage)
          : {};

      return {
        ...asRecord(choice),
        message: {
          ...messageRecord,
          role,
          content,
        },
      } as LiteLlmCompletionChoice;
    });

    return {
      ...data,
      choices: normalizedChoices,
    };
  }

  private normalizeCompletionFromResponses(
    data: LiteLlmResponsesResponse,
    model: string,
  ): LiteLlmCompletionResponse {
    const record = data as Record<string, unknown>;
    const id =
      typeof record.id === "string" && record.id.trim().length > 0
        ? record.id
        : `resp_${Date.now()}`;
    const resolvedModel =
      typeof record.model === "string" && record.model.trim().length > 0
        ? record.model.trim()
        : model;
    const created = this.toUnixSeconds(record.created_at ?? record.created);
    const content = this.extractResponsesOutputText(data);
    const finishReasonRaw =
      typeof record.finish_reason === "string"
        ? record.finish_reason
        : typeof record.status === "string"
          ? record.status
          : undefined;
    const usage = this.normalizeCompletionUsageFromResponses(record.usage);
    const responseCost = this.extractHeaderCost(record.response_cost);

    return {
      id,
      model: resolvedModel,
      created,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          ...(finishReasonRaw ? { finish_reason: finishReasonRaw } : {}),
        },
      ],
      ...(usage ? { usage } : {}),
      ...(typeof responseCost === "number"
        ? { response_cost: responseCost }
        : {}),
    };
  }

  private normalizeCompletionUsageFromResponses(
    raw: unknown,
  ): LiteLlmCompletionResponseUsage | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    const promptTokens = this.extractHeaderCost(
      record.prompt_tokens ?? record.input_tokens,
    );
    const completionTokens = this.extractHeaderCost(
      record.completion_tokens ?? record.output_tokens,
    );
    const totalTokens = this.extractHeaderCost(record.total_tokens);
    if (
      typeof promptTokens !== "number" ||
      typeof completionTokens !== "number"
    ) {
      return undefined;
    }
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens:
        typeof totalTokens === "number"
          ? totalTokens
          : promptTokens + completionTokens,
    };
  }

  private toResponsesInput(messages: LiteLlmMessage[]) {
    return messages.map((message) => ({
      role: message.role,
      content: this.flattenMessageContent(message.content),
    }));
  }

  private flattenMessageContent(content: LiteLlmMessage["content"]): string {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }

  private resolveResponsesTextFormat(
    responseFormat:
      | JsonSchemaResponseFormat
      | Record<string, unknown>
      | undefined,
    mode: LlmGatewayResponseFormatMode,
  ): Record<string, unknown> | undefined {
    if (mode === "none") {
      return undefined;
    }
    if (mode === "json_object") {
      return { type: "json_object" };
    }
    if (!responseFormat || typeof responseFormat !== "object") {
      return undefined;
    }
    const candidate = responseFormat as Record<string, unknown>;
    if (
      candidate.type === "json_schema" ||
      candidate.type === "json_object" ||
      candidate.type === "text"
    ) {
      return candidate;
    }
    return undefined;
  }

  private extractResponsesOutputText(
    response: LiteLlmResponsesResponse,
  ): string | null {
    if (typeof response.output_text === "string") {
      const trimmed = response.output_text.trim();
      return trimmed.length > 0 ? response.output_text : null;
    }

    const record = response as Record<string, unknown>;
    const output = record.output;
    if (!Array.isArray(output)) {
      return null;
    }

    const parts: string[] = [];
    output.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        return;
      }
      content.forEach((entry) => {
        if (!entry || typeof entry !== "object") {
          return;
        }
        const text = (entry as Record<string, unknown>).text;
        if (typeof text === "string" && text.length > 0) {
          parts.push(text);
        }
      });
    });

    if (parts.length === 0) {
      return null;
    }
    return parts.join("");
  }

  private extractResponsesStreamChunk(raw: unknown): {
    delta?: string;
    finishReason?: string;
    error?: string;
  } | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (type === "response.error" || type === "error") {
      const error = record.error;
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim().length > 0) {
          return { error: message.trim() };
        }
      }
      if (
        typeof record.message === "string" &&
        record.message.trim().length > 0
      ) {
        return { error: record.message.trim() };
      }
      return { error: "Responses stream failed" };
    }

    if (type === "response.completed") {
      return { finishReason: "stop" };
    }

    const delta =
      typeof record.delta === "string"
        ? record.delta
        : typeof record.output_text === "string"
          ? record.output_text
          : undefined;
    if (
      typeof delta === "string" &&
      delta.length > 0 &&
      type.includes("output_text")
    ) {
      return { delta };
    }

    return null;
  }

  private toUnixSeconds(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 10_000_000_000) {
        return Math.floor(value / 1_000);
      }
      return Math.floor(value);
    }
    return Math.floor(Date.now() / 1_000);
  }

  private async executeEmbeddingWithRetry(
    client: AxiosInstance,
    cfg: { timeoutMs: number; maxRetries: number; sendMetadata: boolean },
    apiKeyConfigured: boolean,
    model: string,
    params: LiteLlmEmbeddingParams,
    runtimeContext: LiteLlmRequestLogContext | null,
  ) {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      const attemptStartedAt = Date.now();
      try {
        const payload = {
          model,
          input: params.input,
          metadata: this.resolveMetadata(params.metadata, cfg.sendMetadata),
        };
        const start = Date.now();
        const response = await this.postWithFallback<LiteLlmEmbeddingResponse>(
          client,
          "/v1/embeddings",
          "/embeddings",
          payload,
          { timeout: params.timeoutMs ?? cfg.timeoutMs },
        );
        const latencyMs = Date.now() - start;
        const headerCost = this.extractHeaderCost(
          response.headers?.["x-litellm-response-cost"] ??
            response.headers?.["x-litellm-cost"] ??
            response.headers?.["litellm-cost"],
        );
        const keySpendUsd = this.extractHeaderCost(
          response.headers?.["x-litellm-key-spend"],
        );
        const payloadCost = this.extractHeaderCost(
          asRecord(response.data).response_cost,
        );
        const usageCost = this.extractHeaderCost(
          response.data.usage
            ? asRecord(response.data.usage)
                .response_cost
            : undefined,
        );
        const costUsd = headerCost ?? payloadCost ?? usageCost;
        const normalizedResponse = {
          ...response.data,
          costUsd: costUsd ?? undefined,
          keySpendUsd: keySpendUsd ?? undefined,
          latencyMs,
        } satisfies LiteLlmEmbeddingResponse;
        this.logRequest({
          requestType: "embedding",
          model:
            typeof normalizedResponse.model === "string" &&
            normalizedResponse.model.trim().length > 0
              ? normalizedResponse.model.trim()
              : model,
          status: "success",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs,
          usage: this.normalizeEmbeddingUsage(normalizedResponse.usage),
          costUsd,
          apiSurface: "embeddings",
          runtimeContext,
        });
        return normalizedResponse;
      } catch (error) {
        let normalizedError: unknown = error;
        try {
          this.decorateAxiosError(error, {
            apiKeyConfigured,
            apiSurface: "embeddings",
          });
        } catch (decoratedError) {
          normalizedError = decoratedError;
        }
        this.logRequest({
          requestType: "embedding",
          model,
          status: "error",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs: Date.now() - attemptStartedAt,
          error: normalizedError,
          apiSurface: "embeddings",
          runtimeContext,
        });
        if (normalizedError instanceof LlmCompatibilityError) {
          throw normalizedError;
        }
        lastError = normalizedError;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(normalizedError)) {
          throw normalizedError;
        }
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 10_000);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("LiteLLM embedding exhausted retries");
  }

  private async executeRerankWithRetry(
    client: AxiosInstance,
    cfg: { timeoutMs: number; maxRetries: number; sendMetadata: boolean },
    apiKeyConfigured: boolean,
    model: string,
    params: LiteLlmRerankParams,
    runtimeContext: LiteLlmRequestLogContext | null,
  ): Promise<LiteLlmRerankResponse> {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      const attemptStartedAt = Date.now();
      try {
        const payload = {
          model,
          query: params.query,
          documents: params.documents,
          top_n: params.topN ?? params.documents.length,
          metadata: this.resolveMetadata(params.metadata, cfg.sendMetadata),
        };
        const start = Date.now();
        const response = await this.postWithFallback<Record<string, unknown>>(
          client,
          "/v1/rerank",
          "/rerank",
          payload,
          { timeout: params.timeoutMs ?? cfg.timeoutMs },
        );
        const latencyMs = Date.now() - start;
        const normalizedResults = this.normalizeRerankResults(response.data);
        if (normalizedResults.length === 0) {
          throw new Error("LiteLLM rerank returned no usable results");
        }
        const headerCost = this.extractHeaderCost(
          response.headers?.["x-litellm-response-cost"] ??
            response.headers?.["x-litellm-cost"] ??
            response.headers?.["litellm-cost"],
        );
        const keySpendUsd = this.extractHeaderCost(
          response.headers?.["x-litellm-key-spend"],
        );
        const payloadCost = this.extractHeaderCost(
          (response.data as Record<string, unknown>).response_cost,
        );
        const costUsd = headerCost ?? payloadCost;
        const responseModel = this.resolveRerankModel(response.data, model);
        const normalizedResponse = {
          model: responseModel,
          results: normalizedResults,
          ...(typeof payloadCost === "number"
            ? { response_cost: payloadCost }
            : {}),
          ...(typeof costUsd === "number" ? { costUsd } : {}),
          ...(typeof keySpendUsd === "number" ? { keySpendUsd } : {}),
          latencyMs,
        } satisfies LiteLlmRerankResponse;
        this.logRequest({
          requestType: "rerank",
          model:
            typeof normalizedResponse.model === "string" &&
            normalizedResponse.model.trim().length > 0
              ? normalizedResponse.model.trim()
              : model,
          status: "success",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs,
          usage: {
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
          },
          costUsd,
          apiSurface: "rerank",
          runtimeContext,
        });
        return normalizedResponse;
      } catch (error) {
        let normalizedError: unknown = error;
        try {
          this.decorateAxiosError(error, {
            apiKeyConfigured,
            apiSurface: "rerank",
          });
        } catch (decoratedError) {
          normalizedError = decoratedError;
        }
        this.logRequest({
          requestType: "rerank",
          model,
          status: "error",
          orgId: params.orgId,
          metadata: params.metadata,
          latencyMs: Date.now() - attemptStartedAt,
          error: normalizedError,
          apiSurface: "rerank",
          runtimeContext,
        });
        if (normalizedError instanceof LlmCompatibilityError) {
          throw normalizedError;
        }
        lastError = normalizedError;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(normalizedError)) {
          throw normalizedError;
        }
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 10_000);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("LiteLLM rerank exhausted retries");
  }

  private async *iterateSseData(stream: Readable): AsyncGenerator<string> {
    yield* iterateSseDataFromReadable(stream);
  }

  private resolveRerankModel(
    payload: Record<string, unknown>,
    fallbackModel: string,
  ): string {
    const candidate = payload.model;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
    return fallbackModel;
  }

  private normalizeRerankResults(payload: unknown): LiteLlmRerankResult[] {
    if (!payload || typeof payload !== "object") {
      return [];
    }
    const record = payload as Record<string, unknown>;
    const rawResults = Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.data)
        ? record.data
        : [];

    const normalized = rawResults
      .map((entry): LiteLlmRerankResult | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const row = entry as Record<string, unknown>;
        const indexRaw = row.index;
        const scoreRaw =
          row.relevance_score ??
          row.relevanceScore ??
          row.score ??
          row.similarity;
        const index =
          typeof indexRaw === "number" && Number.isInteger(indexRaw)
            ? indexRaw
            : null;
        const score =
          typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
            ? scoreRaw
            : typeof scoreRaw === "string" && scoreRaw.trim().length > 0
              ? Number(scoreRaw)
              : Number.NaN;
        if (index === null || !Number.isFinite(score)) {
          return null;
        }
        return { index, score };
      })
      .filter((entry): entry is LiteLlmRerankResult => Boolean(entry))
      .sort((a, b) => b.score - a.score);

    return normalized;
  }

  private async postWithFallback<T = unknown>(
    client: AxiosInstance,
    primaryPath: string,
    fallbackPath: string,
    payload: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    try {
      return await client.post<T>(primaryPath, payload, config);
    } catch (error) {
      if (
        error instanceof AxiosError &&
        typeof error.response?.status === "number" &&
        [404, 405].includes(error.response.status)
      ) {
        return client.post<T>(fallbackPath, payload, config);
      }
      throw error;
    }
  }

  private extractAxiosErrorText(error: AxiosError) {
    const responseData = error.response?.data as unknown;
    if (!responseData) {
      return error.message || "";
    }
    if (typeof responseData === "string") {
      const trimmed = responseData.trim();
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("<!doctype") || lower.includes("<html")) {
        const titleMatch = trimmed.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
        if (titleMatch?.[1]) {
          return titleMatch[1].trim();
        }
        const h1Match = trimmed.match(/<h1[^>]*>([^<]{1,200})<\/h1>/i);
        if (h1Match?.[1]) {
          return h1Match[1].trim();
        }
        return "HTML error response";
      }
      return responseData;
    }
    if (typeof responseData === "object") {
      const record = responseData as Record<string, unknown>;
      const errorField = record.error;
      if (errorField && typeof errorField === "object") {
        const message = (errorField as { message?: unknown }).message;
        if (typeof message === "string") {
          return message;
        }
      }
      const message = record.message;
      if (typeof message === "string") {
        return message;
      }
      if (Array.isArray(message)) {
        return message.filter((entry) => typeof entry === "string").join("; ");
      }
      try {
        return JSON.stringify(record);
      } catch {
        return error.message || "";
      }
    }
    return String(responseData);
  }

  private decorateAxiosError(
    error: unknown,
    context: {
      apiKeyConfigured: boolean;
      apiSurface?: LlmApiSurface;
    },
  ) {
    if (!(error instanceof AxiosError)) {
      return;
    }
    const status = error.response?.status;
    if (typeof status !== "number") {
      return;
    }

    let detail = sanitizeUpstreamErrorText(this.extractAxiosErrorText(error), {
      maxLength: 500,
    });

    const compatibilityIssue = detectOpenAiCompatibilityIssue({
      status,
      errorText: detail,
      apiSurface:
        context.apiSurface === "rerank" ? undefined : context.apiSurface,
    });
    if (compatibilityIssue) {
      throw new LlmCompatibilityError(compatibilityIssue, { cause: error });
    }

    const lowerDetail = detail.toLowerCase();
    if (status === 401 || status === 403) {
      const authHint = this.buildAuthHint(status, context.apiKeyConfigured);
      if (
        !detail ||
        lowerDetail === "unauthorized" ||
        lowerDetail === "forbidden"
      ) {
        detail = authHint;
      } else if (
        !lowerDetail.includes("apikey") &&
        !lowerDetail.includes("api key")
      ) {
        detail = `${detail} (${authHint})`;
      }
    }
    detail = sanitizeUpstreamErrorText(detail, { maxLength: 500 });

    error.message = `LiteLLM request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`;
  }

  private buildAuthHint(status: number, apiKeyConfigured: boolean) {
    const base = status === 403 ? "Forbidden" : "Unauthorized";
    if (apiKeyConfigured) {
      return `${base} (check apiKey)`;
    }
    return `${base} (apiKey is not configured)`;
  }

  private isRetryable(error: unknown) {
    if (!(error instanceof AxiosError)) {
      return false;
    }
    const status = error.response?.status;
    return (
      !status || [408, 409, 423, 425, 429, 500, 502, 503, 504].includes(status)
    );
  }

  private buildClientKey(baseUrl: string, apiKey: string | undefined) {
    if (!apiKey) {
      return `${baseUrl}::`;
    }
    const digest = createHash("sha256").update(apiKey).digest("hex");
    return `${baseUrl}::${digest}`;
  }

  private getClient(cfg: {
    apiBase: string;
    apiKey?: string;
    timeoutMs: number;
  }) {
    const baseUrl = normalizeOpenAiApiBase(cfg.apiBase);
    const apiKey = normalizeOpenAiApiKey(cfg.apiKey);
    const apiKeyConfigured = Boolean(apiKey);
    const key = this.buildClientKey(baseUrl, apiKey);
    const existing = this.clients.get(key);
    if (existing) {
      return { client: existing, baseUrl, apiKeyConfigured };
    }

    const client = axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    this.clients.set(key, client);
    return { client, baseUrl, apiKeyConfigured };
  }

  private async prepareRequest(kind: "completion" | "embedding" | "rerank") {
    const cfg: LlmGatewayResolvedConfig =
      kind === "embedding"
        ? await this.resolveEmbeddingConfig()
        : kind === "rerank"
          ? await this.resolveRerankConfig()
          : await this.resolveCompletionConfig();

    const { client, baseUrl, apiKeyConfigured } = this.getClient(cfg);
    return { cfg, client, baseUrl, apiKeyConfigured };
  }

  private async resolveCompletionConfig(): Promise<LlmGatewayResolvedConfig> {
    const pipelineCfg = this.configService.config;
    const overrides = await this.llmGatewaySettings.getActiveConfig();
    if (!overrides || !overrides.model?.trim()) {
      throw new Error(ERROR_COMPLETION_MODEL_NOT_CONFIGURED);
    }
    const merged = { ...pipelineCfg.litellm, ...overrides };
    merged.model = overrides.model.trim();
    merged.fallbackModels = overrides.fallbackModels ?? [];
    return {
      ...merged,
      assistantModel: overrides?.assistantModel,
      assistantWebSearchEnabled: overrides?.assistantWebSearchEnabled ?? false,
      sendMetadata: this.resolveSendMetadata(overrides?.sendMetadata),
      responseFormatMode: this.resolveResponseFormatMode(
        overrides?.responseFormatMode,
      ),
      apiSurface: this.resolveApiSurface(overrides?.apiSurface),
      managedByLiteLlmProxyGovernance:
        overrides?.managedByLiteLlmProxyGovernance === true,
      governanceAuthMode: overrides?.governanceAuthMode ?? "profile_key",
      governanceTargetProfileId: overrides?.governanceTargetProfileId ?? null,
    };
  }

  private async resolveEmbeddingConfig(): Promise<LlmGatewayResolvedConfig> {
    const pipelineCfg = this.configService.config;
    const overrides = await this.llmGatewaySettings.getActiveEmbeddingConfig();
    if (!overrides || !overrides.embeddingModel?.trim()) {
      throw new Error(ERROR_EMBEDDING_MODEL_NOT_CONFIGURED);
    }
    const merged = { ...pipelineCfg.litellm, ...overrides };
    merged.embeddingModel = overrides.embeddingModel.trim();
    return {
      ...merged,
      assistantModel: overrides?.assistantModel,
      assistantWebSearchEnabled: overrides?.assistantWebSearchEnabled ?? false,
      sendMetadata: this.resolveSendMetadata(overrides?.sendMetadata),
      responseFormatMode: this.resolveResponseFormatMode(
        overrides?.responseFormatMode,
      ),
      apiSurface: this.resolveApiSurface(overrides?.apiSurface),
      managedByLiteLlmProxyGovernance:
        overrides?.managedByLiteLlmProxyGovernance === true,
      governanceAuthMode: overrides?.governanceAuthMode ?? "profile_key",
      governanceTargetProfileId: overrides?.governanceTargetProfileId ?? null,
    };
  }

  private async resolveRerankConfig(): Promise<LlmGatewayResolvedConfig> {
    const pipelineCfg = this.configService.config;
    const overrides = await this.llmGatewaySettings.getActiveRerankConfig();
    if (!overrides || !overrides.rerankModel?.trim()) {
      throw new Error(ERROR_RERANK_MODEL_NOT_CONFIGURED);
    }
    const merged = { ...pipelineCfg.litellm, ...overrides };
    merged.rerankModel = overrides.rerankModel.trim();
    merged.rerankFallbackModels = overrides.rerankFallbackModels ?? [];

    return {
      ...merged,
      assistantModel: overrides?.assistantModel,
      assistantWebSearchEnabled: overrides?.assistantWebSearchEnabled ?? false,
      sendMetadata: this.resolveSendMetadata(overrides?.sendMetadata),
      responseFormatMode: this.resolveResponseFormatMode(
        overrides?.responseFormatMode,
      ),
      apiSurface: this.resolveApiSurface(overrides?.apiSurface),
      managedByLiteLlmProxyGovernance:
        overrides?.managedByLiteLlmProxyGovernance === true,
      governanceAuthMode: overrides?.governanceAuthMode ?? "profile_key",
      governanceTargetProfileId: overrides?.governanceTargetProfileId ?? null,
    };
  }

  private uniqueModelList(models: (string | undefined | null)[]): string[] {
    return Array.from(
      new Set(
        models
          .filter(
            (model): model is string =>
              typeof model === "string" && model.trim().length > 0,
          )
          .map((model) => model.trim()),
      ),
    );
  }

  private annotateSelectedModel<T extends { model?: string }>(
    response: T,
    requestedModel: string | undefined,
    usedModel: string,
  ): T {
    const resolvedModel =
      typeof response.model === "string" && response.model.trim().length > 0
        ? response.model.trim()
        : usedModel;
    return {
      ...response,
      model: resolvedModel,
      requestedModel,
      fallbackUsed: Boolean(requestedModel && usedModel !== requestedModel),
    };
  }

  private recordModelFallbackOrWarn(input: {
    operation: string;
    models: string[];
    failedIndex: number;
    error: unknown;
    exhaustedMessage: string;
  }): void {
    const primaryModel = input.models[0] ?? "";
    const failedModel = input.models[input.failedIndex] ?? "";
    const nextModel = input.models[input.failedIndex + 1];
    if (!nextModel) {
      this.logger.warn(
        {
          model: failedModel,
          message:
            input.error instanceof Error ? input.error.message : "unknown error",
        },
        input.exhaustedMessage,
      );
      return;
    }

    recordIntegrationEvent({
      integration: "litellm",
      operation: input.operation,
      status: "fallback",
    });
    this.logger.warn(
      {
        primaryModel,
        failedModel,
        nextModel,
        message:
          input.error instanceof Error ? input.error.message : "unknown error",
      },
      "LiteLLM model fallback engaged",
    );
  }

  private logRequest(params: {
    requestType: LlmRequestType;
    model: string;
    status: "success" | "error";
    orgId?: string;
    metadata: Record<string, unknown> | undefined;
    latencyMs: number;
    error?: unknown;
    usage?: LiteLlmTokenUsageSnapshot;
    costUsd?: number | null;
    apiSurface?: LlmApiSurface;
    runtimeContext?: LiteLlmRequestLogContext | null;
  }) {
    void this.writeRequestLog(params);
  }

  private async writeRequestLog(params: {
    requestType: LlmRequestType;
    model: string;
    status: "success" | "error";
    orgId?: string;
    metadata: Record<string, unknown> | undefined;
    latencyMs: number;
    error?: unknown;
    usage?: LiteLlmTokenUsageSnapshot;
    costUsd?: number | null;
    apiSurface?: LlmApiSurface;
    runtimeContext?: LiteLlmRequestLogContext | null;
  }) {
    this.llmRequestLogService.logRequest({
      orgId: this.resolveLogOrgId(params.orgId, params.metadata),
      requestType: params.requestType,
      model: params.model,
      status: params.status,
      promptTokens: params.usage?.promptTokens ?? null,
      completionTokens: params.usage?.completionTokens ?? null,
      totalTokens: params.usage?.totalTokens ?? null,
      costUsd: this.toNullableNumber(params.costUsd),
      feature:
        params.runtimeContext?.feature ??
        this.resolveFeatureToken(params.metadata) ??
        null,
      gatewayProfileId: params.runtimeContext?.gatewayProfileId ?? null,
      governanceApplied: params.runtimeContext?.governanceApplied ?? null,
      authMode: params.runtimeContext?.authMode ?? null,
      governanceTargetProfileId:
        params.runtimeContext?.governanceTargetProfileId ?? null,
      latencyMs: this.normalizeLatency(params.latencyMs),
      error:
        params.status === "error" ? this.normalizeLogError(params.error) : null,
      metadata: params.metadata ?? null,
      apiSurface: params.apiSurface ?? null,
    });
  }

  private async startRuntimeRequest(
    requestType: LlmRequestType,
    metadata?: Record<string, unknown>,
    cfg?: Pick<
      LlmGatewayResolvedConfig,
      | "profileId"
      | "managedByLiteLlmProxyGovernance"
      | "governanceAuthMode"
      | "governanceTargetProfileId"
    >,
  ): Promise<LiteLlmRequestLogContext | null> {
    void requestType;
    return Promise.resolve({
      feature: this.resolveFeatureToken(metadata),
      gatewayProfileId:
        typeof cfg?.profileId === "string" && cfg.profileId.trim().length > 0
          ? cfg.profileId.trim()
          : null,
      governanceApplied:
        cfg?.managedByLiteLlmProxyGovernance === true ? true : false,
      authMode: cfg?.governanceAuthMode ?? "profile_key",
      governanceTargetProfileId:
        typeof cfg?.governanceTargetProfileId === "string" &&
        cfg.governanceTargetProfileId.trim().length > 0
          ? cfg.governanceTargetProfileId.trim()
          : null,
    });
  }

  private async releaseRuntimeRequest(
    runtimeContext: LiteLlmRequestLogContext | null,
  ): Promise<void> {
    void runtimeContext;
  }

  private resolveLogOrgId(
    orgId: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): string {
    const explicit = this.normalizeOrgId(orgId);
    const metadataOrgId = this.normalizeOrgId(metadata?.orgId);
    if (explicit) {
      if (metadataOrgId && metadataOrgId !== explicit) {
        this.logOrgIdMismatchTotal += 1;
        this.logger.warn(
          {
            explicitOrgId: explicit,
            metadataOrgId,
            metricName: "llm_request_log_org_id_mismatch_total",
            metricOutcome: "mismatch",
            logOrgIdMismatchTotal: this.logOrgIdMismatchTotal,
          },
          "Explicit orgId differs from metadata.orgId for LLM request log",
        );
      }
      return explicit;
    }
    return metadataOrgId ?? UNKNOWN_ORG_ID;
  }

  private normalizeOrgId(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeLogError(error: unknown): string | null {
    if (error instanceof Error) {
      const message = error.message.trim();
      if (!message) {
        return null;
      }
      return message.slice(0, MAX_LOG_ERROR_LENGTH);
    }
    if (typeof error === "string") {
      const message = error.trim();
      if (!message) {
        return null;
      }
      return message.slice(0, MAX_LOG_ERROR_LENGTH);
    }
    return null;
  }

  private resolveFeatureToken(
    metadata: Record<string, unknown> | undefined,
  ): string | null {
    const candidate =
      this.normalizeFeatureToken(metadata?.feature) ??
      this.normalizeFeatureToken(metadata?.source) ??
      this.normalizeFeatureToken(metadata?.module);
    return candidate ?? null;
  }

  private normalizeFeatureToken(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized.length > 64) {
      return null;
    }
    return /^[a-z0-9_:\-.]+$/.test(normalized) ? normalized : null;
  }

  private normalizeLatency(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return 0;
    }
    return Math.trunc(numeric);
  }

  private toNullableNumber(value: unknown): number | null {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return numeric;
  }

  private normalizeCompletionUsage(
    usage: LiteLlmCompletionResponse["usage"] | undefined,
  ): LiteLlmTokenUsageSnapshot {
    if (!usage) {
      return { promptTokens: null, completionTokens: null, totalTokens: null };
    }
    const promptTokens = this.toNullableNumber(usage.prompt_tokens);
    const completionTokens = this.toNullableNumber(usage.completion_tokens);
    const totalTokens =
      this.toNullableNumber(usage.total_tokens) ??
      (promptTokens !== null && completionTokens !== null
        ? promptTokens + completionTokens
        : null);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  private normalizeEmbeddingUsage(
    usage: LiteLlmEmbeddingResponse["usage"] | undefined,
  ): LiteLlmTokenUsageSnapshot {
    if (!usage) {
      return { promptTokens: null, completionTokens: null, totalTokens: null };
    }
    const promptTokens = this.toNullableNumber(usage.prompt_tokens);
    const totalTokens =
      this.toNullableNumber(usage.total_tokens) ?? promptTokens;
    return {
      promptTokens,
      completionTokens: null,
      totalTokens,
    };
  }

  private normalizeResponsesUsage(
    payload: LiteLlmResponsesResponse,
  ): LiteLlmTokenUsageSnapshot {
    const record = payload as Record<string, unknown>;
    const usage = this.extractUsageFromUnknown(record.usage);
    if (
      usage.totalTokens !== null ||
      usage.promptTokens !== null ||
      usage.completionTokens !== null
    ) {
      return usage;
    }
    return this.extractUsageFromUnknown(record);
  }

  private extractUsageFromUnknown(raw: unknown): LiteLlmTokenUsageSnapshot {
    if (!raw || typeof raw !== "object") {
      return { promptTokens: null, completionTokens: null, totalTokens: null };
    }
    const record = raw as Record<string, unknown>;
    const promptTokens = this.toNullableNumber(
      record.prompt_tokens ?? record.input_tokens,
    );
    const completionTokens = this.toNullableNumber(
      record.completion_tokens ?? record.output_tokens,
    );
    const totalTokens =
      this.toNullableNumber(record.total_tokens) ??
      (promptTokens !== null && completionTokens !== null
        ? promptTokens + completionTokens
        : promptTokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  private mergeUsage(
    current: LiteLlmTokenUsageSnapshot,
    next: LiteLlmTokenUsageSnapshot,
  ): LiteLlmTokenUsageSnapshot {
    return {
      promptTokens: next.promptTokens ?? current.promptTokens,
      completionTokens: next.completionTokens ?? current.completionTokens,
      totalTokens: next.totalTokens ?? current.totalTokens,
    };
  }

  private extractStreamUsageAndCost(raw: unknown): {
    usage: LiteLlmTokenUsageSnapshot;
    costUsd: number | null;
  } {
    if (!raw || typeof raw !== "object") {
      return {
        usage: {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        },
        costUsd: null,
      };
    }

    const record = raw as Record<string, unknown>;
    const usageFromUsageField = this.extractUsageFromUnknown(record.usage);
    const usageFromRoot = this.extractUsageFromUnknown(record);
    const usage =
      usageFromUsageField.promptTokens !== null ||
      usageFromUsageField.completionTokens !== null ||
      usageFromUsageField.totalTokens !== null
        ? usageFromUsageField
        : usageFromRoot;

    const nestedUsageCost =
      record.usage && typeof record.usage === "object"
        ? this.extractHeaderCost(
            (record.usage as Record<string, unknown>).response_cost,
          )
        : undefined;
    const costUsd = this.toNullableNumber(
      this.extractHeaderCost(record.response_cost) ??
        this.extractHeaderCost(record.cost) ??
        nestedUsageCost,
    );

    return {
      usage,
      costUsd,
    };
  }

  private extractHeaderCost(value: unknown) {
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    return undefined;
  }

  private resolveSendMetadata(value: unknown): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    return DEFAULT_SEND_METADATA;
  }

  private resolveResponseFormatMode(
    value: unknown,
  ): LlmGatewayResponseFormatMode {
    if (
      value === "none" ||
      value === "json_object" ||
      value === "json_schema"
    ) {
      return value;
    }
    return DEFAULT_RESPONSE_FORMAT_MODE;
  }

  private resolveApiSurface(value: unknown): LlmGatewayApiSurface {
    if (value === "responses" || value === "chat_completions") {
      return value;
    }
    return "chat_completions";
  }

  private resolveMetadata(
    metadata: Record<string, unknown> | undefined,
    sendMetadata: boolean,
  ): Record<string, unknown> | undefined {
    if (!sendMetadata) {
      return undefined;
    }
    return metadata;
  }

  private resolveResponseFormat(
    responseFormat:
      | JsonSchemaResponseFormat
      | Record<string, unknown>
      | undefined,
    mode: LlmGatewayResponseFormatMode,
  ): JsonSchemaResponseFormat | Record<string, unknown> | undefined {
    if (mode === "none") {
      return undefined;
    }
    if (mode === "json_object") {
      return { type: "json_object" };
    }
    return responseFormat;
  }

  private async withResolvedGuardrails(
    params: LiteLlmCompletionParams,
  ): Promise<LiteLlmCompletionParams> {
    return {
      ...params,
      guardrails: await this.resolveRequestGuardrails(params),
    };
  }

  private async resolveRequestGuardrails(
    params: LiteLlmCompletionParams,
  ): Promise<string[] | undefined> {
    if (params.guardrails !== undefined) {
      const explicit = this.normalizeGuardrails(params.guardrails);
      return explicit.length > 0 ? explicit : undefined;
    }
    if (!this.isUntrustedContentPath(params.metadata)) {
      return undefined;
    }
    const config = await this.assistantSafety.getEffectiveConfig();
    if (!config.enabled) {
      return undefined;
    }
    return [OPENAI_MODERATION_PRE_GUARDRAIL];
  }

  private isUntrustedContentPath(
    metadata: Record<string, unknown> | undefined,
  ): boolean {
    const tokens = [
      this.normalizeFeatureToken(metadata?.source),
      this.normalizeFeatureToken(metadata?.feature),
      this.normalizeFeatureToken(metadata?.stage),
    ].filter((token): token is string => Boolean(token));
    return tokens.some((token) => UNTRUSTED_CONTENT_FEATURE_TOKENS.has(token));
  }

  private normalizeGuardrails(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const normalized = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return Array.from(new Set(normalized));
  }

  private getAppliedGuardrailsFromHeaders(headers: unknown): string[] {
    if (!headers || typeof headers !== "object") {
      return [];
    }
    const record = headers as Record<string, unknown>;
    const raw =
      record["x-litellm-applied-guardrails"] ??
      record["x-litellm-applied-guardrails".toLowerCase()];
    return this.parseAppliedGuardrailsHeader(raw);
  }

  private parseAppliedGuardrailsHeader(value: unknown): string[] {
    if (Array.isArray(value)) {
      const flat = value
        .filter((entry): entry is string => typeof entry === "string")
        .flatMap((entry) => entry.split(","));
      return Array.from(
        new Set(
          flat.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
        ),
      );
    }
    if (typeof value !== "string") {
      return [];
    }
    return Array.from(
      new Set(
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  private extractGuardrailBlockedMessage(data: unknown): string | null {
    if (!data || typeof data !== "object") {
      return null;
    }
    const record = data as Record<string, unknown>;
    const messagesRaw = record.messages;
    if (!Array.isArray(messagesRaw) || messagesRaw.length === 0) {
      return null;
    }
    const choicesRaw = record.choices;
    const hasChoices = Array.isArray(choicesRaw) && choicesRaw.length > 0;
    if (hasChoices) {
      return null;
    }
    const first = messagesRaw[0];
    if (first && typeof first === "object") {
      const content = (first as { content?: unknown }).content;
      if (typeof content === "string" && content.trim().length > 0) {
        return content.trim();
      }
    }
    return "Unable to complete request: blocked by content safety policy.";
  }

  private throwIfGuardrailsBlockedResponse(response: AxiosResponse) {
    const rawMessage = this.extractGuardrailBlockedMessage(response.data);
    if (!rawMessage) {
      return;
    }
    const appliedGuardrails = this.getAppliedGuardrailsFromHeaders(
      response.headers,
    );
    const normalized = this.buildUserFacingGuardrailMessage(rawMessage);
    throw new LiteLlmGuardrailViolationError(normalized.message, {
      code: normalized.code,
      appliedGuardrails,
      upstreamStatus: response.status,
    });
  }

  private maybeConvertAxiosErrorToGuardrailViolation(
    error: AxiosError,
    requestedGuardrails: string[] = [],
  ): LiteLlmGuardrailViolationError | null {
    const status = error.response?.status;
    const appliedGuardrails = this.getAppliedGuardrailsFromHeaders(
      error.response?.headers,
    );
    const structured = this.extractStructuredGuardrailSignal(
      error.response?.data,
    );
    const detail = sanitizeUpstreamErrorText(
      structured.detail || this.extractAxiosErrorText(error),
      { maxLength: 500 },
    );
    const lower = detail.toLowerCase();

    const isDefiniteGuardrail =
      lower.includes("violated guardrail") ||
      lower.includes("guardrail_intervened") ||
      (lower.includes("guardrail") &&
        (lower.includes("policy") ||
          lower.includes("blocked") ||
          lower.includes("reject")));

    const isInjection =
      lower.includes("prompt injection") ||
      lower.includes("promptinjection") ||
      lower.includes("jailbreak");

    const isTrustSafety =
      (lower.includes("trust") &&
        lower.includes("safety") &&
        lower.includes("violation")) ||
      lower.includes("trust & safety violation");

    const isModeration =
      lower.includes("moderation") &&
      (lower.includes("flag") ||
        lower.includes("blocked") ||
        lower.includes("violate"));

    const looksLikeGuardrail =
      isDefiniteGuardrail || isInjection || isTrustSafety || isModeration;
    const requestedClientError =
      requestedGuardrails.length > 0 &&
      typeof status === "number" &&
      GUARDRAIL_CLIENT_ERROR_STATUSES.has(status);
    const shouldConvert =
      appliedGuardrails.length > 0 ||
      structured.matched ||
      requestedClientError ||
      (typeof status === "number" && looksLikeGuardrail);

    if (!shouldConvert) {
      return null;
    }

    const normalized = this.buildUserFacingGuardrailMessage(detail);
    return new LiteLlmGuardrailViolationError(normalized.message, {
      code: normalized.code,
      appliedGuardrails,
      upstreamStatus: typeof status === "number" ? status : undefined,
      detail: detail || undefined,
      cause: error,
    });
  }

  private extractStructuredGuardrailSignal(data: unknown): {
    matched: boolean;
    detail: string;
  } {
    if (!data || typeof data !== "object") {
      return { matched: false, detail: "" };
    }
    const record = data as Record<string, unknown>;
    const errorObj =
      record.error && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : null;
    const metadata =
      errorObj?.metadata && typeof errorObj.metadata === "object"
        ? (errorObj.metadata as Record<string, unknown>)
        : record.metadata && typeof record.metadata === "object"
          ? (record.metadata as Record<string, unknown>)
          : null;
    const parts = [
      typeof record.message === "string" ? record.message : "",
      errorObj && typeof errorObj.message === "string" ? errorObj.message : "",
      errorObj && typeof errorObj.type === "string" ? errorObj.type : "",
      errorObj && typeof errorObj.code === "string" ? String(errorObj.code) : "",
      errorObj && typeof errorObj.param === "string" ? errorObj.param : "",
      metadata && typeof metadata.guardrail === "string"
        ? metadata.guardrail
        : "",
      metadata && typeof metadata.guardrail_name === "string"
        ? metadata.guardrail_name
        : "",
    ].filter((part) => part.length > 0);
    const joined = parts.join(" ");
    return {
      matched: STRUCTURED_GUARDRAIL_SIGNAL.test(joined.toLowerCase()),
      detail: joined,
    };
  }

  private buildUserFacingGuardrailMessage(detail: string): {
    message: string;
    code: LiteLlmGuardrailViolationCode;
  } {
    const raw = typeof detail === "string" ? detail.trim() : "";
    const lower = raw.toLowerCase();
    if (
      lower.includes("guardrail") &&
      (lower.includes("not found") || lower.includes("unknown"))
    ) {
      return {
        message:
          "AI safety checks are misconfigured (guardrail not found). Please contact an administrator.",
        code: "GUARDRAIL_MISCONFIG",
      };
    }
    if (
      lower.includes("prompt injection") ||
      lower.includes("promptinjection") ||
      lower.includes("jailbreak")
    ) {
      return {
        message:
          "Unable to complete request: prompt injection/jailbreak detected.",
        code: "PROMPT_INJECTION",
      };
    }
    if (
      lower.includes("trust") &&
      lower.includes("safety") &&
      lower.includes("violation")
    ) {
      return {
        message:
          "Unable to complete request: trust & safety violation detected.",
        code: "TRUST_SAFETY_VIOLATION",
      };
    }
    if (lower.includes("language") && lower.includes("violation")) {
      return {
        message:
          "Unable to complete request: language policy violation detected.",
        code: "LANGUAGE_POLICY_VIOLATION",
      };
    }
    if (lower.includes("moderation")) {
      return {
        message: "Unable to complete request: blocked by content moderation.",
        code: "MODERATION_BLOCKED",
      };
    }
    if (lower.includes("guardrail")) {
      return {
        message:
          "Unable to complete request: blocked by content safety guardrails.",
        code: "GUARDRAIL_BLOCKED",
      };
    }
    return {
      message: "Unable to complete request: blocked by content safety policy.",
      code: "GUARDRAIL_BLOCKED",
    };
  }

  private async readReadableToString(
    stream: Readable,
    maxBytes: number,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > maxBytes) {
        chunks.push(
          buf.subarray(0, Math.max(0, maxBytes - (total - buf.length))),
        );
        break;
      }
      chunks.push(buf);
    }

    return Buffer.concat(chunks).toString("utf8");
  }
}
