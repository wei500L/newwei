import { Test, TestingModule } from "@nestjs/testing";
import { AxiosError, AxiosHeaders, AxiosResponse } from "axios";

import { RateLimiterService } from "../cache/rate-limiter.service";
import { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";

import { LiteLlmService, LiteLlmCompletionParams, LiteLlmEmbeddingParams } from "./litellm.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";

// Mock axios
const mockAxiosPost = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
  post: mockAxiosPost,
}));

jest.mock("axios", () => ({
  ...jest.requireActual("axios"),
  create: (...args: unknown[]) => mockAxiosCreate(...args),
  AxiosError: jest.requireActual("axios").AxiosError,
}));

// Mock createLogger
jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock sleep to speed up tests
jest.mock("node:timers/promises", () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

describe("LiteLlmService", () => {
  let service: LiteLlmService;
  let rateLimiterService: jest.Mocked<RateLimiterService>;
  let llmGatewaySettings: jest.Mocked<LlmGatewaySettingsService>;
  let configService: jest.Mocked<NewsPipelineConfigService>;

  const mockConfig = {
    litellm: {
      apiBase: "http://localhost:4001",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      fallbackModels: ["gpt-3.5-turbo"],
      timeoutMs: 60000,
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 1200,
      maxRetries: 3,
      requestsPerMinute: 60,
    },
    pipeline: {
      rateLimitWindowSeconds: 60,
    },
  };

  const mockCompletionResponse: AxiosResponse = {
    data: {
      id: "chatcmpl-123",
      model: "gpt-4o-mini",
      created: 1234567890,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello, world!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    status: 200,
    statusText: "OK",
    headers: {
      "x-litellm-response-cost": "0.0001",
      "x-litellm-key-spend": "0.05",
    },
    config: { headers: new AxiosHeaders() },
  };

  const mockEmbeddingResponse: AxiosResponse = {
    data: {
      model: "text-embedding-3-small",
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    },
    status: 200,
    statusText: "OK",
    headers: {
      "x-litellm-response-cost": "0.00001",
    },
    config: { headers: new AxiosHeaders() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });

    rateLimiterService = {
      consume: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<RateLimiterService>;

    llmGatewaySettings = {
      getActiveConfig: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<LlmGatewaySettingsService>;

    configService = {
      config: mockConfig,
    } as unknown as jest.Mocked<NewsPipelineConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiteLlmService,
        { provide: RateLimiterService, useValue: rateLimiterService },
        { provide: LlmGatewaySettingsService, useValue: llmGatewaySettings },
        { provide: NewsPipelineConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<LiteLlmService>(LiteLlmService);
    mockAxiosPost.mockResolvedValue(mockCompletionResponse);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("acompletion", () => {
    const completionParams: LiteLlmCompletionParams = {
      messages: [{ role: "user", content: "Hello" }],
    };

    it("should complete successfully with default model", async () => {
      const result = await service.acompletion(completionParams);

      expect(result.id).toBe("chatcmpl-123");
      expect(result.model).toBe("gpt-4o-mini");
      expect(result.choices[0].message.content).toBe("Hello, world!");
      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/chat/completions",
        expect.objectContaining({
          model: "gpt-4o-mini",
          messages: completionParams.messages,
          stream: false,
        }),
        expect.any(Object)
      );
    });

    it("should use custom model when provided", async () => {
      await service.acompletion({ ...completionParams, model: "custom-model" });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/chat/completions",
        expect.objectContaining({ model: "custom-model" }),
        expect.any(Object)
      );
    });

    it("should extract cost from x-litellm-response-cost header", async () => {
      const result = await service.acompletion(completionParams);

      expect(result.costUsd).toBe(0.0001);
    });

    it("should extract keySpendUsd from x-litellm-key-spend header", async () => {
      const result = await service.acompletion(completionParams);

      expect(result.keySpendUsd).toBe(0.05);
    });

    it("should extract cost from response_cost in payload when header missing", async () => {
      mockAxiosPost.mockResolvedValueOnce({
        ...mockCompletionResponse,
        headers: {},
        data: { ...mockCompletionResponse.data, response_cost: 0.0002 },
      });

      const result = await service.acompletion(completionParams);

      expect(result.costUsd).toBe(0.0002);
    });

    it("should include latencyMs in response", async () => {
      const result = await service.acompletion(completionParams);

      expect(result.latencyMs).toBeDefined();
      expect(typeof result.latencyMs).toBe("number");
    });

    it("should forward response_format to API payload", async () => {
      const responseFormat = { type: "json_object" };
      await service.acompletion({ ...completionParams, response_format: responseFormat });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/chat/completions",
        expect.objectContaining({ response_format: responseFormat }),
        expect.any(Object)
      );
    });
  });

  describe("retry logic", () => {
    const completionParams: LiteLlmCompletionParams = {
      messages: [{ role: "user", content: "Hello" }],
    };

    it("should retry on 429 (rate limit) status code", async () => {
      const error429 = new AxiosError("Rate limited", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 429,
        data: {},
        statusText: "Too Many Requests",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce(mockCompletionResponse);

      const result = await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(result.id).toBe("chatcmpl-123");
    });

    it("should retry on 500 (server error) status code", async () => {
      const error500 = new AxiosError("Server error", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 500,
        data: {},
        statusText: "Internal Server Error",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost
        .mockRejectedValueOnce(error500)
        .mockResolvedValueOnce(mockCompletionResponse);

      const result = await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(result.id).toBe("chatcmpl-123");
    });

    it("should retry on 502, 503, 504 (gateway errors)", async () => {
      const error502 = new AxiosError("Bad Gateway", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 502,
        data: {},
        statusText: "Bad Gateway",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost
        .mockRejectedValueOnce(error502)
        .mockResolvedValueOnce(mockCompletionResponse);

      const result = await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(result.id).toBe("chatcmpl-123");
    });

    it("should NOT retry on 400 (bad request) - permanent error", async () => {
      const error400 = new AxiosError("Bad request", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 400,
        data: {},
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost.mockRejectedValue(error400);

      await expect(service.acompletion(completionParams)).rejects.toThrow();
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry on 401 (unauthorized) - permanent error", async () => {
      const error401 = new AxiosError("Unauthorized", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 401,
        data: {},
        statusText: "Unauthorized",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost.mockRejectedValue(error401);

      await expect(service.acompletion(completionParams)).rejects.toThrow();
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });

    it("should throw after exhausting all retries", async () => {
      const error500 = new AxiosError("Server error", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 500,
        data: {},
        statusText: "Internal Server Error",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost.mockRejectedValue(error500);

      await expect(service.acompletion({ ...completionParams, maxRetries: 2 })).rejects.toThrow();
      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    });

    it("should respect maxRetries from params", async () => {
      const error500 = new AxiosError("Server error", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 500,
        data: {},
        statusText: "Internal Server Error",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost.mockRejectedValue(error500);

      await expect(service.acompletion({ ...completionParams, maxRetries: 1 })).rejects.toThrow();
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });
  });

  describe("model fallback", () => {
    const completionParams: LiteLlmCompletionParams = {
      messages: [{ role: "user", content: "Hello" }],
    };

    it("should not trigger fallback on primary model success", async () => {
      await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/chat/completions",
        expect.objectContaining({ model: "gpt-4o-mini" }),
        expect.any(Object)
      );
    });

    it("should fallback to next model when primary fails", async () => {
      const error400 = new AxiosError("Bad request", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 400,
        data: {},
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost
        .mockRejectedValueOnce(error400)
        .mockResolvedValueOnce(mockCompletionResponse);

      const result = await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(mockAxiosPost).toHaveBeenNthCalledWith(
        1,
        "/v1/chat/completions",
        expect.objectContaining({ model: "gpt-4o-mini" }),
        expect.any(Object)
      );
      expect(mockAxiosPost).toHaveBeenNthCalledWith(
        2,
        "/v1/chat/completions",
        expect.objectContaining({ model: "gpt-3.5-turbo" }),
        expect.any(Object)
      );
      expect(result.id).toBe("chatcmpl-123");
    });

    it("should throw last error when all models exhausted", async () => {
      const error400 = new AxiosError("Bad request", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 400,
        data: {},
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost.mockRejectedValue(error400);

      await expect(service.acompletion(completionParams)).rejects.toThrow();
      // Primary + 1 fallback = 2 models
      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    });

    it("should deduplicate models in fallback chain", async () => {
      // Set up config with duplicate models
      configService.config = {
        ...mockConfig,
        litellm: {
          ...mockConfig.litellm,
          model: "gpt-4o-mini",
          fallbackModels: ["gpt-4o-mini", "gpt-3.5-turbo", "gpt-4o-mini"],
        },
      };

      const error400 = new AxiosError("Bad request", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 400,
        data: {},
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost.mockRejectedValue(error400);

      await expect(service.acompletion(completionParams)).rejects.toThrow();
      // Should only try unique models: gpt-4o-mini, gpt-3.5-turbo = 2
      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    });
  });

  describe("rate limiting", () => {
    const completionParams: LiteLlmCompletionParams = {
      messages: [{ role: "user", content: "Hello" }],
    };

    it("should call rateLimiter.consume before each request", async () => {
      await service.acompletion(completionParams);

      expect(rateLimiterService.consume).toHaveBeenCalledWith(
        "litellm:rpm",
        60, // requestsPerMinute
        60  // rateLimitWindowSeconds
      );
    });

    it("should throw when rate limiter returns false", async () => {
      rateLimiterService.consume.mockResolvedValueOnce(false);

      await expect(service.acompletion(completionParams)).rejects.toThrow(
        "LiteLLM request throttled by local rate limiter"
      );
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it("should rebuild client when apiBase changes", async () => {
      // First call
      await service.acompletion(completionParams);
      const initialCreateCalls = mockAxiosCreate.mock.calls.length;

      // Change config
      llmGatewaySettings.getActiveConfig.mockResolvedValueOnce({
        apiBase: "http://new-api-base:4002",
      });

      // Second call should rebuild client
      await service.acompletion(completionParams);

      expect(mockAxiosCreate.mock.calls.length).toBeGreaterThan(initialCreateCalls);
    });

    it("should NOT rebuild client when config unchanged", async () => {
      // First call
      await service.acompletion(completionParams);
      const initialCreateCalls = mockAxiosCreate.mock.calls.length;

      // Second call with same config
      await service.acompletion(completionParams);

      expect(mockAxiosCreate.mock.calls.length).toBe(initialCreateCalls);
    });

    it("should merge llmGatewaySettings overrides into config", async () => {
      llmGatewaySettings.getActiveConfig.mockResolvedValueOnce({
        model: "override-model",
        temperature: 0.5,
      });

      await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/chat/completions",
        expect.objectContaining({
          model: "override-model",
          temperature: 0.5,
        }),
        expect.any(Object)
      );
    });
  });

  describe("embedding", () => {
    const embeddingParams: LiteLlmEmbeddingParams = {
      input: "Hello, world!",
    };

    beforeEach(() => {
      mockAxiosPost.mockResolvedValue(mockEmbeddingResponse);
    });

    it("should complete embedding with default embeddingModel", async () => {
      const result = await service.embedding(embeddingParams);

      expect(result.model).toBe("text-embedding-3-small");
      expect(result.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/embeddings",
        expect.objectContaining({
          model: "text-embedding-3-small",
          input: "Hello, world!",
        }),
        expect.any(Object)
      );
    });

    it("should use custom model when provided", async () => {
      await service.embedding({ ...embeddingParams, model: "custom-embedding" });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/embeddings",
        expect.objectContaining({ model: "custom-embedding" }),
        expect.any(Object)
      );
    });

    it("should fallback to config.model when embeddingModel not configured", async () => {
      configService.config = {
        ...mockConfig,
        litellm: {
          ...mockConfig.litellm,
          embeddingModel: undefined,
        },
      };

      await service.embedding(embeddingParams);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/embeddings",
        expect.objectContaining({ model: "gpt-4o-mini" }),
        expect.any(Object)
      );
    });

    it("should throw when no model available", async () => {
      configService.config = {
        ...mockConfig,
        litellm: {
          ...mockConfig.litellm,
          model: undefined,
          embeddingModel: undefined,
        },
      };

      await expect(service.embedding(embeddingParams)).rejects.toThrow(
        "LiteLLM embedding model is not configured"
      );
    });

    it("should include costUsd and latencyMs in response", async () => {
      const result = await service.embedding(embeddingParams);

      expect(result.costUsd).toBe(0.00001);
      expect(result.latencyMs).toBeDefined();
      expect(typeof result.latencyMs).toBe("number");
    });

    it("should retry on transient errors", async () => {
      const error500 = new AxiosError("Server error", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 500,
        data: {},
        statusText: "Internal Server Error",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost
        .mockRejectedValueOnce(error500)
        .mockResolvedValueOnce(mockEmbeddingResponse);

      const result = await service.embedding(embeddingParams);

      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(result.model).toBe("text-embedding-3-small");
    });
  });

  describe("getEmbeddingModel", () => {
    it("should return configured embeddingModel", async () => {
      const model = await service.getEmbeddingModel();

      expect(model).toBe("text-embedding-3-small");
    });

    it("should return undefined when embeddingModel not configured", async () => {
      configService.config = {
        ...mockConfig,
        litellm: {
          ...mockConfig.litellm,
          embeddingModel: undefined,
        },
      };

      const model = await service.getEmbeddingModel();

      expect(model).toBeUndefined();
    });
  });

  describe("API path handling", () => {
    const completionParams: LiteLlmCompletionParams = {
      messages: [{ role: "user", content: "Hello" }],
    };

    it("should try primary path /v1/chat/completions first", async () => {
      await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        "/v1/chat/completions",
        expect.any(Object),
        expect.any(Object)
      );
    });

    it("should fallback to /chat/completions on 404", async () => {
      const error404 = new AxiosError("Not found", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 404,
        data: {},
        statusText: "Not Found",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost
        .mockRejectedValueOnce(error404)
        .mockResolvedValueOnce(mockCompletionResponse);

      await service.acompletion(completionParams);

      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(mockAxiosPost).toHaveBeenNthCalledWith(
        1,
        "/v1/chat/completions",
        expect.any(Object),
        expect.any(Object)
      );
      expect(mockAxiosPost).toHaveBeenNthCalledWith(
        2,
        "/chat/completions",
        expect.any(Object),
        expect.any(Object)
      );
    });

    it("should throw immediately on non-404 errors (no path fallback)", async () => {
      const error400 = new AxiosError("Bad request", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 400,
        data: {},
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      mockAxiosPost.mockRejectedValue(error400);

      // Will try model fallback but not path fallback
      await expect(service.acompletion(completionParams)).rejects.toThrow();
    });
  });

  describe("normalizeApiBase", () => {
    it("should be tested via client rebuild behavior", async () => {
      // Test trailing slash removal
      llmGatewaySettings.getActiveConfig.mockResolvedValueOnce({
        apiBase: "http://localhost:4001/",
      });

      await service.acompletion({ messages: [{ role: "user", content: "test" }] });

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "http://localhost:4001",
        })
      );
    });

    it("should strip /v1/chat/completions suffix", async () => {
      llmGatewaySettings.getActiveConfig.mockResolvedValueOnce({
        apiBase: "http://localhost:4001/v1/chat/completions",
      });

      await service.acompletion({ messages: [{ role: "user", content: "test" }] });

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "http://localhost:4001",
        })
      );
    });

    it("should strip /v1 suffix", async () => {
      llmGatewaySettings.getActiveConfig.mockResolvedValueOnce({
        apiBase: "http://localhost:4001/v1",
      });

      await service.acompletion({ messages: [{ role: "user", content: "test" }] });

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "http://localhost:4001",
        })
      );
    });
  });
});
