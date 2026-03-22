import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("news dedupe settings panel wiring", () => {
  it("wires llmJudgeConcurrency through the query, mutation, form, and submit payload", () => {
    const source = read("components/settings/news-dedupe-settings-panel.tsx");

    expect(source).toContain("llmJudgeConcurrency");
    expect(source).toContain("newsDedupeSettings.llmJudgeConcurrency");
    expect(source).toContain("payload.llmJudgeConcurrency");
    expect(source).toContain('name="llmJudgeConcurrency"');
    expect(source).toContain('fields.llmJudgeConcurrency');
    expect(source).toContain('hints.llmJudgeConcurrency');
  });
});
