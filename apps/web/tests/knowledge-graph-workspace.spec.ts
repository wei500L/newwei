import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("knowledge graph workspace wiring", () => {
  it("mounts the workspace instead of the explorer directly", () => {
    const source = read("app/(app)/knowledge-graph/page.tsx");

    expect(source).toContain("KnowledgeGraphWorkspace");
    expect(source).not.toContain("KnowledgeGraphContent");
  });

  it("wires the impact tab to the backend graph impact queries", () => {
    const source = read("app/(app)/knowledge-graph/knowledge-graph-impact-content.tsx");

    expect(source).toContain("getExecutiveChangeImpact");
    expect(source).toContain("getCommodityMoveImpact");
    expect(source).toContain("getPolicyEventImpact");
    expect(source).toContain("Open in explorer");
  });
});
