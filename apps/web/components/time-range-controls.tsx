"use client";

import { DatePicker, Segmented, Space, Tag, Tooltip, Typography } from "antd";
import type { SegmentedValue } from "antd/es/segmented";
import type { Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";

import { toDashboardZonedTime } from "@/lib/dashboard-time";
import {
  formatGranularityLabelLocalized,
  UiTimeGranularity,
} from "@/lib/time-granularity";
import { useDashboardRangeStore, type DashboardRangePreset } from "@/store/time-range";

const presets: { label: string; value: DashboardRangePreset }[] = [
  { label: "1D", value: "1D" },
  { label: "1W", value: "1W" },
  { label: "1M", value: "1M" },
  { label: "3M", value: "3M" },
  { label: "6M", value: "6M" },
  { label: "1Y", value: "1Y" },
  { label: "3Y", value: "3Y" }
];

export interface TimeRangeControlsProps {
  /**
   * When provided, the UI will display the aggregation bucket size as reported by the backend.
   */
  appliedGranularity?: UiTimeGranularity | null;

  /**
   * Optional bounds for backend-reported granularities when a page renders multiple series at
   * different cadences (e.g. daily + monthly). When provided and the values differ, the UI will
   * display a "Mixed" aggregation label with the finest/coarsest range.
   */
  appliedGranularityRange?: { finest: UiTimeGranularity; coarsest: UiTimeGranularity } | null;
}

export function TimeRangeControls({ appliedGranularity, appliedGranularityRange }: TimeRangeControlsProps) {
  const { t } = useTranslation();
  const { range, start, end, setRange, setCustomRange } = useDashboardRangeStore();
  const backendGranularityEnabled =
    typeof appliedGranularity !== "undefined" || typeof appliedGranularityRange !== "undefined";
  const resolvedAppliedGranularity =
    appliedGranularity && appliedGranularity !== UiTimeGranularity.Unknown
      ? appliedGranularity
      : null;

  const isConcreteGranularity = (value: UiTimeGranularity | null | undefined) =>
    Boolean(value) && value !== UiTimeGranularity.Unknown && value !== UiTimeGranularity.Window;

  const mixedFinest = appliedGranularityRange?.finest;
  const mixedCoarsest = appliedGranularityRange?.coarsest;
  const hasMixedGranularity =
    isConcreteGranularity(mixedFinest) &&
    isConcreteGranularity(mixedCoarsest) &&
    mixedFinest !== mixedCoarsest;

  const appliedGranularityLabel = resolvedAppliedGranularity
    ? formatGranularityLabelLocalized(resolvedAppliedGranularity, t)
    : null;

  const appliedGranularityDisplayLabel = hasMixedGranularity
    ? `${t("dashboard.timeRange.mixed", { defaultValue: "Mixed" })} (${formatGranularityLabelLocalized(
        mixedFinest!,
        t,
      )}-${formatGranularityLabelLocalized(mixedCoarsest!, t)})`
    : appliedGranularityLabel;

  const aggregationLabel = t("dashboard.timeRange.aggregation", { defaultValue: "Aggregation" });
  const aggregationColor =
    resolvedAppliedGranularity || hasMixedGranularity
      ? "geekblue"
      : backendGranularityEnabled
        ? "processing"
        : "default";
  const aggregationText =
    resolvedAppliedGranularity || hasMixedGranularity
      ? `${aggregationLabel}: ${appliedGranularityDisplayLabel}`
      : backendGranularityEnabled
        ? `${aggregationLabel}: ${t("common.loading", { defaultValue: "Loading..." })}`
        : `${aggregationLabel}: ${t("common.notAvailable", { defaultValue: "Not available" })}`;

  const aggregationHint = backendGranularityEnabled
    ? resolvedAppliedGranularity || hasMixedGranularity
      ? t("dashboard.timeRange.aggregationHintBackend", {
          defaultValue: "Aggregation is reported by the backend."
        })
      : t("dashboard.timeRange.aggregationHintPending", {
          defaultValue: "Waiting for backend to report aggregation granularity."
        })
    : t("dashboard.timeRange.aggregationHintUnavailable", {
        defaultValue: "This view does not report aggregation granularity."
      });

  const handlePresetChange = (value: SegmentedValue) => {
    setRange(value as DashboardRangePreset);
  };

  const handleCustomChange = (values: [Dayjs | null, Dayjs | null] | null) => {
    if (!values) {
      return;
    }
    const [startValue, endValue] = values;
    if (startValue && endValue) {
      setCustomRange(startValue.toDate(), endValue.toDate());
    }
  };

  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      <Space
        direction="horizontal"
        size="middle"
        style={{ width: "100%", justifyContent: "space-between" }}
      >
        <Segmented
          options={presets}
          value={range !== "custom" ? range : undefined}
          onChange={handlePresetChange}
          size="middle"
        />
        <DatePicker.RangePicker
          id={{ start: "dashboard-range-start", end: "dashboard-range-end" }}
          value={[toDashboardZonedTime(start), toDashboardZonedTime(end)]}
          allowEmpty={[false, false]}
          onChange={handleCustomChange}
        />
      </Space>

      <Space size={8} wrap align="center">
        <Tooltip title={aggregationHint}>
          <Tag color={aggregationColor} className="text-xs">
            {aggregationText}
          </Tag>
        </Tooltip>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t("dashboard.timeRange.helperText", {
            defaultValue: "Time range affects chart granularity and tooltips."
          })}
        </Typography.Text>
      </Space>
    </Space>
  );
}
