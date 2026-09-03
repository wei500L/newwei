export type NavMode = "rail" | "rail-scroll" | "drawer";

export interface ResolveNavModeInput {
  viewportWidth: number;
  availableRailHeight: number;
  railContentHeight: number;
}

export const DESKTOP_RAIL_MIN_WIDTH = 900;
export const RAIL_SCROLL_MIN_FIT_RATIO = 0.78;

// 度量常量与 globals.css 的 App Shell 导航 token 保持一致：
// --rail-item-size 44px / --rail-item-gap 6px / 组间距见各分隔线度量。
const RAIL_ITEM_HEIGHT = 44;
const RAIL_ITEM_GAP = 6;
const RAIL_PANEL_VERTICAL_PADDING = 32;
/** rail 组间细分隔线：my-2 + 1px = 17px */
const RAIL_USER_GROUP_DIVIDER_HEIGHT = 17;
/** 管理组上边界：mt-3 + 1px 边线 */
const RAIL_ADMIN_SEPARATOR_HEIGHT = 13;
/** 管理组标题块：pt-3 + 14px 标题 + 6px 标题与项间距 */
const RAIL_ADMIN_LABEL_BLOCK_HEIGHT = 32;
const RAIL_VISUAL_BUFFER = 8;

function estimateListHeight(itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }
  return itemCount * RAIL_ITEM_HEIGHT + (itemCount - 1) * RAIL_ITEM_GAP;
}

export interface RailContentEstimateInput {
  /** 每组导航项数量，按渲染顺序（管理组约定在末位） */
  groupItemCounts: readonly number[];
  /** 是否渲染带标题的管理组（标题占额外高度） */
  hasTitledAdminGroup: boolean;
}

/**
 * 估算 rail 面板内容高度（px），供 Shell 决定 rail / rail-scroll / drawer。
 * 五组化（FE-批2）后按组逐段累加：组内列表高度 + 组间分隔线 + 管理组标题块。
 */
export function estimateRailContentHeight({
  groupItemCounts,
  hasTitledAdminGroup,
}: RailContentEstimateInput): number {
  const counts = groupItemCounts.map((count) => Math.max(0, Math.floor(count)));

  let height = RAIL_PANEL_VERTICAL_PADDING;
  counts.forEach((count, index) => {
    const isTitledAdminGroup =
      hasTitledAdminGroup && index === counts.length - 1 && count > 0;
    if (index > 0) {
      height += isTitledAdminGroup
        ? RAIL_ADMIN_SEPARATOR_HEIGHT
        : RAIL_USER_GROUP_DIVIDER_HEIGHT;
    }
    height += estimateListHeight(count);
    if (isTitledAdminGroup) {
      height += RAIL_ADMIN_LABEL_BLOCK_HEIGHT;
    }
  });

  return height + RAIL_VISUAL_BUFFER;
}

export function resolveNavMode({
  viewportWidth,
  availableRailHeight,
  railContentHeight,
}: ResolveNavModeInput): NavMode {
  if (viewportWidth < DESKTOP_RAIL_MIN_WIDTH) {
    return "drawer";
  }

  if (availableRailHeight <= 0 || railContentHeight <= 0) {
    return "rail";
  }

  if (railContentHeight <= availableRailHeight) {
    return "rail";
  }

  const fitRatio = availableRailHeight / railContentHeight;
  return fitRatio >= RAIL_SCROLL_MIN_FIT_RATIO ? "rail-scroll" : "drawer";
}
