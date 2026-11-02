/**
 * War Map overlay 主题常量与按钮 class 解析（FE-批4B：自
 * war-map-overlay-model.ts 拆出）。纯函数模块：无 React、无 "use client"。
 */

export const OVERLAY_SURFACE_CLASS_NAME =
  "rounded-lg border border-[var(--border)] bg-surface shadow-[var(--shadow-surface)]";
export const OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME = `${OVERLAY_SURFACE_CLASS_NAME} transition-colors duration-200 hover:bg-[var(--secondary)]`;
export const OVERLAY_SECTION_TITLE_CLASS_NAME = "kicker";
export const OVERLAY_STATUS_TAG_CLASS_NAME =
  "!m-0 !rounded-full !px-2.5 !py-0.5 !text-xs !font-medium !leading-4";
export const OVERLAY_NEUTRAL_TAG_CLASS_NAME = `${OVERLAY_STATUS_TAG_CLASS_NAME} !border-[var(--border)] !bg-surface !text-muted-foreground`;
export const OVERLAY_BUTTON_BASE_CLASS_NAME =
  "!h-8 !rounded-full !border !px-3 !text-xs !font-medium !leading-none transition-colors duration-200";
export const OVERLAY_BUTTON_NEUTRAL_CLASS_NAME = `${OVERLAY_BUTTON_BASE_CLASS_NAME} !border-[var(--border)] !bg-surface !text-muted-foreground hover:!bg-[var(--secondary)]`;
export const OVERLAY_BUTTON_ACTIVE_CLASS_NAME = `${OVERLAY_BUTTON_BASE_CLASS_NAME} !border-[var(--foreground)] !bg-[var(--foreground)] !text-[var(--background)]`;
export const OVERLAY_BUTTON_GHOST_CLASS_NAME =
  "!h-8 !min-w-8 !rounded-full !border-transparent !bg-transparent !px-0 !text-muted-foreground !shadow-none hover:!bg-[var(--secondary)]";
export const OVERLAY_BUTTON_LINK_CLASS_NAME =
  "!h-auto !px-0 !text-xs !font-medium !text-[var(--primary)] hover:!underline";

export type OverlayButtonTone = "neutral" | "active" | "ghost" | "link";

export function resolveOverlayButtonClassName({
  tone = "neutral",
  iconOnly = false,
  extraClassName,
}: {
  tone?: OverlayButtonTone;
  iconOnly?: boolean;
  extraClassName?: string;
} = {}): string {
  const toneClassName =
    tone === "active"
      ? OVERLAY_BUTTON_ACTIVE_CLASS_NAME
      : tone === "ghost"
        ? OVERLAY_BUTTON_GHOST_CLASS_NAME
        : tone === "link"
          ? OVERLAY_BUTTON_LINK_CLASS_NAME
          : OVERLAY_BUTTON_NEUTRAL_CLASS_NAME;

  return [toneClassName, iconOnly ? "!min-w-8 !px-0" : null, extraClassName]
    .filter(Boolean)
    .join(" ");
}
