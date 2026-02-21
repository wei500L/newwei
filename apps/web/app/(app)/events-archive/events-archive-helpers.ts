import dayjs from "@/lib/dayjs";
import type { Dayjs } from "dayjs";

export interface ArchiveCalendarDayLike {
  date: string;
  count: number;
}

const DATE_PARAM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const parseDateParamUtc = (
  value: string | null,
  nowUtc = dayjs.utc(),
): string => {
  const today = nowUtc.format("YYYY-MM-DD");
  if (!value || !DATE_PARAM_PATTERN.test(value)) {
    return today;
  }

  const parsed = dayjs.utc(`${value}T00:00:00.000Z`);
  if (!parsed.isValid()) {
    return today;
  }
  if (parsed.format("YYYY-MM-DD") !== value) {
    return today;
  }
  if (parsed.isAfter(nowUtc, "day")) {
    return today;
  }
  return parsed.format("YYYY-MM-DD");
};

export const formatSelectedDateParam = (value: Dayjs) =>
  value.format("YYYY-MM-DD");

export const toAnchorIso = (date: string) => `${date}T00:00:00.000Z`;

export const buildCalendarCountMap = (
  days: ArchiveCalendarDayLike[] | null | undefined,
) => {
  const map = new Map<string, number>();
  for (const day of days ?? []) {
    map.set(day.date, day.count);
  }
  return map;
};

export const canNavigateToNextDay = (options: {
  nowUtc?: Dayjs;
  nextDateParam: string;
  currentMonthParam: string;
  currentMonthCountByDate: Map<string, number>;
  nextMonthCountByDate?: Map<string, number>;
}) => {
  const now = options.nowUtc ?? dayjs.utc();
  if (dayjs.utc(options.nextDateParam).isAfter(now, "day")) {
    return false;
  }

  const nextMonth = options.nextDateParam.slice(0, 7);
  const countMap =
    nextMonth === options.currentMonthParam
      ? options.currentMonthCountByDate
      : options.nextMonthCountByDate;
  if (!countMap) {
    return false;
  }
  return (countMap.get(options.nextDateParam) ?? 0) > 0;
};
