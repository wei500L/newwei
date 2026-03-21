import { create } from "zustand";

import { dashboardNow } from "@/lib/dashboard-time";
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

const now = () => dashboardNow();
const DEFAULT_RANGE: DashboardRangePreset = "1M";
const DASHBOARD_RANGE_SESSION_KEY = "dashboard-range-session:v1";
// Keep the current preset/custom window stable across short reload/new-document
// hops without turning the dashboard into a long-lived frozen window.
const DASHBOARD_RANGE_SESSION_TTL_MS = 1000 * 60 * 2;
const RANGE_PRESETS: DashboardRangePreset[] = [
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "1Y",
  "3Y",
  "custom",
];
const RANGE_PRESET_SET = new Set<DashboardRangePreset>(RANGE_PRESETS);

interface DashboardRangeSnapshot {
  range: DashboardRangePreset;
  start: string;
  end: string;
  savedAt: number;
}

interface DashboardRangeUrlState {
  range: DashboardRangePreset | null;
  start: Date | null;
  end: Date | null;
}

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

const normalizeRange = (value: string | null): DashboardRangePreset | null => {
  if (!value) return null;
  return RANGE_PRESET_SET.has(value as DashboardRangePreset)
    ? (value as DashboardRangePreset)
    : null;
};

const parseDashboardDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.toDate() : null;
};

const isValidRangeWindow = (start: Date, end: Date) =>
  Number.isFinite(start.getTime()) &&
  Number.isFinite(end.getTime()) &&
  start.getTime() <= end.getTime();

const readDashboardRangeSnapshot = (): DashboardRangeSnapshot | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(DASHBOARD_RANGE_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DashboardRangeSnapshot>;
    const range = normalizeRange(
      typeof parsed.range === "string" ? parsed.range : null,
    );
    const start = parseDashboardDate(
      typeof parsed.start === "string" ? parsed.start : null,
    );
    const end = parseDashboardDate(
      typeof parsed.end === "string" ? parsed.end : null,
    );
    const savedAt =
      typeof parsed.savedAt === "number" ? parsed.savedAt : Number.NaN;

    if (
      !range ||
      !start ||
      !end ||
      !Number.isFinite(savedAt) ||
      Date.now() - savedAt > DASHBOARD_RANGE_SESSION_TTL_MS ||
      !isValidRangeWindow(start, end)
    ) {
      window.sessionStorage.removeItem(DASHBOARD_RANGE_SESSION_KEY);
      return null;
    }

    return {
      range,
      start: start.toISOString(),
      end: end.toISOString(),
      savedAt,
    };
  } catch {
    return null;
  }
};

const persistDashboardRangeSnapshot = (state: {
  range: DashboardRangePreset;
  start: Date;
  end: Date;
}) => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      DASHBOARD_RANGE_SESSION_KEY,
      JSON.stringify({
        range: state.range,
        start: state.start.toISOString(),
        end: state.end.toISOString(),
        savedAt: Date.now(),
      } satisfies DashboardRangeSnapshot),
    );
  } catch {
    // Ignore sessionStorage failures in private mode or quota pressure.
  }
};

const readDashboardRangeUrlState = (): DashboardRangeUrlState => {
  if (typeof window === "undefined") {
    return {
      range: null,
      start: null,
      end: null,
    };
  }

  const params = new URLSearchParams(window.location.search);
  return {
    range: normalizeRange(params.get("range")),
    start: parseDashboardDate(params.get("start")),
    end: parseDashboardDate(params.get("end")),
  };
};

const getInitialDashboardRange = () => {
  const urlState = readDashboardRangeUrlState();
  if (
    urlState.start &&
    urlState.end &&
    isValidRangeWindow(urlState.start, urlState.end)
  ) {
    const nextState = {
      range: "custom" as const,
      start: urlState.start,
      end: urlState.end,
    };
    persistDashboardRangeSnapshot(nextState);
    return nextState;
  }

  const storedSnapshot = readDashboardRangeSnapshot();
  if (
    urlState.range &&
    urlState.range !== "custom" &&
    storedSnapshot?.range === urlState.range
  ) {
    return {
      range: storedSnapshot.range,
      start: new Date(storedSnapshot.start),
      end: new Date(storedSnapshot.end),
    };
  }

  if (urlState.range && urlState.range !== "custom") {
    const nextState = {
      range: urlState.range,
      ...calculateRange(urlState.range),
    };
    persistDashboardRangeSnapshot(nextState);
    return nextState;
  }

  if (storedSnapshot) {
    return {
      range: storedSnapshot.range,
      start: new Date(storedSnapshot.start),
      end: new Date(storedSnapshot.end),
    };
  }

  const fallback = {
    range: DEFAULT_RANGE,
    ...calculateRange(DEFAULT_RANGE),
  };
  persistDashboardRangeSnapshot(fallback);
  return fallback;
};

export const useDashboardRangeStore = create<DashboardRangeState>((set) => ({
  ...getInitialDashboardRange(),
  setRange: (preset) => {
    if (preset === "custom") {
      return;
    }
    const nextState = { range: preset, ...calculateRange(preset) };
    persistDashboardRangeSnapshot(nextState);
    set(nextState);
  },
  setRangeByDates: (start, end) => {
    const nextState = { range: "custom" as const, start, end };
    persistDashboardRangeSnapshot(nextState);
    set(nextState);
  },
  setCustomRange: (start, end) => {
    const nextState = { range: "custom" as const, start, end };
    persistDashboardRangeSnapshot(nextState);
    set(nextState);
  }
}));
