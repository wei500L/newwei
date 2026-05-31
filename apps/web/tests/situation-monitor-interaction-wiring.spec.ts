import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("situation monitor interaction wiring", () => {
  it("marks panel controls as interactive so grid dragging ignores them", () => {
    const contentSource = read(
      "app/(app)/situation-monitor/situation-monitor-content.tsx",
    );
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
      "draggableCancel={`${SITUATION_MONITOR_INTERACTIVE_SELECTOR},",
    );
    expect(monitorsSource).toContain('"data-sm-interactive": true,');
    expect(monitorsSource).toContain("onClick={openCreate}");
    expect(monitorsSource).toContain("onClick={() => openEdit(monitor)}");
    expect(liveNewsSource).toContain('"data-sm-interactive": true,');
    expect(liveNewsSource).toContain("onClick={() => setManageOpen(true)}");
  });

  it("uses explicit expand buttons for expandable table rows", () => {
    const contentSource = read(
      "app/(app)/situation-monitor/situation-monitor-content.tsx",
    );
    const expandIconMatches = contentSource.match(/expandIcon:\s*\(\{/g);

    expect(expandIconMatches?.length).toBe(2);
    expect(contentSource).toContain(
      "icon={expanded ? <DownOutlined /> : <RightOutlined />}",
    );
    expect(contentSource).toContain(
      "aria-label={`${expanded ? collapseRowLabel : expandRowLabel} row`}",
    );
    expect(contentSource).toContain("onExpand(record, event);");
  });

  it("uses fetch-latest refresh semantics and reloads visible signal panels", () => {
    const contentSource = read(
      "app/(app)/situation-monitor/situation-monitor-content.tsx",
    );

    expect(contentSource).toContain(
      "const { pending: manualRefreshPending, run: runManualRefresh } =",
    );
    expect(contentSource).toContain("await Promise.allSettled([");
    expect(contentSource).toContain("load(),");
    expect(contentSource).toContain("telegramSignalActive");
    expect(contentSource).toContain("loadTelegramFeedRef.current()");
    expect(contentSource).toContain("loadOrefSignalsRef.current()");
    expect(contentSource).not.toContain(
      "apiClient.post<SituationMonitorRefreshResponse>(",
    );
    expect(contentSource).not.toContain('"situation-monitor/refresh"');
    expect(contentSource).toContain(
      "loading={loading || manualRefreshPending}",
    );
  });

  it("renders snapshot status feedback and recovery actions", () => {
    const contentSource = read(
      "app/(app)/situation-monitor/situation-monitor-content.tsx",
    );

    expect(contentSource).toContain("warnings: coreData.warnings ?? [],");
    expect(contentSource).toContain('t("situationMonitor.summary.title")');
    expect(contentSource).toContain('t("situationMonitor.coverage.title")');
    expect(contentSource).toContain('t("situationMonitor.actions.title")');
    expect(contentSource).toContain('t("situationMonitor.summary.articles"');
    expect(contentSource).toContain('t("situationMonitor.summary.clusters"');
    expect(contentSource).toContain('t("situationMonitor.summary.internal"');
    expect(contentSource).toContain('t("situationMonitor.summary.external"');
    expect(contentSource).toContain('t("situationMonitor.summary.mixedClusters"');
    expect(contentSource).toContain("coverageSummary?.visibleCategoryCount");
    expect(contentSource).toContain("data?.clusters?.[category]");
    expect(contentSource).toContain('t("situationMonitor.feeds.viewRawArticles")');
    expect(contentSource).toContain("toggleClusterExpansion(cluster.id)");
    expect(contentSource).toContain(
      "onPointerDown={stopSituationMonitorInteractiveEvent}",
    );
    expect(contentSource).toContain(
      "onMouseDown={stopSituationMonitorInteractiveEvent}",
    );
    expect(contentSource).toContain("data?.externalSnapshot?.generatedAt");
    expect(contentSource).toContain(
      "data?.externalSnapshot?.categories?.[category]",
    );
    expect(contentSource).toContain('t("situationMonitor.snapshot.freshCategories"');
    expect(contentSource).toContain('t("situationMonitor.snapshot.reusedCategories"');
    expect(contentSource).toContain('t("situationMonitor.snapshot.reusedCategory")');
    expect(contentSource).toContain('t("situationMonitor.actions.openNewsSources")');
    expect(contentSource).toContain('t("situationMonitor.actions.openSettings")');
    expect(contentSource).toContain("insightsWarnings.map((warning) => (");
    expect(contentSource).toContain(
      "situationMonitor.empty.generic.title",
    );
    expect(contentSource).toContain("situationMonitor.scopeRecovery.title");
    expect(contentSource).not.toContain(
      "No internal Situation Monitor items are available yet.",
    );
    expect(contentSource).not.toContain(
      "triggering new crawl collection requires crawl.write permission.",
    );
  });

  it("keeps local dashboard layout when remote payload has no geometry", () => {
    const syncSource = read("app/(app)/components/user-ui-settings-sync.tsx");
    const serializationSource = read(
      "lib/situation-monitor-layout-serialization.ts",
    );

    expect(syncSource).toContain("hasSituationMonitorLayoutGeometry(");
    expect(syncSource).toContain("normalizeSituationMonitorLayoutPayload(");
    expect(syncSource).toContain("!ready.situationMonitor ||");
    expect(serializationSource).toContain(
      "export function hasSituationMonitorLayoutGeometry(",
    );
  });

  it("exposes visible bottom-edge resize handles for per-card height changes", () => {
    const contentSource = read(
      "app/(app)/situation-monitor/situation-monitor-content.tsx",
    );
    const globalsSource = read("app/globals.css");

    expect(contentSource).toContain('resizeHandles={["s", "se"]}');
    expect(contentSource).toContain("sm-layout-panel-tools");
    expect(contentSource).toContain("situationMonitor.layout.resetPanelSize");
    expect(contentSource).toContain("data-panel-id={panel.id}");
    expect(contentSource).toContain("setLayoutPreviewItem({ ...nextItem });");
    expect(globalsSource).toContain(
      ".sm-layout-grid .react-resizable-handle-s",
    );
    expect(globalsSource).toContain("cursor: ns-resize;");
    expect(globalsSource).toContain(".sm-layout-panel-tools");
    expect(globalsSource).toContain(".sm-layout-panel-reset.ant-btn");
  });
});
