import { AxiosError, AxiosHeaders, AxiosResponse } from "axios";

import { LlmGatewayTestService } from "./llm-gateway-test.service";

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
  post: mockAxiosPost,
  get: mockAxiosGet
}));

jest.mock("axios", () => ({
  ...jest.requireActual("axios"),
  create: (...args: unknown[]) => mockAxiosCreate(...args),
  AxiosError: jest.requireActual("axios").AxiosError
}));

jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

describe("LlmGatewayTestService", () => {
  const settingsMock = {
    getProfileConfig: jest.fn()
  } as any;

  let service: LlmGatewayTestService;

  const config = {
    apiBase: "http://localhost:4001/v1/chat/completions",
    apiKey: "sk-test",
    model: "openai/gpt-4o-mini",
    embeddingModel: "openai/text-embedding-3-small",
    timeoutMs: 60_000,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 1_200,
    maxRetries: 3,
    fallbackModels: ["openai/gpt-4o-mini"],
    requestsPerMinute: 60
  };

  const mockCompletionResponse: AxiosResponse = {
    data: {
      model: "openai/gpt-4o-mini",
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
    },
    status: 200,
    statusText: "OK",
    headers: {
      "x-litellm-response-cost": "0.0001",
      "x-litellm-key-spend": "0.05"
    },
    config: { headers: new AxiosHeaders() }
  };

  const mockEmbeddingResponse: AxiosResponse = {
    data: {
      model: "openai/text-embedding-3-small",
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 3, total_tokens: 3 }
    },
    status: 200,
    statusText: "OK",
    headers: {
      "x-litellm-response-cost": "0.00001"
    },
    config: { headers: new AxiosHeaders() }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    settingsMock.getProfileConfig.mockResolvedValue(config);
    service = new LlmGatewayTestService(settingsMock);
  });

  it("tests completion and embeddings", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse).mockResolvedValueOnce(mockEmbeddingResponse);

    const result = await service.testProfile("profile-1", { includeEmbeddings: true });

    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.completion.content).toBe("OK");
    expect(result.completion.costUsd).toBe(0.0001);
    expect(result.completion.keySpendUsd).toBe(0.05);
    expect(result.embedding?.dimensions).toBe(3);

    expect(mockAxiosCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://localhost:4001",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test"
        })
      })
    );

    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      "/v1/chat/completions",
      expect.objectContaining({ model: "openai/gpt-4o-mini" }),
      expect.any(Object)
    );
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      2,
      "/v1/embeddings",
      expect.objectContaining({ model: "openai/text-embedding-3-small" }),
      expect.any(Object)
    );
  });

  it("falls back to /chat/completions on 404", async () => {
    const error404 = new AxiosError("Not found", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 404,
      data: {},
      statusText: "Not Found",
      headers: {},
      config: { headers: new AxiosHeaders() }
    });

    mockAxiosPost.mockRejectedValueOnce(error404).mockResolvedValueOnce(mockCompletionResponse);

    const result = await service.testProfile("profile-1", { includeEmbeddings: false });

    expect(result.completion.content).toBe("OK");
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

  it("returns embeddingError when embeddings test fails", async () => {
    const error400 = new AxiosError("Bad request", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 400,
      data: {},
      statusText: "Bad Request",
      headers: {},
      config: { headers: new AxiosHeaders() }
    });

    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse).mockRejectedValueOnce(error400);

    const result = await service.testProfile("profile-1", { includeEmbeddings: true });

    expect(result.completion.content).toBe("OK");
    expect(result.embedding).toBeUndefined();
    expect(result.embeddingError?.status).toBe(400);
    expect(result.embeddingError?.message).toContain("HTTP 400");
  });

  it("lists models via /v1/models", async () => {
    const response: AxiosResponse = {
      data: {
        data: [{ id: "openai/gpt-4o-mini" }, { id: "claude-3-opus-20240229" }]
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() }
    };

    mockAxiosGet.mockResolvedValueOnce(response);

    const result = await service.listModels("profile-1");
    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.models).toEqual(["openai/gpt-4o-mini", "claude-3-opus-20240229"]);
    expect(mockAxiosGet).toHaveBeenCalledWith("/v1/models", expect.any(Object));
  });

  it("falls back to /models on 404", async () => {
    const error404 = new AxiosError("Not found", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 404,
      data: {},
      statusText: "Not Found",
      headers: {},
      config: { headers: new AxiosHeaders() }
    });

    const response: AxiosResponse = {
      data: {
        data: [{ id: "gpt-4" }]
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() }
    };

    mockAxiosGet.mockRejectedValueOnce(error404).mockResolvedValueOnce(response);

    const result = await service.listModels("profile-1");
    expect(result.models).toEqual(["gpt-4"]);
    expect(mockAxiosGet).toHaveBeenNthCalledWith(1, "/v1/models", expect.any(Object));
    expect(mockAxiosGet).toHaveBeenNthCalledWith(2, "/models", expect.any(Object));
  });

  it("supports overriding completion + embedding models", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse).mockResolvedValueOnce(mockEmbeddingResponse);

    await service.testProfile("profile-1", {
      model: "openrouter/gpt-4o",
      includeEmbeddings: true,
      embeddingModel: "openai/text-embedding-3-small"
    });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/chat/completions",
      expect.objectContaining({ model: "openrouter/gpt-4o" }),
      expect.any(Object)
    );
    expect(mockAxiosPost).toHaveBeenCalledWith(
      "/v1/embeddings",
      expect.objectContaining({ model: "openai/text-embedding-3-small" }),
      expect.any(Object)
    );
  });

  it("tests an unsaved config payload", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse).mockResolvedValueOnce(mockEmbeddingResponse);

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
      includeEmbeddings: true
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
      includeEmbeddings: false
    });

    expect(settingsMock.getProfileConfig).toHaveBeenCalledWith("profile-1");
    expect(mockAxiosCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test"
        })
      })
    );
  });

  it("does not reuse stored apiKey when apiKey is explicitly empty", async () => {
    mockAxiosPost.mockResolvedValueOnce(mockCompletionResponse);

    await service.testConfig({
      profileId: "profile-1",
      apiBase: config.apiBase,
      apiKey: "",
      model: config.model,
      includeEmbeddings: false
    });

    expect(settingsMock.getProfileConfig).toHaveBeenCalledWith("profile-1");
    expect(mockAxiosCreate).toHaveBeenCalled();
    const createConfig = mockAxiosCreate.mock.calls[0]?.[0] as any;
    expect(createConfig?.headers?.Authorization).toBeUndefined();
  });

  it("lists models for an unsaved config payload", async () => {
    const response: AxiosResponse = {
      data: {
        data: [{ id: "openai/gpt-4o-mini" }]
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() }
    };
    mockAxiosGet.mockResolvedValueOnce(response);

    const result = await service.listModelsConfig({
      apiBase: config.apiBase,
      apiKey: config.apiKey
    });

    expect(result.apiBase).toBe("http://localhost:4001");
    expect(result.models).toEqual(["openai/gpt-4o-mini"]);
    expect(settingsMock.getProfileConfig).not.toHaveBeenCalled();
  });
});
