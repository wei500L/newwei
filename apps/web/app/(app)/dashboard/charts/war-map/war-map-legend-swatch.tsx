"use client";

import type { ReactNode } from "react";

import { getWarMapLegendSvgMarkup } from "./war-map-symbol-icons";
import type { WarMapLegendItem } from "./war-map-symbol-types";

/**
 * Legend 符号样本组件（FE-批4B：自 war-map-symbols.tsx 拆出）。
 * quick/panel 两种视觉变体；可交互形态渲染真实 button。
 */
export function WarMapLegendSwatch({
  symbolKey,
  label,
  note,
  state = "default",
  tone = "default",
  accentColor,
  countLabel,
  size = 42,
  variant = "panel",
  interactive = false,
  active = false,
  muted = false,
  endAdornment,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: WarMapLegendItem & {
  size?: number;
  variant?: "quick" | "panel";
  interactive?: boolean;
  active?: boolean;
  muted?: boolean;
  endAdornment?: ReactNode;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const iconMarkup = getWarMapLegendSvgMarkup({
    symbolKey,
    state,
    accentColor,
  });
  const containerClassName =
    variant === "quick"
      ? `flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-[border-color,background-color,box-shadow,transform,opacity] duration-150 ${
          active
            ? "border-slate-300/90 bg-white/[0.96] shadow-[0_12px_22px_-20px_rgba(15,23,42,0.2)] dark:border-slate-500/70 dark:bg-slate-950/[0.86]"
            : "border-slate-200/75 bg-white/[0.72] dark:border-slate-700/70 dark:bg-slate-950/[0.52]"
        } ${
          tone === "degraded"
            ? "border-amber-200/90 bg-amber-50/80 dark:border-amber-400/30 dark:bg-amber-950/22"
            : ""
        } ${muted ? "opacity-55" : "opacity-100"} ${
          interactive
            ? "hover:border-slate-300/85 hover:bg-white/[0.9] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.7]"
            : ""
        }`
      : `flex min-w-0 items-center gap-3 rounded-[18px] border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,opacity] duration-150 ${
          active
            ? "border-slate-300 bg-white shadow-[0_14px_28px_-24px_rgba(15,23,42,0.18)] dark:border-slate-500/75 dark:bg-slate-950/82"
            : "border-slate-200/80 bg-white/[0.76] dark:border-slate-700/80 dark:bg-slate-950/[0.54]"
        } ${
          tone === "degraded"
            ? "border-amber-200/90 bg-amber-50/75 dark:border-amber-400/28 dark:bg-amber-950/20"
            : ""
        } ${muted ? "opacity-50" : "opacity-100"} ${
          interactive
            ? "hover:border-slate-300/90 hover:bg-white/[0.9] dark:hover:border-slate-500/80 dark:hover:bg-slate-950/[0.72]"
            : ""
        }`;
  const content = (
    <>
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <span
          className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: iconMarkup }}
          aria-hidden="true"
        />
        {countLabel ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-slate-950 dark:text-slate-900">
            {countLabel}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block ${
            variant === "quick" ? "truncate text-[12px]" : "text-[13px]"
          } font-medium text-slate-900 dark:text-slate-100`}
        >
          {label}
        </span>
        {note ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">
            {note}
          </span>
        ) : null}
      </span>
      {endAdornment ? <span className="shrink-0">{endAdornment}</span> : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={containerClassName}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {content}
      </button>
    );
  }

  return <div className={containerClassName}>{content}</div>;
}
