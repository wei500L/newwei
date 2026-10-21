import { describe, expect, it, vi } from "vitest";

import {
  classifyQueueOpsError,
  countQueueOpsDlqResiduals,
  isQueueOpsJobState,
  resolveQueueOpsErrorStatus,
  type QueueOpsDlqReplayResult,
} from "@/lib/queue-ops";

import { canViewQueueOps } from "./queue-ops-access";
import {
  formatQueueOpsFailedReason,
  formatQueueOpsJobName,
  formatQueueOpsJson,
  formatQueueOpsTimestamp,
  truncateQueueOpsPreview,
} from "./queue-ops.helpers";

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn() }),
}));

function buildReplayResult(
  overrides: Partial<QueueOpsDlqReplayResult>,
): QueueOpsDlqReplayResult {
  return {
    dlqJobId: "dlq-1",
    originalJobId: "job-1",
    originalQueue: "itemPipeline",
    orgId: "org-1",
    newJobId: "job-2",
    replayed: true,
    dlqRemoved: true,
    warning: null,
    ...overrides,
  };
}

describe("canViewQueueOps", () => {
  it("requires both queue.manage and platform_admin", () => {
    expect(
      canViewQueueOps({
        permissions: ["queue.manage"],
        globalRoles: ["platform_admin"],
      }),
    ).toBe(true);
    expect(
      canViewQueueOps({
        permissions: ["queue.manage"],
        globalRoles: ["org_admin"],
      }),
    ).toBe(false);
    expect(
      canViewQueueOps({
        permissions: ["crawl.read"],
        globalRoles: ["platform_admin"],
      }),
    ).toBe(false);
  });

  it("treats missing permission/role lists as empty", () => {
    expect(canViewQueueOps({})).toBe(false);
    expect(canViewQueueOps({ permissions: null, globalRoles: null })).toBe(false);
    expect(
      canViewQueueOps({
        permissions: undefined,
        globalRoles: ["platform_admin"],
      }),
    ).toBe(false);
  });
});

describe("formatQueueOpsTimestamp", () => {
  it("formats millisecond timestamps and falls back for empty values", () => {
    expect(formatQueueOpsTimestamp(null, "en-US")).toBe("-");
    expect(formatQueueOpsTimestamp(undefined, "en-US")).toBe("-");
    expect(formatQueueOpsTimestamp(Number.NaN, "en-US")).toBe("-");

    const formatted = formatQueueOpsTimestamp(1_710_000_000_000, "en-US");
    expect(formatted).not.toBe("-");
    expect(formatted.length).toBeGreaterThan(0);
  });
});

describe("formatQueueOpsJson", () => {
  it("returns an empty string for empty values and passes strings through", () => {
    expect(formatQueueOpsJson(undefined)).toBe("");
    expect(formatQueueOpsJson(null)).toBe("");
    expect(formatQueueOpsJson("raw-text")).toBe("raw-text");
  });

  it("pretty prints objects and tolerates circular structures", () => {
    expect(formatQueueOpsJson({ a: 1 })).toContain('"a": 1');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatQueueOpsJson(circular)).toBe("[object Object]");
  });
});

describe("truncateQueueOpsPreview", () => {
  it("keeps short values and truncates long ones", () => {
    expect(truncateQueueOpsPreview("  short  ")).toBe("short");
    const truncated = truncateQueueOpsPreview("x".repeat(200), 20);
    expect(truncated).toHaveLength(21);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

describe("formatQueueOpsJobName / formatQueueOpsFailedReason", () => {
  it("falls back to a dash for blank values", () => {
    expect(formatQueueOpsJobName("  ")).toBe("-");
    expect(formatQueueOpsJobName("pipeline")).toBe("pipeline");
    expect(formatQueueOpsFailedReason("")).toBe("-");
    expect(formatQueueOpsFailedReason("boom")).toBe("boom");
  });
});

describe("countQueueOpsDlqResiduals", () => {
  it("counts replay results whose DLQ entry was not removed", () => {
    expect(countQueueOpsDlqResiduals([])).toBe(0);
    expect(
      countQueueOpsDlqResiduals([
        buildReplayResult({}),
        buildReplayResult({ dlqJobId: "dlq-2", dlqRemoved: false }),
        buildReplayResult({ dlqJobId: "dlq-3", dlqRemoved: false }),
      ]),
    ).toBe(2);
  });
});

describe("queue ops error classification", () => {
  it("extracts HTTP status from response-shaped errors", () => {
    expect(resolveQueueOpsErrorStatus({ response: { status: 404 } })).toBe(404);
    expect(resolveQueueOpsErrorStatus({ response: { status: 500 } })).toBe(500);
    expect(resolveQueueOpsErrorStatus(null)).toBeNull();
    expect(resolveQueueOpsErrorStatus("nope")).toBeNull();
    expect(resolveQueueOpsErrorStatus({})).toBeNull();
    expect(resolveQueueOpsErrorStatus({ response: {} })).toBeNull();
  });

  it("maps 404 to legacy mode and 403 to permission errors", () => {
    expect(classifyQueueOpsError({ response: { status: 404 } })).toBe(
      "notFound",
    );
    expect(classifyQueueOpsError({ response: { status: 403 } })).toBe(
      "forbidden",
    );
    expect(classifyQueueOpsError(new Error("boom"))).toBe("other");
    expect(classifyQueueOpsError({ response: { status: 500 } })).toBe("other");
  });

  it("accepts only known job states", () => {
    expect(isQueueOpsJobState("waiting")).toBe(true);
    expect(isQueueOpsJobState("failed")).toBe(true);
    expect(isQueueOpsJobState("bogus")).toBe(false);
    expect(isQueueOpsJobState(1)).toBe(false);
    expect(isQueueOpsJobState(null)).toBe(false);
  });
});
