"use client";

import { ExclamationCircleOutlined } from "@ant-design/icons";
import { DatePicker, Segmented, Space, Tag, Tooltip, Typography } from "antd";
import type { SegmentedValue } from "antd/es/segmented";
import type { Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";

import { toDashboardZonedTime } from "@/lib/dashboard-time";
import {
  compareGranularity,
  formatGranularityLabel,
  resolveDefaultGranularityForRangePreset,
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
   * When provided, the UI will display the observed aggregation bucket size (as reported by the
   * backend) and warn when it differs from the suggested/default granularity.
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
  const defaultGranularity = resolveDefaultGranularityForRangePreset(range, start, end);
  const defaultGranularityLabel = formatGranularityLabel(defaultGranularity);
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
    ? formatGranularityLabel(resolvedAppliedGranularity)
    : null;

  const appliedGranularityDisplayLabel = hasMixedGranularity
    ? `${t("dashboard.timeRange.mixed", { defaultValue: "Mixed" })} (${formatGranularityLabel(
        mixedFinest!,
      )}-${formatGranularityLabel(mixedCoarsest!)})`
    : appliedGranularityLabel;

  const granularityCompareTarget = hasMixedGranularity ? mixedCoarsest! : resolvedAppliedGranularity;
  const granularityCompare = granularityCompareTarget
    ? compareGranularity(granularityCompareTarget, defaultGranularity)
    : "unknown";
  const granularityColor =
    granularityCompareTarget && granularityCompare !== "unknown"
      ? granularityCompare === "match"
        ? "geekblue"
        : granularityCompare === "coarser"
          ? "orange"
          : "cyan"
      : "geekblue";

  const aggregationLabel = resolvedAppliedGranularity
    ? t("dashboard.timeRange.aggregation", { defaultValue: "Aggregation" })
    : t("dashboard.timeRange.defaultAggregation", { defaultValue: "Suggested aggregation" });

  const aggregationText = resolvedAppliedGranularity
    ? granularityCompare === "match" || defaultGranularity === UiTimeGranularity.Unknown
      ? `${aggregationLabel}: ${appliedGranularityDisplayLabel}`
      : `${aggregationLabel}: ${appliedGranularityDisplayLabel} (${t("dashboard.timeRange.defaultAggregationSuffix", { defaultValue: "suggested" })} ${defaultGranularityLabel})`
    : `${aggregationLabel}: ${defaultGranularityLabel}`;

  const hasMismatch =
    Boolean(resolvedAppliedGranularity) &&
    granularityCompare === "coarser" &&
    defaultGranularity !== UiTimeGranularity.Unknown;

  const aggregationHint = resolvedAppliedGranularity
    ? hasMismatch
      ? t("dashboard.timeRange.aggregationMismatchHint", {
          defaultValue:
            "Suggested granularity is {{suggested}} but backend applied {{observed}}. Use the applied bucket size when interpreting trends.",
          suggested: defaultGranularityLabel,
          observed: appliedGranularityDisplayLabel ?? ""
        })
      : t("dashboard.timeRange.aggregationHint", {
          defaultValue:
            "Aggregation is reported by the backend and may differ from the suggested granularity."
        })
    : t("dashboard.timeRange.defaultAggregationHint", {
        defaultValue:
          "Suggested granularity is derived from the selected window; actual buckets may differ depending on data availability."
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
          <Tag color={granularityColor} className="text-xs">
            {hasMismatch ? (
              <ExclamationCircleOutlined style={{ marginRight: 6 }} aria-hidden />
            ) : null}
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
