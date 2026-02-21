import { createLogger } from "@modular/utils";
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
import { RateLimiterService } from "../cache/rate-limiter.service";
import {
  LlmGatewaySettingsService,
  type LlmGatewayApiSurface,
  type LlmGatewayResponseFormatMode,
} from "../system-settings/llm-gateway-settings.service";

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
}

export interface LiteLlmEmbeddingParams {
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
}

export interface LiteLlmStreamChunk {
  model: string;
  raw: unknown;
  delta?: string;
  finishReason?: string;
}

export interface LiteLlmResponsesParams {
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
  [key: string]: unknown;
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

@Injectable()
export class LiteLlmService {
  private readonly clients = new Map<string, AxiosInstance>();
  private readonly logger = createLogger({ name: "litellm-service" });

  constructor(
    private readonly configService: NewsPipelineConfigService,
    private readonly rateLimiter: RateLimiterService,
    private readonly llmGatewaySettings: LlmGatewaySettingsService,
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
    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("completion");
    const apiSurface = this.resolveApiSurface(
      (cfg as { apiSurface?: unknown }).apiSurface,
    );
    const models = [params.model ?? cfg.model, ...cfg.fallbackModels];
    const uniqueModels = Array.from(
      new Set(
        models.filter((model) => typeof model === "string" && model.length > 0),
      ),
    );
    let lastError: unknown;
    for (const model of uniqueModels) {
      try {
        if (apiSurface === "responses") {
          return await this.executeResponsesCompletionWithRetry(
            client,
            cfg,
            apiKeyConfigured,
            model,
            params,
          );
        }

        return await this.executeWithRetry(
          client,
          cfg,
          apiKeyConfigured,
          model,
          params,
        );
      } catch (error) {
        if (error instanceof LiteLlmGuardrailViolationError) {
          throw error;
        }
        if (error instanceof LlmCompatibilityError) {
          throw error;
        }
        lastError = error;
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error",
          },
          "LiteLLM completion failed; evaluating fallback",
        );
      }
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
    const model = params.model ?? cfg.embeddingModel ?? cfg.model;
    if (!model) {
      throw new Error("LiteLLM embedding model is not configured");
    }
    return this.executeEmbeddingWithRetry(
      client,
      cfg,
      apiKeyConfigured,
      model,
      params,
    );
  }

  async rerank(
    params: LiteLlmRerankParams,
  ): Promise<LiteLlmRerankResponse> {
    if (!Array.isArray(params.documents) || params.documents.length === 0) {
      throw new Error("LiteLLM rerank documents are required");
    }
    const query = params.query.trim();
    if (!query) {
      throw new Error("LiteLLM rerank query is required");
    }

    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("rerank");
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
      throw new Error("LiteLLM rerank model is not configured");
    }

