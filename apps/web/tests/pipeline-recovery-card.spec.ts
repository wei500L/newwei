import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("pipeline recovery card wiring", () => {
  it("mounts the recovery card in item detail", () => {
    const source = read("app/(app)/items/[id]/item-detail.tsx");

    expect(source).toContain("PipelineRecoveryCard");
    expect(source).toContain("onActionComplete={refetch}");
  });

  it("targets the replay and rollback endpoints", () => {
    const source = read("app/(app)/items/[id]/pipeline-recovery-card.tsx");

    expect(source).toContain("admin/quality/pipeline/runs");
    expect(source).toContain("admin/quality/pipeline/${action}");
    expect(source).toContain('action: "replay" | "rollback"');
  });
});
