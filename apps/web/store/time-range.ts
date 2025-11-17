import { create } from "zustand";

export type DashboardRangePreset = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "3Y" | "custom";

export interface DashboardRangeState {
  range: DashboardRangePreset;
  start: Date;
  end: Date;
  setRange: (range: DashboardRangePreset) => void;
  setRangeByDates: (start: Date, end: Date) => void;
  setCustomRange: (start: Date, end: Date) => void;
}

const now = () => new Date();

const calculateRange = (preset: DashboardRangePreset) => {
  const end = now();
  const start = new Date(end);
  switch (preset) {
    case "1D":
      start.setDate(end.getDate() - 1);
      break;
    case "1W":
      start.setDate(end.getDate() - 7);
      break;
    case "1M":
      start.setMonth(end.getMonth() - 1);
      break;
    case "3M":
      start.setMonth(end.getMonth() - 3);
      break;
    case "6M":
      start.setMonth(end.getMonth() - 6);
      break;
    case "1Y":
      start.setFullYear(end.getFullYear() - 1);
      break;
    case "3Y":
      start.setFullYear(end.getFullYear() - 3);
      break;
    default:
      start.setMonth(end.getMonth() - 1);
  }
  return { start, end };
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
