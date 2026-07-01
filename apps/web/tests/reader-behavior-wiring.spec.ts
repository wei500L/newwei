import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("reader behavior wiring", () => {
  it("wires reader page share actions and read milestones through shared helpers", () => {
    const source = read("app/(reader)/read/items/[id]/page.tsx");

    expect(source).toContain("useUserNewsReadMilestones");
    expect(source).toContain("shareTrackedNewsLink");
    expect(source).toContain('type: "share"');
    expect(source).toContain("estimatedReadingTimeMinutes");
  });

  it("wires item detail share actions and read milestones through shared helpers", () => {
    const source = read("app/(app)/items/[id]/item-detail.tsx");

    expect(source).toContain("useUserNewsReadMilestones");
    expect(source).toContain("shareTrackedNewsLink");
    expect(source).toContain('type: "share"');
  });
});
