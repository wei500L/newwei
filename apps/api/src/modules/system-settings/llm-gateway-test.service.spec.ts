import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { AxiosError, AxiosHeaders, AxiosResponse } from "axios";

import { LLM_GATEWAY_ERROR_CODE_UNAVAILABLE } from "./llm-gateway-error-codes";
import { LlmGatewayTestService } from "./llm-gateway-test.service";

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
  post: mockAxiosPost,
  get: mockAxiosGet,
}));

jest.mock("axios", () => ({
  ...jest.requireActual("axios"),
  create: (...args: unknown[]) => mockAxiosCreate(...args),
  AxiosError: jest.requireActual("axios").AxiosError,
}));

jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe("LlmGatewayTestService", () => {
  const settingsMock = {
    getProfileConfig: jest.fn(),
  } as any;
  const cacheMock = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  } as any;

  let service: LlmGatewayTestService;

  const config = {
    apiBase: "http://localhost:4001/v1/chat/completions",
    apiKey: "sk-test",
    model: "openai/gpt-4o-mini",
    embeddingModel: "openai/text-embedding-3-small",
    rerankModel: "cohere/rerank-v3.5",
    rerankFallbackModels: ["cohere/rerank-v3.0"],
    timeoutMs: 60_000,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 1_200,
    maxRetries: 3,
    fallbackModels: ["openai/gpt-4o-mini"],
    requestsPerMinute: 60,
    sendMetadata: true,
    responseFormatMode: "json_schema",
    apiSurface: "chat_completions",
  };

  const mockCompletionResponse: AxiosResponse = {
    data: {
      model: "openai/gpt-4o-mini",
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
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
      model: "openai/text-embedding-3-small",
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 3, total_tokens: 3 },
    },
    status: 200,
    statusText: "OK",
    headers: {
      "x-litellm-response-cost": "0.00001",
    },
    config: { headers: new AxiosHeaders() },
  };

  const mockRerankResponse: AxiosResponse = {
    data: {
      model: "cohere/rerank-v3.5",
      results: [
        { index: 1, relevance_score: 0.92 },
        { index: 0, relevance_score: 0.61 },
      ],
    },
    status: 200,
    statusText: "OK",
    headers: {
      "x-litellm-response-cost": "0.00003",
    },
    config: { headers: new AxiosHeaders() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    settingsMock.getProfileConfig.mockResolvedValue(config);
    cacheMock.get.mockResolvedValue(null);
    cacheMock.set.mockResolvedValue(undefined);
    cacheMock.del.mockResolvedValue(undefined);
    service = new LlmGatewayTestService(settingsMock, cacheMock);
  });

  it("tests completion and embeddings", async () => {
    mockAxiosPost
      .mockResolvedValueOnce(mockCompletionResponse)
      .mockResolvedValueOnce(mockEmbeddingResponse);

    const result = await service.testProfile("profile-1", {
      includeEmbeddings: true,
    });

    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.completion.content).toBe("OK");
    expect(result.completion.costUsd).toBe(0.0001);
    expect(result.completion.keySpendUsd).toBe(0.05);
    expect(result.embedding?.dimensions).toBe(3);

    expect(mockAxiosCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://localhost:4001",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
      }),
    );

    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      "/v1/chat/completions",
      expect.objectContaining({ model: "openai/gpt-4o-mini" }),
      expect.any(Object),
    );
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      2,
      "/v1/embeddings",
      expect.objectContaining({ model: "openai/text-embedding-3-small" }),
      expect.any(Object),
    );
  });

  it("falls back to /chat/completions on 404", async () => {
    const error404 = new AxiosError(
      "Not found",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 404,
        data: {},
        statusText: "Not Found",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    mockAxiosPost
      .mockRejectedValueOnce(error404)
      .mockResolvedValueOnce(mockCompletionResponse);

    const result = await service.testProfile("profile-1", {
      includeEmbeddings: false,
    });

    expect(result.completion.content).toBe("OK");
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      "/v1/chat/completions",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      2,
      "/chat/completions",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("tests rerank probe when includeRerank is enabled", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockRerankResponse);

    const result = await service.testProfile("profile-1", {
      includeCompletion: false,
      includeEmbeddings: false,
      includeRerank: true,
      rerankQuery: "us inflation and fed policy",
      rerankDocuments: [
        "Fed comments suggest slower cuts.",
        "Bank earnings beat expectations.",
      ],
    });

    expect(result.rerank?.model).toBe("cohere/rerank-v3.5");
    expect(result.rerank?.results).toEqual([
      { index: 0, score: 0.61 },
      { index: 1, score: 0.92 },
    ]);
    expect(result.rerankError).toBeUndefined();
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/rerank",
      expect.objectContaining({
        model: "cohere/rerank-v3.5",
        query: "us inflation and fed policy",
        documents: [
          "Fed comments suggest slower cuts.",
          "Bank earnings beat expectations.",
        ],
      }),
      expect.any(Object),
    );
  });

  it("uses backup rerank model when primary rerank model fails", async () => {
    const error400 = new AxiosError(
      "Bad request",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 400,
        data: {},
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );
    mockAxiosPost
      .mockRejectedValueOnce(error400)
      .mockResolvedValueOnce({
        ...mockRerankResponse,
        data: {
          model: "cohere/rerank-v3.0",
          results: [{ index: 0, relevance_score: 0.88 }],
        },
      });

    const result = await service.testProfile("profile-1", {
      includeCompletion: false,
      includeEmbeddings: false,
      includeRerank: true,
    });

    expect(result.rerank?.model).toBe("cohere/rerank-v3.0");
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      "/v1/rerank",
      expect.objectContaining({ model: "cohere/rerank-v3.5" }),
      expect.any(Object),
    );
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      2,
      "/v1/rerank",
      expect.objectContaining({ model: "cohere/rerank-v3.0" }),
      expect.any(Object),
    );
  });

  it("falls back to /chat/completions on 405", async () => {
    const error405 = new AxiosError(
      "Method not allowed",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 405,
        data: {
          error: { message: "Method not allowed for /v1/chat/completions" },
        },
        statusText: "Method Not Allowed",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    mockAxiosPost
      .mockRejectedValueOnce(error405)
      .mockResolvedValueOnce(mockCompletionResponse);

    const result = await service.testProfile("profile-1", {
      includeEmbeddings: false,
    });

    expect(result.completion.content).toBe("OK");
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      "/v1/chat/completions",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      2,
      "/chat/completions",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("extracts completion text from content parts array", async () => {
    const response: AxiosResponse = {
      data: {
        model: "openai/gpt-4o-mini",
        choices: [
          {
            message: {
              content: [{ type: "text", text: "OK" }],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosPost.mockResolvedValueOnce(response);

    const result = await service.testProfile("profile-1", {
      includeEmbeddings: false,
    });

    expect(result.completion.content).toBe("OK");
  });

  it("returns embeddingError when embeddings test fails", async () => {
    const error400 = new AxiosError(
      "Bad request",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 400,
        data: {},
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    mockAxiosPost
      .mockResolvedValueOnce(mockCompletionResponse)
      .mockRejectedValueOnce(error400);

    const result = await service.testProfile("profile-1", {
      includeEmbeddings: true,
    });

    expect(result.completion.content).toBe("OK");
    expect(result.embedding).toBeUndefined();
    expect(result.embeddingError?.code).toBe("UPSTREAM_REQUEST_FAILED");
    expect(result.embeddingError?.status).toBe(400);
    expect(result.embeddingError?.message).toContain("HTTP 400");
  });

  it("returns embeddingError when embedding vector is missing", async () => {
    const embeddingResponseMissing: AxiosResponse = {
      data: {
        model: "openai/text-embedding-3-small",
        data: [{ index: 0 }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosPost
      .mockResolvedValueOnce(mockCompletionResponse)
      .mockResolvedValueOnce(embeddingResponseMissing);

    const result = await service.testProfile("profile-1", {
      includeEmbeddings: true,
    });

    expect(result.embedding).toBeUndefined();
    expect(result.embeddingError?.message).toContain(
      "Embedding response did not include an embedding vector",
    );
  });

  it("skips completion when includeCompletion is false", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockEmbeddingResponse);

    const result = await service.testProfile("profile-1", {
      includeCompletion: false,
      includeEmbeddings: true,
    });

    expect(result.completion).toBeUndefined();
    expect(result.completionError).toBeUndefined();
    expect(result.embedding?.dimensions).toBe(3);

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/embeddings",
      expect.objectContaining({ model: "openai/text-embedding-3-small" }),
      expect.any(Object),
    );
  });

  it("lists models via /v1/models", async () => {
    const response: AxiosResponse = {
      data: {
        data: [{ id: "openai/gpt-4o-mini" }, { id: "claude-3-opus-20240229" }],
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosGet.mockResolvedValueOnce(response);

    const result = await service.listModels("profile-1");
    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.models).toEqual([
      "openai/gpt-4o-mini",
      "claude-3-opus-20240229",
    ]);
    expect(mockAxiosGet).toHaveBeenCalledWith("/v1/models", expect.any(Object));
  });

  it("checks proxy liveliness + readiness endpoints", async () => {
    const livelinessResponse: AxiosResponse = {
      data: { status: "ok" },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    const readinessResponse: AxiosResponse = {
      data: { status: "ok" },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosGet
      .mockResolvedValueOnce(livelinessResponse)
      .mockResolvedValueOnce(readinessResponse);

    const result = await service.checkProxyHealth("profile-1");

    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.liveliness.ok).toBe(true);
    expect(result.liveliness.status).toBe(200);
    expect(result.readiness.ok).toBe(true);
    expect(result.readiness.status).toBe(200);

    expect(mockAxiosCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://localhost:4001",
        timeout: 10_000,
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
      }),
    );

    expect(mockAxiosGet).toHaveBeenNthCalledWith(1, "/health/liveliness", {
      timeout: 10_000,
    });
    expect(mockAxiosGet).toHaveBeenNthCalledWith(2, "/health/readiness", {
      timeout: 10_000,
    });
  });

  it("fetches proxy model info", async () => {
    const modelInfoResponse: AxiosResponse = {
      data: {
        models: [
          {
            model_name: "openai/gpt-4o-mini",
            litellm_params: {
              model: "openai/gpt-4o-mini",
              api_key: "sk-super-secret",
              rpm: 60,
            },
          },
        ],
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosGet.mockResolvedValueOnce(modelInfoResponse);

    const result = await service.getProxyModelInfo("profile-1");

    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.modelName).toBe("openai/gpt-4o-mini");
    expect(result.models[0]?.litellmParams).toEqual(
      expect.objectContaining({
        model: "openai/gpt-4o-mini",
        rpm: 60,
      }),
    );
    expect(result.models[0]?.litellmParams).not.toHaveProperty("api_key");

    expect(mockAxiosGet).toHaveBeenCalledWith("/v1/model/info", {
      timeout: 60_000,
    });
  });

  it("returns failed check results when proxy endpoints error", async () => {
    const error404 = new AxiosError(
      "Not found",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 404,
        data: {},
        statusText: "Not Found",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    const readinessResponse: AxiosResponse = {
      data: { status: "ok" },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosGet
      .mockRejectedValueOnce(error404)
      .mockResolvedValueOnce(readinessResponse);

    const result = await service.checkProxyHealth("profile-1");

    expect(result.liveliness.ok).toBe(false);
    expect(result.liveliness.status).toBe(404);
    expect(result.liveliness.message).toContain("HTTP 404");
    expect(result.readiness.ok).toBe(true);
    expect(result.readiness.status).toBe(200);
  });

  it("marks proxy health endpoints unhealthy when they return HTML", async () => {
    const htmlResponse: AxiosResponse = {
      data: "<!doctype html><html><head><title>Not health</title></head><body>OK</body></html>",
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
      config: { headers: new AxiosHeaders() },
    };

    const readinessResponse: AxiosResponse = {
      data: { status: "ok" },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosGet
      .mockResolvedValueOnce(htmlResponse)
      .mockResolvedValueOnce(readinessResponse);

    const result = await service.checkProxyHealth("profile-1");

    expect(result.liveliness.ok).toBe(false);
    expect(result.liveliness.status).toBe(200);
    expect(result.liveliness.message).toContain("HTML");
    expect(result.readiness.ok).toBe(true);
    expect(result.readiness.status).toBe(200);
  });

  it("surfaces upstream error details instead of Axios codes", async () => {
    const error401 = new AxiosError(
      "Unauthorized",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 401,
        data: { error: { message: "Incorrect API key provided." } },
        statusText: "Unauthorized",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    mockAxiosGet.mockRejectedValueOnce(error401);

    try {
      await service.listModels("profile-1");
      throw new Error("Expected listModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        code?: unknown;
        message?: unknown;
      };
      expect(response.code).toBe("UPSTREAM_UNAUTHORIZED");
      expect(response.message).toContain("HTTP 401");
      expect(response.message).toContain("Incorrect API key provided.");
      expect(response.message).not.toContain("ERR_BAD_REQUEST");
    }
  });

  it("replaces generic Axios codes with actionable auth hints", async () => {
    const error401 = new AxiosError(
      "Request failed with status code 401",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 401,
        data: { message: "ERR_BAD_REQUEST" },
        statusText: "",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    mockAxiosGet.mockRejectedValueOnce(error401);

    try {
      await service.listModels("profile-1");
      throw new Error("Expected listModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        code?: unknown;
        message?: unknown;
      };
      expect(response.code).toBe("UPSTREAM_UNAUTHORIZED");
      expect(response.message).toContain("HTTP 401");
      expect(response.message).toContain("Unauthorized");
      expect(response.message).toContain("apiKey");
      expect(response.message).not.toContain("ERR_BAD_REQUEST");
    }
  });

  it("falls back to /models on 404", async () => {
    const error404 = new AxiosError(
      "Not found",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 404,
        data: {},
        statusText: "Not Found",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    const response: AxiosResponse = {
      data: {
        data: [{ id: "gpt-4" }],
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosGet
      .mockRejectedValueOnce(error404)
      .mockResolvedValueOnce(response);

    const result = await service.listModels("profile-1");
    expect(result.models).toEqual(["gpt-4"]);
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      1,
      "/v1/models",
      expect.any(Object),
    );
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      2,
      "/models",
      expect.any(Object),
    );
  });

  it("falls back to /models on 405", async () => {
    const error405 = new AxiosError(
      "Method not allowed",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 405,
        data: { error: { message: "Method not allowed for /v1/models" } },
        statusText: "Method Not Allowed",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    const response: AxiosResponse = {
      data: {
        data: [{ id: "gpt-4" }],
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosGet
      .mockRejectedValueOnce(error405)
      .mockResolvedValueOnce(response);

    const result = await service.listModels("profile-1");
    expect(result.models).toEqual(["gpt-4"]);
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      1,
      "/v1/models",
      expect.any(Object),
    );
    expect(mockAxiosGet).toHaveBeenNthCalledWith(
      2,
      "/models",
      expect.any(Object),
    );
  });

  it("returns explicit unavailable code for network errors without HTTP status", async () => {
    const networkError = new AxiosError("connect ECONNREFUSED", "ECONNREFUSED");
    mockAxiosGet.mockRejectedValueOnce(networkError);

    try {
      await service.listModels("profile-1");
      throw new Error("Expected listModels to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const response = (error as ServiceUnavailableException).getResponse() as {
        code?: unknown;
        message?: unknown;
      };
      expect(response.code).toBe(LLM_GATEWAY_ERROR_CODE_UNAVAILABLE);
      expect(String(response.message)).toContain("LLM gateway request failed");
    }
  });

  it("supports overriding completion + embedding models", async () => {
    mockAxiosPost
      .mockResolvedValueOnce(mockCompletionResponse)
      .mockResolvedValueOnce(mockEmbeddingResponse);

    await service.testProfile("profile-1", {
      model: "openrouter/gpt-4o",
      includeEmbeddings: true,
      embeddingModel: "openai/text-embedding-3-small",
    });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/chat/completions",
      expect.objectContaining({ model: "openrouter/gpt-4o" }),
      expect.any(Object),
    );
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/embeddings",
      expect.objectContaining({ model: "openai/text-embedding-3-small" }),
      expect.any(Object),
    );
  });

  it("supports responses API surface in profile tests", async () => {
    const responsesResult: AxiosResponse = {
      data: {
        id: "resp_123",
        model: "openai/gpt-4o-mini",
        output_text: "OK",
      },
      status: 200,
      statusText: "OK",
      headers: {
        "x-litellm-response-cost": "0.0002",
      },
      config: { headers: new AxiosHeaders() },
    };

    mockAxiosPost.mockResolvedValueOnce(responsesResult);

    const result = await service.testProfile("profile-1", {
      includeCompletion: true,
      includeEmbeddings: false,
      apiSurface: "responses",
    });

    expect(result.apiSurfaceUsed).toBe("responses");
    expect(result.completion?.content).toBe("OK");
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/responses",
      expect.objectContaining({ input: expect.any(String) }),
      expect.any(Object),
    );
  });

  it("uses profile apiSurface when request does not provide one", async () => {
    settingsMock.getProfileConfig.mockResolvedValueOnce({
      ...config,
      apiSurface: "responses",
    });
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        id: "resp_abc",
        model: "openai/gpt-4o-mini",
        output_text: "OK",
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

    const result = await service.testProfile("profile-1", {
      includeCompletion: true,
      includeEmbeddings: false,
    });

    expect(result.apiSurfaceUsed).toBe("responses");
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/responses",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("inherits profile compatibility defaults for profile tests", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse);

    await service.testProfile("profile-1", {
      includeCompletion: true,
      includeEmbeddings: false,
    });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/chat/completions",
      expect.objectContaining({
        response_format: expect.objectContaining({ type: "json_schema" }),
        metadata: { source: "gateway-test" },
      }),
      expect.any(Object),
    );
  });

  it("respects profile compatibility settings when probes are omitted", async () => {
    settingsMock.getProfileConfig.mockResolvedValueOnce({
      ...config,
      sendMetadata: false,
      responseFormatMode: "none",
    });
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse);

    await service.testProfile("profile-1", {
      includeCompletion: true,
      includeEmbeddings: false,
    });

    const payload = mockAxiosPost.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("metadata");
    expect(payload).not.toHaveProperty("response_format");
  });


  it("returns compatibilityError when metadata is unsupported", async () => {
    const error400 = new AxiosError(
      "Bad request",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 400,
        data: {
          error: {
            message:
              "Unrecognized request argument supplied: metadata Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789",
          },
        },
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );

    mockAxiosPost.mockRejectedValue(error400);

    const result = await service.testProfile("profile-1", {
      includeCompletion: true,
      includeEmbeddings: false,
      includeMetadataProbe: true,
    });

    expect(result.completion).toBeUndefined();
    expect(result.completionError?.compatibilityError?.code).toBe(
      "UNSUPPORTED_METADATA",
    );
    expect(result.compatibilityError?.code).toBe("UNSUPPORTED_METADATA");
    expect(
      result.completionError?.compatibilityError?.upstreamMessage,
    ).toContain("Bearer [REDACTED]");
    expect(
      result.completionError?.compatibilityError?.upstreamMessage,
    ).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("passes response_format probe for completion tests", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse);

    await service.testProfile("profile-1", {
      includeCompletion: true,
      includeEmbeddings: false,
      responseFormatMode: "json_object",
    });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/chat/completions",
      expect.objectContaining({
        response_format: { type: "json_object" },
      }),
      expect.any(Object),
    );
  });

  it("tests an unsaved config payload", async () => {
    mockAxiosPost
      .mockResolvedValueOnce(mockCompletionResponse)
      .mockResolvedValueOnce(mockEmbeddingResponse);

    const result = await service.testConfig({
      apiBase: config.apiBase,
      apiKey: config.apiKey,
      model: config.model,
      embeddingModel: config.embeddingModel ?? undefined,
      timeoutMs: config.timeoutMs,
      temperature: config.temperature,
      topP: config.topP,
      maxOutputTokens: config.maxOutputTokens,
      fallbackModels: config.fallbackModels,
      includeEmbeddings: true,
    });

    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.completion.content).toBe("OK");
    expect(result.embedding?.dimensions).toBe(3);
    expect(settingsMock.getProfileConfig).not.toHaveBeenCalled();
  });

  it("reuses stored apiKey when apiKey is omitted for config test", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse);

    await service.testConfig({
      profileId: "profile-1",
      apiBase: config.apiBase,
      model: config.model,
      includeEmbeddings: false,
    });

    expect(settingsMock.getProfileConfig).toHaveBeenCalledWith("profile-1");
    expect(mockAxiosCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
      }),
    );
  });

  it("does not reuse stored apiKey when apiKey is explicitly empty", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse);

    await service.testConfig({
      profileId: "profile-1",
      apiBase: config.apiBase,
      apiKey: "",
      model: config.model,
      includeEmbeddings: false,
    });

    expect(settingsMock.getProfileConfig).toHaveBeenCalledWith("profile-1");
    expect(mockAxiosCreate).toHaveBeenCalled();
    const createConfig = mockAxiosCreate.mock.calls[0]?.[0] as any;
    expect(createConfig?.headers?.Authorization).toBeUndefined();
  });

  it("lists models for an unsaved config payload", async () => {
    const response: AxiosResponse = {
      data: {
        data: [{ id: "openai/gpt-4o-mini" }],
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    mockAxiosGet.mockResolvedValueOnce(response);

    const result = await service.listModelsConfig({
      apiBase: config.apiBase,
      apiKey: config.apiKey,
    });

    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.models).toEqual(["openai/gpt-4o-mini"]);
    expect(settingsMock.getProfileConfig).not.toHaveBeenCalled();
  });

  it("allows config tests to reuse stored model when model is omitted", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse);

    await service.testConfig({
      profileId: "profile-1",
      apiBase: config.apiBase,
      includeEmbeddings: false,
    });

    expect(settingsMock.getProfileConfig).toHaveBeenCalledWith("profile-1");
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/chat/completions",
      expect.objectContaining({ model: config.model }),
      expect.any(Object),
    );
  });

  it("supports embeddings-only config tests without requiring a completion model", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockEmbeddingResponse);

    const result = await service.testConfig({
      apiBase: config.apiBase,
      apiKey: config.apiKey,
      embeddingModel: config.embeddingModel ?? undefined,
      includeCompletion: false,
      includeEmbeddings: true,
    });

    expect(result.completion).toBeUndefined();
    expect(result.embedding?.dimensions).toBe(3);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/embeddings",
      expect.objectContaining({ model: "openai/text-embedding-3-small" }),
      expect.any(Object),
    );
  });
});
