import { describe, expect, it } from "vitest";

import {
  buildKnowledgeGraphExplorerHref,
  parseKnowledgeGraphExplorerParams
} from "../lib/knowledge-graph-explorer";

describe("knowledge graph explorer route helpers", () => {
  it("parses supported query params with clamping and relation normalization", () => {
    const params = new URLSearchParams(
      "seed=Acme&seedType=company&depth=9&maxNodes=20&relations=supplies,invalid&relations=affects_company"
    );

    expect(parseKnowledgeGraphExplorerParams(params)).toEqual({
      seedName: "Acme",
      seedType: "company",
      maxDepth: 5,
      maxNodes: 50,
      relationTypes: ["supplies", "affects_company"]
    });
  });

  it("builds a stable deep link and omits default values", () => {
    expect(
      buildKnowledgeGraphExplorerHref({
        seedName: "Acme",
        seedType: "company",
        relationTypes: ["supplies", "affects_company"]
      })
    ).toBe("/knowledge-graph?seed=Acme&seedType=company&relations=supplies%2Caffects_company");
  });
});
