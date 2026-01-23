import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
  AxiosInstance,
} from "axios";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { RateLimiterService } from "../cache/rate-limiter.service";
import { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";

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

export interface LiteLlmStreamChunk {
  model: string;
  raw: unknown;
  delta?: string;
  finishReason?: string;
}

interface GatewayCompatibilityFlags {
  supportsMetadata: boolean;
  supportsResponseFormat: boolean;
  supportsJsonSchema: boolean;
}

@Injectable()
export class LiteLlmService {
  private client: AxiosInstance;
  private currentBaseUrl: string;
  private currentApiKey?: string;
  private readonly logger = createLogger({ name: "litellm-service" });
  private readonly compatibility = new Map<string, GatewayCompatibilityFlags>();

  constructor(
    private readonly configService: NewsPipelineConfigService,
    private readonly rateLimiter: RateLimiterService,
    private readonly llmGatewaySettings: LlmGatewaySettingsService,
  ) {
    this.currentBaseUrl = "";
    this.currentApiKey = undefined;
    this.client = this.buildClient(this.configService.config.litellm);
  }

  async getEmbeddingModel(): Promise<string | undefined> {
    const cfg = await this.resolveConfig();
    return cfg.embeddingModel;
  }

  async getCompletionModels(): Promise<string[]> {
    const cfg = await this.resolveConfig();
    const models = [cfg.model, ...cfg.fallbackModels].filter(
      (model): model is string => typeof model === "string" && model.trim().length > 0,
    );
    return Array.from(new Set(models.map((model) => model.trim())));
  }

  async acompletion(
    params: LiteLlmCompletionParams,
  ): Promise<LiteLlmCompletionResponse> {
    const cfg = await this.enforceRateLimit();
    const models = [params.model ?? cfg.model, ...cfg.fallbackModels];
    const uniqueModels = Array.from(
      new Set(
        models.filter((model) => typeof model === "string" && model.length > 0),
      ),
    );
    let lastError: unknown;
    for (const model of uniqueModels) {
      try {
        return await this.executeWithRetry(cfg, model, params);
      } catch (error) {
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
    const cfg = await this.enforceRateLimit();
    const model = params.model ?? cfg.embeddingModel ?? cfg.model;
    if (!model) {
      throw new Error("LiteLLM embedding model is not configured");
    }
    return this.executeEmbeddingWithRetry(cfg, model, params);
  }

  async *stream(params: LiteLlmCompletionParams): AsyncGenerator<LiteLlmStreamChunk> {
    const cfg = await this.enforceRateLimit();
    const models = [params.model ?? cfg.model, ...cfg.fallbackModels];
    const uniqueModels = Array.from(
      new Set(models.filter((model) => typeof model === "string" && model.length > 0)),
    );

    let lastError: unknown;
    for (const model of uniqueModels) {
      let started = false;
      try {
        for await (const chunk of this.executeStream(cfg, model, params)) {
          started = true;
          yield chunk;
        }
        return;
      } catch (error) {
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

    throw lastError instanceof Error ? lastError : new Error("LiteLLM stream failed");
  }

  private async executeWithRetry(
    cfg: { timeoutMs: number; temperature: number; topP: number; maxOutputTokens: number; maxRetries: number },
    model: string,
    params: LiteLlmCompletionParams,
  ) {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
        const compatibility = this.getCompatibilityFlags();
        const payload = {
          model,
          messages: params.messages,
          temperature: params.temperature ?? cfg.temperature,
          top_p: params.top_p ?? cfg.topP,
          max_tokens: params.max_tokens ?? cfg.maxOutputTokens,
          response_format: this.resolveResponseFormat(params.response_format, compatibility),
          stream: false,
          metadata: compatibility.supportsMetadata ? params.metadata : undefined,
        };
        const start = Date.now();
        const response = await this.postWithCompatibilityFallback<LiteLlmCompletionResponse>(
          "/v1/chat/completions",
          "/chat/completions",
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
            ? (response.data.usage as unknown as Record<string, unknown>).response_cost
            : undefined,
        );
        const costUsd = headerCost ?? payloadCost ?? usageCost;
        return {
          ...response.data,
          costUsd: costUsd ?? undefined,
          keySpendUsd: keySpendUsd ?? undefined,
          latencyMs,
        } satisfies LiteLlmCompletionResponse;
      } catch (error) {
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
    cfg: { timeoutMs: number; temperature: number; topP: number; maxOutputTokens: number },
    model: string,
    params: LiteLlmCompletionParams,
  ): AsyncGenerator<LiteLlmStreamChunk> {
    const compatibility = this.getCompatibilityFlags();
    const payload = {
      model,
      messages: params.messages,
      temperature: params.temperature ?? cfg.temperature,
      top_p: params.top_p ?? cfg.topP,
      max_tokens: params.max_tokens ?? cfg.maxOutputTokens,
      response_format: this.resolveResponseFormat(params.response_format, compatibility),
      stream: true,
      metadata: compatibility.supportsMetadata ? params.metadata : undefined,
    };

    const response = await this.postWithCompatibilityFallback(
      "/v1/chat/completions",
      "/chat/completions",
      payload,
      {
        responseType: "stream",
        timeout: params.timeoutMs ?? cfg.timeoutMs,
        headers: { Accept: "text/event-stream" },
      },
    );
    const stream = response.data as Readable;

    for await (const data of this.iterateSseData(stream)) {
      if (data.trim() === "[DONE]") {
        return;
      }
      let parsed:
        | { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] }
        | null = null;
      try {
        parsed = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
        };
      } catch {
        continue;
      }

      const choice = parsed?.choices?.[0];
      const delta = choice?.delta?.content;
      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
      if (typeof delta === "string" && delta.length > 0) {
        yield { model, raw: parsed, delta, finishReason };
      } else if (typeof finishReason === "string" && finishReason.length > 0) {
        yield { model, raw: parsed, finishReason };
      }
    }
  }

  private async executeEmbeddingWithRetry(
    cfg: { timeoutMs: number; maxRetries: number },
    model: string,
    params: LiteLlmEmbeddingParams,
  ) {
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
        const compatibility = this.getCompatibilityFlags();
        const payload = {
          model,
          input: params.input,
          metadata: compatibility.supportsMetadata ? params.metadata : undefined,
        };
        const start = Date.now();
        const response = await this.postWithCompatibilityFallback<LiteLlmEmbeddingResponse>(
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
            ? (response.data.usage as unknown as Record<string, unknown>).response_cost
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

  private async *iterateSseData(stream: Readable): AsyncGenerator<string> {
    yield* iterateSseDataFromReadable(stream);
  }

  private async postWithFallback<T = unknown>(
    primaryPath: string,
    fallbackPath: string,
    payload: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    try {
      return await this.client.post<T>(primaryPath, payload, config);
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        return this.client.post<T>(fallbackPath, payload, config);
      }
      throw error;
    }
  }

  private async postWithCompatibilityFallback<T = unknown>(
    primaryPath: string,
    fallbackPath: string,
    payload: Record<string, unknown>,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    try {
      return await this.postWithFallback<T>(primaryPath, fallbackPath, payload, config);
    } catch (error) {
      if (!(error instanceof AxiosError)) {
        throw error;
      }
      const status = error.response?.status;
      if (!status || ![400, 422].includes(status)) {
        throw error;
      }

      const errorText = this.extractAxiosErrorText(error).toLowerCase();
      const mentionsMetadata = errorText.includes("metadata");
      const mentionsResponseFormat =
        errorText.includes("response_format") ||
        errorText.includes("response format") ||
        errorText.includes("json_schema") ||
        errorText.includes("json schema") ||
        errorText.includes("structured output") ||
        errorText.includes("structured outputs");

      if (!mentionsMetadata && !mentionsResponseFormat) {
        throw error;
      }

      const candidates = this.buildCompatibilityPayloadCandidates(payload, {
        dropMetadata: mentionsMetadata,
        adjustResponseFormat: mentionsResponseFormat,
      });

      if (candidates.length === 0) {
        throw error;
      }

      let lastError: unknown = error;
      for (const candidate of candidates) {
        try {
          const response = await this.postWithFallback<T>(
            primaryPath,
            fallbackPath,
            candidate.payload,
            config,
          );
          this.applyCompatibilityUpdate(candidate.update);
          return response;
        } catch (candidateError) {
          lastError = candidateError;
        }
      }
      throw lastError;
    }
  }

  private buildCompatibilityPayloadCandidates(
    payload: Record<string, unknown>,
    options: { dropMetadata: boolean; adjustResponseFormat: boolean },
  ) {
    const candidates: Array<{ payload: Record<string, unknown>; update: Partial<GatewayCompatibilityFlags> }> = [];

    const hasMetadata = "metadata" in payload && payload.metadata !== undefined;
    const hasResponseFormat = "response_format" in payload && payload.response_format !== undefined;
    const responseFormatType =
      hasResponseFormat &&
      payload.response_format &&
      typeof payload.response_format === "object" &&
      "type" in (payload.response_format as Record<string, unknown>)
        ? (payload.response_format as { type?: unknown }).type
        : undefined;
    const hasJsonSchema = responseFormatType === "json_schema";

    const stripMetadata = (input: Record<string, unknown>) => {
      const next = { ...input };
      delete next.metadata;
      return next;
    };

    const stripResponseFormat = (input: Record<string, unknown>) => {
      const next = { ...input };
      delete next.response_format;
      return next;
    };

    const downgradeJsonSchema = (input: Record<string, unknown>) => ({
      ...input,
      response_format: { type: "json_object" },
    });

    if (options.dropMetadata && hasMetadata && options.adjustResponseFormat && hasResponseFormat) {
      if (hasJsonSchema) {
        candidates.push({
          payload: stripMetadata(downgradeJsonSchema(payload)),
          update: { supportsMetadata: false, supportsJsonSchema: false },
        });
      }
      candidates.push({
        payload: stripMetadata(stripResponseFormat(payload)),
        update: { supportsMetadata: false, supportsResponseFormat: false, supportsJsonSchema: false },
      });
    }

    if (options.dropMetadata && hasMetadata) {
      candidates.push({
        payload: stripMetadata(payload),
        update: { supportsMetadata: false },
      });
    }

    if (options.adjustResponseFormat && hasResponseFormat) {
      if (hasJsonSchema) {
        candidates.push({
          payload: downgradeJsonSchema(payload),
          update: { supportsJsonSchema: false },
        });
      }
      candidates.push({
        payload: stripResponseFormat(payload),
        update: { supportsResponseFormat: false, supportsJsonSchema: false },
      });
    }

    return this.dedupePayloadCandidates(candidates);
  }

  private dedupePayloadCandidates(
    candidates: Array<{ payload: Record<string, unknown>; update: Partial<GatewayCompatibilityFlags> }>,
  ) {
    const seen = new Set<string>();
    const unique: Array<{ payload: Record<string, unknown>; update: Partial<GatewayCompatibilityFlags> }> = [];
    for (const candidate of candidates) {
      let key: string;
      try {
        key = JSON.stringify(candidate.payload);
      } catch {
        key = String(unique.length);
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(candidate);
    }
    return unique;
  }

  private applyCompatibilityUpdate(update: Partial<GatewayCompatibilityFlags>) {
    if (!update || Object.keys(update).length === 0) {
      return;
    }
    const flags = this.getCompatibilityFlags();
    this.compatibility.set(this.currentBaseUrl, { ...flags, ...update });
  }

  private getCompatibilityFlags(): GatewayCompatibilityFlags {
    const existing = this.compatibility.get(this.currentBaseUrl);
    if (existing) {
      return existing;
    }
    const initial: GatewayCompatibilityFlags = {
      supportsMetadata: true,
      supportsResponseFormat: true,
      supportsJsonSchema: true,
    };
    this.compatibility.set(this.currentBaseUrl, initial);
    return initial;
  }

  private resolveResponseFormat(
    responseFormat: LiteLlmCompletionParams["response_format"],
    compatibility: GatewayCompatibilityFlags,
  ) {
    if (!responseFormat || !compatibility.supportsResponseFormat) {
      return undefined;
    }

    if (!compatibility.supportsJsonSchema) {
      const type =
        responseFormat &&
        typeof responseFormat === "object" &&
        "type" in (responseFormat as Record<string, unknown>)
          ? (responseFormat as { type?: unknown }).type
          : undefined;
      if (type === "json_schema") {
        return { type: "json_object" };
      }
    }

    return responseFormat;
  }

  private extractAxiosErrorText(error: AxiosError) {
    const responseData = error.response?.data as unknown;
    if (!responseData) {
      return error.message || "";
    }
    if (typeof responseData === "string") {
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

  private isRetryable(error: unknown) {
    if (!(error instanceof AxiosError)) {
      return false;
    }
    const status = error.response?.status;
    return (
      !status || [408, 409, 423, 425, 429, 500, 502, 503, 504].includes(status)
    );
  }

  private buildClient(cfg: { apiBase: string; apiKey?: string; timeoutMs: number }) {
    const baseUrl = normalizeApiBase(cfg.apiBase);
    const apiKey = normalizeApiKey(cfg.apiKey);
    this.currentBaseUrl = baseUrl;
    this.currentApiKey = apiKey;
    return axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
  }

  private async enforceRateLimit() {
    const pipelineCfg = this.configService.config;
    const cfg = await this.resolveConfig();
    const limitKey = `litellm:rpm`;
    const allowed = await this.rateLimiter.consume(
      limitKey,
      cfg.requestsPerMinute,
      pipelineCfg.pipeline.rateLimitWindowSeconds,
    );
    if (!allowed) {
      throw new Error("LiteLLM request throttled by local rate limiter");
    }
    const base = normalizeApiBase(cfg.apiBase);
    const apiKey = normalizeApiKey(cfg.apiKey);
    const shouldRebuild = base !== this.currentBaseUrl || apiKey !== this.currentApiKey;
    if (shouldRebuild) {
      this.client = this.buildClient(cfg);
    }
    return cfg;
  }

  private async resolveConfig() {
    const pipelineCfg = this.configService.config;
    const overrides = await this.llmGatewaySettings.getActiveConfig();
    return overrides ? { ...pipelineCfg.litellm, ...overrides } : pipelineCfg.litellm;
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
    "/models",
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
