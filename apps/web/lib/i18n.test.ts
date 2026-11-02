import { describe, expect, it } from "vitest";

import { formatClock, formatTimestamp } from "@/lib/i18n";

describe("formatTimestamp", () => {
  it("formats in the application time zone with the standard layout", () => {
    expect(formatTimestamp("2026-01-01T00:00:00Z", "zh-CN")).toContain("08:00");
  });
});

describe("formatClock", () => {
  it("returns only hours and minutes in the application time zone", () => {
    expect(formatClock("2026-01-01T00:00:00Z", "zh-CN")).toBe("08:00");
  });
});
