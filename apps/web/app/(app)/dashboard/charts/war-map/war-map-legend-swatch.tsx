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
            ? "border-[var(--border-strong)] bg-surface shadow-[var(--shadow-surface)]"
            : "border-[var(--border)] bg-surface"
        } ${
          tone === "degraded"
            ? "border-amber-200/90 bg-amber-50/80 dark:border-amber-400/30 dark:bg-amber-950/22"
            : ""
        } ${muted ? "opacity-55" : "opacity-100"} ${
          interactive
            ? "hover:bg-[var(--secondary)]"
            : ""
        }`
      : `flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,opacity] duration-150 ${
          active
            ? "border-[var(--border-strong)] bg-surface shadow-[var(--shadow-surface)]"
            : "border-[var(--border)] bg-surface"
        } ${
          tone === "degraded"
            ? "border-amber-200/90 bg-amber-50/75 dark:border-amber-400/28 dark:bg-amber-950/20"
            : ""
        } ${muted ? "opacity-50" : "opacity-100"} ${
          interactive
            ? "hover:bg-[var(--secondary)]"
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
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-semibold text-slate-950 dark:text-slate-900">
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
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
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
