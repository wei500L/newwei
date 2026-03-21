import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("system health UI wiring", () => {
  it("routes SystemDefcon through the shared scorer and meter", () => {
    const source = read("app/(app)/components/system-defcon.tsx");

    expect(source).toContain("useSystemHealthContext");
    expect(source).toContain("SystemHealthMeter");
  });

  it("adds the dashboard summary card without replacing the existing switch", () => {
    const source = read("app/(app)/dashboard/dashboard-content.tsx");

    expect(source).toContain("SystemHealthSummaryCard");
    expect(source).toContain("checked={showSystemStats}");
    expect(source).toContain("setShowSystemStats={setShowSystemStats}");
    expect(source).toContain("useSystemHealthContext");
    expect(source).not.toContain("useQueueEvents");
    expect(source).not.toContain("useQueueStatsQuery");
  });

  it("wires summary card actions to system settings and crawl tasks", () => {
    const source = read(
      "app/(app)/dashboard/components/system-health-summary-card.tsx",
    );

    expect(source).toContain("buildAdminSettingsHref");
    expect(source).toContain('page: "ingestion"');
    expect(source).toContain('panel: "crawl-client"');
    expect(source).toContain("/admin/ops/crawl-tasks");
    expect(source).toContain("setShowSystemStats(!showSystemStats)");
    expect(source).toContain("aria-controls={detailsId}");
  });

  it("provides a shared provider and reduced-motion animation fallback", () => {
    const shellSource = read("app/(app)/components/shell.tsx");
    const contextSource = read("app/(app)/components/system-health-context.tsx");
    const cssSource = read(
      "app/(app)/components/system-health-meter.module.css",
    );

    expect(shellSource).toContain("SystemHealthProvider");
    expect(shellSource).toContain("realtimeEnabled={systemHealthRealtimeEnabled}");
    expect(shellSource).toContain(
      'pathname?.startsWith("/dashboard") || viewportWidth >= NAV_FULL_MIN_WIDTH',
    );
    expect(contextSource).toContain("useQueueEvents");
    expect(contextSource).toContain("queueLive: queueRealtime.connected");
    expect(contextSource).toContain("queueConnectionError: queueRealtime.connectionError");
    expect(cssSource).toContain("prefers-reduced-motion: reduce");
  });
});
