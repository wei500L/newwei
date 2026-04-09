import { createLogger } from "@modular/utils";
import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { createHash } from "node:crypto";

import {
  detectOpenAiCompatibilityIssue,
  type LlmApiSurface,
  LlmCompatibilityError,
  type LlmCompatibilityErrorInfo,
  normalizeOpenAiApiBase,
  normalizeOpenAiApiKey,
  sanitizeUpstreamErrorText,
  toLlmCompatibilityErrorInfo,
} from "../../common/llm-openai-compat";
import { extractOpenAiTextFromChoice } from "../../common/openai-chat";
import { CacheService } from "../cache/cache.service";

import { LiteLlmProxyGovernanceService } from "./litellm-proxy-governance.service";
import {
  LLM_GATEWAY_ERROR_CODE_API_BASE_REQUIRED as ERROR_CODE_API_BASE_REQUIRED,
  LLM_GATEWAY_ERROR_CODE_EMBEDDING_MODEL_REQUIRED as ERROR_CODE_EMBEDDING_MODEL_REQUIRED,
  LLM_GATEWAY_ERROR_CODE_INVALID_EMBEDDING_RESPONSE as ERROR_CODE_INVALID_EMBEDDING_RESPONSE,
  LLM_GATEWAY_ERROR_CODE_INVALID_RERANK_RESPONSE as ERROR_CODE_INVALID_RERANK_RESPONSE,
  LLM_GATEWAY_ERROR_CODE_MODEL_REQUIRED as ERROR_CODE_MODEL_REQUIRED,
  LLM_GATEWAY_ERROR_CODE_NOTHING_TO_TEST as ERROR_CODE_NOTHING_TO_TEST,
  LLM_GATEWAY_ERROR_CODE_PROFILE_NOT_FOUND as ERROR_CODE_PROFILE_NOT_FOUND,
  LLM_GATEWAY_ERROR_CODE_RERANK_DOCUMENTS_REQUIRED as ERROR_CODE_RERANK_DOCUMENTS_REQUIRED,
  LLM_GATEWAY_ERROR_CODE_RERANK_MODEL_REQUIRED as ERROR_CODE_RERANK_MODEL_REQUIRED,
  LLM_GATEWAY_ERROR_CODE_RERANK_QUERY_REQUIRED as ERROR_CODE_RERANK_QUERY_REQUIRED,
  LLM_GATEWAY_ERROR_CODE_RERANK_TEST_FAILED as ERROR_CODE_RERANK_TEST_FAILED,
  LLM_GATEWAY_ERROR_CODE_REQUEST_FAILED as ERROR_CODE_REQUEST_FAILED,
  LLM_GATEWAY_ERROR_CODE_UNAVAILABLE as ERROR_CODE_UNAVAILABLE,
} from "./llm-gateway-error-codes";
import {
  LlmGatewaySettingsService,
  type LlmGatewayResponseFormatMode,
} from "./llm-gateway-settings.service";

interface ChatCompletionResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  response_cost?: unknown;
}

interface ResponsesTextOutputPart {
  text?: string | null;
  type?: string;
}

interface ResponsesOutputItem {
  content?: ResponsesTextOutputPart[];
}

interface ResponsesApiResponse {
  id?: string;
  model?: string;
  output_text?: string;
  output?: ResponsesOutputItem[];
  response_cost?: unknown;
}

interface EmbeddingResponse {
  model?: string;
  data?: { embedding?: number[] }[];
  usage?: { prompt_tokens: number; total_tokens: number };
  response_cost?: unknown;
}

interface RerankResponseResult {
  index?: unknown;
  relevance_score?: unknown;
  relevanceScore?: unknown;
  score?: unknown;
  similarity?: unknown;
}

interface RerankResponse {
  model?: string;
  results?: RerankResponseResult[];
  data?: RerankResponseResult[];
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
  callId?: string;
  modelId?: string;
  modelApiBase?: string;
  modelGroup?: string;
  proxyVersion?: string;
}

export interface LlmGatewayEmbeddingTestResult {
  model: string;
  dimensions: number;
  latencyMs: number;
  usage?: EmbeddingResponse["usage"];
  costUsd?: number;
  keySpendUsd?: number;
  callId?: string;
  modelId?: string;
  modelApiBase?: string;
  modelGroup?: string;
  proxyVersion?: string;
}

export interface LlmGatewayRerankTestResult {
  model: string;
  topN: number;
  latencyMs: number;
  results: { index: number; score: number }[];
  costUsd?: number;
  keySpendUsd?: number;
  callId?: string;
  modelId?: string;
  modelApiBase?: string;
  modelGroup?: string;
  proxyVersion?: string;
}

export interface LlmGatewayTestError {
  code?: string;
  message: string;
  status?: number;
  axiosCode?: string;
  requestId?: string;
  upstreamType?: string;
  upstreamCode?: string;
  compatibilityError?: LlmCompatibilityErrorInfo;
}

