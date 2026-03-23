import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("news source runtime secrets panel wiring", () => {
  it("surfaces blank draft rows in an explicit draft group and focuses new entries", () => {
    const source = read("components/settings/news-source-runtime-secrets-panel.tsx");

    expect(source).toContain("const UNASSIGNED_SOURCE_GROUP_KEY = '__draft__'");
    expect(source).toContain("focusRow(nextRow.rowKey, nextRow.sourceId)");
    expect(source).toContain("group.isDraftGroup");
    expect(source).toContain("Draft entries");
  });
});
