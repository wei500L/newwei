import { describe, expect, it } from "vitest";

import {
  buildWarMapInteractionLegendItems,
  buildWarMapLegendSections,
  buildWarMapQuickLegendItems,
  coerceHexColor,
  formatWarMapClusterCountLabel,
  getQuickLegendVisibility,
  getWarMapDeckIcon,
  getWarMapLegendSvgMarkup,
  getWarMapSymbolAccentColor,
  matchesWarMapLegendItem,
  resolveWarMapLegendLabel,
  selectVisibleQuickLegendItems,
} from "./war-map-symbols";

const ALL_SYMBOL_KEYS = [
  "signal-high",
  "signal-medium",
  "signal-low",
  "news-geocoded",
  "news-fallback",
  "monitor",
  "flight",
  "ais-vessel-military",
  "ais-vessel-fishing",
  "ais-vessel-passenger",
  "ais-vessel-cargo",
  "ais-vessel-tanker",
  "ais-vessel-other",
  "ais-vessel-generic",
  "ais-density",
  "ais-disruption-high",
  "ais-disruption-medium",
  "ais-disruption-low",
  "generic-point",
] as const;

const EN_T = ((key: string, options?: Record<string, unknown>) => {
  if (key === "dashboard.charts.warMap.legend.moreItems") {
    return `+${options?.count} more`;
  }
  return `⟦${key}⟧`;
}) as never;

/** EN_T：将 key 包装为 ⟦key⟧ 以断言翻译链路命中，而非组件内部实现。 */

