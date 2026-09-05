"use client";

import { CloseOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";

import {
  LegendInteractionStrip,
  LegendSectionsList,
} from "./war-map-legend-sections";
import type { WarMapLegendPanelProps } from "./war-map-controls-types";
import { resolveOverlayButtonClassName } from "./war-map-overlay-model";

/**
 * Legend 全量面板（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * overlay 打开的完整图例：头部 + 交互状态条 + 可折叠 sections。
 */
export function WarMapLegendPanel({
  legendSections,
  interactionLegendItems,
  summaryDataLabel,
  onClose,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: WarMapLegendPanelProps) {
  return (
    <div className="flex h-full min-h-0 max-h-full flex-col">
      <div className="border-b border-[var(--border)] bg-gradient-to-b from-white to-slate-50/90 px-4 py-3.5 dark:from-slate-950/90 dark:to-slate-900/86">
        <div className="flex items-start justify-between gap-3">
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
          {onClose ? (
            <Button
              type="default"
              aria-label={t("common.close")}
              className={resolveOverlayButtonClassName({
                tone: "neutral",
                iconOnly: true,
                extraClassName: "!h-10 !min-w-10 !rounded-full",
              })}
              icon={<CloseOutlined />}
              onClick={onClose}
            />
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
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
      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3.5">
        <LegendInteractionStrip items={interactionLegendItems} t={t} />
        <div className="mt-3">
          <LegendSectionsList
            legendSections={legendSections}
            activeLegendKey={activeLegendKey}
            highlightedLegendKey={highlightedLegendKey}
            onLegendItemHover={onLegendItemHover}
            onLegendItemFocus={onLegendItemFocus}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}
