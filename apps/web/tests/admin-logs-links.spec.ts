import { describe, expect, it } from "vitest";

import {
  buildAdminLogsHref,
  buildAdminLogsTabSelectionHref,
  resolveAdminLogsTabId,
} from "../lib/admin-logs";

describe("admin logs links", () => {
  it("builds tab-scoped hrefs with filtered query values", () => {
    expect(
      buildAdminLogsHref({
        tab: "task",
        query: {
          taskQueue: "crawl4ai",
          taskStatus: "failed",
          empty: "",
          ignoreFalse: false,
          ignoreUndefined: undefined,
        },
      }),
    ).toBe("/admin/logs?tab=task&taskQueue=crawl4ai&taskStatus=failed");
  });

  it("preserves existing search params when selecting a new tab", () => {
    const current = new URLSearchParams("tab=task&taskQueue=crawl4ai&auditSearch=rate-limit");

    expect(buildAdminLogsTabSelectionHref("/admin/logs", current, "audit")).toBe(
      "/admin/logs?tab=audit&taskQueue=crawl4ai&auditSearch=rate-limit",
    );
  });

  it("falls back to task tab for unknown values", () => {
    expect(resolveAdminLogsTabId("errors")).toBe("errors");
    expect(resolveAdminLogsTabId("unknown")).toBe("task");
    expect(resolveAdminLogsTabId(null)).toBe("task");
  });
});
