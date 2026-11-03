import { describe, expect, it } from "vitest";

import type { LayerSummary } from "./engine-types";
import {
  GLOBE_LAYER_GROUPS,
  OTHER_LAYERS_GROUP_KEY,
  deriveLayerRow,
  formatLayerCount,
  groupLayers,
  type LayerPanelDeps,
} from "./layer-panel-model";

const deps: LayerPanelDeps = {
  layerFeedState: (stats) => String(stats?.status ?? "nominal"),
  shownLayerName: (name, id) => `shown:${name ?? ""}:${id ?? ""}`,
  keyRequirementText: (id) => (id ? `needs ${id}` : ""),
  keyGuidanceText: (requirement) => (requirement ? `hint ${requirement}` : ""),
  translateFeedError: (text) => `translated:${text ?? ""}`,
  locale: "en",
};

function layer(overrides: Partial<LayerSummary> = {}): LayerSummary {
  return {
    id: "flights",
    name: "Live Flights",
    icon: "✈",
    showInTogglePanel: true,
    enabled: true,
    lifecycleState: "enabled",
    stats: { count: 12, lastUpdate: 1000 },
    ...overrides,
  };
}

describe("formatLayerCount", () => {
  it(">=10000 按语言显示为万 / k", () => {
    expect(formatLayerCount(12000, "zh-CN")).toBe("1.2万");
    expect(formatLayerCount(12000, "en")).toBe("12k");
    expect(formatLayerCount(10000, "zh-CN")).toBe("1万");
    expect(formatLayerCount(15500, "en")).toBe("15.5k");
  });

  it("低于 10000 按语言分组，0 与空值显示 —", () => {
    expect(formatLayerCount(9999, "en")).toBe("9,999");
    expect(formatLayerCount(0, "en")).toBe("—");
    expect(formatLayerCount(null, "zh-CN")).toBe("—");
  });
});

describe("deriveLayerRow", () => {
  it("正常状态", () => {
    const row = deriveLayerRow(layer(), deps);
    expect(row.name).toBe("shown:Live Flights:flights");
    expect(row.icon).toBe("✈");
    expect(row.enabled).toBe(true);
    expect(row.busy).toBe(false);
    expect(row.state).toBe("nominal");
    expect(row.stateLabelKey).toBe("globe.layers.state.nominal");
    expect(row.count).toBe(12);
    expect(row.countText).toBe("12");
  });

  it.each([
    ["loading", "loading"],
    ["degraded", "degraded"],
    ["stale", "stale"],
    ["partial", "partial"],
    ["fallback", "fallback"],
    ["unavailable", "unavailable"],
  ])("feed 状态 %s", (status, expected) => {
    const row = deriveLayerRow(layer({ stats: { status } }), deps);
    expect(row.state).toBe(expected);
    expect(row.stateLabelKey).toBe(`globe.layers.state.${expected}`);
  });

  it("关闭的图层是 off，即使 stats 报了错误", () => {
    const row = deriveLayerRow(
      layer({ enabled: false, stats: { status: "degraded" } }),
      deps,
    );
    expect(row.state).toBe("off");
  });

  it("生命周期过渡态优先于 feed 状态", () => {
    expect(
      deriveLayerRow(layer({ lifecycleState: "enabling" }), deps).state,
    ).toBe("enabling");
    const disabling = deriveLayerRow(
      layer({ lifecycleState: "disabling" }),
      deps,
    );
    expect(disabling.state).toBe("disabling");
    expect(disabling.busy).toBe(true);
  });

  it("sourceUnavailable 归为不可用；lifecycleUncertain 单独标记", () => {
    expect(
      deriveLayerRow(
        layer({ stats: { sourceUnavailable: true, status: "nominal" } }),
        deps,
      ).state,
    ).toBe("unavailable");
    expect(
      deriveLayerRow(layer({ lifecycleUncertain: true }), deps).state,
    ).toBe("uncertain");
  });

  it("错误文字经过 translateFeedError，且取 stats.error/lastError/managerRefreshError", () => {
    expect(
      deriveLayerRow(layer({ stats: { error: "bad" } }), deps).error,
    ).toBe("translated:bad");
    expect(
      deriveLayerRow(layer({ stats: { lastError: "worse" } }), deps).error,
    ).toBe("translated:worse");
    expect(
      deriveLayerRow(layer({ stats: { managerRefreshError: "oof" } }), deps)
        .error,
    ).toBe("translated:oof");
  });

  it("缺少密钥时生成 keyGuidance 且 keyRequired 为真", () => {
    const row = deriveLayerRow(
      layer({
        requiresKeyId: "aisstream",
        stats: { keyRequired: true, keyAlternatives: [] },
      }),
      deps,
    );
    expect(row.keyRequired).toBe(true);
    expect(row.keyGuidance).toBe("hint needs aisstream");
  });

  it("countLabel 优先于数字格式化", () => {
    const row = deriveLayerRow(
      layer({ stats: { count: 12, countLabel: "24 nearby" } }),
      deps,
    );
    expect(row.countText).toBe("24 nearby");
  });
});

describe("groupLayers", () => {
  it("按 GLOBE_LAYER_GROUPS 的顺序排列，未登记项进其它", () => {
    const all = [
      layer({ id: "flights", name: "Live Flights" }),
      layer({ id: "satellites", name: "Satellites" }),
      layer({ id: "cctv", name: "CCTV" }),
      layer({ id: "alpr-cameras", name: "ALPR Cameras" }),
      layer({ id: "earthquakes", name: "Earthquakes" }),
      layer({ id: "radio", name: "Radio" }),
      layer({ id: "custom-layer", name: "Custom" }),
    ];
    const groups = groupLayers(all);
    expect(groups.map((group) => group.groupKey)).toEqual([
      "globe.layers.groups.movement",
      "globe.layers.groups.cameras",
      "globe.layers.groups.infrastructure",
      "globe.layers.groups.events",
      "globe.layers.groups.audio",
      OTHER_LAYERS_GROUP_KEY,
    ]);
    expect(groups[0]!.rows.map((row) => row.id)).toEqual([
      "satellites",
      "flights",
    ]);
    expect(groups[5]!.rows.map((row) => row.id)).toEqual(["custom-layer"]);
  });

  it("showInTogglePanel === false 的图层不显示", () => {
    const groups = groupLayers([
      layer({ id: "flights" }),
      layer({ id: "military-awareness", showInTogglePanel: false }),
    ]);
    const ids = groups.flatMap((group) => group.rows.map((row) => row.id));
    expect(ids).toEqual(["flights"]);
  });

  it("空组被丢弃", () => {
    const groups = groupLayers([layer({ id: "radio" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.groupKey).toBe("globe.layers.groups.audio");
  });

  it("分组常量与 GEV layerPanel.js:41-99 一致（顺序与 id）", () => {
    // G6：情报组固定排在最前面。
    expect(GLOBE_LAYER_GROUPS[0]!.ids).toEqual([
      "newwei-events",
      "newwei-news",
    ]);
    expect(GLOBE_LAYER_GROUPS[1]!.ids).toEqual([
      "satellites",
      "flights",
      "military",
      "local-adsb",
      "ais-live-vessels",
      "traffic",
      "transit",
      "bikeshare",
    ]);
  });
});
