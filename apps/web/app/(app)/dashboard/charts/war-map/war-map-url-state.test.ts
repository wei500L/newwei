import { describe, expect, it } from "vitest";

import {
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  WAR_MAP_LAYER_IDS,
  type WarMapLayerVisibility,
} from "@modular/utils";

import {
  mergeWarMapSettingsWithUrlState,
  readWarMapUrlState,
  writeWarMapUrlState,
} from "./url-state";

function toVisibility(enabled: string[]): WarMapLayerVisibility {
  const next = {} as WarMapLayerVisibility;
  for (const layerId of WAR_MAP_LAYER_IDS) {
    next[layerId] = enabled.includes(layerId);
  }
  return next;
}

describe("readWarMapUrlState", () => {
  it("空 search 解析为全空覆盖（各字段 undefined）", () => {
    const parsed = readWarMapUrlState(new URLSearchParams());
    expect(parsed.viewState).toBeUndefined();
    expect(parsed.activePreset).toBeUndefined();
    expect(parsed.timeRangePreset).toBeUndefined();
    expect(parsed.layerVisibility).toBeUndefined();
    expect(parsed.flightMode).toBeUndefined();
    expect(parsed.aisMode).toBeUndefined();
    expect(parsed.aisAutoMode).toBeUndefined();
  });

  it("合法 view state 解析并强制 2D（bearing/pitch 归零）", () => {
    const parsed = readWarMapUrlState(
      new URLSearchParams(
        "lat=35.1234&lon=105.6789&zoom=4.56&bearing=30&pitch=45",
      ),
    );
    expect(parsed.viewState).toEqual({
      lat: 35.1234,
      lon: 105.6789,
      zoom: 4.56,
      bearing: 0,
      pitch: 0,
    });
  });

  it("非法数字安全回退：无法解析的值忽略、越界值钳制", () => {
    const parsed = readWarMapUrlState(
      new URLSearchParams("lat=999&lon=-500&zoom=99"),
    );
    expect(parsed.viewState).toBeDefined();
    expect(parsed.viewState?.lat).toBe(90);
    expect(parsed.viewState?.lon).toBe(-180);
    expect(parsed.viewState?.zoom).toBe(18);
    expect(parsed.viewState?.bearing).toBe(0);
    expect(parsed.viewState?.pitch).toBe(0);
  });

  it("非法枚举安全回退：preset/tr/fm/am 非法值忽略", () => {
    const parsed = readWarMapUrlState(
      new URLSearchParams("preset=bogus&tr=9d&fm=other&am=other"),
    );
    expect(parsed.activePreset).toBeUndefined();
    expect(parsed.timeRangePreset).toBeUndefined();
    expect(parsed.flightMode).toBeUndefined();
    expect(parsed.aisMode).toBeUndefined();
  });

  it("合法枚举完整解析", () => {
    const parsed = readWarMapUrlState(
      new URLSearchParams("preset=mena&tr=24h&fm=all&am=density"),
    );
    expect(parsed.activePreset).toBe("mena");
    expect(parsed.timeRangePreset).toBe("24h");
    expect(parsed.flightMode).toBe("all");
    expect(parsed.aisMode).toBe("density");
  });

  it("layerVisibility 解析：启用列表外的层全部关闭", () => {
    const parsed = readWarMapUrlState(
      new URLSearchParams("layers=conflicts,ais"),
    );
    expect(parsed.layerVisibility).toEqual(
      toVisibility(["conflicts", "ais"]),
    );
  });

  it("layerVisibility 忽略未知层名", () => {
    const parsed = readWarMapUrlState(
      new URLSearchParams("layers=conflicts,notALayer"),
    );
    expect(parsed.layerVisibility?.conflicts).toBe(true);
    expect(parsed.layerVisibility?.ais).toBe(false);
  });

  it("旧 aa 参数可读（legacy 兼容），1/0 映射布尔、其他忽略", () => {
    expect(
      readWarMapUrlState(new URLSearchParams("aa=1")).aisAutoMode,
    ).toBe(true);
    expect(
      readWarMapUrlState(new URLSearchParams("aa=0")).aisAutoMode,
    ).toBe(false);
    expect(
      readWarMapUrlState(new URLSearchParams("aa=maybe")).aisAutoMode,
    ).toBeUndefined();
  });
});