describe("War Map symbols（FE-批4B characterization）", () => {
  describe("deck icon 与 SVG 确定性", () => {
    it("全部 symbol key 的 legend SVG 均可确定性生成", () => {
      for (const symbolKey of ALL_SYMBOL_KEYS) {
        const markup = getWarMapLegendSvgMarkup({ symbolKey });
        expect(markup).toMatch(/^<svg /);
        expect(markup).toMatch(/<\/svg>$/);
        expect(markup).not.toContain("undefined");
        expect(markup).not.toContain("NaN");
      }
    });

    it("全部 symbol key 的 deck icon 均可确定性生成", () => {
      for (const symbolKey of ALL_SYMBOL_KEYS) {
        const icon = getWarMapDeckIcon({ symbolKey });
        expect(icon.url).toMatch(/^data:image\/svg\+xml/);
        expect(decodeURIComponent(icon.url)).toContain("<svg");
      }
    });

    it("状态语义：hover 与 selected 生成不同 markup 且 default 恒有主体", () => {
      for (const symbolKey of ALL_SYMBOL_KEYS) {
        const def = getWarMapLegendSvgMarkup({ symbolKey, state: "default" });
        const hover = getWarMapLegendSvgMarkup({ symbolKey, state: "hover" });
        const sel = getWarMapLegendSvgMarkup({ symbolKey, state: "selected" });
        const clus = getWarMapLegendSvgMarkup({ symbolKey, state: "cluster" });
        expect(hover).not.toBe(def);
        expect(sel).not.toBe(def);
        expect(hover).not.toBe(sel);
        // cluster 气泡有数字徽标位（内圆 r=3.45）
        expect(clus).toContain('r="3.45"');
      }
    });

    it("map 与 legend 两个 target 的 SVG 不相同（map 为 48px 画布）", () => {
      const legend = getWarMapLegendSvgMarkup({ symbolKey: "flight" });
      const map = decodeURIComponent(
        getWarMapDeckIcon({ symbolKey: "flight" }).url,
      );
      expect(legend).toContain('width="24"');
      expect(map).toContain('width="48"');
      expect(map).not.toBe(legend);
    });

    it("deck icon 的结构字段（尺寸/anchor/mask）不漂移", () => {
      for (const symbolKey of ALL_SYMBOL_KEYS) {
        const icon = getWarMapDeckIcon({ symbolKey });
        expect(icon.width).toBe(48);
        expect(icon.height).toBe(48);
        expect(icon.anchorX).toBe(24);
        expect(icon.anchorY).toBe(24);
        expect(icon.mask).toBe(false);
      }
    });

    it("同 key+state 命中同一缓存对象；不同 state 不误共用", () => {
      const a = getWarMapDeckIcon({ symbolKey: "monitor" });
      const b = getWarMapDeckIcon({ symbolKey: "monitor" });
      expect(b).toBe(a);
      const hovered = getWarMapDeckIcon({ symbolKey: "monitor", state: "hover" });
      expect(hovered).not.toBe(a);
      expect(hovered.url).not.toBe(a.url);
    });

    it("generic-point 的 accent 参与缓存键：不同 accent 不共用缓存", () => {
      const blue = getWarMapDeckIcon({
        symbolKey: "generic-point",
        accentColor: "#112233",
      });
      const blueAgain = getWarMapDeckIcon({
        symbolKey: "generic-point",
        accentColor: "#112233",
      });
      expect(blueAgain).toBe(blue);
      const red = getWarMapDeckIcon({
        symbolKey: "generic-point",
        accentColor: "#cc2211",
      });
      expect(red).not.toBe(blue);
      expect(red.url).not.toBe(blue.url);
    });

    it("non-generic key 忽略 accentColor（调色板固定色）", () => {
      const plain = getWarMapDeckIcon({ symbolKey: "signal-high" });
      const tinted = getWarMapDeckIcon({
        symbolKey: "signal-high",
        accentColor: "#cc2211",
      });
      expect(tinted).toBe(plain);
    });
  });

  describe("颜色归一化与安全 fallback", () => {
    it("接受 #rgb、#rrggbb、rgb()、rgba() 并归一化为 #rrggbb", () => {
      expect(coerceHexColor("#abc")).toBe("#aabbcc");
      expect(coerceHexColor("aabbcc")).toBe("#aabbcc");
      expect(coerceHexColor("#aabbcc")).toBe("#aabbcc");
      expect(coerceHexColor("rgb(1, 2, 3)")).toBe("#010203");
      expect(coerceHexColor("rgba(1, 2, 3, 0.5)")).toBe("#010203");
      expect(coerceHexColor("rgba(300, 2, 3, 1)")).toBe("#ff0203");
    });

    it("空值与非法颜色回落到默认蓝色（可指定 fallback）", () => {
      expect(coerceHexColor(undefined)).toBe("#3b82f6");
      expect(coerceHexColor("")).toBe("#3b82f6");
      expect(coerceHexColor("not-a-color")).toBe("#3b82f6");
      expect(coerceHexColor("#12345")).toBe("#3b82f6");
      expect(coerceHexColor("javascript:alert(1)")).toBe("#3b82f6");
      expect(coerceHexColor(undefined, "#ff0000")).toBe("#ff0000");
    });

    it("恶意 accentColor 不会原样进入 legend SVG 标记", () => {
      const markup = getWarMapLegendSvgMarkup({
        symbolKey: "generic-point",
        accentColor: '" onload="alert(1)',
      });
      expect(markup).not.toContain("onload");
      expect(markup).not.toContain("alert(1");
      expect(markup).not.toContain("<script");
    });

    it("generic accent：accentColor 传入时用于 generic-point", () => {
      expect(getWarMapSymbolAccentColor("generic-point", "#ffcc00")).toBe(
        "#ffcc00",
      );
      // 非 generic key 固定调色板
      expect(getWarMapSymbolAccentColor("signal-high")).toBe("#b42318");
      expect(getWarMapSymbolAccentColor("flight")).toBe("#334155");
    });
  });

  describe("quick legend 可见性", () => {
    it("expanded/compact 显示 quick legend；minimal 不显示", () => {
      expect(getQuickLegendVisibility("expanded")).toBe(true);
      expect(getQuickLegendVisibility("compact")).toBe(true);
      expect(getQuickLegendVisibility("minimal")).toBe(false);
    });

    it("expanded 上限 7、compact 上限 6、minimal 为 0", () => {
      const items = ALL_SYMBOL_KEYS.slice(0, 10).map((key, index) => ({
        key,
        symbolKey: key,
        label: `label-${index}`,
      }));
      const expanded = selectVisibleQuickLegendItems({
        density: "expanded",
        items,
      });
      const compact = selectVisibleQuickLegendItems({
        density: "compact",
        items,
      });
      const minimal = selectVisibleQuickLegendItems({
        density: "minimal",
        items,
      });
      expect(expanded.visibleItems).toHaveLength(7);
      expect(compact.visibleItems).toHaveLength(6);
      expect(minimal.visibleItems).toHaveLength(0);
      expect(minimal.hiddenCount).toBe(items.length);
    });

    it("transport 项目优先：flight 出现在可见列表且总数不超过上限", () => {
      // 8 项 > compact 上限 6；flight 位居列表尾部（低优先级段），
      // 选择器以可移除项（signal-low 等）替换出 flight
      const items = [
        "signal-high",
        "signal-medium",
        "signal-low",
        "news-geocoded",
        "monitor",
        "ais-vessel-generic",
        "ais-disruption",
        "flight",
      ].map((key) => ({ key, symbolKey: key as never, label: key }));
      const { visibleItems, hiddenCount } = selectVisibleQuickLegendItems({
        density: "compact",
        items,
      });
      const keys = visibleItems.map((item) => item.key);
      expect(keys).toContain("flight");
      expect(visibleItems).toHaveLength(6);
      expect(hiddenCount).toBe(2);
    });

    it("ais 主项缺席时以可移除项替换补位", () => {
      const items = [
        "signal-high",
        "signal-medium",
        "signal-low",
        "news-geocoded",
        "monitor",
        "flight",
        "ais-vessel-generic",
      ].map((key) => ({ key, symbolKey: key as never, label: key }));
      const { visibleItems } = selectVisibleQuickLegendItems({
        density: "compact",
        items: items.slice(0, 6).concat(items.slice(6)),
      });
      expect(visibleItems.map((i) => i.key)).toContain("ais-vessel-generic");
    });
  });

  describe("legend 匹配语义", () => {
    it("按 symbolKey 匹配，matchSymbolKeys 展宽匹配集合", () => {
      const item = {
        symbolKey: "signal-high" as const,
        matchSymbolKeys: ["signal-high" as const, "signal-medium" as const],
      };
      expect(matchesWarMapLegendItem(item, { symbolKey: "signal-high" })).toBe(
        true,
      );
      expect(matchesWarMapLegendItem(item, { symbolKey: "signal-medium" })).toBe(
        true,
      );
      expect(matchesWarMapLegendItem(item, { symbolKey: "signal-low" })).toBe(
        false,
      );
    });

    it("layerId 命中 matchLayerIds 优先且独立生效", () => {
      const item = {
        symbolKey: "generic-point" as const,
        matchLayerIds: ["custom-layer-a"],
      };
      expect(
        matchesWarMapLegendItem(item, {
          symbolKey: "signal-high",
          layerId: "custom-layer-a",
        }),
      ).toBe(true);
      expect(
        matchesWarMapLegendItem(item, {
          symbolKey: "signal-high",
          layerId: "custom-layer-b",
        }),
      ).toBe(false);
      // 未提供 layerId 时回落 symbolKey 匹配
      expect(
        matchesWarMapLegendItem(item, { symbolKey: "generic-point" }),
      ).toBe(true);
    });
  });

  describe("label 与 i18n 链路", () => {
    it("全部 symbol key 的 label 经 t() 解析（无裸 key）", () => {
      for (const symbolKey of ALL_SYMBOL_KEYS) {
        const label = resolveWarMapLegendLabel(symbolKey, EN_T);
        expect(label).toMatch(
          /^⟦dashboard\.charts\.warMap\.legend\.\w+⟧$/,
        );
      }
    });

    it("quick legend items 的 label 与 match 集合随 AIS mode 变化", () => {
      const base = {
        t: EN_T,
        showMonitors: true,
        showFlights: true,
        showAis: true,
      };
      const density = buildWarMapQuickLegendItems({
        ...base,
        effectiveAisMode: "density",
      });
      const all = buildWarMapQuickLegendItems({
        ...base,
        effectiveAisMode: "all",
      });
      const military = buildWarMapQuickLegendItems({
        ...base,
        effectiveAisMode: "military",
      });
      const densityKeys = density.map((i) => i.key);
      expect(densityKeys).toContain("ais-density");
      expect(densityKeys).not.toContain("ais-vessel-generic");
      const allKeys = all.map((i) => i.key);
      expect(allKeys).toContain("ais-vessel-generic");
      const milKeys = military.map((i) => i.key);
      expect(milKeys).toContain("ais-vessel-military");
      // 三种模式都带 disruption 快捷项
      expect(densityKeys).toContain("ais-disruption");
      expect(allKeys).toContain("ais-disruption");
      expect(milKeys).toContain("ais-disruption");
      // monitor/flight 由开关控制
      expect(densityKeys).toContain("monitor");
      expect(densityKeys).toContain("flight");
    });

    it("showMonitors/showFlights/showAis 为 false 时对应项缺席", () => {
      const items = buildWarMapQuickLegendItems({
        t: EN_T,
        showMonitors: false,
        showFlights: false,
        showAis: false,
        effectiveAisMode: "all",
      });
      const keys = items.map((i) => i.key);
      expect(keys).not.toContain("monitor");
      expect(keys).not.toContain("flight");
      expect(keys).not.toContain("ais-density");
      expect(keys).not.toContain("ais-vessel-generic");
      expect(keys).toContain("signal-high");
    });

    it("transportState 的 note/count/tone 透传到 flight 项", () => {
      const items = buildWarMapQuickLegendItems({
        t: EN_T,
        showMonitors: false,
        showFlights: true,
        showAis: false,
        effectiveAisMode: "all",
        transportState: {
          flights: { note: "5 flights", countLabel: "5", tone: "degraded" },
        },
      });
      const flight = items.find((i) => i.key === "flight");
      expect(flight?.note).toBe("5 flights");
      expect(flight?.countLabel).toBe("5");
      expect(flight?.tone).toBe("degraded");
    });
  });

  describe("完整 legend sections", () => {
    it("基础三节：signals/transport/news + AIS mode 分支", () => {
      const sections = buildWarMapLegendSections({
        t: EN_T,
        showMonitors: true,
        showFlights: true,
        showAis: true,
        effectiveAisMode: "all",
        activePointLayers: [],
      });
      const keys = sections.map((s) => s.key);
      expect(keys).toEqual(["signals", "transport", "news"]);
      const transport = sections.find((s) => s.key === "transport");
      const transportItemKeys = transport?.items.map((i) => i.key) ?? [];
      expect(transportItemKeys).toContain("flight");
      expect(transportItemKeys).toContain("ais-vessel-cargo");
      expect(transportItemKeys).not.toContain("ais-density");
      // monitors 归入 news 节
      const news = sections.find((s) => s.key === "news");
      expect(news?.items.map((i) => i.key)).toContain("monitor");
    });

    it("density 模式：transport 节为 density + disruption 三档", () => {
      const sections = buildWarMapLegendSections({
        t: EN_T,
        showMonitors: false,
        showFlights: false,
        showAis: true,
        effectiveAisMode: "density",
        activePointLayers: [],
      });
      const transport = sections.find((s) => s.key === "transport");
      const keys = transport?.items.map((i) => i.key) ?? [];
      expect(keys).toContain("ais-density");
      expect(keys).not.toContain("ais-vessel-tanker");
      expect(keys).toEqual([
        "ais-density",
        "ais-disruption-high",
        "ais-disruption-medium",
        "ais-disruption-low",
      ]);
    });

    it("无 transport 项时 transport 节整体移除", () => {
      const sections = buildWarMapLegendSections({
        t: EN_T,
        showMonitors: false,
        showFlights: false,
        showAis: false,
        effectiveAisMode: "all",
        activePointLayers: [],
      });
      expect(sections.map((s) => s.key)).toEqual(["signals", "news"]);
    });

    it("activePointLayers 生成 other-point-layers 节，匹配 layerId", () => {
      const sections = buildWarMapLegendSections({
        t: EN_T,
        showMonitors: false,
        showFlights: false,
        showAis: false,
        effectiveAisMode: "all",
        activePointLayers: [
          { key: "layer-custom", label: "Custom layer", accentColor: "#ffcc00" },
        ],
      });
      const other = sections.find((s) => s.key === "other-point-layers");
      expect(other?.defaultExpanded).toBe(false);
      expect(other?.items[0]?.symbolKey).toBe("generic-point");
      expect(other?.items[0]?.matchLayerIds).toEqual(["layer-custom"]);
      expect(other?.items[0]?.accentColor).toBe("#ffcc00");
    });

    it("transportState 的节状态透传到 transport 节", () => {
      const sections = buildWarMapLegendSections({
        t: EN_T,
        showMonitors: false,
        showFlights: true,
        showAis: false,
        effectiveAisMode: "all",
        activePointLayers: [],
        transportState: {
          sectionStatusLabel: "degraded",
          sectionStatusTone: "warning",
          sectionStatusHint: "partially limited",
        },
      });
      const transport = sections.find((s) => s.key === "transport");
      expect(transport?.statusLabel).toBe("degraded");
      expect(transport?.statusTone).toBe("warning");
      expect(transport?.statusHint).toBe("partially limited");
    });
  });

  describe("interaction legend 与 cluster count", () => {
    it("interaction items：hover/selected/cluster 三态", () => {
      const items = buildWarMapInteractionLegendItems({ t: EN_T });
      expect(items.map((i) => i.key)).toEqual([
        "hover",
        "selected",
        "cluster",
      ]);
      const states = items.map((i) => i.state);
      expect(states).toEqual(["hover", "selected", "cluster"]);
      expect(items[2]?.countLabel).toBe("12");
    });

    it("cluster count：空值/0/普通值/超界", () => {
      expect(formatWarMapClusterCountLabel(Number.NaN)).toBe("");
      expect(formatWarMapClusterCountLabel(0)).toBe("");
      expect(formatWarMapClusterCountLabel(1)).toBe("1");
      expect(formatWarMapClusterCountLabel(999)).toBe("999");
      expect(formatWarMapClusterCountLabel(1000)).toBe("999+");
      expect(formatWarMapClusterCountLabel(10000)).toBe("999+");
      expect(formatWarMapClusterCountLabel(2.4)).toBe("2");
      expect(formatWarMapClusterCountLabel(2.5)).toBe("3");
      expect(formatWarMapClusterCountLabel(-5)).toBe("");
    });
  });
});
