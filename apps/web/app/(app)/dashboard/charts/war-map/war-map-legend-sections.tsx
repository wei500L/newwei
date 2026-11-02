"use client";

import {
  DownOutlined,
  PushpinOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Tooltip, Typography } from "antd";
import { useEffect, useId, useState } from "react";

import type { WarMapLegendInteractionProps } from "./war-map-controls-types";
import { WarMapLegendSwatch } from "./war-map-legend-swatch";
import {
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import type {
  WarMapLegendItem,
  WarMapLegendSection,
  WarMapLegendStatusTone,
} from "./war-map-symbols";

/**
 * Legend 展示区块（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * items 网格、可折叠 section 卡与交互状态条；hover 预览 / click 聚焦
 * 的交互契约由 WarMapLegendInteractionProps 统一表达。
 */

export function resolveLegendSectionStatusClasses(
  tone: WarMapLegendStatusTone | undefined,
): string {
  switch (tone) {
    case "critical":
      return "border-rose-200/90 bg-rose-50 text-rose-700 dark:border-rose-400/35 dark:bg-rose-400/12 dark:text-rose-200";
    case "warning":
      return "border-amber-200/90 bg-amber-50 text-amber-700 dark:border-amber-400/35 dark:bg-amber-400/12 dark:text-amber-200";
    case "info":
    default:
      return "border-cyan-200/90 bg-cyan-50 text-cyan-700 dark:border-cyan-400/35 dark:bg-cyan-400/12 dark:text-cyan-200";
  }
}

export function LegendItemsGrid({
  items,
  compact = false,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: {
  items: WarMapLegendItem[];
  compact?: boolean;
  t: WarMapTranslateFn;
} & WarMapLegendInteractionProps) {
  if (items.length === 0) {
    return null;
  }

  const gridClassName = compact ? "mt-2.5 grid gap-2" : "mt-3 grid gap-2.5";

  return (
    <div className={gridClassName}>
      {items.map(({ key, ...item }) => (
        <WarMapLegendSwatch
          key={key}
          size={compact ? 22 : 24}
          variant={compact ? "quick" : "panel"}
          interactive={Boolean(onLegendItemHover || onLegendItemFocus)}
          active={activeLegendKey === key}
          muted={Boolean(highlightedLegendKey) && highlightedLegendKey !== key}
          onClick={
            onLegendItemFocus
              ? () => onLegendItemFocus(activeLegendKey === key ? null : key)
              : undefined
          }
          onMouseEnter={
            onLegendItemHover ? () => onLegendItemHover(key) : undefined
          }
          onMouseLeave={
            onLegendItemHover ? () => onLegendItemHover(null) : undefined
          }
          endAdornment={
            activeLegendKey === key ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-surface px-2 py-1 text-xs font-medium text-muted-foreground">
                <PushpinOutlined />
                {compact
                  ? null
                  : t("dashboard.charts.warMap.legend.focusBadge")}
              </span>
            ) : null
          }
          {...item}
        />
      ))}
    </div>
  );
}

export function LegendSectionCard({
  section,
  expanded,
  contentId,
  activeLegendKey,
  highlightedLegendKey,
  onToggle,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: {
  section: WarMapLegendSection;
  expanded: boolean;
  contentId: string;
  onToggle: () => void;
  t: WarMapTranslateFn;
} & WarMapLegendInteractionProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-surface px-3.5 py-3 shadow-[var(--shadow-surface)]">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Typography.Text
              strong
              className={OVERLAY_SECTION_TITLE_CLASS_NAME}
            >
              {section.title}
            </Typography.Text>
            {section.statusLabel ? (
              <Tooltip title={section.statusHint}>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold leading-none ${resolveLegendSectionStatusClasses(
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
              className="mt-1 block text-xs leading-[1.15rem]"
            >
              {section.description}
            </Typography.Text>
          ) : null}
        </div>
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-surface text-xs text-muted-foreground">
          {expanded ? <DownOutlined /> : <RightOutlined />}
        </span>
      </button>
      {expanded ? (
        <div id={contentId}>
          <LegendItemsGrid
            items={section.items}
            activeLegendKey={activeLegendKey}
            highlightedLegendKey={highlightedLegendKey}
            onLegendItemHover={onLegendItemHover}
            onLegendItemFocus={onLegendItemFocus}
            t={t}
          />
        </div>
      ) : null}
    </div>
  );
}

export function LegendInteractionStrip({
  items,
  t,
}: {
  items: WarMapLegendItem[];
  t: WarMapTranslateFn;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-surface px-3 py-2.5 shadow-[var(--shadow-surface)]">
      <div className="min-w-0">
        <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
          {t("dashboard.charts.warMap.legend.interactionTitle")}
        </Typography.Text>
        <Typography.Text
          type="secondary"
          className="mt-0.5 block text-xs leading-[1rem]"
        >
          {t("dashboard.charts.warMap.legend.quickLegendHint")}
        </Typography.Text>
      </div>
      <div className="mt-2.5 grid gap-1.5 sm:grid-cols-3">
        {items.map(({ key, ...item }) => (
          <WarMapLegendSwatch key={key} size={22} variant="quick" {...item} />
        ))}
      </div>
    </div>
  );
}

export function LegendSectionsList({
  legendSections,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: {
  legendSections: WarMapLegendSection[];
  t: WarMapTranslateFn;
} & WarMapLegendInteractionProps) {
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >(() =>
    Object.fromEntries(
      legendSections.map((section) => [
        section.key,
        section.defaultExpanded !== false,
      ]),
    ),
  );
  const sectionIdPrefix = useId();

  useEffect(() => {
    setExpandedSections((current) =>
      Object.fromEntries(
        legendSections.map((section) => [
          section.key,
          current[section.key] ?? section.defaultExpanded !== false,
        ]),
      ),
    );
  }, [legendSections]);

  return (
    <div className="flex w-full flex-col gap-2.5">
      {legendSections.map((section) => (
        <LegendSectionCard
          key={section.key}
          section={section}
          expanded={
            expandedSections[section.key] ?? section.defaultExpanded !== false
          }
          contentId={`${sectionIdPrefix}-${section.key}`}
          activeLegendKey={activeLegendKey}
          highlightedLegendKey={highlightedLegendKey}
          onToggle={() =>
            setExpandedSections((current) => ({
              ...current,
              [section.key]: !current[section.key],
            }))
          }
          onLegendItemHover={onLegendItemHover}
          onLegendItemFocus={onLegendItemFocus}
          t={t}
        />
      ))}
    </div>
  );
}
