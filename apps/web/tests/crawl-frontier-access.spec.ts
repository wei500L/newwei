import { describe, expect, it } from "vitest";

import { canViewCrawlFrontierLlmLogs } from "../app/(app)/admin/ops/crawl-frontier/crawl-frontier-access";

describe("crawl frontier access", () => {
  it("requires settings.manage before showing llm log deep links", () => {
    expect(canViewCrawlFrontierLlmLogs(["crawl.read"])).toBe(false);
    expect(canViewCrawlFrontierLlmLogs(["crawl.write"])).toBe(false);
    expect(
      canViewCrawlFrontierLlmLogs(["crawl.read", "settings.manage"]),
    ).toBe(true);
  });
});