export interface LlmGatewayTestResult {
  apiBase: string;
  apiSurfaceUsed?: "chat_completions" | "responses";
  compatibilityError?: LlmCompatibilityErrorInfo;
  completion?: LlmGatewayChatTestResult;
  completionError?: LlmGatewayTestError;
  embedding?: LlmGatewayEmbeddingTestResult;
  embeddingError?: LlmGatewayTestError;
  rerank?: LlmGatewayRerankTestResult;
  rerankError?: LlmGatewayTestError;
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

export interface LlmGatewayProxyModelInfoEntry {
  modelName: string;
  litellmParams?: Record<string, unknown>;
  modelInfo?: Record<string, unknown>;
}

export interface LlmGatewayProxyModelInfoResult {
  apiBase: string;
  checkedAt: string;
  cached?: boolean;
  cacheTtlSeconds?: number;
  models: LlmGatewayProxyModelInfoEntry[];
}

export interface LlmGatewayProxyLoadBalancingTestResult {
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
  errors: LlmGatewayTestError[];
}

export interface LlmGatewayModelsConfigInput {
  profileId?: string;
  apiBase: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface LlmGatewayTestConfigInput extends LlmGatewayModelsConfigInput {
  model?: string;
  embeddingModel?: string;
  rerankModel?: string;
  rerankFallbackModels?: string[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  fallbackModels?: string[];
  prompt?: string;
  includeCompletion?: boolean;
  includeEmbeddings?: boolean;
  embeddingInput?: string;
  includeRerank?: boolean;
  rerankQuery?: string;
  rerankDocuments?: string[];
  apiSurface?: "chat_completions" | "responses";
  responseFormatMode?: LlmGatewayResponseFormatMode;
  includeMetadataProbe?: boolean;
}

export interface LlmGatewayTestInput {
  model?: string;
  prompt?: string;
  includeCompletion?: boolean;
  includeEmbeddings?: boolean;
  embeddingModel?: string;
  embeddingInput?: string;
  includeRerank?: boolean;
  rerankModel?: string;
  rerankQuery?: string;
  rerankDocuments?: string[];
  apiSurface?: "chat_completions" | "responses";
  responseFormatMode?: LlmGatewayResponseFormatMode;
  includeMetadataProbe?: boolean;
}

const DEFAULT_PROMPT = 'Say "OK" and nothing else.';
const DEFAULT_EMBEDDING_INPUT = "hello";
const DEFAULT_RERANK_QUERY = "latest US inflation outlook and Fed policy";
const DEFAULT_RERANK_DOCUMENTS = [
  "Federal Reserve officials signaled rates may stay higher for longer as inflation remains sticky.",
  "Quarterly earnings beat estimates as cloud revenue accelerated and margins improved.",
  "Oil prices rose after unexpected inventory draw, pressuring transportation and input costs.",
];
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 0.9;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;
const DEFAULT_SEND_METADATA = true;
const DEFAULT_RESPONSE_FORMAT_MODE: LlmGatewayResponseFormatMode =
  "json_schema";

@Injectable()
export class LlmGatewayTestService {
  private readonly logger = createLogger({ name: "llm-gateway-test" });

  constructor(
    private readonly settings: LlmGatewaySettingsService,
    private readonly cache: CacheService,
    private readonly proxyGovernance: LiteLlmProxyGovernanceService,
  ) {}

  private buildErrorPayload(
    code: string,
    message: string,
    extras?: Record<string, unknown>,
  ) {
    return {
      code,
      message,
      ...(extras ?? {}),
    };
  }

  private badRequest(
    code: string,
    message: string,
    extras?: Record<string, unknown>,
  ) {
    return new BadRequestException(this.buildErrorPayload(code, message, extras));
  }

  private badGateway(
    code: string,
    message: string,
    extras?: Record<string, unknown>,
  ) {
    return new BadGatewayException(this.buildErrorPayload(code, message, extras));
  }

  private serviceUnavailable(
    code: string,
    message: string,
    extras?: Record<string, unknown>,
  ) {
    return new ServiceUnavailableException(
      this.buildErrorPayload(code, message, extras),
    );
  }

  private notFound(
    code: string,
    message: string,
    extras?: Record<string, unknown>,
  ) {
    return new NotFoundException(this.buildErrorPayload(code, message, extras));
  }

  private buildProxyModelInfoCacheKey(profileId: string, apiBase: string) {
    const digest = createHash("sha256")
      .update(apiBase)
      .digest("hex")
      .slice(0, 16);
    return `llm_gateway:proxy_model_info:v1:${profileId}:${digest}`;
  }

  async checkProxyHealth(
    profileId: string,
  ): Promise<LlmGatewayProxyHealthResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw this.notFound(
        ERROR_CODE_PROFILE_NOT_FOUND,
        "LLM gateway profile not found",
      );
    }

    const baseUrl = normalizeOpenAiApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw this.badRequest(
        ERROR_CODE_API_BASE_REQUIRED,
        "apiBase is not configured",
      );
    }

    const timeoutMs = Math.min(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000);
    const apiKey = await this.resolveApiKeyForBase(
      baseUrl,
      cfg.apiKey,
      profileId,
    );
    const client = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    const context = { apiKeyConfigured: Boolean(apiKey) };

    const [liveliness, readiness] = await Promise.all([
      this.checkProxyEndpoint(client, "/health/liveliness", timeoutMs, context),
      this.checkProxyEndpoint(client, "/health/readiness", timeoutMs, context),
    ]);

    return {
      apiBase: baseUrl,
      checkedAt: new Date().toISOString(),
      liveliness,
      readiness,
    };
  }

