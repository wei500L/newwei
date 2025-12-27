import { create } from "zustand";

import dayjs from "@/lib/dayjs";

export type DashboardRangePreset = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "3Y" | "custom";

export interface DashboardRangeState {
  range: DashboardRangePreset;
  start: Date;
  end: Date;
  setRange: (range: DashboardRangePreset) => void;
  setRangeByDates: (start: Date, end: Date) => void;
  setCustomRange: (start: Date, end: Date) => void;
}

const now = () => dayjs();

const calculateRange = (preset: DashboardRangePreset) => {
  const end = now();
  let start = end;
  switch (preset) {
    case "1D":
      start = end.subtract(1, "day");
      break;
    case "1W":
      start = end.subtract(7, "day");
      break;
    case "1M":
      start = end.subtract(1, "month");
      break;
    case "3M":
      start = end.subtract(3, "month");
      break;
    case "6M":
      start = end.subtract(6, "month");
      break;
    case "1Y":
      start = end.subtract(1, "year");
      break;
    case "3Y":
      start = end.subtract(3, "year");
      break;
    default:
      start = end.subtract(1, "month");
  }
  return { start: start.toDate(), end: end.toDate() };
};

export const useDashboardRangeStore = create<DashboardRangeState>((set) => ({
  range: "1M",
  ...calculateRange("1M"),
  setRange: (preset) => {
    if (preset === "custom") {
      return;
    }
    set({ range: preset, ...calculateRange(preset) });
  },
  setRangeByDates: (start, end) => set({ range: "custom", start, end }),
  setCustomRange: (start, end) => {
    set({ range: "custom", start, end });
  }
}));
