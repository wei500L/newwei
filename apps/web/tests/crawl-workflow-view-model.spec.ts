import { describe, expect, it } from "vitest";

import {
  buildWorkflowCandidateTraceChain,
  buildWorkflowCandidateTraceSummary,
  buildWorkflowTraceEntryDiffRows,
  buildWorkflowCompareSummary,
  formatWorkflowStepSummary,
} from "../app/(app)/admin/ops/crawl-frontier/crawl-workflow-view-model";

describe("crawl workflow view model", () => {
  it("builds compare summary for changed settings and node ids", () => {
    const summary = buildWorkflowCompareSummary({
      left: {
        id: "left",
        version: 1,
        name: "v1",
        definition: {
          settings: { maxDepth: 3, maxPages: 60, executionMode: "layered" },
          nodes: [{ id: "seed", type: "seed-discovery", label: "Seed" }],
          edges: [],
        },
      },
      right: {
        id: "right",
        version: 2,
        name: "v2",
        definition: {
          settings: { maxDepth: 4, maxPages: 60, executionMode: "hybrid" },
          nodes: [
            { id: "seed", type: "seed-discovery", label: "Seed" },
            { id: "filter", type: "url-filter", label: "Filter" },
          ],
          edges: [{ id: "e1", source: "seed", target: "filter" }],
        },
      },
      summary: {
        nodeCountDelta: 1,
        edgeCountDelta: 1,
        changedSettingsCount: 2,
        changedNodeCount: 1,
        addedEdgeCount: 1,
        removedEdgeCount: 0,
      },
      definitionDiff: {
        leftSettings: { maxDepth: 3, maxPages: 60, executionMode: "layered" },
        rightSettings: { maxDepth: 4, maxPages: 60, executionMode: "hybrid" },
        leftNodeIds: ["seed"],
        rightNodeIds: ["seed", "filter"],
        settings: [
          { key: "executionMode", left: "layered", right: "hybrid" },
          { key: "maxDepth", left: 3, right: 4 },
        ],
        nodes: {
          added: [{ id: "filter", type: "url-filter", label: "Filter" }],
          removed: [],
          changed: [
            {
              id: "seed",
              left: {
                id: "seed",
                type: "seed-discovery",
                label: "Seed",
              },
              right: {
                id: "seed",
                type: "seed-discovery",
                label: "Seed Discovery",
              },
              changedFields: ["label"],
            },
          ],
        },
        edges: {
          added: [{ id: "e1", source: "seed", target: "filter" }],
          removed: [],
        },
      },
      bindingImpact: {
        workflows: [{ id: "wf-1", name: "Workflow", publishedVersionId: "right" }],
        profiles: {
          total: 2,
          followingPublishedCount: 1,
          leftVersionCount: 0,
          rightVersionCount: 1,
          items: [],
        },
        newsSources: {
          total: 1,
          followingPublishedCount: 0,
          leftVersionCount: 0,
          rightVersionCount: 1,
          items: [],
        },
      },
    });

    expect(summary.changedSettings).toEqual(["executionMode", "maxDepth"]);
    expect(summary.addedNodeIds).toEqual(["filter"]);
    expect(summary.removedNodeIds).toEqual([]);
    expect(summary.changedNodeIds).toEqual(["seed"]);
    expect(summary.addedEdgeCount).toBe(1);
    expect(summary.removedEdgeCount).toBe(0);
    expect(summary.profileImpactCount).toBe(2);
    expect(summary.newsSourceImpactCount).toBe(1);
    expect(summary.nodeCountDelta).toBe(1);
    expect(summary.edgeCountDelta).toBe(1);
  });

  it("summarizes candidate trace deltas and changed fields", () => {
    const summary = buildWorkflowCandidateTraceSummary({
      id: "candidate-1",
      sourceNodeId: "seed",
      url: "https://example.com/article",
      status: "selected",
      trace: [
        {
          timestamp: "2026-03-21T10:00:00.000Z",
          nodeId: "seed",
          nodeType: "seed-discovery",
          action: "scored",
          message: "scored",
          scoreDelta: 0.8,
          freshnessDelta: 0.6,
          ruleHits: ["seed_scored"],
          beforeSnapshot: { status: "active", score: 0 },
          afterSnapshot: { status: "active", score: 0.8 },
        },
        {
          timestamp: "2026-03-21T10:00:01.000Z",
          nodeId: "persist",
          nodeType: "persist-result",
          action: "persisted",
          message: "persisted",
          ruleHits: ["queued_frontier_node"],
          beforeSnapshot: { status: "active" },
          afterSnapshot: { status: "selected", queuedNodeId: "node-1" },
        },
      ],
    });

    expect(summary.totalScoreDelta).toBe(0.8);
    expect(summary.totalFreshnessDelta).toBe(0.6);
    expect(summary.ruleHits).toEqual(["seed_scored", "queued_frontier_node"]);
    expect(summary.changedFields).toEqual(["score", "status", "queuedNodeId"]);
  });

  it("formats step counters consistently", () => {
    expect(
      formatWorkflowStepSummary({
        nodeId: "seed",
        nodeType: "seed-discovery",
        label: "Seed",
        status: "completed",
        durationMs: 120,
        inputCount: 1,
        outputCount: 8,
        rejectedCount: 3,
        sampleUrls: [],
      }),
    ).toBe("in 1 / out 8 / rejected 3");
  });

  it("builds a step chain with statuses, deltas, and changed fields", () => {
    const steps = buildWorkflowCandidateTraceChain({
      id: "candidate-2",
      sourceNodeId: "seed",
      url: "https://example.com/article",
      status: "rejected",
      rejectedReason: "persist_trim",
      trace: [
        {
          timestamp: "2026-03-21T10:00:00.000Z",
          nodeId: "score",
          nodeType: "url-scorer",
          action: "scored",
          message: "scored",
          scoreDelta: 0.45,
          beforeSnapshot: { score: 0, status: "active" },
          afterSnapshot: { score: 0.45, status: "active" },
        },
        {
          timestamp: "2026-03-21T10:00:01.000Z",
          nodeId: "persist",
          nodeType: "persist-result",
          action: "persisted",
          message: "trimmed",
          accepted: false,
          rejectedReason: "persist_trim",
          beforeSnapshot: { status: "active" },
          afterSnapshot: { status: "rejected", rejectedReason: "persist_trim" },
        },
      ],
    });

    expect(steps.map((step) => step.status)).toEqual(["active", "rejected"]);
    expect(steps[0]?.deltaSummary).toEqual(["score +0.45"]);
    expect(steps[0]?.changedFields).toEqual(["score"]);
    expect(steps[1]).toEqual(
      expect.objectContaining({
        label: "persist-result / persisted",
        rejectedReason: "persist_trim",
      }),
    );
  });

  it("builds compact before/after diff rows for a trace entry", () => {
    const diffRows = buildWorkflowTraceEntryDiffRows({
      timestamp: "2026-03-21T10:00:00.000Z",
      nodeId: "budget",
      nodeType: "budget-control",
      action: "budgeted",
      message: "Rejected by budget trim",
      beforeSnapshot: {
        status: "active",
        score: 1.25,
        metadata: { queueClass: "high", nested: true },
      },
      afterSnapshot: {
        status: "rejected",
        score: 1.25,
        rejectedReason: "budget_trim",
        metadata: { queueClass: "normal", nested: true },
      },
    });

    expect(diffRows).toEqual([
      {
        field: "status",
        beforeValue: "active",
        afterValue: "rejected",
      },
      {
        field: "metadata",
        beforeValue: '{"queueClass":"high","nested":true}',
        afterValue: '{"queueClass":"normal","nested":true}',
      },
      {
        field: "rejectedReason",
        beforeValue: "(missing)",
        afterValue: "budget_trim",
      },
    ]);
  });
});
