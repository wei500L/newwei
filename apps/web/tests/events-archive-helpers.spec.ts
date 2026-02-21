import { describe, expect, it } from "vitest";

import dayjs from "@/lib/dayjs";
import {
  buildCalendarCountMap,
  canNavigateToNextDay,
  formatSelectedDateParam,
  parseDateParamUtc,
  toAnchorIso,
} from "../app/(app)/events-archive/events-archive-helpers";

describe("events archive date helpers", () => {
  it("parses valid UTC date parameters", () => {
    const parsed = parseDateParamUtc(
      "2025-05-28",
      dayjs.utc("2025-06-01T00:00:00.000Z"),
    );
    expect(parsed).toBe("2025-05-28");
  });

  it("falls back to today UTC when date is invalid or future", () => {
    const now = dayjs.utc("2025-06-01T00:00:00.000Z");
    expect(parseDateParamUtc("2025-02-30", now)).toBe("2025-06-01");
    expect(parseDateParamUtc("2025-12-01", now)).toBe("2025-06-01");
    expect(parseDateParamUtc(null, now)).toBe("2025-06-01");
  });

  it("keeps selected calendar date when the value carries timezone offset", () => {
    const selected = dayjs.tz("2025-05-29", "Asia/Shanghai");
    expect(selected.utc().format("YYYY-MM-DD")).toBe("2025-05-28");
    expect(formatSelectedDateParam(selected)).toBe("2025-05-29");
  });

  it("builds anchor ISO at UTC midnight", () => {
    expect(toAnchorIso("2025-05-28")).toBe("2025-05-28T00:00:00.000Z");
  });
});

describe("events archive next-day navigation helper", () => {
  it("uses current month counts for same-month next day", () => {
    const currentMonthMap = buildCalendarCountMap([
      { date: "2025-05-29", count: 3 },
    ]);

    const result = canNavigateToNextDay({
      nowUtc: dayjs.utc("2025-05-30T00:00:00.000Z"),
      nextDateParam: "2025-05-29",
      currentMonthParam: "2025-05",
      currentMonthCountByDate: currentMonthMap,
    });

    expect(result).toBe(true);
  });

  it("uses next month counts for cross-month next day", () => {
    const currentMonthMap = buildCalendarCountMap([]);
    const nextMonthMap = buildCalendarCountMap([
      { date: "2025-06-01", count: 1 },
    ]);

    const result = canNavigateToNextDay({
      nowUtc: dayjs.utc("2025-06-03T00:00:00.000Z"),
      nextDateParam: "2025-06-01",
      currentMonthParam: "2025-05",
      currentMonthCountByDate: currentMonthMap,
      nextMonthCountByDate: nextMonthMap,
    });

    expect(result).toBe(true);
  });

  it("blocks future dates even if data map has values", () => {
    const currentMonthMap = buildCalendarCountMap([
      { date: "2025-06-10", count: 2 },
    ]);

    const result = canNavigateToNextDay({
      nowUtc: dayjs.utc("2025-06-08T00:00:00.000Z"),
      nextDateParam: "2025-06-10",
      currentMonthParam: "2025-06",
      currentMonthCountByDate: currentMonthMap,
    });

    expect(result).toBe(false);
  });
});
