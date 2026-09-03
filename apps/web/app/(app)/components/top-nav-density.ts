export type TopNavDensityMode = "full" | "compact" | "minimal";

export const NAV_FULL_MIN_WIDTH = 1700;
export const NAV_COMPACT_MIN_WIDTH = 1280;
export const NAV_OVERFLOW_EPSILON = 2;
export const NAV_UPGRADE_SLACK = 24;

export const resolveBaseDensityMode = (viewportWidth: number): TopNavDensityMode => {
  if (viewportWidth >= NAV_FULL_MIN_WIDTH) {
    return "full";
  }
  if (viewportWidth >= NAV_COMPACT_MIN_WIDTH) {
    return "compact";
  }
  return "minimal";
};

export const downgradeDensityMode = (mode: TopNavDensityMode): TopNavDensityMode => {
  if (mode === "full") {
    return "compact";
  }
  return "minimal";
};

export const alignDensityModeToBase = (
  mode: TopNavDensityMode,
  baseMode: TopNavDensityMode
): TopNavDensityMode => {
  if (baseMode === "minimal") {
    return "minimal";
  }

  if (baseMode === "compact" && mode !== "compact") {
    return "compact";
  }

  return mode;
};

export const downgradeDensityModeForBase = (
  mode: TopNavDensityMode,
  baseMode: TopNavDensityMode
): TopNavDensityMode => {
  if (mode === "minimal") {
    return "minimal";
  }

  const nextMode = downgradeDensityMode(mode);
  if (baseMode === "compact" && nextMode === "minimal") {
    return "compact";
  }
  return nextMode;
};

export const upgradeDensityMode = (
  mode: TopNavDensityMode,
  target: TopNavDensityMode
): TopNavDensityMode => {
  if (mode === target) {
    return mode;
  }

  if (mode === "minimal") {
    return target === "full" ? "compact" : target;
  }

  if (mode === "compact" && target === "full") {
    return "full";
  }

  return mode;
};

/**
 * 纯宽屏附属层（跑马灯等整行次要信息）的显示条件。
 *
 * 与 full 密度基线同源（NAV_FULL_MIN_WIDTH），不引入第二套断点；但它
 * 刻意不跟随 header 的溢出降级——跑马灯是 header 之外的独立整行，
 * Shell 的顶部占位高度依赖同一信号，两处必须始终一致（见 shell.tsx
 * 的 --ticker-height 覆盖与 TopNav 的条件渲染）。
 */
export const isFullWidthViewport = (viewportWidth: number): boolean =>
  viewportWidth >= NAV_FULL_MIN_WIDTH;

/**
 * 顶部栏响应式优先级（FE-批2）——由密度档位推导各入口的呈现方式。
 *
 * minimal 档顶部栏只保留：菜单、品牌（短名）、搜索、通知、用户菜单。
 * 其余入口（组织切换 / 主题切换 / 语言切换 / 抓取 / 同步状态）在该档
 * 一律收进用户菜单或隐藏，避免 320–390px 视口下堆放过多人机入口；
 * 组织/主题/语言/有权限的抓取仍从用户菜单可达，功能不消失。
 * compact / full 档行为与迁移前一致。
 *
 * 该函数是纯函数：密度边界与优先级表在这里集中、可测。每个入口的
 * 呈现状态是明确的联合类型值（inline / popover / menu / none），
 * 消费方按值分发，不散落布尔判断。
 */
export type CrawlActionVariant = "primary" | "compact" | "menu" | "none";
/** 通用入口呈现：inline = 顶部栏内联；menu = 收进用户菜单 */
export type TopNavEntryVariant = "inline" | "menu";
/** 组织切换：full 档内联输入；compact 档 Popover 图标；minimal 档收进用户菜单 */
export type OrganizationSwitcherVariant = "inline" | "popover" | "menu";

export interface TopNavLayout {
  densityMode: TopNavDensityMode;
  /** 命令面板（full/compact；minimal 由 searchEntry 兜底） */
  showCommandBar: boolean;
  /** 窄屏全局搜索兜底入口（→ /search） */
  showSearchEntry: boolean;
  /** 系统状态（DEFCON）仅 full 档 */
  showSystemStatus: boolean;
  /** 抓取操作形态：主按钮 / 图标按钮 / 收进用户菜单 / 无权限 */
  crawlButton: CrawlActionVariant;
  /** 语言切换形态：内联 Select（lg+）/ 收进用户菜单 */
  languageSwitcher: TopNavEntryVariant;
  /** 组织切换形态（见 OrganizationSwitcherVariant） */
  organizationSwitcher: OrganizationSwitcherVariant;
  /** 主题切换形态：内联图标按钮 / 收进用户菜单 */
  themeToggle: TopNavEntryVariant;
  /** 同步状态指示仅 full/compact（minimal 收起） */
  showSyncIndicator: boolean;
  /**
   * minimal 档放大核心入口触控目标（≥44px）：窄屏以触控设备为主，
   * 命中区优先于紧凑度；full/compact 保持紧凑尺寸（32/40px）。
   */
  largeTouchTargets: boolean;
}

export interface TopNavLayoutInput {
  densityMode: TopNavDensityMode;
  canStartCrawl: boolean;
}

export function resolveTopNavLayout({
  densityMode,
  canStartCrawl,
}: TopNavLayoutInput): TopNavLayout {
  const isFull = densityMode === "full";
  const isMinimal = densityMode === "minimal";

  const crawlButton: CrawlActionVariant = !canStartCrawl
    ? "none"
    : isFull
      ? "primary"
      : isMinimal
        ? "menu"
        : "compact";

  return {
    densityMode,
    showCommandBar: !isMinimal,
    showSearchEntry: isMinimal,
    showSystemStatus: isFull,
    crawlButton,
    languageSwitcher: isMinimal ? "menu" : "inline",
    organizationSwitcher: isFull ? "inline" : isMinimal ? "menu" : "popover",
    themeToggle: isMinimal ? "menu" : "inline",
    showSyncIndicator: !isMinimal,
    largeTouchTargets: isMinimal,
  };
}
