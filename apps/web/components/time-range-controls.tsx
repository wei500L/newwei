"use client";

import { DatePicker, Segmented, Space, Tag, Tooltip, Typography } from "antd";
import type { SegmentedValue } from "antd/es/segmented";
import type { Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";

import { toDashboardZonedTime } from "@/lib/dashboard-time";
import {
  formatGranularityLabel,
  resolveDefaultGranularityForRangePreset,
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

export function TimeRangeControls() {
  const { t } = useTranslation();
  const { range, start, end, setRange, setCustomRange } = useDashboardRangeStore();
  const defaultGranularity = resolveDefaultGranularityForRangePreset(range, start, end);
  const defaultGranularityLabel = formatGranularityLabel(defaultGranularity);
  const defaultGranularityHint =
    t("dashboard.timeRange.defaultAggregationHint", {
      defaultValue:
        "Most charts will aggregate data at this granularity for the selected window; individual charts may differ."
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
        <Tooltip title={defaultGranularityHint}>
          <Tag color="geekblue" className="text-xs">
            {t("dashboard.timeRange.defaultAggregation", { defaultValue: "Default aggregation" })}:{" "}
            {defaultGranularityLabel}
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
