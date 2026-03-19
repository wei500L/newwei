import { BadRequestException } from "@nestjs/common";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
const writeAuditLogBestEffortMock = jest.fn().mockResolvedValue(undefined);

jest.mock("@modular/utils", () => ({
  createLogger: () => mockLogger,
}));
jest.mock("../audit/audit-log.writer", () => ({
  writeAuditLogBestEffort: (...args: unknown[]) =>
    writeAuditLogBestEffortMock(...args),
}));

import { LlmRequestLogService } from "./llm-request-log.service";

async function readStream(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      chunks.push(chunk);
      continue;
    }
    chunks.push(Buffer.from(chunk as ArrayBufferLike).toString("utf-8"));
  }
  return chunks.join("");
}

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
  const prismaMock = {} as any;

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
    service = new LlmRequestLogService(
      modelMock,
      prismaMock,
      settingsServiceMock,
    );
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

  it("persists normalized feature without runtime governance fields", () => {
    service.logRequest({
      orgId: "org-1",
      requestType: "completion",
      model: "gpt-4o-mini",
      status: "success",
      latencyMs: 120,
      feature: "Situation_Monitor_Monitors",
      gatewayProfileId: "profile-1",
      metadata: {
        traceId: "trace-123",
        source: "situation-monitor-monitors",
      },
    });

    const payload = modelMock.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload.feature).toBe("situation_monitor_monitors");
    expect(payload.gatewayProfileId).toBe("profile-1");
    expect(payload).not.toHaveProperty("runtimeRequestId");
    expect(payload).not.toHaveProperty("runtimeDecision");
    expect(payload).not.toHaveProperty("currentConcurrency");
    expect(payload).not.toHaveProperty("concurrencyLimit");
    expect(payload).not.toHaveProperty("dailySpendUsdSnapshot");
    expect(payload).not.toHaveProperty("monthlySpendUsdSnapshot");
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
    modelMock.create = jest
      .fn()
      .mockRejectedValue(new Error("mongo write failed"));
    service = new LlmRequestLogService(
      modelMock,
      prismaMock,
      settingsServiceMock,
    );

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

  it("filters feature against top-level feature and legacy metadata.feature", async () => {
    modelMock.countDocuments = jest.fn().mockResolvedValue(0);
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    modelMock.find = jest.fn().mockReturnValue({ sort });

    await service.queryLogs(
      { orgId: "org-1", feature: "news_event_brief" },
      {},
    );

    expect(modelMock.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        $and: [
          {
            $or: [
              { feature: "news_event_brief" },
              { "metadata.feature": "news_event_brief" },
            ],
          },
        ],
      }),
    );
  });

  it("applies gateway profile filter when querying logs", async () => {
    modelMock.countDocuments = jest.fn().mockResolvedValue(0);
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    modelMock.find = jest.fn().mockReturnValue({ sort });

    await service.queryLogs(
      { orgId: "org-1", profileId: " profile-1 " },
      {},
    );

    expect(modelMock.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        $and: [
          {
            $or: [
              { gatewayProfileId: "profile-1" },
              { "metadata.profileid": "profile-1" },
              { "metadata.crawlsiteprofileid": "profile-1" },
            ],
          },
        ],
      }),
    );
  });

  it("applies run and node metadata filters when querying logs", async () => {
    modelMock.countDocuments = jest.fn().mockResolvedValue(0);
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    modelMock.find = jest.fn().mockReturnValue({ sort });

    await service.queryLogs(
      {
        orgId: "org-1",
        runId: "run-1",
        nodeId: "node-1",
      },
      {},
    );

    expect(modelMock.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        $and: [
          {
            $or: [
              { "metadata.runid": "run-1" },
              { "metadata.frontierrunid": "run-1" },
            ],
          },
          {
            $or: [
              { "metadata.nodeid": "node-1" },
              { "metadata.frontiernodeid": "node-1" },
            ],
          },
        ],
      }),
    );
  });

  it("exports CSV rows for matched logs", async () => {
    const probeLean = jest
      .fn()
      .mockResolvedValue([{ _id: "row-1" }, { _id: "row-2" }]);
    const probeLimit = jest.fn().mockReturnValue({ lean: probeLean });
    const probeSelect = jest.fn().mockReturnValue({ limit: probeLimit });

    const close = jest.fn().mockResolvedValue(undefined);
    const cursor = {
      async *[Symbol.asyncIterator]() {
        yield {
          requestType: "responses",
          model: "gpt-4o-mini",
          status: "success",
          promptTokens: 11,
          completionTokens: 22,
          totalTokens: 33,
          costUsd: 0.001,
          latencyMs: 123,
          error: null,
          createdAt: new Date("2026-02-01T10:00:00.000Z"),
        };
        yield {
          requestType: "responses",
          model: "gpt-4o-mini",
          status: "error",
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          costUsd: null,
          latencyMs: -8,
          error: 'bad, "quote"',
          createdAt: new Date("2026-02-01T09:00:00.000Z"),
        };
      },
      close,
    };

    const cursorFactory = jest.fn().mockReturnValue(cursor);
    const exportLean = jest.fn().mockReturnValue({ cursor: cursorFactory });
    const exportSelect = jest.fn().mockReturnValue({ lean: exportLean });
    const exportSort = jest.fn().mockReturnValue({ select: exportSelect });
    modelMock.find = jest
      .fn()
      .mockReturnValueOnce({ select: probeSelect })
      .mockReturnValueOnce({ sort: exportSort });

    const result = await service.exportLogsCsvStream(
      { orgId: "org-1" },
      { actorId: "user-1" },
    );
    const csv = await readStream(result.stream);

    expect(result.rowCount).toBe(2);
    expect(modelMock.find).toHaveBeenNthCalledWith(1, { orgId: "org-1" });
    expect(modelMock.find).toHaveBeenNthCalledWith(2, { orgId: "org-1" });
    expect(exportSelect).toHaveBeenCalledWith({
      createdAt: 1,
      model: 1,
      requestType: 1,
      status: 1,
      latencyMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 1,
      error: 1,
    });
    expect(csv).toBe(
      "timestamp,model,requestType,status,durationMs,inputTokens,outputTokens,totalTokens,error\n" +
        "2026-02-01T10:00:00.000Z,gpt-4o-mini,responses,success,123,11,22,33,\n" +
        '2026-02-01T09:00:00.000Z,gpt-4o-mini,responses,error,0,,,,"bad, ""quote"""\n',
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(writeAuditLogBestEffortMock).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          actorId: "user-1",
          resource: "llm_request_logs",
          action: "export_csv",
        }),
      }),
      expect.objectContaining({
        orgId: "org-1",
        actorId: "user-1",
        outcome: "success",
      }),
    );
  });

  it("reuses filter conditions when exporting CSV", async () => {
    const probeLean = jest.fn().mockResolvedValue([{ _id: "row-1" }]);
    const probeLimit = jest.fn().mockReturnValue({ lean: probeLean });
    const probeSelect = jest.fn().mockReturnValue({ limit: probeLimit });
    const close = jest.fn().mockResolvedValue(undefined);
    const cursor = {
      async *[Symbol.asyncIterator]() {},
      close,
    };
    const cursorFactory = jest.fn().mockReturnValue(cursor);
    const exportLean = jest.fn().mockReturnValue({ cursor: cursorFactory });
    const exportSelect = jest.fn().mockReturnValue({ lean: exportLean });
    const exportSort = jest.fn().mockReturnValue({ select: exportSelect });
    modelMock.find = jest
      .fn()
      .mockReturnValueOnce({ select: probeSelect })
      .mockReturnValueOnce({ sort: exportSort });

    const start = new Date("2026-02-01T00:00:00.000Z");
    const end = new Date("2026-02-28T23:59:59.999Z");

    const result = await service.exportLogsCsvStream({
      orgId: " org-1 ",
      model: " gpt-4.1-mini ",
      requestType: "responses",
      status: "error",
      start,
      end,
    });
    await readStream(result.stream);
    expect(result.rowCount).toBe(1);

    const expectedWhere = {
      orgId: "org-1",
      model: "gpt-4.1-mini",
      requestType: "responses",
      status: "error",
      createdAt: {
        $gte: start,
        $lte: end,
      },
    };
    expect(modelMock.find).toHaveBeenNthCalledWith(1, expectedWhere);
    expect(modelMock.find).toHaveBeenNthCalledWith(2, expectedWhere);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects export when date range exceeds guardrail", async () => {
    await expect(
      service.exportLogsCsvStream({
        orgId: "org-1",
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(modelMock.find).not.toHaveBeenCalled();
    expect(writeAuditLogBestEffortMock).toHaveBeenCalledWith(
      prismaMock,
      expect.any(Object),
      expect.objectContaining({ outcome: "failure" }),
    );
  });

  it("rejects export when matched rows exceed maximum", async () => {
    const probeLean = jest.fn().mockResolvedValue({ length: 50_001 });
    const probeLimit = jest.fn().mockReturnValue({ lean: probeLean });
    const probeSelect = jest.fn().mockReturnValue({ limit: probeLimit });
    modelMock.find = jest.fn().mockReturnValueOnce({ select: probeSelect });

    await expect(
      service.exportLogsCsvStream({ orgId: "org-1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(modelMock.find).toHaveBeenCalledTimes(1);
    expect(writeAuditLogBestEffortMock).toHaveBeenCalledWith(
      prismaMock,
      expect.any(Object),
      expect.objectContaining({ outcome: "failure" }),
    );
  });

  it("prevents CSV formula injection in exported string cells", async () => {
    const probeLean = jest.fn().mockResolvedValue([{ _id: "row-1" }]);
    const probeLimit = jest.fn().mockReturnValue({ lean: probeLean });
    const probeSelect = jest.fn().mockReturnValue({ limit: probeLimit });

    const close = jest.fn().mockResolvedValue(undefined);
    const cursor = {
      async *[Symbol.asyncIterator]() {
        yield {
          requestType: "responses",
          model: "=risky-model",
          status: "success",
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
          latencyMs: 18,
          error: "@malicious",
          createdAt: new Date("2026-02-03T10:00:00.000Z"),
        };
      },
      close,
    };
    const cursorFactory = jest.fn().mockReturnValue(cursor);
    const exportLean = jest.fn().mockReturnValue({ cursor: cursorFactory });
    const exportSelect = jest.fn().mockReturnValue({ lean: exportLean });
    const exportSort = jest.fn().mockReturnValue({ select: exportSelect });
    modelMock.find = jest
      .fn()
      .mockReturnValueOnce({ select: probeSelect })
      .mockReturnValueOnce({ sort: exportSort });

    const result = await service.exportLogsCsvStream({ orgId: "org-1" });
    const csv = await readStream(result.stream);

    expect(csv).toContain("'=risky-model");
    expect(csv).toContain(",'@malicious");
  });

  it("applies feature filter when querying logs", async () => {
    modelMock.countDocuments = jest.fn().mockResolvedValue(0);
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    modelMock.find = jest.fn().mockReturnValue({ sort });

    await service.queryLogs(
      {
        orgId: "org-1",
        feature: " News_Event_Brief ",
      },
      {},
    );

    expect(modelMock.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        $and: [
          {
            $or: [
              { feature: "news_event_brief" },
              { "metadata.feature": "news_event_brief" },
            ],
          },
        ],
      }),
    );
    expect(modelMock.find).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        $and: [
          {
            $or: [
              { feature: "news_event_brief" },
              { "metadata.feature": "news_event_brief" },
            ],
          },
        ],
      }),
    );
  });

  it("returns summary status breakdown, p95 latency and top errors", async () => {
    modelMock.aggregate = jest
      .fn()
      .mockResolvedValueOnce([
        {
          requestCount: 10,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          costUsd: 0.12,
          totalLatencyMs: 2_000,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { _id: "success", count: 8 },
        { _id: "error", count: 2 },
      ])
      .mockResolvedValueOnce([
        { _id: "LiteLLM returned invalid JSON for news event brief", count: 2 },
      ]);
    modelMock.countDocuments = jest.fn().mockResolvedValue(10);
    const p95Lean = jest.fn().mockResolvedValue([{ latencyMs: 420 }]);
    const p95Select = jest.fn().mockReturnValue({ lean: p95Lean });
    const p95Limit = jest.fn().mockReturnValue({ select: p95Select });
    const p95Skip = jest.fn().mockReturnValue({ limit: p95Limit });
    const p95Sort = jest.fn().mockReturnValue({ skip: p95Skip });
    modelMock.find = jest.fn().mockReturnValue({ sort: p95Sort });

    const result = await service.getUsageSummary("org-1", {
      feature: "news_event_brief",
    });

    expect(result.statusBreakdown).toEqual({
      success: 8,
      error: 2,
      successRate: 0.8,
      errorRate: 0.2,
    });
    expect(result.latency).toEqual({
      avgMs: 200,
      p95Ms: 420,
    });
    expect(result.topErrors).toEqual([
      {
        message: "LiteLLM returned invalid JSON for news event brief",
        count: 2,
      },
    ]);
    expect(modelMock.aggregate.mock.calls[0]?.[0]?.[0]).toEqual({
      $match: expect.objectContaining({
        orgId: "org-1",
        $and: [
          {
            $or: [
              { feature: "news_event_brief" },
              { "metadata.feature": "news_event_brief" },
            ],
          },
        ],
      }),
    });
  });
});
