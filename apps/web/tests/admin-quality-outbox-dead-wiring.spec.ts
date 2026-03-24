import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

describe("admin quality outbox dead wiring", () => {
  it("keeps dead outbox totals visible in the quality view", () => {
    const source = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/admin/quality/quality-content.tsx"),
      "utf8",
    );

    expect(source).toContain("pipeline.outbox.totals.dead");
    expect(source).toContain('t("quality.pipeline.outbox.dead"');
    expect(source).toContain('defaultValue: "Outbox dead"');
  });
});
