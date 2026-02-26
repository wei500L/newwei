import { describe, expect, it } from "vitest";

import {
  parseExpansionHeadSignalSummary,
  resolveHeadSignalFallbackHint,
} from "../lib/crawl-task-head-signal";

describe("crawl task head signal helpers", () => {
  it("parses head-signal summary from expansion logs for UI warnings", () => {
    const summary = parseExpansionHeadSignalSummary([
      {
        stage: "expansion",
        data: {
          headSignalEnrichment: {
            attempted: 12,
            succeeded: 8,
            failed: 4,
            softFailureCount: 4,
            softFailures: {
              httpStatus: 1,
              nonHtml: 0,
              emptyHtml: 1,
              networkOrTimeout: 1,
              noPublishSignal: 1,
            },
            urlPathFallbackCount: 3,
            totalSignalCandidates: 12,
            urlPathFallbackRatio: 0.25,
          },
        },
      },
    ]);

    expect(summary).not.toBeNull();
    expect(summary?.softFailureCount).toBe(4);
    expect(summary?.softFailures.noPublishSignal).toBe(1);
    expect(summary?.urlPathFallbackCount).toBe(3);
    expect(summary?.totalSignalCandidates).toBe(12);
    expect(summary?.urlPathFallbackRatio).toBe(0.25);
  });

  it("infers softFailureCount from breakdown when count is missing", () => {
    const summary = parseExpansionHeadSignalSummary([
      {
        stage: "expansion",
        data: {
          headSignalEnrichment: {
            attempted: 5,
            softFailures: {
              httpStatus: 1,
              nonHtml: 1,
              emptyHtml: 0,
              networkOrTimeout: 1,
              noPublishSignal: 2,
            },
          },
        },
      },
    ]);

    expect(summary?.softFailureCount).toBe(5);
  });

  it("builds url-path fallback hint for quality-impact alert", () => {
    const hint = resolveHeadSignalFallbackHint({
      softFailureCount: 0,
      softFailures: {
        httpStatus: 0,
        nonHtml: 0,
        emptyHtml: 0,
        networkOrTimeout: 0,
        noPublishSignal: 0,
      },
      attempted: 10,
      urlPathFallbackCount: 4,
      totalSignalCandidates: 10,
    });

    expect(hint).toEqual({
      fallbackCount: 4,
      totalCandidates: 10,
      fallbackRatio: 0.4,
    });
  });
});