  async getProxyModelInfo(
    profileId: string,
    options?: { force?: boolean },
  ): Promise<LlmGatewayProxyModelInfoResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw this.notFound(
        ERROR_CODE_PROFILE_NOT_FOUND,
        "LLM gateway profile not found",
      );
    }

    const baseUrl = normalizeOpenAiApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw this.badRequest(
        ERROR_CODE_API_BASE_REQUIRED,
        "apiBase is not configured",
      );
    }

    const cacheTtlSeconds = 60;
    const cacheKey = this.buildProxyModelInfoCacheKey(profileId, baseUrl);
    if (!options?.force) {
      try {
        const cached =
          await this.cache.get<LlmGatewayProxyModelInfoResult>(cacheKey);
        if (cached) {
          return {
            ...cached,
            cached: true,
            cacheTtlSeconds,
          };
        }
      } catch (error) {
        this.logger.warn(
          { err: error },
          "Failed to read proxy model info cache",
        );
      }
    }

    const apiKey = await this.resolveApiKeyForBase(
      baseUrl,
      cfg.apiKey,
      profileId,
    );
    const client = axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    const context = {
      apiKeyConfigured: Boolean(apiKey),
    };

    try {
      const response = await getWithFallback<{ models?: unknown }>(
        client,
        "/v1/model/info",
        "/model/info",
        { timeout: cfg.timeoutMs },
      );

      const rawModels = response.data?.models;
      const models = Array.isArray(rawModels) ? rawModels : [];
      const normalized = models
        .map((entry) => normalizeProxyModelInfoEntry(entry))
        .filter(
          (entry): entry is LlmGatewayProxyModelInfoEntry => entry !== null,
        );

      const result: LlmGatewayProxyModelInfoResult = {
        apiBase: baseUrl,
        checkedAt: new Date().toISOString(),
        models: normalized,
      };
      if (!options?.force) {
        try {
          await this.cache.set(cacheKey, result, cacheTtlSeconds);
        } catch (error) {
          this.logger.warn(
            { err: error },
            "Failed to write proxy model info cache",
          );
        }
      }
      return result;
    } catch (error) {
      this.throwGatewayError(error, context);
    }
  }

  async testProxyLoadBalancing(
    profileId: string,
    input: {
      model?: string;
      attempts?: number;
      concurrency?: number;
      prompt?: string;
    },
  ): Promise<LlmGatewayProxyLoadBalancingTestResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw this.notFound(
        ERROR_CODE_PROFILE_NOT_FOUND,
        "LLM gateway profile not found",
      );
    }

    const baseUrl = normalizeOpenAiApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw this.badRequest(
        ERROR_CODE_API_BASE_REQUIRED,
        "apiBase is not configured",
      );
    }

    const model =
      normalizeOptionalString(input.model) ??
      normalizeOptionalString(cfg.model);
    if (!model) {
      throw this.badRequest(ERROR_CODE_MODEL_REQUIRED, "model is not configured");
    }

    const attempts = clampInt(input.attempts, 1, 50, 8);
    const concurrency = clampInt(input.concurrency, 1, 10, 2);
    const prompt = normalizeOptionalString(input.prompt) ?? DEFAULT_PROMPT;

    const apiKey = await this.resolveApiKeyForBase(
      baseUrl,
      cfg.apiKey,
      profileId,
    );
    const client = axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    const context = {
      apiKeyConfigured: Boolean(apiKey),
    };
    const startedAt = Date.now();

    const modelIdDistribution: Record<string, number> = {};
    const modelApiBaseDistribution: Record<string, number> = {};
    const callIdSamples: string[] = [];
    const errors: LlmGatewayTestError[] = [];

    let succeeded = 0;
    let failed = 0;

    const semaphore = new AsyncSemaphore(concurrency);

    await Promise.allSettled(
      Array.from({ length: attempts }).map((_, idx) =>
        semaphore.withPermit(async () => {
          try {
            const payload = {
              model,
              messages: [{ role: "user", content: `${prompt}\n#${idx + 1}` }],
              temperature: 0,
              top_p: 1,
              max_tokens: 16,
              stream: false,
            };

            const response = await postWithFallback<ChatCompletionResponse>(
              client,
              "/v1/chat/completions",
              "/chat/completions",
              payload,
              { timeout: cfg.timeoutMs },
            );

            succeeded += 1;

            const modelId =
              normalizeOptionalString(
                response.headers?.["x-litellm-model-id"],
              ) ?? "unknown";
            const apiBase =
              normalizeOptionalString(
                response.headers?.["x-litellm-model-api-base"],
              ) ?? "unknown";

            modelIdDistribution[modelId] =
              (modelIdDistribution[modelId] ?? 0) + 1;
            modelApiBaseDistribution[apiBase] =
              (modelApiBaseDistribution[apiBase] ?? 0) + 1;

            const callId = normalizeOptionalString(
              response.headers?.["x-litellm-call-id"],
            );
            if (callId && callIdSamples.length < 20) {
              callIdSamples.push(callId);
            }
          } catch (error) {
            failed += 1;
            if (errors.length < 10) {
              errors.push(this.toGatewayErrorInfo(error, context));
            }
          }
        }),
      ),
    );

    return {
      apiBase: baseUrl,
      model,
      attempts,
      succeeded,
      failed,
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      modelIdDistribution,
      modelApiBaseDistribution,
      callIdSamples,
      errors,
    };
  }

  async listModels(profileId: string): Promise<LlmGatewayModelsResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw this.notFound(
        ERROR_CODE_PROFILE_NOT_FOUND,
        "LLM gateway profile not found",
      );
    }

    const baseUrl = normalizeOpenAiApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw this.badRequest(
        ERROR_CODE_API_BASE_REQUIRED,
        "apiBase is not configured",
      );
    }

    const apiKey = await this.resolveApiKeyForBase(
      baseUrl,
      cfg.apiKey,
      profileId,
    );
    const client = axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    try {
      const response = await getWithFallback<ModelsResponse>(
        client,
        "/v1/models",
        "/models",
        { timeout: cfg.timeoutMs },
      );

      const models = normalizeModels(response.data);
      return { apiBase: baseUrl, models };
    } catch (error) {
      this.throwGatewayError(error, {
        apiKeyConfigured: Boolean(apiKey),
      });
    }
  }

  async listModelsConfig(
    input: LlmGatewayModelsConfigInput,
  ): Promise<LlmGatewayModelsResult> {
    const stored = input.profileId
      ? await this.getStoredConfig(input.profileId)
      : null;
    const baseUrl = normalizeOpenAiApiBase(input.apiBase);
    if (!baseUrl) {
      throw this.badRequest(
        ERROR_CODE_API_BASE_REQUIRED,
        "apiBase is not configured",
      );
    }

    const apiKey = await this.resolveApiKeyForBase(
      baseUrl,
      typeof input.apiKey === "string"
        ? normalizeOpenAiApiKey(input.apiKey)
        : stored?.apiKey,
      input.profileId,
    );
    const timeoutMs =
      input.timeoutMs ?? stored?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const client = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    try {
      const response = await getWithFallback<ModelsResponse>(
        client,
        "/v1/models",
        "/models",
        { timeout: timeoutMs },
      );

      const models = normalizeModels(response.data);
      return { apiBase: baseUrl, models };
    } catch (error) {
      this.throwGatewayError(error, { apiKeyConfigured: Boolean(apiKey) });
    }
  }

  async testProfile(
    profileId: string,
    input: LlmGatewayTestInput,
  ): Promise<LlmGatewayTestResult> {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw this.notFound(
        ERROR_CODE_PROFILE_NOT_FOUND,
        "LLM gateway profile not found",
      );
    }

    const baseUrl = normalizeOpenAiApiBase(cfg.apiBase);
    if (!baseUrl) {
      throw this.badRequest(
        ERROR_CODE_API_BASE_REQUIRED,
        "apiBase is not configured",
      );
    }
    const apiKey = await this.resolveApiKeyForBase(
      baseUrl,
      cfg.apiKey,
      profileId,
    );
    const effectiveCfg = {
      ...cfg,
      apiKey,
    };

    const client = axios.create({
      baseURL: baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    const shouldTestCompletion = input.includeCompletion ?? true;
    const apiSurface =
      input.apiSurface ?? cfg.apiSurface ?? "chat_completions";
    const responseFormatMode =
      input.responseFormatMode ??
      cfg.responseFormatMode ??
      DEFAULT_RESPONSE_FORMAT_MODE;
    const includeMetadataProbe =
      input.includeMetadataProbe ?? cfg.sendMetadata ?? DEFAULT_SEND_METADATA;
    const prompt = input.prompt?.trim() ? input.prompt.trim() : DEFAULT_PROMPT;
    const completionModelOverride = input.model?.trim()
      ? input.model.trim()
      : undefined;

    const completionResult = shouldTestCompletion
      ? apiSurface === "responses"
        ? await this.testResponses(
            client,
            effectiveCfg,
            prompt,
            completionModelOverride,
            {
              responseFormatMode,
              includeMetadataProbe,
            },
          )
        : await this.testCompletion(
            client,
            effectiveCfg,
            prompt,
            completionModelOverride,
            {
              responseFormatMode,
              includeMetadataProbe,
            },
          )
      : { completion: undefined, error: undefined };
    const completion = completionResult.completion;
    const completionError = completionResult.error;

    const shouldTestEmbeddings =
      input.includeEmbeddings ??
      Boolean(
        (input.embeddingModel?.trim()
          ? input.embeddingModel.trim()
          : undefined) ?? cfg.embeddingModel,
      );
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
        embedding = await this.testEmbeddings(
          client,
          effectiveCfg,
          embeddingInput,
          embeddingModelOverride,
        );
      } catch (error) {
        const info = this.toGatewayErrorInfo(error, {
          apiKeyConfigured: Boolean(apiKey),
          apiSurface: "embeddings",
        });
        embeddingError = info;
        this.logger.warn(
          { profileId, status: info.status, message: info.message },
          "LLM gateway embedding test failed",
        );
      }
    }

    const shouldTestRerank = input.includeRerank ?? false;
    let rerank: LlmGatewayRerankTestResult | undefined;
    let rerankError: LlmGatewayTestError | undefined;
    if (shouldTestRerank) {
      const rerankQuery =
        input.rerankQuery?.trim() && input.rerankQuery.trim().length > 0
          ? input.rerankQuery.trim()
          : DEFAULT_RERANK_QUERY;
      const rerankDocuments = normalizeRerankDocuments(input.rerankDocuments);
      try {
        rerank = await this.testRerank(
          client,
          {
            model: effectiveCfg.model,
            rerankModel: effectiveCfg.rerankModel,
            rerankFallbackModels: effectiveCfg.rerankFallbackModels,
            timeoutMs: effectiveCfg.timeoutMs,
            apiKey,
          },
          {
            query: rerankQuery,
            documents: rerankDocuments,
            modelOverride: normalizeOptionalString(input.rerankModel),
            includeMetadataProbe,
          },
        );
      } catch (error) {
        const info = this.toGatewayErrorInfo(error, {
          apiKeyConfigured: Boolean(apiKey),
        });
        rerankError = info;
        this.logger.warn(
          { profileId, status: info.status, message: info.message },
          "LLM gateway rerank test failed",
        );
      }
    }

    if (
      !completion &&
      !completionError &&
      !embedding &&
      !embeddingError &&
      !rerank &&
      !rerankError
    ) {
      throw this.badRequest(ERROR_CODE_NOTHING_TO_TEST, "Nothing to test");
    }

    return {
      apiBase: baseUrl,
      ...(shouldTestCompletion ? { apiSurfaceUsed: apiSurface } : {}),
      ...(completionError?.compatibilityError
        ? { compatibilityError: completionError.compatibilityError }
        : {}),
      ...(completion ? { completion } : {}),
      ...(completionError ? { completionError } : {}),
      ...(embedding ? { embedding } : {}),
      ...(embeddingError ? { embeddingError } : {}),
      ...(rerank ? { rerank } : {}),
      ...(rerankError ? { rerankError } : {}),
    };
  }

  async testConfig(
    input: LlmGatewayTestConfigInput,
  ): Promise<LlmGatewayTestResult> {
    const stored = input.profileId
      ? await this.getStoredConfig(input.profileId)
      : null;
    const baseUrl = normalizeOpenAiApiBase(input.apiBase);
    if (!baseUrl) {
      throw this.badRequest(
        ERROR_CODE_API_BASE_REQUIRED,
        "apiBase is not configured",
      );
    }

    const shouldTestCompletion = input.includeCompletion ?? true;
    const apiSurface =
      input.apiSurface ?? stored?.apiSurface ?? "chat_completions";
    const responseFormatMode =
      input.responseFormatMode ??
      stored?.responseFormatMode ??
      DEFAULT_RESPONSE_FORMAT_MODE;
    const includeMetadataProbe =
      input.includeMetadataProbe ??
      stored?.sendMetadata ??
      DEFAULT_SEND_METADATA;
    const model = input.model?.trim();
    const storedModel = stored?.model?.trim();
    if (shouldTestCompletion && !model && !storedModel) {
      throw this.badRequest(ERROR_CODE_MODEL_REQUIRED, "model is not configured");
    }

    const apiKey = await this.resolveApiKeyForBase(
      baseUrl,
      typeof input.apiKey === "string"
        ? normalizeOpenAiApiKey(input.apiKey)
        : stored?.apiKey,
      input.profileId,
    );
    const timeoutMs =
      input.timeoutMs ?? stored?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const temperature =
      input.temperature ?? stored?.temperature ?? DEFAULT_TEMPERATURE;
    const topP = input.topP ?? stored?.topP ?? DEFAULT_TOP_P;
    const maxOutputTokens =
      input.maxOutputTokens ??
      stored?.maxOutputTokens ??
      DEFAULT_MAX_OUTPUT_TOKENS;
    const fallbackModelsRaw =
      input.fallbackModels ?? stored?.fallbackModels ?? [];
    const fallbackModels = normalizeStringList(fallbackModelsRaw);

    const embeddingModel =
      normalizeOptionalString(input.embeddingModel) ?? stored?.embeddingModel;
    const shouldTestEmbeddings =
      input.includeEmbeddings ?? Boolean(embeddingModel);
    const rerankModel =
      normalizeOptionalString(input.rerankModel) ?? stored?.rerankModel;
    const rerankFallbackModelsRaw =
      input.rerankFallbackModels ?? stored?.rerankFallbackModels ?? [];
    const rerankFallbackModels = normalizeStringList(rerankFallbackModelsRaw);
    const shouldTestRerank = input.includeRerank ?? false;

    if (!shouldTestCompletion && !shouldTestEmbeddings && !shouldTestRerank) {
      throw this.badRequest(ERROR_CODE_NOTHING_TO_TEST, "Nothing to test");
    }

    const cfg = {
      model: model ?? stored?.model ?? embeddingModel ?? "unknown",
      embeddingModel,
      rerankModel,
      rerankFallbackModels,
      apiBase: baseUrl,
      apiKey,
      timeoutMs,
      temperature,
      topP,
      maxOutputTokens,
      fallbackModels,
    } satisfies {
      model: string;
      embeddingModel?: string;
      rerankModel?: string;
      rerankFallbackModels: string[];
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
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    const prompt = input.prompt?.trim() ? input.prompt.trim() : DEFAULT_PROMPT;

    const completionResult = shouldTestCompletion
      ? apiSurface === "responses"
        ? await this.testResponses(client, cfg, prompt, undefined, {
            responseFormatMode,
            includeMetadataProbe,
          })
        : await this.testCompletion(client, cfg, prompt, undefined, {
            responseFormatMode,
            includeMetadataProbe,
          })
      : { completion: undefined, error: undefined };
    const completion = completionResult.completion;
    const completionError = completionResult.error;
    let embedding: LlmGatewayEmbeddingTestResult | undefined;
    let embeddingError: LlmGatewayTestError | undefined;
    let rerank: LlmGatewayRerankTestResult | undefined;
    let rerankError: LlmGatewayTestError | undefined;
    if (shouldTestEmbeddings) {
      const embeddingInput = input.embeddingInput?.trim()
        ? input.embeddingInput.trim()
        : DEFAULT_EMBEDDING_INPUT;
      try {
        embedding = await this.testEmbeddings(client, cfg, embeddingInput);
      } catch (error) {
        const info = this.toGatewayErrorInfo(error, {
          apiKeyConfigured: Boolean(apiKey),
          apiSurface: "embeddings",
        });
        embeddingError = info;
        this.logger.warn(
          {
            profileId: input.profileId,
            status: info.status,
            message: info.message,
          },
          "LLM gateway embedding test failed",
        );
      }
    }

    if (shouldTestRerank) {
      const rerankQuery =
        input.rerankQuery?.trim() && input.rerankQuery.trim().length > 0
          ? input.rerankQuery.trim()
          : DEFAULT_RERANK_QUERY;
      const rerankDocuments = normalizeRerankDocuments(input.rerankDocuments);
      try {
        rerank = await this.testRerank(
          client,
          cfg,
          {
            query: rerankQuery,
            documents: rerankDocuments,
            modelOverride: normalizeOptionalString(input.rerankModel),
            includeMetadataProbe,
          },
        );
      } catch (error) {
        const info = this.toGatewayErrorInfo(error, {
          apiKeyConfigured: Boolean(apiKey),
        });
        rerankError = info;
        this.logger.warn(
          {
            profileId: input.profileId,
            status: info.status,
            message: info.message,
          },
          "LLM gateway rerank test failed",
        );
      }
    }

    return {
      apiBase: baseUrl,
      ...(shouldTestCompletion ? { apiSurfaceUsed: apiSurface } : {}),
      ...(completionError?.compatibilityError
        ? { compatibilityError: completionError.compatibilityError }
        : {}),
      ...(completion ? { completion } : {}),
      ...(completionError ? { completionError } : {}),
      ...(embedding ? { embedding } : {}),
      ...(embeddingError ? { embeddingError } : {}),
      ...(rerank ? { rerank } : {}),
      ...(rerankError ? { rerankError } : {}),
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
    modelOverride?: string,
    options?: {
      responseFormatMode?: LlmGatewayResponseFormatMode;
      includeMetadataProbe?: boolean;
    },
  ): Promise<{
    completion?: LlmGatewayChatTestResult;
    error?: LlmGatewayTestError;
  }> {
    const uniqueModels = Array.from(
      new Set(
        (modelOverride
          ? [modelOverride]
          : [cfg.model, ...(cfg.fallbackModels ?? [])]
        )
          .filter(
            (model): model is string =>
              typeof model === "string" && model.trim().length > 0,
          )
          .map((model) => model.trim()),
      ),
    );
    if (uniqueModels.length === 0) {
      return {
        error: {
          code: ERROR_CODE_MODEL_REQUIRED,
          message: "model is not configured",
        },
      };
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
          stream: false,
          ...(this.resolveResponseFormatProbe(options?.responseFormatMode) ??
            {}),
          ...(options?.includeMetadataProbe
            ? { metadata: { source: "gateway-test" } }
            : {}),
        };
        const start = Date.now();
        const response = await postWithFallback<ChatCompletionResponse>(
          client,
          "/v1/chat/completions",
          "/chat/completions",
          payload,
          { timeout: cfg.timeoutMs },
        );
        const latencyMs = Date.now() - start;
        const choice = (response.data as unknown as { choices?: unknown[] })
          ?.choices?.[0];
        const content = extractOpenAiTextFromChoice(choice);
        const finishReason =
          choice &&
          typeof choice === "object" &&
          typeof (choice as Record<string, unknown>).finish_reason === "string"
            ? ((choice as Record<string, unknown>).finish_reason as string)
            : undefined;

        return {
          completion: {
            model: response.data.model?.trim() || model,
            content,
            ...(finishReason ? { finishReason } : {}),
            latencyMs,
            ...(response.data.usage ? { usage: response.data.usage } : {}),
            ...this.extractCosts(response),
            ...this.extractLiteLlmHeaders(response),
          } satisfies LlmGatewayChatTestResult,
        };
      } catch (error) {
        if (error instanceof LlmCompatibilityError) {
          lastError = error;
          break;
        }
        lastError = error;
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error",
          },
          "LLM gateway completion test failed; evaluating fallback",
        );
      }
    }

    return {
      error: this.toGatewayErrorInfo(lastError, {
        apiKeyConfigured: Boolean(cfg.apiKey),
        apiSurface: "chat_completions",
      }),
    };
  }

  private async testResponses(
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
    modelOverride?: string,
    options?: {
      responseFormatMode?: LlmGatewayResponseFormatMode;
      includeMetadataProbe?: boolean;
    },
  ): Promise<{
    completion?: LlmGatewayChatTestResult;
    error?: LlmGatewayTestError;
  }> {
    const uniqueModels = Array.from(
      new Set(
        (modelOverride
          ? [modelOverride]
          : [cfg.model, ...(cfg.fallbackModels ?? [])]
        )
          .filter(
            (model): model is string =>
              typeof model === "string" && model.trim().length > 0,
          )
          .map((model) => model.trim()),
      ),
    );
    if (uniqueModels.length === 0) {
      return {
        error: {
          code: ERROR_CODE_MODEL_REQUIRED,
          message: "model is not configured",
        },
      };
    }

    let lastError: unknown;
    for (const model of uniqueModels) {
      try {
        const payload = {
          model,
          input: prompt,
          temperature: cfg.temperature,
          top_p: cfg.topP,
          max_output_tokens: Math.min(Math.max(1, cfg.maxOutputTokens), 128),
          ...(this.resolveResponseFormatProbe(options?.responseFormatMode) ??
            {}),
          ...(options?.includeMetadataProbe
            ? { metadata: { source: "gateway-test" } }
            : {}),
        };
        const start = Date.now();
        const response = await postWithFallback<ResponsesApiResponse>(
          client,
          "/v1/responses",
          "/responses",
          payload,
          { timeout: cfg.timeoutMs },
        );
        const latencyMs = Date.now() - start;
        const content = this.extractResponsesOutputText(response.data);

        return {
          completion: {
            model: response.data.model?.trim() || model,
            content,
            latencyMs,
            ...this.extractCosts(response),
            ...this.extractLiteLlmHeaders(response),
          } satisfies LlmGatewayChatTestResult,
        };
      } catch (error) {
        if (error instanceof LlmCompatibilityError) {
          lastError = error;
          break;
        }
        lastError = error;
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error",
          },
          "LLM gateway responses test failed; evaluating fallback",
        );
      }
    }

    return {
      error: this.toGatewayErrorInfo(lastError, {
        apiKeyConfigured: Boolean(cfg.apiKey),
        apiSurface: "responses",
      }),
    };
  }

  private async testEmbeddings(
    client: ReturnType<typeof axios.create>,
    cfg: { model: string; embeddingModel?: string; timeoutMs: number },
    input: string,
    modelOverride?: string,
  ): Promise<LlmGatewayEmbeddingTestResult> {
    const model =
      modelOverride?.trim() || cfg.embeddingModel?.trim() || cfg.model?.trim();
    if (!model) {
      throw this.badRequest(
        ERROR_CODE_EMBEDDING_MODEL_REQUIRED,
        "embedding model is not configured",
      );
    }

    const payload = {
      model,
      input,
    };
    const start = Date.now();
    const response = await postWithFallback<EmbeddingResponse>(
      client,
      "/v1/embeddings",
      "/embeddings",
      payload,
      { timeout: cfg.timeoutMs },
    );
    const latencyMs = Date.now() - start;
    const firstEmbedding = response.data.data?.[0]?.embedding;
    if (!Array.isArray(firstEmbedding) || firstEmbedding.length === 0) {
      throw this.badGateway(
        ERROR_CODE_INVALID_EMBEDDING_RESPONSE,
        "Embedding response did not include an embedding vector",
      );
    }

    return {
      model: response.data.model?.trim() || model,
      dimensions: firstEmbedding.length,
      latencyMs,
      ...(response.data.usage ? { usage: response.data.usage } : {}),
      ...this.extractCosts(response),
      ...this.extractLiteLlmHeaders(response),
    };
  }

  private async testRerank(
    client: ReturnType<typeof axios.create>,
    cfg: {
      model: string;
      rerankModel?: string;
      rerankFallbackModels?: string[];
      timeoutMs: number;
      apiKey?: string;
    },
    options: {
      query: string;
      documents: string[];
      modelOverride?: string;
      includeMetadataProbe?: boolean;
    },
  ): Promise<LlmGatewayRerankTestResult> {
    const query = options.query.trim();
    if (!query) {
      throw this.badRequest(
        ERROR_CODE_RERANK_QUERY_REQUIRED,
        "rerank query is required",
      );
    }
    const documents = options.documents
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (documents.length === 0) {
      throw this.badRequest(
        ERROR_CODE_RERANK_DOCUMENTS_REQUIRED,
        "rerank documents are required",
      );
    }

    const uniqueModels = Array.from(
      new Set(
        (
          options.modelOverride
            ? [options.modelOverride, ...(cfg.rerankFallbackModels ?? [])]
            : [cfg.rerankModel, ...(cfg.rerankFallbackModels ?? [])]
        )
          .filter(
            (model): model is string =>
              typeof model === "string" && model.trim().length > 0,
          )
          .map((model) => model.trim()),
      ),
    );
    if (uniqueModels.length === 0) {
      throw this.badRequest(
        ERROR_CODE_RERANK_MODEL_REQUIRED,
        "rerank model is not configured",
      );
    }

    let lastError: unknown;
    for (const model of uniqueModels) {
      try {
        const payload = {
          model,
          query,
          documents,
          top_n: documents.length,
          ...(options.includeMetadataProbe
            ? { metadata: { source: "gateway-test" } }
            : {}),
        };
        const start = Date.now();
        const response = await postWithFallback<RerankResponse>(
          client,
          "/v1/rerank",
          "/rerank",
          payload,
          { timeout: cfg.timeoutMs },
        );
        const latencyMs = Date.now() - start;
        const results = this.normalizeRerankResults(response.data);
        if (results.length === 0) {
          throw this.badGateway(
            ERROR_CODE_INVALID_RERANK_RESPONSE,
            "Rerank response did not include scored results",
          );
        }

        return {
          model: normalizeOptionalString(response.data.model) ?? model,
          topN: Math.min(documents.length, results.length),
          latencyMs,
          results,
          ...this.extractCosts(response),
          ...this.extractLiteLlmHeaders(response),
        };
      } catch (error) {
        if (error instanceof LlmCompatibilityError) {
          lastError = error;
          break;
        }
        lastError = error;
        this.logger.warn(
          {
            model,
            message: error instanceof Error ? error.message : "unknown error",
          },
          "LLM gateway rerank test failed; evaluating backup model",
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : this.badGateway(ERROR_CODE_RERANK_TEST_FAILED, "LLM gateway rerank test failed");
  }

  private normalizeRerankResults(
    payload: RerankResponse | undefined,
  ): { index: number; score: number }[] {
    const rawResults = Array.isArray(payload?.results)
      ? payload?.results
      : Array.isArray(payload?.data)
        ? payload?.data
        : [];
    return rawResults
      .map((entry): { index: number; score: number } | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const indexRaw = record.index;
        const scoreRaw =
          record.relevance_score ??
          record.relevanceScore ??
          record.score ??
          record.similarity;
        const index =
          typeof indexRaw === "number" && Number.isInteger(indexRaw)
            ? indexRaw
            : Number.NaN;
        const score =
          typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
            ? scoreRaw
            : typeof scoreRaw === "string" && scoreRaw.trim().length > 0
              ? Number(scoreRaw)
              : Number.NaN;
        if (!Number.isFinite(index) || !Number.isFinite(score)) {
          return null;
        }
        return { index, score };
      })
      .filter((entry): entry is { index: number; score: number } => entry !== null)
      .sort((a, b) => a.index - b.index);
  }

  private resolveResponseFormatProbe(
    mode: LlmGatewayResponseFormatMode | undefined,
  ): { response_format?: Record<string, unknown> } | undefined {
    if (!mode || mode === "none") {
      return undefined;
    }
    if (mode === "json_object") {
      return { response_format: { type: "json_object" } };
    }
    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "gateway_test_response",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" },
            },
            required: ["answer"],
          },
        },
      },
    };
  }

  private extractResponsesOutputText(
    response: ResponsesApiResponse,
  ): string | null {
    if (typeof response.output_text === "string") {
      const trimmed = response.output_text.trim();
      return trimmed.length > 0 ? response.output_text : null;
    }
    if (!Array.isArray(response.output)) {
      return null;
    }

    const chunks = response.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter((text) => text.length > 0);
    if (chunks.length === 0) {
      return null;
    }
    return chunks.join("");
  }

  private extractCosts(response: AxiosResponse<{ response_cost?: unknown }>) {
    const headerCost = extractNumber(
      response.headers?.["x-litellm-response-cost"] ??
        response.headers?.["x-litellm-cost"] ??
        response.headers?.["litellm-cost"],
    );
    const keySpendUsd = extractNumber(
      response.headers?.["x-litellm-key-spend"],
    );
    const payloadCost = extractNumber(response.data.response_cost);
    const costUsd = headerCost ?? payloadCost;

    return {
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(keySpendUsd !== undefined ? { keySpendUsd } : {}),
    };
  }

  private extractLiteLlmHeaders(response: AxiosResponse) {
    const callId = normalizeOptionalString(
      response.headers?.["x-litellm-call-id"],
    );
    const modelId = normalizeOptionalString(
      response.headers?.["x-litellm-model-id"],
    );
    const modelApiBase = normalizeOptionalString(
      response.headers?.["x-litellm-model-api-base"],
    );
    const proxyVersion = normalizeOptionalString(
      response.headers?.["x-litellm-version"],
    );
    const modelGroup = normalizeOptionalString(
      response.headers?.["x-litellm-model-group"],
    );

    return {
      ...(callId ? { callId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(modelApiBase ? { modelApiBase } : {}),
      ...(modelGroup ? { modelGroup } : {}),
      ...(proxyVersion ? { proxyVersion } : {}),
    };
  }

  private async checkProxyEndpoint(
    client: ReturnType<typeof axios.create>,
    path: string,
    timeoutMs: number,
    context?: {
      apiKeyConfigured?: boolean;
    },
  ): Promise<LlmGatewayProxyEndpointCheck> {
    try {
      const response = await client.get(path, { timeout: timeoutMs });
      const status = response.status;
      const ok = status >= 200 && status < 300;

      const contentType = response.headers?.["content-type"];
      const hasHtmlContentType =
        typeof contentType === "string" &&
        contentType.toLowerCase().includes("text/html");
      const hasHtmlBody =
        typeof response.data === "string" &&
        /<\s*!doctype\s+html|<\s*html\b/i.test(response.data);

      if (ok && (hasHtmlContentType || hasHtmlBody)) {
        return {
          ok: false,
          status,
          message:
            "Unexpected HTML response (not a LiteLLM Proxy health endpoint).",
        };
      }

      return {
        ok,
        status,
      };
    } catch (error) {
      const info = this.toGatewayErrorInfo(error, context);
      const message = info.message.startsWith("LLM gateway request failed")
        ? info.message.replace(/^LLM gateway request failed\\s*/i, "").trim()
        : info.message;
      return {
        ok: false,
        ...(info.status ? { status: info.status } : {}),
        message,
      };
    }
  }

  private throwGatewayError(
    error: unknown,
    context?: {
      apiKeyConfigured?: boolean;
      apiSurface?: LlmApiSurface;
    },
  ): never {
    if (
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    ) {
      throw error;
    }

    const info = this.toGatewayErrorInfo(error, context);
    const metadata = {
      ...(info.status ? { status: info.status } : {}),
      ...(info.requestId ? { requestId: info.requestId } : {}),
      ...(info.upstreamType ? { upstreamType: info.upstreamType } : {}),
      ...(info.upstreamCode ? { upstreamCode: info.upstreamCode } : {}),
      ...(info.compatibilityError
        ? { compatibilityError: info.compatibilityError }
        : {}),
    };

    if (info.code === "LLM_COMPATIBILITY_ERROR") {
      throw this.badRequest(info.code, info.message, metadata);
    }

    if (typeof info.status !== "number") {
      throw this.serviceUnavailable(
        info.code ?? ERROR_CODE_UNAVAILABLE,
        info.message,
        metadata,
      );
    }
    if (info.status >= 500) {
      throw this.badGateway(
        info.code ?? ERROR_CODE_REQUEST_FAILED,
        info.message,
        metadata,
      );
    }
    throw this.badRequest(
      info.code ?? ERROR_CODE_REQUEST_FAILED,
      info.message,
      metadata,
    );
  }

  private toGatewayErrorInfo(
    error: unknown,
    context?: {
      apiKeyConfigured?: boolean;
      apiSurface?: LlmApiSurface;
    },
  ): LlmGatewayTestError {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const response = error.getResponse();
      const responseRecord =
        response && typeof response === "object"
          ? (response as Record<string, unknown>)
          : null;
      const messageRaw = responseRecord?.message;
      const messageFromArray = Array.isArray(messageRaw)
        ? messageRaw.find((entry): entry is string => typeof entry === "string")
        : undefined;
      const message =
        (typeof messageRaw === "string" ? messageRaw : undefined) ??
        messageFromArray ??
        error.message;
      const codeFromResponse =
        typeof responseRecord?.code === "string" ? responseRecord.code : undefined;
      return {
        code:
          codeFromResponse ??
          (status === 404
            ? ERROR_CODE_PROFILE_NOT_FOUND
            : status === 503
              ? ERROR_CODE_UNAVAILABLE
              : ERROR_CODE_REQUEST_FAILED),
        message,
        status,
      };
    }

    if (error instanceof LlmCompatibilityError) {
      return {
        code: "LLM_COMPATIBILITY_ERROR",
        message: error.message,
        ...(typeof error.status === "number" ? { status: error.status } : {}),
        compatibilityError: toLlmCompatibilityErrorInfo(error),
      };
    }

    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const axiosCode = normalizeOptionalString(error.code);
      const requestId =
        extractRequestIdFromHeaders(error.response?.headers) ??
        extractRequestIdFromResponseData(error.response?.data);
      const upstreamMeta = extractUpstreamErrorMeta(error.response?.data);

      let detail = extractAxiosDetail(error);
      if (status === 401 && detail && detail.toLowerCase() === "unauthorized") {
        detail = undefined;
      }
      if (status === 403 && detail && detail.toLowerCase() === "forbidden") {
        detail = undefined;
      }
      if (status === 401 || status === 403) {
        detail =
          detail ?? buildAuthHint(status ?? 401, context?.apiKeyConfigured);
      }

      const issue = detectOpenAiCompatibilityIssue({
        status,
        errorText: detail ?? "",
        apiSurface: context?.apiSurface,
      });
      if (issue) {
        const compatibilityError = new LlmCompatibilityError(issue, {
          cause: error,
        });
        return {
          code: "LLM_COMPATIBILITY_ERROR",
          message: compatibilityError.message,
          ...(status ? { status } : {}),
          ...(axiosCode ? { axiosCode } : {}),
          ...(requestId ? { requestId } : {}),
          ...(upstreamMeta.upstreamType
            ? { upstreamType: upstreamMeta.upstreamType }
            : {}),
          ...(upstreamMeta.upstreamCode
            ? { upstreamCode: upstreamMeta.upstreamCode }
            : {}),
          compatibilityError: toLlmCompatibilityErrorInfo(compatibilityError),
        };
      }

      const message = status
        ? `LLM gateway request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`
        : `LLM gateway request failed${detail ? `: ${detail}` : ""}`;
      const code =
        typeof status === "number"
          ? status === 401
            ? "UPSTREAM_UNAUTHORIZED"
            : status === 403
              ? "UPSTREAM_FORBIDDEN"
              : status === 404
                ? "UPSTREAM_NOT_FOUND"
                : status === 405
                  ? "UPSTREAM_METHOD_NOT_ALLOWED"
                  : status === 408
                    ? "UPSTREAM_TIMEOUT"
                    : status === 429
                      ? "UPSTREAM_RATE_LIMITED"
                      : status >= 500
                        ? "UPSTREAM_SERVER_ERROR"
                        : "UPSTREAM_REQUEST_FAILED"
          : ERROR_CODE_UNAVAILABLE;
      return {
        code,
        message,
        ...(status ? { status } : {}),
        ...(axiosCode ? { axiosCode } : {}),
        ...(requestId ? { requestId } : {}),
        ...(upstreamMeta.upstreamType
          ? { upstreamType: upstreamMeta.upstreamType }
          : {}),
        ...(upstreamMeta.upstreamCode
          ? { upstreamCode: upstreamMeta.upstreamCode }
          : {}),
      };
    }

    if (error instanceof Error) {
      return {
        code: ERROR_CODE_REQUEST_FAILED,
        message: error.message,
      };
    }

    return {
      code: ERROR_CODE_REQUEST_FAILED,
      message: "LLM gateway request failed",
    };
  }

  private async getStoredConfig(profileId: string) {
    const cfg = await this.settings.getProfileConfig(profileId);
    if (!cfg) {
      throw this.notFound(
        ERROR_CODE_PROFILE_NOT_FOUND,
        "LLM gateway profile not found",
      );
    }
    return cfg;
  }

  private async resolveApiKeyForBase(
    apiBase: string,
    fallbackApiKey?: string,
    profileId?: string,
  ): Promise<string | undefined> {
    return this.proxyGovernance.resolveTestingApiKey(
      apiBase,
      fallbackApiKey,
      profileId,
    );
  }
}

