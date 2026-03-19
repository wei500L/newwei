import { BadRequestException, StreamableFile } from "@nestjs/common";
import { Readable } from "stream";

import type { AuthenticatedUser } from "../auth/auth.service";

import { LlmRequestLogController } from "./llm-request-log.controller";

describe("LlmRequestLogController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    email: "demo@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: ["settings.manage"],
    firstName: "Demo",
    lastName: "User",
  };

  const llmRequestLogService = {
    queryLogs: jest.fn(),
    getUsageSummary: jest.fn(),
    exportLogsCsvStream: jest.fn(),
  } as const;

  let controller: LlmRequestLogController;

  beforeEach(() => {
    jest.resetAllMocks();
    llmRequestLogService.queryLogs.mockResolvedValue({
      page: 1,
      pageSize: 20,
      total: 0,
      items: [],
      metadataPolicy: {
        source: "default",
        allowedTopLevelKeys: [],
        allowedTopLevelPrefixes: [],
        keyCount: 0,
        prefixCount: 0,
      },
    });
    llmRequestLogService.getUsageSummary.mockResolvedValue({
      totals: {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        avgLatencyMs: 0,
      },
      statusBreakdown: {
        success: 0,
        error: 0,
        successRate: 0,
        errorRate: 0,
      },
      latency: {
        avgMs: 0,
        p95Ms: null,
      },
      topErrors: [],
      byModel: [],
      byDay: [],
    });
    llmRequestLogService.exportLogsCsvStream.mockResolvedValue(
      {
        stream: Readable.from(["timestamp,model\n"]),
        rowCount: 1,
      },
    );
    controller = new LlmRequestLogController(llmRequestLogService as any);
  });

  it("passes normalized list filters and pagination to service", async () => {
    await controller.list(
      user,
      "2",
      "50",
      " gpt-4o-mini ",
      " news_event_brief ",
      " profile-1 ",
      " run-1 ",
      " node-1 ",
      "responses",
      "success",
      "2026-02-01T00:00:00.000Z",
      "2026-02-02T23:59:59.999Z",
    );

    expect(llmRequestLogService.queryLogs).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        model: "gpt-4o-mini",
        feature: "news_event_brief",
        profileId: "profile-1",
        runId: "run-1",
        nodeId: "node-1",
        requestType: "responses",
        status: "success",
        start: new Date("2026-02-01T00:00:00.000Z"),
        end: new Date("2026-02-02T23:59:59.999Z"),
      },
      {
        page: 2,
        pageSize: 50,
      },
    );
  });

  it("returns streamable csv for export endpoint", async () => {
    const result = await controller.export(
      user,
      " gpt-4o-mini ",
      "news_event_brief",
      "profile-1",
      "run-1",
      "node-1",
      "responses",
      "error",
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.999Z",
    );

    expect(result).toBeInstanceOf(StreamableFile);
    expect(llmRequestLogService.exportLogsCsvStream).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        model: "gpt-4o-mini",
        feature: "news_event_brief",
        profileId: "profile-1",
        runId: "run-1",
        nodeId: "node-1",
        requestType: "responses",
        status: "error",
        start: new Date("2026-02-01T00:00:00.000Z"),
        end: new Date("2026-02-28T23:59:59.999Z"),
      },
      {
        actorId: "user-1",
      },
    );
  });

  it("throws bad request for invalid export date range", async () => {
    await expect(
      controller.export(
        user,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "2026-02-10T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(llmRequestLogService.exportLogsCsvStream).not.toHaveBeenCalled();
  });

  it("throws bad request for invalid requestType", async () => {
    await expect(
      controller.export(
        user,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "invalid-type",
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(llmRequestLogService.exportLogsCsvStream).not.toHaveBeenCalled();
  });

  it("throws bad request for invalid status", async () => {
    await expect(
      controller.export(
        user,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "pending",
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(llmRequestLogService.exportLogsCsvStream).not.toHaveBeenCalled();
  });

  it("throws bad request for invalid start date format", async () => {
    await expect(
      controller.export(
        user,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "not-a-date",
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(llmRequestLogService.exportLogsCsvStream).not.toHaveBeenCalled();
  });

  it("passes date range to usage summary endpoint", async () => {
    await controller.summary(
      user,
      "news_event_brief",
      "profile-1",
      "run-1",
      "node-1",
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.999Z",
    );

    expect(llmRequestLogService.getUsageSummary).toHaveBeenCalledWith("org-1", {
      start: new Date("2026-02-01T00:00:00.000Z"),
      end: new Date("2026-02-28T23:59:59.999Z"),
      feature: "news_event_brief",
      profileId: "profile-1",
      runId: "run-1",
      nodeId: "node-1",
    });
  });

  it("throws bad request for invalid feature filter", async () => {
    await expect(
      controller.summary(user, "INVALID FEATURE", undefined, undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(llmRequestLogService.getUsageSummary).not.toHaveBeenCalled();
  });
});
