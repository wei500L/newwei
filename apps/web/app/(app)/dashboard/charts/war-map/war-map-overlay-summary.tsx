"use client";

import { Tag, Tooltip, Typography } from "antd";

import {
  OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
} from "./war-map-overlay-model";
import type { WarMapSummaryStatusCard } from "./war-map-overlay-model";

/**
 * Overlay rail 状态摘要（FE-批4B：自 war-map-overlay-rail.tsx 拆出）。
 * minimal 密度降级为紧凑 Tag + data 胶囊；否则完整 stream/data 卡。
 */
export function WarMapOverlayRailSummary({
  density,
  statusCards,
  dataLabel,
}: {
  density: "expanded" | "compact" | "minimal";
  statusCards: WarMapSummaryStatusCard[];
  dataLabel: string;
}) {
  const streamStatus = statusCards.find((card) => card.key === "stream");
  const dataStatus = statusCards.find((card) => card.key === "data");

  if (density === "minimal") {
    return (
      <div
        className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex max-w-full items-center gap-2 px-3 py-2`}
      >
        {streamStatus ? (
          <Tooltip title={streamStatus.tooltip}>
            <Tag
              color={streamStatus.tagColor}
              className={OVERLAY_STATUS_TAG_CLASS_NAME}
            >
              {streamStatus.value}
            </Tag>
          </Tooltip>
        ) : null}
        {dataStatus ? (
          <Tooltip title={dataStatus.tooltip}>
            <span className="inline-flex max-w-[160px] items-center truncate rounded-full border border-[var(--border)] bg-surface px-2.5 py-1 text-xs text-muted-foreground">
              {dataLabel}
            </span>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex w-full flex-wrap items-center gap-2 px-3 py-2.5`}
    >
      {streamStatus ? (
        <Tooltip title={streamStatus.tooltip}>
          <div className="min-w-0 rounded-full border border-[var(--border)] bg-surface px-3 py-2 shadow-[var(--shadow-surface)]">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${streamStatus.dotClassName}`}
              />
              <Typography.Text
                type="secondary"
                className="text-xs uppercase tracking-[0.12em]"
              >
                {streamStatus.label}
              </Typography.Text>
              <Typography.Text className="text-[12px] font-semibold text-slate-900 dark:text-slate-50">
                {streamStatus.value}
              </Typography.Text>
              <Typography.Text
                type="secondary"
                className="max-w-[8rem] truncate text-xs"
              >
                {streamStatus.detail}
              </Typography.Text>
            </div>
          </div>
        </Tooltip>
      ) : null}
      <Tooltip title={dataStatus?.tooltip}>
        <div className="min-w-0 rounded-full border border-[var(--border)] bg-surface px-3 py-2 shadow-[var(--shadow-surface)]">
          <div className="flex items-center gap-2">
            {dataStatus ? (
              <span
                className={`h-2 w-2 rounded-full ${dataStatus.dotClassName}`}
              />
            ) : null}
            <Typography.Text
              type="secondary"
              className="text-xs uppercase tracking-[0.12em]"
            >
              {dataStatus?.label ?? "Data"}
            </Typography.Text>
            <span className="max-w-[180px] truncate text-xs text-muted-foreground">
              {dataLabel}
            </span>
          </div>
        </div>
      </Tooltip>
    </div>
  );
}
