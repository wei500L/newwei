import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("realtime signals settings panel wiring", () => {
  it("wires the OpenSky budget and HKT schedule controls into the settings panel", () => {
    const source = read("components/settings/realtime-signals-settings-panel.tsx");

    expect(source).toContain("openskyDailyCreditBudget");
    expect(source).toContain("openskyDayIntervalSec");
    expect(source).toContain("openskyNightIntervalSec");
    expect(source).toContain("openskyDayStartHourHkt");
    expect(source).toContain("openskyNightStartHourHkt");
    expect(source).toContain("openskyWarningRemainingPct");
    expect(source).toContain("openskyCriticalRemainingPct");
    expect(source).toContain("openskyBudget?.recentDays");
    expect(source).toContain("OpenSky budget & schedule");
    expect(source).toContain("effectiveMilitaryIntervalSec");
    expect(source).toContain("configuredIntervalSec");
  });
});
