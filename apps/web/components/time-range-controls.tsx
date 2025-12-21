"use client";

import { DatePicker, Segmented, Space } from "antd";
import type { SegmentedValue } from "antd/es/segmented";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

import type { DashboardRangePreset } from "@/store/time-range";
import { useDashboardRangeStore } from "@/store/time-range";


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
  const { range, start, end, setRange, setCustomRange } = useDashboardRangeStore();

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
    <Space direction="horizontal" size="middle" style={{ width: "100%", justifyContent: "space-between" }}>
      <Segmented
        options={presets}
        value={range !== "custom" ? range : undefined}
        onChange={handlePresetChange}
        size="middle"
      />
      <DatePicker.RangePicker
        value={[dayjs(start), dayjs(end)]}
        allowEmpty={[false, false]}
        onChange={handleCustomChange}
      />
    </Space>
  );
}
