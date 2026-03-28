import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("situation monitor interaction wiring", () => {
  it("marks panel controls as interactive so grid dragging ignores them", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");
    const monitorsSource = read(
      "app/(app)/situation-monitor/situation-monitor-monitors-panel.tsx",
    );
    const liveNewsSource = read(
      "app/(app)/situation-monitor/components/situation-monitor-live-news-panel.tsx",
    );

    expect(contentSource).toContain(
      'const SITUATION_MONITOR_INTERACTIVE_SELECTOR = "[data-sm-interactive]";',
    );
    expect(contentSource).toContain(
      'draggableCancel={`${SITUATION_MONITOR_INTERACTIVE_SELECTOR},',
    );
    expect(monitorsSource).toContain('"data-sm-interactive": true,');
    expect(monitorsSource).toContain("onClick={openCreate}");
    expect(monitorsSource).toContain("onClick={() => openEdit(monitor)}");
    expect(liveNewsSource).toContain('"data-sm-interactive": true,');
    expect(liveNewsSource).toContain("onClick={() => setManageOpen(true)}");
  });

  it("uses explicit expand buttons for expandable table rows", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");
    const expandIconMatches = contentSource.match(
      /expandIcon: \(\{ expanded, onExpand, record \}: \{/g,
    );

    expect(expandIconMatches?.length).toBe(2);
    expect(contentSource).toContain(
      "icon={expanded ? <DownOutlined /> : <RightOutlined />}",
    );
    expect(contentSource).toContain(
      'aria-label={`${expanded ? collapseRowLabel : expandRowLabel} row`}',
    );
    expect(contentSource).toContain("onExpand(record, event);");
  });

  it("triggers backend refresh tasks and then reloads visible signal panels", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");

    expect(contentSource).toContain("const { pending: manualRefreshPending, run: runManualRefresh } =");
    expect(contentSource).toContain("const catalog = signalCatalog ?? (await loadSignalCatalog());");
    expect(contentSource).toContain("const refreshTargets = catalog?.refreshReadiness.backendRefreshTargets;");
    expect(contentSource).toContain("if (refreshTargets && !refreshTargets.any) {");
    expect(contentSource).toContain('apiClient.post<SituationMonitorRefreshResponse>(');
    expect(contentSource).toContain('"situation-monitor/refresh"');
    expect(contentSource).toContain('situation-monitor/refresh-runs/${encodeURIComponent(refreshRunId)}');
    expect(contentSource).toContain("await Promise.allSettled([");
    expect(contentSource).toContain("telegramSignalActive");
    expect(contentSource).toContain("loadTelegramFeedRef.current()");
    expect(contentSource).toContain("loadOrefSignalsRef.current()");
    expect(contentSource).toContain("setManualRefreshResult(nextResult);");
    expect(contentSource).toContain("setRefreshTimelineOpen(true);");
    expect(contentSource).toContain("void loadRefreshRun(nextResult.refreshId);");
    expect(contentSource).toContain('loading={loading || manualRefreshPending}');
  });

  it("renders explicit alert feedback, timeline UI, and recovery actions", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");

    expect(contentSource).toContain("warnings: coreData.warnings ?? [],");
    expect(contentSource).toContain('manualRefreshResult.status === "accepted"');
    expect(contentSource).toContain('getRefreshRunAlertType(refreshRun.status)');
    expect(contentSource).toContain('title={t("situationMonitor.manualRefresh.timelineTitle"');
    expect(contentSource).toContain("Open News Sources");
    expect(contentSource).toContain("Open Situation Monitor Settings");
    expect(contentSource).toContain("insightsWarnings.map((warning) => (");
    expect(contentSource).toContain("No internal Situation Monitor items are available yet.");
    expect(contentSource).toContain("triggering new crawl collection requires crawl.write permission.");
  });
});
