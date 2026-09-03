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
 * 顶部栏响应式优先级（FE-批2）——由密度档位推导各入口的呈现方式。
 *
 * 始终保留：菜单、品牌、搜索/命令入口、通知、用户入口（mininal 档用
 * searchEntry 兜底全局搜索——迁移前窄屏会完全失去搜索入口）。
 * 空间允许：组织切换、系统状态、高频抓取操作。
 * 更宽屏：命令面板完整宽度、系统状态文字、主按钮形态。
 *
 * 该函数是纯函数：密度边界与优先级表在这里集中、可测。
 */
export type CrawlActionVariant = "primary" | "compact" | "menu" | "none";
export type LanguageSwitcherVariant = "inline" | "menu";
export type OrganizationSwitcherVariant = "inline" | "popover";

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
  languageSwitcher: LanguageSwitcherVariant;
  /** 组织切换形态：内联输入 / Popover 图标 */
  organizationSwitcher: OrganizationSwitcherVariant;
  showSyncIndicator: boolean;
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
    organizationSwitcher: isFull ? "inline" : "popover",
    showSyncIndicator: !isMinimal,
  };
}
