export type NavMode = "rail" | "rail-scroll" | "drawer";

export interface ResolveNavModeInput {
  viewportWidth: number;
  availableRailHeight: number;
  railContentHeight: number;
}

export const DESKTOP_RAIL_MIN_WIDTH = 900;
export const RAIL_SCROLL_MIN_FIT_RATIO = 0.78;

const RAIL_BUTTON_HEIGHT = 44;
const RAIL_ITEM_GAP = 6;
const RAIL_PANEL_VERTICAL_PADDING = 32;
const RAIL_SECTION_GAP = 8;
const RAIL_MAIN_BOTTOM_PADDING = 16;
const RAIL_MAIN_BORDER_HEIGHT = 1;
const RAIL_ADMIN_TOP_PADDING = 12;
const RAIL_ADMIN_LABEL_HEIGHT = 14;
const RAIL_ADMIN_LABEL_TO_ITEMS_GAP = 6;
const RAIL_VISUAL_BUFFER = 8;

function estimateListHeight(itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }
  return itemCount * RAIL_BUTTON_HEIGHT + (itemCount - 1) * RAIL_ITEM_GAP;
}

export function estimateRailContentHeight(mainNavCount: number, adminNavCount: number): number {
  const normalizedMainCount = Math.max(0, Math.floor(mainNavCount));
  const normalizedAdminCount = Math.max(0, Math.floor(adminNavCount));

  const mainSectionHeight =
    estimateListHeight(normalizedMainCount) + RAIL_MAIN_BOTTOM_PADDING + RAIL_MAIN_BORDER_HEIGHT;

  if (normalizedAdminCount === 0) {
    return RAIL_PANEL_VERTICAL_PADDING + mainSectionHeight + RAIL_VISUAL_BUFFER;
  }

  const adminSectionHeight =
    RAIL_ADMIN_TOP_PADDING +
    RAIL_ADMIN_LABEL_HEIGHT +
    RAIL_ADMIN_LABEL_TO_ITEMS_GAP +
    estimateListHeight(normalizedAdminCount);

  return (
    RAIL_PANEL_VERTICAL_PADDING +
    mainSectionHeight +
    RAIL_SECTION_GAP +
    adminSectionHeight +
    RAIL_VISUAL_BUFFER
  );
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
