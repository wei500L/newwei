import { describe, expect, it } from "vitest";

import {
  buildDefaultLiveNewsChannelPreferences,
  getOrderedRegionChannels,
  normalizeLiveNewsChannelPreferences,
  reorderRegionChannelIds,
  resolveRegionChannels,
} from "../lib/situation-monitor-live-news";

describe("situation monitor live news preferences", () => {
  it("builds defaults that include all region channels", () => {
    const defaults = buildDefaultLiveNewsChannelPreferences();
    const global = defaults.regions.global;

    expect(global.order.length).toBeGreaterThanOrEqual(4);
    expect(global.enabled.length).toBe(global.order.length);
  });

  it("normalizes invalid preference payload to safe defaults", () => {
    const normalized = normalizeLiveNewsChannelPreferences({
      regions: {
        global: {
          order: ["sky-news", "missing-channel"],
          enabled: [],
        },
      },
    });

    const ordered = getOrderedRegionChannels("global", normalized).map((channel) => channel.id);
    expect(ordered[0]).toBe("sky-news");
    expect(normalized.regions.global.enabled.length).toBeGreaterThan(0);
  });

  it("reorders ids by drag-drop source and target", () => {
    const ids = ["a", "b", "c", "d"];
    expect(reorderRegionChannelIds(ids, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("resolves only top 4 visible channels", () => {
    const prefs = buildDefaultLiveNewsChannelPreferences();
    const channels = resolveRegionChannels("americas", prefs, 4);
    expect(channels.length).toBeLessThanOrEqual(4);
  });
});
