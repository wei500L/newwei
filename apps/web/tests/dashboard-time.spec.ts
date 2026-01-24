import { afterEach, describe, expect, it } from "vitest";

import { formatDashboardDate, formatDashboardWindowLabel } from "../lib/dashboard-time";

describe("dashboard time helpers", () => {
  const originalTimeZone = process.env.NEXT_PUBLIC_TIME_ZONE;

  afterEach(() => {
    if (originalTimeZone === undefined) {
      delete process.env.NEXT_PUBLIC_TIME_ZONE;
    } else {
      process.env.NEXT_PUBLIC_TIME_ZONE = originalTimeZone;
    }
  });

  it("formats dates in the configured dashboard time zone", () => {
    const instant = new Date("2025-12-24T16:50:19.463Z");

    process.env.NEXT_PUBLIC_TIME_ZONE = "UTC";
    expect(formatDashboardDate(instant)).toBe("2025-12-24");

    process.env.NEXT_PUBLIC_TIME_ZONE = "Asia/Shanghai";
    expect(formatDashboardDate(instant)).toBe("2025-12-25");
  });

  it("formats window labels with consistent boundaries", () => {
    process.env.NEXT_PUBLIC_TIME_ZONE = "Asia/Shanghai";

    const start = new Date("2025-12-24T16:50:19.463Z");
    const end = new Date("2026-01-24T16:50:19.463Z");

    expect(formatDashboardWindowLabel(start, end)).toBe("2025-12-25 - 2026-01-25");
  });
});