describe("writeWarMapUrlState", () => {
  const baseState = {
    viewState: {
      lat: 35.12345,
      lon: 105.67894,
      zoom: 4.567,
      bearing: 0,
      pitch: 0,
    },
    activePreset: "asia" as const,
    timeRangePreset: "24h" as const,
    layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY },
    flightMode: "military" as const,
    aisMode: "military" as const,
  };

  it("写回精度：lat/lon 4 位小数、zoom/bearing/pitch 2 位", () => {
    const next = writeWarMapUrlState(new URLSearchParams(), baseState);
    expect(next.get("lat")).toBe("35.1234");
    expect(next.get("lon")).toBe("105.6789");
    expect(next.get("zoom")).toBe("4.57");
    expect(next.get("bearing")).toBe("0.00");
    expect(next.get("pitch")).toBe("0.00");
  });

  it("默认 layer visibility 省略 layers 参数（可恢复）", () => {
    const next = writeWarMapUrlState(new URLSearchParams(), baseState);
    expect(next.has("layers")).toBe(false);
    // 重新读回：无 layers → undefined（远端/默认设置继续生效）
    expect(readWarMapUrlState(next).layerVisibility).toBeUndefined();
  });

  it("非默认 layer visibility 写入 layers 列表", () => {
    const next = writeWarMapUrlState(new URLSearchParams(), {
      ...baseState,
      layerVisibility: toVisibility(["conflicts", "monitors"]),
    });
    expect(next.get("layers")).toBe("conflicts,monitors");
  });

  it("flightMode=military 省略 fm；all 写入 fm=all", () => {
    expect(
      writeWarMapUrlState(new URLSearchParams(), {
        ...baseState,
        flightMode: "military",
      }).has("fm"),
    ).toBe(false);
    expect(
      writeWarMapUrlState(new URLSearchParams(), {
        ...baseState,
        flightMode: "all",
      }).get("fm"),
    ).toBe("all");
  });

  it("aisMode=military 省略 am；all/density 写入 am", () => {
    expect(
      writeWarMapUrlState(new URLSearchParams(), {
        ...baseState,
        aisMode: "military",
      }).has("am"),
    ).toBe(false);
    expect(
      writeWarMapUrlState(new URLSearchParams(), {
        ...baseState,
        aisMode: "all",
      }).get("am"),
    ).toBe("all");
    expect(
      writeWarMapUrlState(new URLSearchParams(), {
        ...baseState,
        aisMode: "density",
      }).get("am"),
    ).toBe("density");
  });

  it("旧 aa 参数在写回时被清理", () => {
    const next = writeWarMapUrlState(
      new URLSearchParams("aa=1&custom=keep"),
      baseState,
    );
    expect(next.has("aa")).toBe(false);
  });

  it("未知查询参数保留", () => {
    const next = writeWarMapUrlState(
      new URLSearchParams("custom=keep&tab=overview"),
      baseState,
    );
    expect(next.get("custom")).toBe("keep");
    expect(next.get("tab")).toBe("overview");
  });

  it("写回后重新读取可还原完整状态（往返一致）", () => {
    const state = {
      ...baseState,
      viewState: { lat: 35.1235, lon: 105.6789, zoom: 4.57, bearing: 0, pitch: 0 },
      layerVisibility: toVisibility(["conflicts", "ais", "monitors"]),
      flightMode: "all" as const,
      aisMode: "density" as const,
    };
    const written = writeWarMapUrlState(new URLSearchParams("src=share"), state);
    const parsed = readWarMapUrlState(written);
    expect(parsed.viewState).toEqual(state.viewState);
    expect(parsed.activePreset).toBe(state.activePreset);
    expect(parsed.timeRangePreset).toBe(state.timeRangePreset);
    expect(parsed.layerVisibility).toEqual(state.layerVisibility);
    expect(parsed.flightMode).toBe(state.flightMode);
    expect(parsed.aisMode).toBe(state.aisMode);
  });
});

describe("mergeWarMapSettingsWithUrlState（URL 与远端设置优先级）", () => {
  const remoteSettings = {
    layerVisibility: toVisibility(["conflicts", "ais"]),
    viewState: { lat: 10, lon: 20, zoom: 3, bearing: 0, pitch: 0 },
    activePreset: "global",
    timeRangePreset: "7d",
    flightMode: "military",
    aisMode: "military",
    aisHighlightCandidates: false,
  };

  it("URL 无覆盖字段时返回远端设置原样", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      remoteSettings,
      new URLSearchParams(),
    );
    expect(merged).toEqual(remoteSettings);
  });

  it("URL 提供的字段优先于远端设置", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      remoteSettings,
      new URLSearchParams("lat=40.5&lon=-74&zoom=5&preset=america&tr=24h&fm=all&am=density"),
    );
    expect(merged.viewState.lat).toBe(40.5);
    expect(merged.viewState.lon).toBe(-74);
    expect(merged.viewState.zoom).toBe(5);
    expect(merged.activePreset).toBe("america");
    expect(merged.timeRangePreset).toBe("24h");
    expect(merged.flightMode).toBe("all");
    expect(merged.aisMode).toBe("density");
  });

  it("URL 未提供的字段继续使用远端设置", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      remoteSettings,
      new URLSearchParams("tr=1h"),
    );
    expect(merged.viewState).toEqual(remoteSettings.viewState);
    expect(merged.activePreset).toBe("global");
    expect(merged.timeRangePreset).toBe("1h");
    expect(merged.flightMode).toBe("military");
    expect(merged.aisMode).toBe("military");
    expect(merged.layerVisibility).toEqual(remoteSettings.layerVisibility);
    expect(merged.aisHighlightCandidates).toBe(false);
  });

  it("仅 preset 无 viewState 时使用该 preset 的视图状态", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      remoteSettings,
      new URLSearchParams("preset=asia"),
    );
    expect(merged.viewState).toEqual({
      lat: 35,
      lon: 105,
      zoom: 2.9,
      bearing: 0,
      pitch: 0,
    });
  });

  it("viewState 与 preset 同时存在时 viewState 优先", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      remoteSettings,
      new URLSearchParams("preset=asia&lat=1.5&lon=2.5&zoom=6"),
    );
    expect(merged.viewState).toEqual({
      lat: 1.5,
      lon: 2.5,
      zoom: 6,
      bearing: 0,
      pitch: 0,
    });
  });

  it("仅 layers 覆盖时 viewState 保持远端值", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      remoteSettings,
      new URLSearchParams("layers=conflicts"),
    );
    expect(merged.viewState).toEqual(remoteSettings.viewState);
    expect(merged.layerVisibility).toEqual(toVisibility(["conflicts"]));
  });
});
