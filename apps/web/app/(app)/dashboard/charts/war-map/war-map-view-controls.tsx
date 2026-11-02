"use client";

import {
  WAR_MAP_PRESETS,
  WAR_MAP_TIME_RANGE_PRESETS,
  type WarMapLayerId,
  type WarMapLayerVisibility,
  type WarMapPreset,
  type WarMapTimeRangePreset,
} from "@modular/utils";
import { Checkbox } from "antd";
import { useMemo } from "react";

import type { WarMapTranslateFn } from "./war-map-overlay-model";
import { toLayerLabel } from "./war-map-point-model";

const PRESET_LABELS: Record<WarMapPreset, string> = {
  global: "Global",
  america: "America",
  mena: "MENA",
  eu: "Europe",
  asia: "Asia",
  latam: "LatAm",
  africa: "Africa",
  oceania: "Oceania",
};

const TIME_RANGE_LABELS: Record<WarMapTimeRangePreset, string> = {
  "1h": "1H",
  "6h": "6H",
  "24h": "24H",
  "48h": "48H",
  "7d": "7D",
  all: "All",
};

export interface WarMapLayerVisibilityControlsProps {
  displayableLayerIds: WarMapLayerId[];
  layerVisibility: WarMapLayerVisibility;
  monitorsCount: number;
  onLayerVisible: (layerId: WarMapLayerId, visible: boolean) => void;
  t: WarMapTranslateFn;
}

/** 图层可见性 checkbox 组（Controls → View 区块，FE-批4A 迁移）。 */
export function WarMapLayerVisibilityControls({
  displayableLayerIds,
  layerVisibility,
  monitorsCount,
  onLayerVisible,
  t,
}: WarMapLayerVisibilityControlsProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {displayableLayerIds.map((layerId) => {
        const disabled = layerId === "monitors" ? monitorsCount === 0 : false;
        return (
          <Checkbox
            key={layerId}
            checked={layerVisibility[layerId]}
            disabled={disabled}
            className={`!m-0 !inline-flex !min-h-[42px] !w-full !items-center rounded-lg border !px-3 !py-2 transition ${
              disabled
                ? "border-[var(--border)] bg-surface opacity-60"
                : "border-[var(--border)] bg-surface hover:bg-[var(--secondary)]"
            }`}
            onChange={(event) => {
              onLayerVisible(layerId, event.target.checked);
            }}
          >
            <span className="text-sm font-medium leading-5 text-slate-800 dark:text-slate-100">
              {t(`dashboard.charts.warMap.layerNames.${layerId}`, {
                defaultValue: toLayerLabel(layerId),
              })}
            </span>
          </Checkbox>
        );
      })}
    </div>
  );
}

export interface UseWarMapViewOptionsParams {
  t: WarMapTranslateFn;
  activePreset: WarMapPreset;
  timeRangePreset: WarMapTimeRangePreset;
}

export interface WarMapViewOptionsResult {
  presetOptions: {
    key: WarMapPreset;
    label: string;
    active: boolean;
  }[];
  timeRangeOptions: {
    key: WarMapTimeRangePreset;
    label: string;
    active: boolean;
  }[];
}

/** preset / time range 选项（Controls → View 区块，FE-批4A 迁移）。 */
export function useWarMapViewOptions(
  params: UseWarMapViewOptionsParams,
): WarMapViewOptionsResult {
  const { t, activePreset, timeRangePreset } = params;

  const presetOptions = useMemo(
    () =>
      WAR_MAP_PRESETS.map((preset) => ({
        key: preset,
        label: t(`dashboard.charts.warMap.presets.${preset}`, {
          defaultValue: PRESET_LABELS[preset],
        }),
        active: activePreset === preset,
      })),
    [activePreset, t],
  );
  const timeRangeOptions = useMemo(
    () =>
      WAR_MAP_TIME_RANGE_PRESETS.map((preset) => ({
        key: preset,
        label: t(`dashboard.charts.warMap.timeRange.${preset}`, {
          defaultValue: TIME_RANGE_LABELS[preset],
        }),
        active: timeRangePreset === preset,
      })),
    [t, timeRangePreset],
  );

  return { presetOptions, timeRangeOptions };
}

export interface WarMapAisViewportEmptyBannerProps {
  label: string;
  hint: string;
}

/** AIS 视口空态提示条（FE-批4A：样式与文案结构不变）。 */
export function WarMapAisViewportEmptyBanner({
  label,
  hint,
}: WarMapAisViewportEmptyBannerProps) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-[min(34rem,calc(100%-2rem))] -translate-x-1/2">
      <div className="rounded-lg border border-[var(--border)] bg-surface px-4 py-3 shadow-[var(--shadow-surface)]">
        <div className="flex items-start gap-3">
          <span className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.16)] dark:bg-amber-300 dark:shadow-[0_0_0_4px_rgba(252,211,77,0.18)]" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-[-0.01em] text-slate-950 dark:text-slate-50">
              {label}
            </p>
            <p className="mt-1 text-[12px] leading-5 text-slate-700 dark:text-slate-300">
              {hint}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

