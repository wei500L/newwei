import { describe, expect, it } from "vitest";

import {
  alignDensityModeToBase,
  downgradeDensityModeForBase,
  NAV_COMPACT_MIN_WIDTH,
  NAV_FULL_MIN_WIDTH,
  resolveBaseDensityMode,
  resolveTopNavLayout,
  upgradeDensityMode,
} from "./top-nav-density";

describe("resolveBaseDensityMode（密度基线边界）", () => {
  it("在 1280 / 1700 两个边界上切换 minimal / compact / full", () => {
    expect(resolveBaseDensityMode(0)).toBe("minimal");
    expect(resolveBaseDensityMode(NAV_COMPACT_MIN_WIDTH - 1)).toBe("minimal");
    expect(resolveBaseDensityMode(NAV_COMPACT_MIN_WIDTH)).toBe("compact");
    expect(resolveBaseDensityMode(NAV_FULL_MIN_WIDTH - 1)).toBe("compact");
    expect(resolveBaseDensityMode(NAV_FULL_MIN_WIDTH)).toBe("full");
  });
});

describe("密度档位在基线内降级 / 升级", () => {
  it("溢出时逐级降级，compact 基线不降到 minimal 以下", () => {
    expect(downgradeDensityModeForBase("full", "full")).toBe("compact");
    expect(downgradeDensityModeForBase("compact", "full")).toBe("minimal");
    expect(downgradeDensityModeForBase("compact", "compact")).toBe("compact");
    expect(downgradeDensityModeForBase("minimal", "minimal")).toBe("minimal");
  });

  it("富余时逐步升级，一次只升一级", () => {
    expect(upgradeDensityMode("minimal", "full")).toBe("compact");
    expect(upgradeDensityMode("compact", "full")).toBe("full");
    expect(upgradeDensityMode("minimal", "compact")).toBe("compact");
    expect(upgradeDensityMode("full", "full")).toBe("full");
  });

  it("基线变化时先对齐基线（窄屏不可能保持高密度）", () => {
    expect(alignDensityModeToBase("full", "minimal")).toBe("minimal");
    expect(alignDensityModeToBase("minimal", "compact")).toBe("compact");
    expect(alignDensityModeToBase("minimal", "full")).toBe("minimal");
  });
});

describe("resolveTopNavLayout（顶部栏响应式优先级）", () => {
  it("full：命令面板 + 系统状态 + 主按钮 + 内联语言/组织", () => {
    const layout = resolveTopNavLayout({ densityMode: "full", canStartCrawl: true });
    expect(layout.showCommandBar).toBe(true);
    expect(layout.showSearchEntry).toBe(false);
    expect(layout.showSystemStatus).toBe(true);
    expect(layout.crawlButton).toBe("primary");
    expect(layout.languageSwitcher).toBe("inline");
    expect(layout.organizationSwitcher).toBe("inline");
    expect(layout.showSyncIndicator).toBe(true);
  });

  it("compact：命令面板保留，系统状态收起，抓取降为图标，组织进 Popover", () => {
    const layout = resolveTopNavLayout({ densityMode: "compact", canStartCrawl: true });
    expect(layout.showCommandBar).toBe(true);
    expect(layout.showSearchEntry).toBe(false);
    expect(layout.showSystemStatus).toBe(false);
    expect(layout.crawlButton).toBe("compact");
    expect(layout.languageSwitcher).toBe("inline");
    expect(layout.organizationSwitcher).toBe("popover");
  });

  it("minimal：命令面板让位于搜索兜底入口，抓取与语言收进用户菜单", () => {
    const layout = resolveTopNavLayout({ densityMode: "minimal", canStartCrawl: true });
    expect(layout.showCommandBar).toBe(false);
    expect(layout.showSearchEntry).toBe(true);
    expect(layout.showSystemStatus).toBe(false);
    expect(layout.crawlButton).toBe("menu");
    expect(layout.languageSwitcher).toBe("menu");
    expect(layout.organizationSwitcher).toBe("popover");
    expect(layout.showSyncIndicator).toBe(false);
  });

  it("无抓取权限时任何密度都不出现抓取入口", () => {
    for (const densityMode of ["full", "compact", "minimal"] as const) {
      expect(
        resolveTopNavLayout({ densityMode, canStartCrawl: false }).crawlButton,
      ).toBe("none");
    }
  });
});