    let lastError: unknown;
    for (const model of uniqueModels) {
      try {
        return await this.executeRerankWithRetry(
          client,
          cfg,
          apiKeyConfigured,
          model,
          { ...params, query },
        );
      } catch (error) {
        lastError = error;
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error",
          },
          "LiteLLM rerank failed; evaluating backup model",
        );
      }
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
    const { cfg, client, apiKeyConfigured } =
      await this.prepareRequest("completion");
    const apiSurface = this.resolveApiSurface(
      (cfg as { apiSurface?: unknown }).apiSurface,
    );
    const models = [params.model ?? cfg.model, ...cfg.fallbackModels];
    const uniqueModels = Array.from(
      new Set(
        models.filter((model) => typeof model === "string" && model.length > 0),
      ),
    );

    let lastError: unknown;
    for (const model of uniqueModels) {
      let started = false;
      try {
        const streamIterator =
          apiSurface === "responses"
            ? this.executeResponsesStream(
                client,
                cfg,
                apiKeyConfigured,
                model,
                params,
              )
            : this.executeStream(client, cfg, apiKeyConfigured, model, params);

        for await (const chunk of streamIterator) {
          started = true;
          yield chunk;
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
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error",
          },
          "LiteLLM stream failed; evaluating fallback",
        );
      }
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
    const models = [params.model ?? cfg.model, ...cfg.fallbackModels];
    const uniqueModels = Array.from(
      new Set(
        models.filter((model) => typeof model === "string" && model.length > 0),
      ),
    );

    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);

    let lastError: unknown;
    for (const model of uniqueModels) {
      let attempt = 0;
      let delayMs = 1_000;
      while (attempt < maxAttempts) {
        try {
          const payload = {
            model,
            input: params.input,
            temperature: params.temperature ?? cfg.temperature,
            top_p: params.top_p ?? cfg.topP,
            max_output_tokens: params.max_output_tokens ?? cfg.maxOutputTokens,
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
          return {
            ...response.data,
            ...(typeof costUsd === "number" ? { costUsd } : {}),
            ...(typeof keySpendUsd === "number" ? { keySpendUsd } : {}),
            latencyMs,
          };
        } catch (error) {
          if (error instanceof LlmCompatibilityError) {
            throw error;
          }
          this.decorateAxiosError(error, {
            apiKeyConfigured,
            apiSurface: "responses",
          });
          lastError = error;
          attempt += 1;
          if (attempt >= maxAttempts || !this.isRetryable(error)) {
            throw error;
          }
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 10_000);
        }
      }
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
  ): Promise<LiteLlmCompletionResponse> {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
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
          guardrails: guardrails.length > 0 ? guardrails : undefined,
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
        return {
          ...normalized,
          costUsd: costUsd ?? undefined,
          keySpendUsd: keySpendUsd ?? undefined,
          latencyMs,
        } satisfies LiteLlmCompletionResponse;
      } catch (error) {
        this.decorateAxiosError(error, {
          apiKeyConfigured,
          apiSurface: "responses",
        });
        lastError = error;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(error)) {
          throw error;
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
  ): AsyncGenerator<LiteLlmStreamChunk> {
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
      this.decorateAxiosError(error, {
        apiKeyConfigured,
        apiSurface: "responses",
      });
      throw error;
    }

    const stream = response.data as Readable;
    const contentTypeRaw = response.headers?.["content-type"];
    const contentType =
      typeof contentTypeRaw === "string" ? contentTypeRaw.toLowerCase() : "";
    if (contentType && !contentType.includes("text/event-stream")) {
      const bodyText = await this.readReadableToString(stream, 128 * 1024);
      this.logger.warn(
        {
          model,
          contentType: contentTypeRaw,
          bodyPreview: sanitizeUpstreamErrorText(bodyText, { maxLength: 500 }),
        },
        "LiteLLM responses stream returned non-SSE response",
      );
      throw new Error(
        `LiteLLM responses stream returned non-SSE response (${typeof contentTypeRaw === "string" ? contentTypeRaw : "unknown content-type"})`,
      );
    }

    for await (const data of this.iterateSseData(stream)) {
      if (data.trim() === "[DONE]") {
        return;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        continue;
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
  ) {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
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
          stream: false,
          guardrails: guardrails.length > 0 ? guardrails : undefined,
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
          (response.data as unknown as Record<string, unknown>).response_cost,
        );
        const usageCost = this.extractHeaderCost(
          response.data.usage
            ? (response.data.usage as unknown as Record<string, unknown>)
                .response_cost
            : undefined,
        );
        const costUsd = headerCost ?? payloadCost ?? usageCost;
        const normalized = this.normalizeCompletionResponse(response.data);
        return {
          ...normalized,
          costUsd: costUsd ?? undefined,
          keySpendUsd: keySpendUsd ?? undefined,
          latencyMs,
        } satisfies LiteLlmCompletionResponse;
      } catch (error) {
        if (error instanceof AxiosError) {
          const guardrailError =
            this.maybeConvertAxiosErrorToGuardrailViolation(error);
          if (guardrailError) {
            throw guardrailError;
          }
        }
        this.decorateAxiosError(error, {
          apiKeyConfigured,
          apiSurface: "chat_completions",
        });
        lastError = error;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(error)) {
          throw error;
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
  ): AsyncGenerator<LiteLlmStreamChunk> {
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
          this.maybeConvertAxiosErrorToGuardrailViolation(error);
        if (guardrailError) {
          throw guardrailError;
        }
      }
      this.decorateAxiosError(error, {
        apiKeyConfigured,
        apiSurface: "chat_completions",
      });
      throw error;
    }
    const stream = response.data as Readable;
    const contentTypeRaw = response.headers?.["content-type"];
    const contentType =
      typeof contentTypeRaw === "string" ? contentTypeRaw.toLowerCase() : "";
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

      const choice = parsed?.choices?.[0];
      const delta = choice?.delta?.content;
      const finishReason =
        typeof choice?.finish_reason === "string"
          ? choice.finish_reason
          : undefined;
      if (typeof delta === "string" && delta.length > 0) {
        yield { model, raw: parsed, delta, finishReason };
      } else if (typeof finishReason === "string" && finishReason.length > 0) {
        yield { model, raw: parsed, finishReason };
      }
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
          ? (choice as unknown as Record<string, unknown>).message
          : undefined;
      const role =
        rawMessage &&
        typeof rawMessage === "object" &&
        typeof (rawMessage as Record<string, unknown>).role === "string"
          ? ((rawMessage as Record<string, unknown>).role as string)
          : "assistant";

      const messageRecord =
        rawMessage && typeof rawMessage === "object"
          ? (rawMessage as Record<string, unknown>)
          : {};

      return {
        ...(choice as unknown as Record<string, unknown>),
        message: {
          ...messageRecord,
          role,
          content,
        },
      } as unknown as LiteLlmCompletionChoice;
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
    responseFormat: JsonSchemaResponseFormat | Record<string, unknown> | undefined,
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

  private extractResponsesOutputText(response: LiteLlmResponsesResponse): string | null {
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
      if (typeof record.message === "string" && record.message.trim().length > 0) {
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
  ) {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
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
          (response.data as unknown as Record<string, unknown>).response_cost,
        );
        const usageCost = this.extractHeaderCost(
          response.data.usage
            ? (response.data.usage as unknown as Record<string, unknown>)
                .response_cost
            : undefined,
        );
        const costUsd = headerCost ?? payloadCost ?? usageCost;
        return {
          ...response.data,
          costUsd: costUsd ?? undefined,
          keySpendUsd: keySpendUsd ?? undefined,
          latencyMs,
        } satisfies LiteLlmEmbeddingResponse;
      } catch (error) {
        this.decorateAxiosError(error, {
          apiKeyConfigured,
          apiSurface: "embeddings",
        });
        lastError = error;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(error)) {
          throw error;
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
  ): Promise<LiteLlmRerankResponse> {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
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
        return {
          model: responseModel,
          results: normalizedResults,
          ...(typeof payloadCost === "number"
            ? { response_cost: payloadCost }
            : {}),
          ...(typeof costUsd === "number" ? { costUsd } : {}),
          ...(typeof keySpendUsd === "number" ? { keySpendUsd } : {}),
          latencyMs,
        } satisfies LiteLlmRerankResponse;
      } catch (error) {
        this.decorateAxiosError(error, {
          apiKeyConfigured,
          apiSurface: "chat_completions",
        });
        lastError = error;
        attempt += 1;
        if (attempt >= maxAttempts || !this.isRetryable(error)) {
          throw error;
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
      apiSurface?: "chat_completions" | "embeddings" | "responses";
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
      apiSurface: context.apiSurface,
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
    const pipelineCfg = this.configService.config;
    const cfg =
      kind === "embedding"
        ? await this.resolveEmbeddingConfig()
        : kind === "rerank"
          ? await this.resolveRerankConfig()
        : await this.resolveCompletionConfig();
    const limitKey = `litellm:rpm:${kind}`;
    const allowed = await this.rateLimiter.consume(
      limitKey,
      cfg.requestsPerMinute,
      pipelineCfg.pipeline.rateLimitWindowSeconds,
    );
    if (!allowed) {
      throw new Error("LiteLLM request throttled by local rate limiter");
    }

    const { client, baseUrl, apiKeyConfigured } = this.getClient(cfg);
    return { cfg, client, baseUrl, apiKeyConfigured };
  }

  private async resolveCompletionConfig() {
    const pipelineCfg = this.configService.config;
    const overrides = await this.llmGatewaySettings.getActiveConfig();
    if (!overrides || !overrides.model?.trim()) {
      throw new Error(ERROR_COMPLETION_MODEL_NOT_CONFIGURED);
    }
    const merged = overrides
      ? { ...pipelineCfg.litellm, ...overrides }
      : { ...pipelineCfg.litellm };
    merged.model = overrides.model.trim();
    merged.fallbackModels = overrides.fallbackModels ?? [];
    return {
      ...merged,
      sendMetadata: this.resolveSendMetadata(overrides?.sendMetadata),
      responseFormatMode: this.resolveResponseFormatMode(
        overrides?.responseFormatMode,
      ),
      apiSurface: this.resolveApiSurface(overrides?.apiSurface),
    };
  }

  private async resolveEmbeddingConfig() {
    const pipelineCfg = this.configService.config;
    const overrides = await this.llmGatewaySettings.getActiveEmbeddingConfig();
    if (!overrides || !overrides.embeddingModel?.trim()) {
      throw new Error(ERROR_EMBEDDING_MODEL_NOT_CONFIGURED);
    }
    const merged = overrides
      ? { ...pipelineCfg.litellm, ...overrides }
      : { ...pipelineCfg.litellm };
    merged.embeddingModel = overrides.embeddingModel.trim();
    return {
      ...merged,
      sendMetadata: this.resolveSendMetadata(overrides?.sendMetadata),
      responseFormatMode: this.resolveResponseFormatMode(
        overrides?.responseFormatMode,
      ),
    };
  }

  private async resolveRerankConfig() {
    const pipelineCfg = this.configService.config;
    const overrides = await this.llmGatewaySettings.getActiveRerankConfig();
    if (!overrides || !overrides.rerankModel?.trim()) {
      throw new Error(ERROR_RERANK_MODEL_NOT_CONFIGURED);
    }
    const merged = overrides
      ? { ...pipelineCfg.litellm, ...overrides }
      : { ...pipelineCfg.litellm };
    merged.rerankModel = overrides.rerankModel.trim();
    merged.rerankFallbackModels = overrides.rerankFallbackModels ?? [];

    return {
      ...merged,
      sendMetadata: this.resolveSendMetadata(overrides?.sendMetadata),
      responseFormatMode: this.resolveResponseFormatMode(
        overrides?.responseFormatMode,
      ),
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
    if (value === "none" || value === "json_object" || value === "json_schema") {
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
    responseFormat: JsonSchemaResponseFormat | Record<string, unknown> | undefined,
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
  ): LiteLlmGuardrailViolationError | null {
    const status = error.response?.status;
    if (typeof status !== "number") {
      return null;
    }

    const appliedGuardrails = this.getAppliedGuardrailsFromHeaders(
      error.response?.headers,
    );
    const detail = sanitizeUpstreamErrorText(
      this.extractAxiosErrorText(error),
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
    const shouldConvert =
      looksLikeGuardrail ||
      (appliedGuardrails.length > 0 && [400, 403, 422].includes(status));

    if (!shouldConvert) {
      return null;
    }

    const normalized = this.buildUserFacingGuardrailMessage(detail);
    return new LiteLlmGuardrailViolationError(normalized.message, {
      code: normalized.code,
      appliedGuardrails,
      upstreamStatus: status,
      detail: detail || undefined,
      cause: error,
    });
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
