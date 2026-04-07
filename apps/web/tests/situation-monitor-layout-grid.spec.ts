import { describe, expect, it } from "vitest";

import {
  buildPackedResponsiveLayout,
  getDefaultPanelLayoutForBreakpoint,
  GRID_COLS,
  isPanelSizeCustomizedForBreakpoint,
  projectLayoutToLg,
  stabilizeDesktopDragLayout,
} from "../app/(app)/situation-monitor/utils/layout-grid";
import { SITUATION_MONITOR_PANELS } from "../store/situation-monitor-layout";

function getDefaultLayout(id: string) {
  const panel = SITUATION_MONITOR_PANELS.find((entry) => entry.id === id);
  if (!panel) {
    throw new Error(`Unknown panel: ${id}`);
  }
  return { ...panel.defaultLayout };
}

describe("situation monitor responsive layout helpers", () => {
  it("keeps overview and feed cards in a compact multi-column layout on md", () => {
    const layout = [
      getDefaultLayout("summary"),
      getDefaultLayout("coverage"),
      getDefaultLayout("feeds-politics"),
    ];

    const mdLayout = buildPackedResponsiveLayout(layout, "md");

    expect(mdLayout[0]?.w).toBe(5);
    expect(mdLayout[1]?.w).toBe(5);
    expect(mdLayout[2]?.w).toBe(5);
  });

  it("stacks default small-screen cards full width with tighter heights", () => {
    const layout = [
      getDefaultLayout("map"),
      getDefaultLayout("realtime-snapshot"),
      getDefaultLayout("alerts"),
    ];

    const smLayout = buildPackedResponsiveLayout(layout, "sm");
    const map = smLayout.find((item) => item.i === "map");
    const snapshot = smLayout.find((item) => item.i === "realtime-snapshot");
    const alerts = smLayout.find((item) => item.i === "alerts");

    expect(map?.w).toBe(GRID_COLS.sm);
    expect(snapshot?.w).toBe(GRID_COLS.sm);
    expect(alerts?.w).toBe(GRID_COLS.sm);
    expect(map?.x).toBe(0);
    expect(snapshot?.x).toBe(0);
    expect(alerts?.x).toBe(0);
    expect(map?.y).toBeLessThan(snapshot?.y ?? 0);
    expect(snapshot?.y).toBeLessThan(alerts?.y ?? 0);
    expect(map?.h).toBeLessThan(getDefaultLayout("map").h);
    expect(alerts?.h).toBeLessThan(getDefaultLayout("alerts").h);
  });

  it("preserves customized widths after projecting through lg", () => {
    const politics = {
      ...getDefaultLayout("feeds-politics"),
      w: 6,
      h: 5,
    };

    const smLayout = buildPackedResponsiveLayout([politics], "sm");
    expect(smLayout[0]?.w).toBe(3);
    expect(smLayout[0]?.h).toBe(5);
    expect(smLayout[0]?.minW).toBe(3);

    const roundTrip = buildPackedResponsiveLayout(
      projectLayoutToLg(smLayout, "sm"),
      "sm",
    );
    expect(roundTrip[0]?.w).toBe(3);
    expect(roundTrip[0]?.h).toBe(5);
  });

  it("relaxes mobile min widths so xxs cards remain resizable", () => {
    const politics = buildPackedResponsiveLayout(
      [getDefaultLayout("feeds-politics")],
      "xxs",
    )[0];

    expect(politics?.w).toBe(GRID_COLS.xxs);
    expect(politics?.minW).toBe(1);
  });

  it("exposes breakpoint-aware default panel sizes for reset affordances", () => {
    const summary = getDefaultPanelLayoutForBreakpoint("summary", "lg");
    const summarySm = getDefaultPanelLayoutForBreakpoint("summary", "sm");
    const map = getDefaultPanelLayoutForBreakpoint("map", "lg");
    const mapSm = getDefaultPanelLayoutForBreakpoint("map", "sm");

    expect(summary?.w).toBe(4);
    expect(summary?.h).toBe(4);
    expect(summarySm?.w).toBe(GRID_COLS.sm);
    expect(mapSm?.h).toBeLessThan(map?.h ?? 0);
  });

  it("detects when a card size differs from its breakpoint default", () => {
    const summary = getDefaultPanelLayoutForBreakpoint("summary", "lg");
    if (!summary) {
      throw new Error("Missing default summary layout");
    }

    expect(isPanelSizeCustomizedForBreakpoint(summary, "lg")).toBe(false);
    expect(
      isPanelSizeCustomizedForBreakpoint(
        { ...summary, h: summary.h + 2 },
        "lg",
      ),
    ).toBe(true);
  });

  it("stabilizes desktop drag swaps without cascading unrelated cards downward", () => {
    const previousLayout = [
      getDefaultLayout("summary"),
      getDefaultLayout("coverage"),
      getDefaultLayout("next-actions"),
      getDefaultLayout("map"),
      getDefaultLayout("realtime-snapshot"),
    ];
    const nextLayout = [
      { ...getDefaultLayout("summary"), x: 8, y: 0 },
      getDefaultLayout("coverage"),
      { ...getDefaultLayout("next-actions"), x: 8, y: 4 },
      getDefaultLayout("map"),
      { ...getDefaultLayout("realtime-snapshot"), x: 8, y: 8 },
    ];

    const stabilized = stabilizeDesktopDragLayout(previousLayout, nextLayout);
    const nextActions = stabilized.find((item) => item.i === "next-actions");
    const snapshot = stabilized.find((item) => item.i === "realtime-snapshot");

    expect(nextActions?.x).toBe(0);
    expect(nextActions?.y).toBe(0);
    expect(snapshot?.x).toBe(8);
    expect(snapshot?.y).toBe(4);
  });
});