async function postWithFallback<T>(
  client: ReturnType<typeof axios.create>,
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

async function getWithFallback<T>(
  client: ReturnType<typeof axios.create>,
  primaryPath: string,
  fallbackPath: string,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  try {
    return await client.get<T>(primaryPath, config);
  } catch (error) {
    if (
      error instanceof AxiosError &&
      typeof error.response?.status === "number" &&
      [404, 405].includes(error.response.status)
    ) {
      return client.get<T>(fallbackPath, config);
    }
    throw error;
  }
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

class AsyncSemaphore {
  private limit: number;
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain() {
    while (this.active < this.limit) {
      const next = this.queue.shift();
      if (!next) {
        return;
      }
      next();
    }
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
  const responseDetail = normalizeAxiosDetail(
    extractDetailFromResponseData(responseData),
    {
      status,
      axiosCode,
    },
  );
  if (responseDetail) {
    return (
      sanitizeUpstreamErrorText(responseDetail, { maxLength: 500 }) || undefined
    );
  }

  const statusText = normalizeAxiosDetail(
    normalizeOptionalString(error.response?.statusText),
    {
      status,
      axiosCode,
    },
  );
  if (statusText) {
    return (
      sanitizeUpstreamErrorText(statusText, { maxLength: 500 }) || undefined
    );
  }

  const message = normalizeAxiosDetail(normalizeOptionalString(error.message), {
    status,
    axiosCode,
  });
  if (message) {
    return sanitizeUpstreamErrorText(message, { maxLength: 500 }) || undefined;
  }

  const code = normalizeAxiosDetail(axiosCode, { status, axiosCode });
  if (code) {
    return sanitizeUpstreamErrorText(code, { maxLength: 500 }) || undefined;
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
  const bearerRedacted = text.replace(
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    "Bearer [REDACTED]",
  );
  return bearerRedacted.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-[REDACTED]");
}

function sanitizeProxyModelInfoValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProxyModelInfoValue(entry));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (
        key === "api_key" ||
        key === "apiKey" ||
        key === "Authorization" ||
        key === "authorization"
      ) {
        continue;
      }
      next[key] = sanitizeProxyModelInfoValue(entry);
    }
    return next;
  }
  return value;
}

