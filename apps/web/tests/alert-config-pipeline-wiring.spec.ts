import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

describe("alert config pipeline wiring", () => {
  it("surfaces dedicated pipeline outbox controls in the alert config form", () => {
    const source = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/dashboard/alert-config-form.tsx"),
      "utf8",
    );

    expect(source).toContain("pipelineOutboxType");
    expect(source).toContain("alerts.config.pipeline.metricPreset");
    expect(source).toContain("alerts.config.pipeline.outboxType");
    expect(source).toContain("buildPipelineProviderMetadata");
    expect(source).toContain("stripControlledMetadataForProvider");
  });

  it("keeps mongo outbox presets available in the shared pipeline helper", () => {
    const source = fs.readFileSync(
      path.resolve(webRoot, "app/(app)/dashboard/alert-config.pipeline.ts"),
      "utf8",
    );

    expect(source).toContain('"mongo_outbox.dead"');
    expect(source).toContain('"mongo_outbox.oldest_age_minutes"');
    expect(source).toContain('"cleanup_crawl_results"');
  });
});
