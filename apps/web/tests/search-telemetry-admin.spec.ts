import { describe, expect, it } from "vitest";

import dayjs from "@/lib/dayjs";
import { resolveDefaultSearchTelemetryRange } from "../lib/search-telemetry-admin";

describe("search telemetry admin helpers", () => {
  it("builds the default window from local calendar days", () => {
    const now = dayjs.tz("2026-04-18 10:30", "America/Los_Angeles");
    const [from, to] = resolveDefaultSearchTelemetryRange(now);

    expect(from.format("YYYY-MM-DD")).toBe("2026-04-12");
    expect(to.format("YYYY-MM-DD")).toBe("2026-04-18");
  });
});
