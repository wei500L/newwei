import dayjs from "@/lib/dayjs";
import type { DashboardRangePreset } from "@/store/time-range";

export enum UiTimeGranularity {
  Realtime = "realtime",
  Minute = "minute",
  Hour = "hour",
  Day = "day",
  Week = "week",
  Month = "month",
  Quarter = "quarter",
  Year = "year",
  Window = "window",
  Unknown = "unknown",
}

const GRANULARITY_RANK: Record<UiTimeGranularity, number> = {
  [UiTimeGranularity.Realtime]: 0,
  [UiTimeGranularity.Minute]: 1,
  [UiTimeGranularity.Hour]: 2,
  [UiTimeGranularity.Day]: 3,
  [UiTimeGranularity.Week]: 4,
  [UiTimeGranularity.Month]: 5,
  [UiTimeGranularity.Quarter]: 6,
  [UiTimeGranularity.Year]: 7,
  [UiTimeGranularity.Window]: 98,
  [UiTimeGranularity.Unknown]: 99,
};

export type GranularityComparison = "match" | "finer" | "coarser" | "unknown";

export const compareGranularity = (
  actual: UiTimeGranularity,
  expected: UiTimeGranularity,
): GranularityComparison => {
  if (actual === UiTimeGranularity.Unknown || expected === UiTimeGranularity.Unknown) {
    return "unknown";
  }
  const actualRank = GRANULARITY_RANK[actual] ?? 99;
  const expectedRank = GRANULARITY_RANK[expected] ?? 99;
  if (actualRank === expectedRank) return "match";
  return actualRank < expectedRank ? "finer" : "coarser";
};

const isConcreteGranularity = (
  value: UiTimeGranularity | null | undefined,
): value is UiTimeGranularity =>
  Boolean(value) && value !== UiTimeGranularity.Unknown && value !== UiTimeGranularity.Window;

export const pickCoarsestGranularity = (
  granularities: Array<UiTimeGranularity | null | undefined>,
): UiTimeGranularity => {
  const candidates = granularities.filter(isConcreteGranularity);
  if (candidates.length === 0) return UiTimeGranularity.Unknown;
  return candidates.reduce((coarsest, next) => {
    const currentRank = GRANULARITY_RANK[coarsest] ?? 99;
    const nextRank = GRANULARITY_RANK[next] ?? 99;
    return nextRank > currentRank ? next : coarsest;
  }, candidates[0]!);
};

export const pickFinestGranularity = (
  granularities: Array<UiTimeGranularity | null | undefined>,
): UiTimeGranularity => {
  const candidates = granularities.filter(isConcreteGranularity);
  if (candidates.length === 0) return UiTimeGranularity.Unknown;
  return candidates.reduce((finest, next) => {
    const currentRank = GRANULARITY_RANK[finest] ?? 99;
    const nextRank = GRANULARITY_RANK[next] ?? 99;
    return nextRank < currentRank ? next : finest;
  }, candidates[0]!);
};

export const formatGranularityLabel = (granularity: UiTimeGranularity): string => {
  switch (granularity) {
    case UiTimeGranularity.Realtime:
      return "Real-time";
    case UiTimeGranularity.Minute:
      return "Minute";
    case UiTimeGranularity.Hour:
      return "Hourly";
    case UiTimeGranularity.Day:
      return "Daily";
    case UiTimeGranularity.Week:
      return "Weekly";
    case UiTimeGranularity.Month:
      return "Monthly";
    case UiTimeGranularity.Quarter:
      return "Quarterly";
    case UiTimeGranularity.Year:
      return "Yearly";
    case UiTimeGranularity.Window:
      return "Window";
    default:
      return "Unknown";
  }
};

export const resolveDefaultGranularityForRangePreset = (
  preset: DashboardRangePreset,
  start: Date,
  end: Date,
): UiTimeGranularity => {
  if (preset !== "custom") {
    switch (preset) {
      case "1D":
        return UiTimeGranularity.Day;
      case "1W":
        return UiTimeGranularity.Day;
      case "1M":
        return UiTimeGranularity.Day;
      case "3M":
        return UiTimeGranularity.Week;
      case "6M":
        return UiTimeGranularity.Month;
      case "1Y":
        return UiTimeGranularity.Month;
      case "3Y":
        return UiTimeGranularity.Quarter;
      default:
        return UiTimeGranularity.Day;
    }
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs));
  if (diffDays > 1095) return UiTimeGranularity.Year;
  if (diffDays > 365) return UiTimeGranularity.Quarter;
  if (diffDays > 120) return UiTimeGranularity.Month;
  if (diffDays > 45) return UiTimeGranularity.Week;
  return UiTimeGranularity.Day;
};

export interface ParsedInterval {
  count: number;
  unit: "minute" | "hour" | "day" | "week" | "month" | "year";
}

const parseUnit = (rawUnit: string): ParsedInterval["unit"] | null => {
  const normalized = rawUnit.toLowerCase();
  if (["mo", "mon", "month", "months"].includes(normalized)) return "month";
  if (["wk", "w", "week", "weeks"].includes(normalized)) return "week";
  if (["d", "day", "days"].includes(normalized)) return "day";
  if (["h", "hr", "hour", "hours"].includes(normalized)) return "hour";
  if (["min", "mins", "minute", "minutes"].includes(normalized)) return "minute";
  if (["m"].includes(normalized)) return "minute";
  if (["y", "yr", "year", "years"].includes(normalized)) return "year";
  return null;
};

