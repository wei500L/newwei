"use client";

import { Button, Tooltip, Typography } from "antd";

import type {
  WarMapLegendDockProps,
  WarMapLegendInteractionProps,
} from "./war-map-controls-types";
import {
  LegendItemsGrid,
  LegendInteractionStrip,
  resolveLegendSectionStatusClasses,
} from "./war-map-legend-sections";
import {
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  resolveOverlayButtonClassName,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import type { WarMapLegendSection } from "./war-map-symbols";

/**
 * Legend dock（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * standalone 布局常驻的全量图例：交互状态条 + 双列 section 卡。
 */
export function WarMapLegendDock({
  legendSections,
  interactionLegendItems,
  summaryDataLabel,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: WarMapLegendDockProps) {
  return (
    <div className="flex flex-col">
      <div className="border-b border-[var(--border)] bg-gradient-to-b from-white to-slate-50/90 px-5 py-4 dark:from-slate-950/90 dark:to-slate-900/86">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Typography.Text
              strong
              className="block text-base text-slate-900 dark:text-slate-100"
            >
              {t("dashboard.charts.warMap.legend.title")}
            </Typography.Text>
            <Typography.Text
              type="secondary"
              className="mt-1 block text-[12px] leading-5"
            >
              {t("dashboard.charts.warMap.legend.quickLegendHint")}
            </Typography.Text>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
            {summaryDataLabel ? (
              <span className="truncate">{summaryDataLabel}</span>
            ) : null}
            {activeLegendKey ? (
              <Button
                type="link"
                size="small"
                className={resolveOverlayButtonClassName({ tone: "link" })}
                style={{ padding: 0, height: "auto", fontSize: 11 }}
                onClick={() => onLegendItemFocus?.(null)}
              >
                {t("dashboard.charts.warMap.legend.clearFocus")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="px-5 pb-5 pt-4">
        <LegendInteractionStrip items={interactionLegendItems} t={t} />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {legendSections.map((section) => (
            <LegendDockSectionCard
              key={section.key}
              section={section}
              activeLegendKey={activeLegendKey}
              highlightedLegendKey={highlightedLegendKey}
              onLegendItemHover={onLegendItemHover}
              onLegendItemFocus={onLegendItemFocus}
              t={t}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function LegendDockSectionCard({
  section,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: {
  section: WarMapLegendSection;
  t: WarMapTranslateFn;
} & WarMapLegendInteractionProps) {
  return (
    <div className="flex h-full flex-col rounded-[22px] border border-slate-200/75 bg-white/[0.8] px-5 py-5 shadow-[0_12px_20px_-22px_rgba(15,23,42,0.1)] dark:border-slate-700/80 dark:bg-slate-950/[0.54] dark:shadow-[0_12px_20px_-22px_rgba(2,6,23,0.52)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
            {section.title}
          </Typography.Text>
          {section.statusLabel ? (
            <Tooltip title={section.statusHint}>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${resolveLegendSectionStatusClasses(
                  section.statusTone,
                )}`}
              >
                {section.statusLabel}
              </span>
            </Tooltip>
          ) : null}
        </div>
        {section.description ? (
          <Typography.Text
            type="secondary"
            className="mt-1.5 block text-[12px] leading-5"
          >
            {section.description}
          </Typography.Text>
        ) : null}
      </div>
      <div className="mt-4">
        <LegendItemsGrid
          items={section.items}
          activeLegendKey={activeLegendKey}
          highlightedLegendKey={highlightedLegendKey}
          onLegendItemHover={onLegendItemHover}
          onLegendItemFocus={onLegendItemFocus}
          t={t}
        />
      </div>
    </div>
  );
}
