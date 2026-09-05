"use client";

import { Tag, Tooltip, Typography } from "antd";

import {
  OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME,
} from "./war-map-controls-primitives";
import type {
  WarMapDetailedChainStatus,
  WarMapFeedSummaryCard,
  WarMapLayoutVariant,
} from "./war-map-overlay-model";
import { OVERLAY_STATUS_TAG_CLASS_NAME } from "./war-map-overlay-model";

/**
 * Feeds 节（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * feed 三卡与链路状态 Tag。
 */
export function FeedsSection({
  feedSummaryCards,
  detailedChainStatuses,
  layoutVariant,
}: {
  feedSummaryCards: WarMapFeedSummaryCard[];
  detailedChainStatuses: WarMapDetailedChainStatus[];
  layoutVariant?: WarMapLayoutVariant;
}) {
  const standaloneLayout = layoutVariant === "standalone";

  return (
    <div
      className={
        standaloneLayout
          ? "flex w-full flex-col gap-4"
          : "flex w-full flex-col gap-3"
      }
    >
      <div className="grid grid-cols-3 gap-3">
        {feedSummaryCards.map((card) => (
          <div
            key={card.key}
            className={OVERLAY_PANEL_SUBTLE_SECTION_CLASS_NAME}
          >
            <Typography.Text
              className={`block text-lg font-semibold ${card.toneClassName}`}
            >
              {card.value}
            </Typography.Text>
            <Typography.Text type="secondary" className="text-[11px]">
              {card.label}
            </Typography.Text>
          </div>
        ))}
      </div>
      {detailedChainStatuses.map((status) => (
        <Tooltip
          key={status.key}
          title={<span className="whitespace-pre-line">{status.tooltip}</span>}
        >
          <div className="rounded-xl border border-[var(--border)] bg-slate-50/90 px-3 py-2.5 dark:bg-slate-900/76">
            <Tag color={status.color} className={OVERLAY_STATUS_TAG_CLASS_NAME}>
              {status.text}
            </Tag>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}
