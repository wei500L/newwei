import { describe, expect, it } from "vitest";

import {
  buildEntityGraphConnectionMap,
  filterEntityGraphData,
  resolveEntityGraphForce,
  resolveEntityGraphNodeSize,
  sanitizeEntityGraphLinks,
  selectEntityGraphLabelNodeIds,
} from "../lib/entity-impact-graph";

const sampleNodes = [
  { id: "n1", category: "person", value: 9 },
  { id: "n2", category: "organization", value: 5 },
  { id: "n3", category: "stock", value: 2 },
  { id: "n4", category: "commodity", value: 1 },
];

const sampleLinks = [
  { source: "n1", target: "n2", type: "co-occurrence", value: 6 },
  { source: "n2", target: "n3", type: "correlation", value: 0.8 },
  { source: "n1", target: "n4", type: "co-occurrence", value: 2 },
];

describe("entity-impact-graph helpers", () => {
  it("resolves force settings by node count ranges", () => {
    expect(resolveEntityGraphForce(10)).toEqual({
      repulsion: 460,
      gravity: 0.08,
      edgeLength: [72, 170],
    });

    expect(resolveEntityGraphForce(45)).toEqual({
      repulsion: 620,
      gravity: 0.1,
      edgeLength: [84, 220],
    });

    expect(resolveEntityGraphForce(90)).toEqual({
      repulsion: 780,
      gravity: 0.12,
      edgeLength: [96, 260],
    });
  });

  it("filters by selected categories and edge types", () => {
    const result = filterEntityGraphData(
      sampleNodes,
      sampleLinks,
      ["person", "organization", "stock"],
      ["correlation"],
    );

    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.type).toBe("correlation");
    expect(result.nodes.map((node) => node.id).sort()).toEqual(["n2", "n3"]);
  });

  it("keeps category nodes when selected edge type has no matching links", () => {
    const result = filterEntityGraphData(
      sampleNodes,
      sampleLinks,
      ["commodity"],
      ["correlation"],
    );

    expect(result.links).toEqual([]);
    expect(result.nodes.map((node) => node.id)).toEqual(["n4"]);
  });

  it("selects top labels and always includes selected adjacency", () => {
    const map = buildEntityGraphConnectionMap(sampleLinks);
    const compactLabelIds = selectEntityGraphLabelNodeIds(
      sampleNodes,
      "compact",
      "n4",
      map,
    );

    expect(compactLabelIds.has("n4")).toBe(true);
    expect(compactLabelIds.has("n1")).toBe(true);
  });

  it("scales node size with sqrt weighting and selected boost", () => {
    const normalSize = resolveEntityGraphNodeSize(9, false);
    const selectedSize = resolveEntityGraphNodeSize(9, true);
    const clampedSize = resolveEntityGraphNodeSize(10_000, true);

    expect(normalSize).toBeGreaterThan(18);
    expect(selectedSize).toBeGreaterThan(normalSize);
    expect(clampedSize).toBeLessThanOrEqual(60);
  });

  it("sanitizes links by resolving ids, removing invalid edges and deduping", () => {
    const links = [
      { source: "n1", target: "n2", type: "co-occurrence", value: 4 },
      { source: "n2", target: "n1", type: "co-occurrence", value: 5 },
      { source: "Alice", target: "n3", type: "correlation", value: 0.82 },
      { source: "n1", target: "n1", type: "co-occurrence", value: 1 },
      { source: "n4", target: "n2", type: "co-occurrence", value: 2 },
      { source: "n2", target: "n3", type: "correlation", value: 0 },
    ];

    const sanitized = sanitizeEntityGraphLinks(links, {
      nodeIds: new Set(["n1", "n2", "n3"]),
      nodeIdByNormalizedName: new Map([
        ["alice", "n1"],
        ["n1", "n1"],
        ["n2", "n2"],
        ["n3", "n3"],
      ]),
    });

    expect(sanitized).toHaveLength(2);
    expect(sanitized[0]).toMatchObject({
      source: "n1",
      target: "n2",
      type: "co-occurrence",
      value: 5,
    });
    expect(sanitized[1]).toMatchObject({
      source: "n1",
      target: "n3",
      type: "correlation",
    });
  });
});
