import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

describe("admin quality task logs wiring", () => {
  it("links the quality task-log summary card to the unified logs workspace", () => {
    const source = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/admin/quality/quality-content.tsx"),
      "utf8",
    );

    expect(source).toContain("buildQualityTaskLogsHref");
    expect(source).toContain('t("adminLogs.openTaskLogs"');
    expect(source).toContain('t("adminLogs.task.summaryCardDescription"');
    expect(source).not.toContain("applyTaskLogFilters");
  });

  it("keeps live events visible while disabling automatic live refresh by default", () => {
    const source = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/admin/quality/quality-content.tsx"),
      "utf8",
    );

    expect(source).toContain("const createDefaultLiveRefreshSources");
    expect(source).toContain("pipeline: false");
    expect(source).toContain("crawl: false");
    expect(source).toContain('quality.liveUpdates.stale.title');
    expect(source).toContain("setLiveDirtySources");
  });

  it("connects the quality socket only after listeners are attached", () => {
    const source = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/admin/quality/quality-content.tsx"),
      "utf8",
    );

    expect(source).toContain("autoConnect: false");
    expect(source).toContain("const connectTimer = window.setTimeout(() => {");
    expect(source).toContain("socket.connect();");
    expect(source).toContain("window.clearTimeout(connectTimer);");
  });
});
