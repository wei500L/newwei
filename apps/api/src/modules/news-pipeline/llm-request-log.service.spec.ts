const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("@modular/utils", () => ({
  createLogger: () => mockLogger,
}));

import { LlmRequestLogService } from "./llm-request-log.service";

describe("LlmRequestLogService", () => {
  const modelMock = {
    create: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
  } as any;
  const settingsServiceMock = {
    getMetadataPolicySnapshot: jest.fn(),
    getMetadataPolicySummarySnapshot: jest.fn(),
  } as any;

  let service: LlmRequestLogService;

  beforeEach(() => {
    jest.resetAllMocks();
    modelMock.create = jest.fn().mockResolvedValue({});
    settingsServiceMock.getMetadataPolicySnapshot.mockReturnValue({
      allowedTopLevelKeys: ["traceid", "requestid"],
      allowedTopLevelPrefixes: ["x_", "meta_", "ctx_"],
    });
    settingsServiceMock.getMetadataPolicySummarySnapshot.mockReturnValue({
      source: "db",
      allowedTopLevelKeys: ["traceid", "requestid"],
      allowedTopLevelPrefixes: ["x_", "meta_", "ctx_"],
    });
    service = new LlmRequestLogService(modelMock, settingsServiceMock);
  });

  it("filters metadata with top-level allowlist and preserves safe fields", () => {
    service.logRequest({
      orgId: "org-1",
      requestType: "completion",
      model: "gpt-4o-mini",
      status: "success",
      latencyMs: 120,
      metadata: {
        traceId: "trace-123",
        requestId: "req-456",
        prompt: "should-not-be-stored",
        x_context: {
          nestedPrompt: "also-not-whitelisted-at-top-level",
          source: "news-pipeline",
        },
      },
    });

    expect(modelMock.create).toHaveBeenCalledTimes(1);
    const payload = modelMock.create.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown> | null;
    };

    expect(payload.metadata).toEqual(
      expect.objectContaining({
        traceid: "trace-123",
        requestid: "req-456",
        x_context: expect.any(Object),
      }),
    );
    expect(payload.metadata?.prompt).toBeUndefined();
  });

  it("applies metadata allowlist from system settings dynamically", () => {
    settingsServiceMock.getMetadataPolicySnapshot.mockReturnValue({
      allowedTopLevelKeys: ["customkey"],
      allowedTopLevelPrefixes: ["allow_"],
    });

    service.logRequest({
      orgId: "org-1",
      requestType: "completion",
      model: "gpt-4o-mini",
      status: "success",
      latencyMs: 60,
      metadata: {
        traceId: "trace-should-drop",
        customKey: "keep-by-key",
        allow_extra: "keep-by-prefix",
      },
    });

    const payload = modelMock.create.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown> | null;
    };

    expect(payload.metadata).toEqual({
      customkey: "keep-by-key",
      allow_extra: "keep-by-prefix",
    });
  });

  it("truncates oversized metadata payloads", () => {
    const oversizedMetadata: Record<string, unknown> = {};
    for (let index = 0; index < 60; index += 1) {
      oversizedMetadata[`x_key_${index}`] = "x".repeat(400);
    }

    service.logRequest({
      orgId: "org-1",
      requestType: "responses",
      model: "gpt-4.1-mini",
      status: "success",
      latencyMs: 80,
      metadata: oversizedMetadata,
    });

    const payload = modelMock.create.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown> | null;
    };

    expect(payload.metadata?._truncated).toBe(true);
    expect(typeof payload.metadata?._originalKeyCount).toBe("number");
    expect(typeof payload.metadata?._retainedKeyCount).toBe("number");
  });

  it("does not throw when async write fails", async () => {
    modelMock.create = jest.fn().mockRejectedValue(new Error("mongo write failed"));
    service = new LlmRequestLogService(modelMock, settingsServiceMock);

    expect(() =>
      service.logRequest({
        orgId: "org-1",
        requestType: "stream",
        model: "gpt-4o-mini",
        status: "error",
        latencyMs: 20,
        error: "upstream timeout",
      }),
    ).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("returns effective metadata policy summary in list response", async () => {
    modelMock.countDocuments = jest.fn().mockResolvedValue(0);
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    modelMock.find = jest.fn().mockReturnValue({ sort });

    const result = await service.queryLogs({ orgId: "org-1" }, {});

    expect(result.metadataPolicy).toEqual({
      source: "db",
      allowedTopLevelKeys: ["traceid", "requestid"],
      allowedTopLevelPrefixes: ["x_", "meta_", "ctx_"],
      keyCount: 2,
      prefixCount: 3,
    });
  });
});
