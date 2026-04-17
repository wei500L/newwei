import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");
const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("news events settings panel llm recovery wiring", () => {
  it("loads clustering readiness and queues llm backfill from the admin panel", () => {
    const source = read("components/settings/news-events-settings-panel.tsx");

    expect(source).toContain(
      '"system-settings/news-events/clustering/readiness"',
    );
    expect(source).toContain("/failures/${groupId}/llm-backfill");
    expect(source).toContain("llmBackfillReady");
    expect(source).toContain("Open LLM gateway settings");
    expect(source).toContain("progressProcessedCount");
    expect(source).toContain("lastRecoveryModel");
  });
});
