import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("newsnow behavior actions", () => {
  it("adds source-level hide and not-interested actions", () => {
    const source = read("app/(app)/newsnow/components/newsnow-card.tsx");

    expect(source).toContain('hideSessionBehaviorKey("newsnowSources", sourceBehaviorKey)');
    expect(source).toContain('type: "not_interested"');
    expect(source).toContain("<Dropdown");
    expect(source).toContain("negativeContribution");
  });
});
