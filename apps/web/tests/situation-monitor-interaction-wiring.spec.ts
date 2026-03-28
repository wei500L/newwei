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

  it("uses fetch-latest refresh semantics and reloads visible signal panels", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");

    expect(contentSource).toContain("const { pending: manualRefreshPending, run: runManualRefresh } =");
    expect(contentSource).toContain("await Promise.allSettled([");
    expect(contentSource).toContain("load(),");
    expect(contentSource).toContain("telegramSignalActive");
    expect(contentSource).toContain("loadTelegramFeedRef.current()");
    expect(contentSource).toContain("loadOrefSignalsRef.current()");
    expect(contentSource).not.toContain('apiClient.post<SituationMonitorRefreshResponse>(');
    expect(contentSource).not.toContain('"situation-monitor/refresh"');
    expect(contentSource).toContain('loading={loading || manualRefreshPending}');
  });

  it("renders snapshot status feedback and recovery actions", () => {
    const contentSource = read("app/(app)/situation-monitor/situation-monitor-content.tsx");

    expect(contentSource).toContain("warnings: coreData.warnings ?? [],");
    expect(contentSource).toContain('title={t("situationMonitor.snapshot.title"');
    expect(contentSource).toContain("data?.externalSnapshot");
    expect(contentSource).toContain("getExternalSnapshotStatusColor(");
    expect(contentSource).toContain("Open News Sources");
    expect(contentSource).toContain("Open Situation Monitor Settings");
    expect(contentSource).toContain("insightsWarnings.map((warning) => (");
    expect(contentSource).toContain("No internal Situation Monitor items are available yet.");
    expect(contentSource).toContain("triggering new crawl collection requires crawl.write permission.");
  });
});