export const parseInterval = (interval: string | null | undefined): ParsedInterval | null => {
  if (!interval) return null;
  const raw = interval.trim();
  if (!raw) return null;

  const match = raw.match(/^(\d+)\s*([a-zA-Z]+)$/);
  if (!match) {
    const normalized = raw.toLowerCase();
    if (normalized === "day" || normalized === "daily") {
      return { count: 1, unit: "day" };
    }
    if (normalized === "week" || normalized === "weekly") {
      return { count: 1, unit: "week" };
    }
    if (normalized === "month" || normalized === "monthly") {
      return { count: 1, unit: "month" };
    }
    if (normalized === "year" || normalized === "yearly") {
      return { count: 1, unit: "year" };
    }
    if (normalized === "hour" || normalized === "hourly") {
      return { count: 1, unit: "hour" };
    }
    return null;
  }

  const count = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = parseUnit(match[2] ?? "");
  if (!unit) return null;
  return { count, unit };
};

export const intervalToGranularity = (interval: ParsedInterval | null): UiTimeGranularity => {
  if (!interval) return UiTimeGranularity.Unknown;
  if (interval.unit === "minute") return UiTimeGranularity.Minute;
  if (interval.unit === "hour") return UiTimeGranularity.Hour;
  if (interval.unit === "day") return UiTimeGranularity.Day;
  if (interval.unit === "week") return UiTimeGranularity.Week;
  if (interval.unit === "year") return UiTimeGranularity.Year;
  if (interval.unit === "month") {
    if (interval.count === 3) return UiTimeGranularity.Quarter;
    if (interval.count >= 12) return UiTimeGranularity.Year;
    return UiTimeGranularity.Month;
  }
  return UiTimeGranularity.Unknown;
};

export const timeGranularityToUiGranularity = (
  granularity: string | null | undefined,
): UiTimeGranularity => {
  if (!granularity) return UiTimeGranularity.Unknown;
  const normalized = granularity.trim().toLowerCase();
  switch (normalized) {
    case "realtime":
      return UiTimeGranularity.Realtime;
    case "minute":
      return UiTimeGranularity.Minute;
    case "hour":
      return UiTimeGranularity.Hour;
    case "day":
      return UiTimeGranularity.Day;
    case "week":
      return UiTimeGranularity.Week;
    case "month":
      return UiTimeGranularity.Month;
    case "quarter":
      return UiTimeGranularity.Quarter;
    case "year":
      return UiTimeGranularity.Year;
    default:
      return UiTimeGranularity.Unknown;
  }
};

export const uiGranularityToInterval = (granularity: UiTimeGranularity): ParsedInterval | null => {
  switch (granularity) {
    case UiTimeGranularity.Minute:
      return { count: 1, unit: "minute" };
    case UiTimeGranularity.Hour:
      return { count: 1, unit: "hour" };
    case UiTimeGranularity.Day:
      return { count: 1, unit: "day" };
    case UiTimeGranularity.Week:
      return { count: 1, unit: "week" };
    case UiTimeGranularity.Month:
      return { count: 1, unit: "month" };
    case UiTimeGranularity.Quarter:
      return { count: 3, unit: "month" };
    case UiTimeGranularity.Year:
      return { count: 1, unit: "year" };
    default:
      return null;
  }
};

export const addInterval = (startIso: string, interval: ParsedInterval | null): string | null => {
  if (!interval) return null;
  const base = dayjs(startIso);
  if (!base.isValid()) return null;
  return base.add(interval.count, interval.unit).toISOString();
};

const median = (values: number[]): number | null => {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (typeof a !== "number" || typeof b !== "number") return null;
  return (a + b) / 2;
};

export const inferGranularityFromTimestampsMs = (timestampsMs: number[]): UiTimeGranularity => {
  const sorted = [...timestampsMs].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length < 2) return UiTimeGranularity.Unknown;
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (typeof prev !== "number" || typeof next !== "number") continue;
    const diff = next - prev;
    if (diff > 0) diffs.push(diff);
  }
  const diff = median(diffs);
  if (!diff) return UiTimeGranularity.Unknown;

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff <= 5 * minute) return UiTimeGranularity.Minute;
  if (diff <= 3 * hour) return UiTimeGranularity.Hour;
  if (diff <= 2 * day) return UiTimeGranularity.Day;
  if (diff <= 10 * day) return UiTimeGranularity.Week;
  if (diff <= 45 * day) return UiTimeGranularity.Month;
  if (diff <= 120 * day) return UiTimeGranularity.Quarter;
  return UiTimeGranularity.Year;
};

export const resolveActiveGranularityFromTimestampsMs = (
  fallback: UiTimeGranularity,
  timestampsMs: number[],
): UiTimeGranularity => {
  const inferred = inferGranularityFromTimestampsMs(timestampsMs);
  return inferred === UiTimeGranularity.Unknown ? fallback : inferred;
};