function normalizeProxyModelInfoEntry(
  raw: unknown,
): LlmGatewayProxyModelInfoEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const modelName =
    typeof record.model_name === "string" ? record.model_name.trim() : "";
  if (!modelName) {
    return null;
  }

  const litellmParamsRaw = record.litellm_params;
  const modelInfoRaw = record.model_info;

  const litellmParams =
    litellmParamsRaw &&
    typeof litellmParamsRaw === "object" &&
    !Array.isArray(litellmParamsRaw)
      ? (sanitizeProxyModelInfoValue(litellmParamsRaw) as Record<
          string,
          unknown
        >)
      : undefined;

  const modelInfo =
    modelInfoRaw &&
    typeof modelInfoRaw === "object" &&
    !Array.isArray(modelInfoRaw)
      ? (sanitizeProxyModelInfoValue(modelInfoRaw) as Record<string, unknown>)
      : undefined;

  return {
    modelName,
    ...(litellmParams ? { litellmParams } : {}),
    ...(modelInfo ? { modelInfo } : {}),
  };
}

function buildAuthHint(
  status: number,
  apiKeyConfigured: boolean | undefined,
): string {
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
  context: { status?: number; axiosCode?: string },
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
    new RegExp(`^Request failed with status code ${context.status}$`, "i").test(
      trimmed,
    )
  ) {
    return undefined;
  }

  if (
    context.axiosCode &&
    trimmed === context.axiosCode &&
    isGenericAxiosErrorCode(trimmed)
  ) {
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

function normalizeOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function extractRequestIdFromHeaders(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const record = headers as Record<string, unknown>;
  const candidates = [
    record["x-request-id"],
    record["openai-request-id"],
    record["x-openai-request-id"],
    record["x-correlation-id"],
    record["x-amzn-requestid"],
    record["x-amzn-request-id"],
    record["x-amz-request-id"],
  ];

  for (const candidate of candidates) {
    const value = Array.isArray(candidate)
      ? candidate.filter((entry) => typeof entry === "string").join(", ")
      : candidate;
    const trimmed = normalizeOptionalString(value);
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function extractRequestIdFromText(
  text: string | undefined,
): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = /request\s*id\s*[:=]\s*([A-Za-z0-9._-]{6,})/i.exec(text);
  return match?.[1]?.trim() ? match[1].trim() : undefined;
}

function extractRequestIdFromResponseData(data: unknown): string | undefined {
  if (!data) {
    return undefined;
  }
  if (typeof data === "string") {
    return extractRequestIdFromText(data);
  }
  if (typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const errorObj =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  const requestId =
    normalizeOptionalString(record.request_id) ??
    normalizeOptionalString(record.requestId) ??
    normalizeOptionalString(errorObj?.request_id) ??
    normalizeOptionalString(errorObj?.requestId);
  return (
    requestId ??
    extractRequestIdFromText(
      extractMessageLike(errorObj?.message) ??
        extractMessageLike(record.message),
    )
  );
}

function extractUpstreamErrorMeta(data: unknown): {
  upstreamType?: string;
  upstreamCode?: string;
} {
  if (!data || typeof data !== "object") {
    return {};
  }
  const record = data as Record<string, unknown>;
  const errorObj =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;

  const upstreamType =
    normalizeOptionalString(errorObj?.type) ??
    normalizeOptionalString(record.type) ??
    normalizeOptionalString(record.error_type);
  const upstreamCode =
    normalizeOptionalString(errorObj?.code) ??
    normalizeOptionalString(record.code) ??
    normalizeOptionalString(record.error_code);

  return {
    ...(upstreamType ? { upstreamType } : {}),
    ...(upstreamCode ? { upstreamCode } : {}),
  };
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

function normalizeRerankDocuments(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_RERANK_DOCUMENTS;
  }
  const entries = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const unique = Array.from(new Set(entries));
  return unique.length > 0 ? unique : DEFAULT_RERANK_DOCUMENTS;
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
