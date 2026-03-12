import { beforeEach, describe, expect, it } from "vitest";

import { useSituationMonitorLayoutStore } from "../store/situation-monitor-layout";

function getPanelWidth(
  panelId: string,
  breakpoint: "layout" | "lg" | "sm" = "layout",
): number | undefined {
  const state = useSituationMonitorLayoutStore.getState();
  const layout =
    breakpoint === "layout" ? state.layout : state.layouts[breakpoint];
  return layout?.find((item) => item.i === panelId)?.w;
}

function getPanel(
  panelId: string,
  breakpoint: "layout" | "lg" | "sm" = "layout",
) {
  const state = useSituationMonitorLayoutStore.getState();
  const layout =
    breakpoint === "layout" ? state.layout : state.layouts[breakpoint];
  return layout?.find((item) => item.i === panelId);
}

beforeEach(() => {
  useSituationMonitorLayoutStore.getState().reset();
});

describe("situation monitor layout store", () => {
  it("stores compact breakpoint layouts independently from desktop layout", () => {
    const state = useSituationMonitorLayoutStore.getState();
    const nextSmLayout = state.layout.map((item) =>
      item.i === "feeds-politics" ? { ...item, w: 6, h: 5 } : { ...item },
    );

    state.setLayout(nextSmLayout, "sm");

    expect(getPanelWidth("feeds-politics", "sm")).toBe(6);
    expect(getPanelWidth("feeds-politics", "layout")).toBe(4);
    expect(getPanelWidth("feeds-politics", "lg")).toBe(4);
  });

  it("hydrates legacy payloads into the lg layout slot", () => {
    const state = useSituationMonitorLayoutStore.getState();
    const legacyLayout = state.layout.map((item) =>
      item.i === "feeds-politics" ? { ...item, w: 6 } : { ...item },
    );

    const repaired = state.hydrateFromRemote({
      layout: legacyLayout,
      visibility: { alerts: false },
    });

    expect(repaired).toBe(false);
    expect(getPanelWidth("feeds-politics", "layout")).toBe(6);
    expect(getPanelWidth("feeds-politics", "lg")).toBe(6);
    expect(
      useSituationMonitorLayoutStore.getState().layouts.sm,
    ).toBeUndefined();
    expect(useSituationMonitorLayoutStore.getState().visibility.alerts).toBe(
      false,
    );
  });

  it("hydrates responsive payloads and clears compact overrides on reset layout preset", () => {
    const state = useSituationMonitorLayoutStore.getState();
    const lgLayout = state.layout.map((item) => ({ ...item }));
    const smLayout = state.layout.map((item) =>
      item.i === "feeds-politics" ? { ...item, w: 6, h: 5 } : { ...item },
    );

    state.hydrateFromRemote({
      layouts: {
        lg: lgLayout,
        sm: smLayout,
      },
      visibility: {},
    });

    expect(getPanelWidth("feeds-politics", "sm")).toBe(6);

    state.applyPreset("minimal", { resetLayout: true });

    expect(
      useSituationMonitorLayoutStore.getState().layouts.sm,
    ).toBeUndefined();
    expect(
      useSituationMonitorLayoutStore.getState().layouts.lg?.length,
    ).toBeGreaterThan(0);
  });

  it("fills in newly added panels when hydrating an older layout payload", () => {
    const state = useSituationMonitorLayoutStore.getState();
    const legacyLayout = state.layout
      .filter((item) => item.i !== "realtime-snapshot")
      .map((item) => ({ ...item }));

    const repaired = state.hydrateFromRemote({
      layout: legacyLayout,
      visibility: {},
    });

    expect(repaired).toBe(false);
    expect(getPanel("realtime-snapshot", "layout")).toMatchObject({
      i: "realtime-snapshot",
      x: 0,
      y: 9,
      w: 12,
      h: 8,
    });
  });

  it("toggles realtime snapshot visibility per preset", () => {
    const state = useSituationMonitorLayoutStore.getState();

    state.applyPreset("intel");
    expect(
      useSituationMonitorLayoutStore.getState().visibility["realtime-snapshot"],
    ).toBe(true);

    state.applyPreset("minimal");
    expect(
      useSituationMonitorLayoutStore.getState().visibility["realtime-snapshot"],
    ).toBe(false);
  });
});
