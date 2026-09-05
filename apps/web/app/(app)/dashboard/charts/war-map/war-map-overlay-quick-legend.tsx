"use client";

import { InfoCircleOutlined } from "@ant-design/icons";
import { Button, Tooltip, Typography } from "antd";

import { selectVisibleQuickLegendItems } from "./war-map-legend-model";
import { WarMapLegendSwatch } from "./war-map-legend-swatch";
import {
  OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME,
  resolveOverlayButtonClassName,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import type { WarMapOverlayRailQuickLegend } from "./war-map-overlay-rail-types";
import type { OverlayDensity } from "./war-map-symbol-types";

/**
 * Rail quick legend（FE-批4B：自 war-map-overlay-rail.tsx 拆出）。
 * 展示密度上限内的可聚焦 legend 项与 hidden count 打开入口。
 */
export function WarMapOverlayQuickLegend({
  density,
  legendLabel,
  quickLegend,
  onOpenFullLegend,
  t,
}: {
  density: OverlayDensity;
  legendLabel: string;
  quickLegend: WarMapOverlayRailQuickLegend;
  onOpenFullLegend: () => void;
  t: WarMapTranslateFn;
}) {
  const { items, activeKey, highlightedKey, onItemHover, onItemFocus } =
    quickLegend;
  const {
    visibleItems: visibleQuickLegendItems,
    hiddenCount: hiddenQuickLegendCount,
  } = selectVisibleQuickLegendItems({
    density,
    items,
  });

  return (
    <div
      className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto w-full px-3 py-2.5`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Typography.Text className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
            {legendLabel}
          </Typography.Text>
          <Typography.Text className="mt-0.5 block text-[11px] leading-4 text-slate-600 dark:text-slate-300">
            {t("dashboard.charts.warMap.legend.quickLegendCompactHint")}
          </Typography.Text>
        </div>
        <Tooltip title={t("dashboard.charts.warMap.overlay.openFullLegend")}>
          <Button
            size="small"
            type="default"
            className={resolveOverlayButtonClassName({
              tone: "ghost",
              iconOnly: true,
              extraClassName:
                "!h-8 !min-w-8 !rounded-full !border !border-slate-200/80 !bg-white/[0.76] dark:!border-slate-700/80 dark:!bg-slate-950/[0.68]",
            })}
            aria-label={legendLabel}
            icon={<InfoCircleOutlined />}
            onClick={onOpenFullLegend}
          />
        </Tooltip>
      </div>
      <div className="mt-2.5 grid gap-2">
        {visibleQuickLegendItems.map(({ key, ...item }) => (
          <WarMapLegendSwatch
            key={key}
            {...item}
            size={22}
            variant="quick"
            interactive
            active={activeKey === key}
            muted={Boolean(highlightedKey) && highlightedKey !== key}
            onClick={() => onItemFocus?.(activeKey === key ? null : key)}
            onMouseEnter={() => onItemHover?.(key)}
            onMouseLeave={() => onItemHover?.(null)}
          />
        ))}
        {hiddenQuickLegendCount > 0 ? (
          <Button
            type="default"
            className={resolveOverlayButtonClassName({
              tone: "neutral",
              extraClassName:
                "!h-9 !justify-start !rounded-xl !px-3 !text-[11px] !font-medium",
            })}
            onClick={onOpenFullLegend}
          >
            {t("dashboard.charts.warMap.legend.moreItems", {
              count: hiddenQuickLegendCount,
            })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
