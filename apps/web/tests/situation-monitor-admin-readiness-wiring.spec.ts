import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("situation monitor admin readiness wiring", () => {
  it("renders workspace readiness actions on the news sources page", () => {
    const source = read("app/(app)/admin/ops/news-sources/news-sources-content.tsx");

    expect(source).toContain("Situation Monitor readiness");
    expect(source).toContain("loadReadinessSummary");
    expect(source).toContain("const pageSize = 50;");
    expect(source).not.toContain("const pageSize = 200;");
    expect(source).toContain('page: "ingestion"');
    expect(source).toContain('panel: "news-source-scheduler"');
    expect(source).toContain("Create source");
    expect(source).toContain("Import OPML");
  });

  it("renders provider readiness and a monitor backlink on the settings panel", () => {
    const source = read("components/settings/situation-monitor-settings-panel.tsx");

    expect(source).toContain("Back to Situation Monitor");
    expect(source).toContain('router.push("/situation-monitor")');
    expect(source).toContain("Provider readiness");
    expect(source).toContain("GDELT snapshot scheduler");
    expect(source).toContain("handleForceExternalSnapshotRefresh");
    expect(source).toContain("externalSnapshotStatus");
    expect(source).toContain("Last full success");
    expect(source).toContain("Last partial/failure");
    expect(source).toContain("Next scheduled run");
    expect(source).toContain("24h success");
    expect(source).toContain("Rebuild external snapshot");
    expect(source).toContain("Analysis quality");
    expect(source).toContain("Dedupe ratio");
    expect(source).toContain("Avg sources / cluster");
    expect(source).toContain("qualitySummary");
    expect(source).toContain("OREF");
    expect(source).toContain("orefEnabled");
    expect(source).toContain("orefConfigured");
  });
});
