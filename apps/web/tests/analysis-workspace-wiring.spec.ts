import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");

describe("analysis workspace wiring", () => {
  it("mounts the shared workspace on the analysis route", () => {
    const source = readFileSync(
      resolve(repoRoot, "app/(app)/analysis/page.tsx"),
      "utf8",
    );

    expect(source).toContain("AnalysisWorkspace");
    expect(source).not.toContain("AnalysisLibrary");
  });

  it("keeps subject pages wired to task creation", () => {
    const annotationPanel = readFileSync(
      resolve(repoRoot, "components/analysis/annotation-panel.tsx"),
      "utf8",
    );
    const toolbar = readFileSync(
      resolve(repoRoot, "components/analysis/analysis-toolbar.tsx"),
      "utf8",
    );

    expect(annotationPanel).toContain("CreateAnalysisTaskButton");
    expect(toolbar).toContain("CreateAnalysisTaskButton");
  });
});
