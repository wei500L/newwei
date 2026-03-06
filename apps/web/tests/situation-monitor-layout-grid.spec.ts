import { describe, expect, it } from "vitest";

import {
  buildPackedResponsiveLayout,
  GRID_COLS,
  projectLayoutToLg,
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
  it("stacks default small-screen cards full width with tighter heights", () => {
    const layout = [getDefaultLayout("map"), getDefaultLayout("feeds-politics"), getDefaultLayout("alerts")];

    const smLayout = buildPackedResponsiveLayout(layout, "sm");
    const map = smLayout.find((item) => item.i === "map");
    const politics = smLayout.find((item) => item.i === "feeds-politics");
    const alerts = smLayout.find((item) => item.i === "alerts");

    expect(map?.w).toBe(GRID_COLS.sm);
    expect(politics?.w).toBe(GRID_COLS.sm);
    expect(alerts?.w).toBe(GRID_COLS.sm);
    expect(map?.x).toBe(0);
    expect(politics?.x).toBe(0);
    expect(alerts?.x).toBe(0);
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

    const roundTrip = buildPackedResponsiveLayout(projectLayoutToLg(smLayout, "sm"), "sm");
    expect(roundTrip[0]?.w).toBe(3);
    expect(roundTrip[0]?.h).toBe(5);
  });

  it("relaxes mobile min widths so xxs cards remain resizable", () => {
    const politics = buildPackedResponsiveLayout([getDefaultLayout("feeds-politics")], "xxs")[0];

    expect(politics?.w).toBe(GRID_COLS.xxs);
    expect(politics?.minW).toBe(1);
  });
});
