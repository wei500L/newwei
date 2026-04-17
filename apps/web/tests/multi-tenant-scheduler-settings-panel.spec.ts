import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("multi-tenant scheduler settings panel wiring", () => {
  it("wires all scheduler concurrency fields through the shared admin panel and REST endpoint", () => {
    const source = read(
      "components/settings/multi-tenant-scheduler-settings-panel.tsx",
    );

    expect(source).toContain("system-settings/multi-tenant-schedulers");
    expect(source).toContain("newsEventsIngestionOrgConcurrency");
    expect(source).toContain("knowledgeGraphIngestionOrgConcurrency");
    expect(source).toContain("sentimentSnapshotOrgConcurrency");
    expect(source).toContain("newsnowHottestAnalysisOrgConcurrency");
    expect(source).toContain("userDigestDeliveryOrgConcurrency");
    expect(source).toContain("Scheduler fan-out policy");
  });
});
