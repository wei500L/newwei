/**
 * War Map overlay 主题常量与按钮 class 解析（FE-批4B：自
 * war-map-overlay-model.ts 拆出）。纯函数模块：无 React、无 "use client"。
 */

export const OVERLAY_SURFACE_CLASS_NAME =
  "rounded-2xl border border-[var(--border)] bg-white/[0.88] shadow-xl backdrop-blur dark:bg-slate-950/[0.72] dark:shadow-[0_20px_48px_-30px_rgba(2,6,23,0.88)]";
export const OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME = `${OVERLAY_SURFACE_CLASS_NAME} transition-all duration-200 hover:bg-white/[0.95] dark:hover:bg-slate-950/[0.82]`;
export const OVERLAY_SECTION_TITLE_CLASS_NAME =
  "text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400";
export const OVERLAY_STATUS_TAG_CLASS_NAME =
  "!m-0 !rounded-full !px-2.5 !py-0.5 !text-[11px] !font-medium !leading-4";
export const OVERLAY_NEUTRAL_TAG_CLASS_NAME = `${OVERLAY_STATUS_TAG_CLASS_NAME} !border-[var(--border)] !bg-white/[0.78] !text-slate-700 dark:!border-slate-700/80 dark:!bg-slate-950/[0.68] dark:!text-slate-200`;
export const OVERLAY_BUTTON_GROUP_CLASS_NAME =
  "inline-flex flex-wrap gap-1.5 rounded-[18px] border border-[var(--border)] bg-white/[0.55] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:bg-slate-950/[0.55] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";
export const OVERLAY_BUTTON_BASE_CLASS_NAME =
  "!h-8 !rounded-full !border !px-3 !text-[11px] !font-medium !leading-none !backdrop-blur-sm !shadow-[0_10px_22px_-20px_rgba(15,23,42,0.45)] transition-[background-color,border-color,color,box-shadow,transform] duration-200";
export const OVERLAY_BUTTON_NEUTRAL_CLASS_NAME = `${OVERLAY_BUTTON_BASE_CLASS_NAME} !border-[var(--border)] !bg-white/[0.82] !text-slate-700 hover:!border-slate-300/90 hover:!bg-white hover:!text-slate-950 hover:!shadow-[0_14px_26px_-22px_rgba(15,23,42,0.35)] dark:!border-slate-700/80 dark:!bg-slate-950/[0.68] dark:!text-slate-200 dark:hover:!border-slate-500/[0.85] dark:hover:!bg-slate-900 dark:hover:!text-slate-50 dark:hover:!shadow-[0_16px_30px_-24px_rgba(2,6,23,0.82)]`;
export const OVERLAY_BUTTON_ACTIVE_CLASS_NAME = `${OVERLAY_BUTTON_BASE_CLASS_NAME} !border-slate-900 !bg-slate-900 !text-white !shadow-[0_16px_30px_-24px_rgba(15,23,42,0.52)] hover:!border-slate-800 hover:!bg-slate-800 hover:-translate-y-[1px] dark:!border-sky-400/26 dark:!bg-sky-400/16 dark:!text-sky-100 dark:!shadow-[0_18px_32px_-24px_rgba(8,47,73,0.68)] dark:hover:!border-sky-300/38 dark:hover:!bg-sky-400/22`;
export const OVERLAY_BUTTON_GHOST_CLASS_NAME =
  "!h-8 !min-w-8 !rounded-full !border-transparent !bg-transparent !px-0 !text-slate-500 !shadow-none hover:!bg-slate-900/[0.06] hover:!text-slate-900 dark:!text-slate-300 dark:hover:!bg-white/[0.10] dark:hover:!text-slate-50";
export const OVERLAY_BUTTON_LINK_CLASS_NAME =
  "!h-auto !px-0 !text-xs !font-medium !text-slate-600 hover:!text-slate-900 dark:!text-slate-300 dark:hover:!text-slate-100";

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
