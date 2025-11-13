import { Injectable } from "@nestjs/common";
import axios, { AxiosError, AxiosInstance } from "axios";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@modular/utils";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import type { JsonSchemaResponseFormat } from "./news-prompt.builder";

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
}

@Injectable()
export class LiteLlmService {
  private client: AxiosInstance;
  private currentBaseUrl: string;
  private readonly logger = createLogger({ name: "litellm-service" });

  constructor(
    private readonly configService: NewsPipelineConfigService,
    private readonly rateLimiter: RateLimiterService
  ) {
    this.currentBaseUrl = "";
    this.client = this.buildClient();
  }

  async acompletion(params: LiteLlmCompletionParams): Promise<LiteLlmCompletionResponse> {
    await this.enforceRateLimit();
    const cfg = this.configService.config.litellm;
    const models = [params.model ?? cfg.model, ...cfg.fallbackModels];
    const uniqueModels = Array.from(new Set(models.filter((model) => typeof model === "string" && model.length > 0)));
    let lastError: unknown;
    for (const model of uniqueModels) {
      try {
        return await this.executeWithRetry(model, params);
      } catch (error) {
        lastError = error;
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error"
          },
          "LiteLLM completion failed; evaluating fallback"
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error("LiteLLM completion failed");
  }

  private async executeWithRetry(model: string, params: LiteLlmCompletionParams) {
    const cfg = this.configService.config.litellm;
    const maxAttempts = Math.max(1, params.maxRetries ?? cfg.maxRetries);
    let attempt = 0;
    let delayMs = 1_000;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
        const payload = {
          model,
          messages: params.messages,
          temperature: params.temperature ?? cfg.temperature,
          top_p: params.top_p ?? cfg.topP,
          max_tokens: params.max_tokens ?? cfg.maxOutputTokens,
          response_format: params.response_format ?? undefined,
          stream: cfg.stream,
          metadata: params.metadata
        };
        const response = await this.client.post<LiteLlmCompletionResponse>("/v1/chat/completions", payload, {
          timeout: params.timeoutMs ?? cfg.timeoutMs
        });
        return response.data;
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

    throw lastError instanceof Error ? lastError : new Error("LiteLLM completion exhausted retries");
  }

  private isRetryable(error: unknown) {
    if (!(error instanceof AxiosError)) {
      return false;
    }
    const status = error.response?.status;
    return !status || [408, 409, 423, 425, 429, 500, 502, 503, 504].includes(status);
  }

  private buildClient() {
    const cfg = this.configService.config.litellm;
    this.currentBaseUrl = cfg.apiBase.replace(/\/$/, "");
    return axios.create({
      baseURL: this.currentBaseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      }
    });
  }

  private async enforceRateLimit() {
    const cfg = this.configService.config;
    const limitKey = `litellm:rpm`;
    const allowed = await this.rateLimiter.consume(
      limitKey,
      cfg.litellm.requestsPerMinute,
      cfg.pipeline.rateLimitWindowSeconds
    );
    if (!allowed) {
      throw new Error("LiteLLM request throttled by local rate limiter");
    }
    const base = cfg.litellm.apiBase.replace(/\/$/, "");
    if (base !== this.currentBaseUrl) {
      this.client = this.buildClient();
    }
  }
}
