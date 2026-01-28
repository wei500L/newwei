import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import type { EntityImpactGraphService } from "../../modules/dashboard/entity-impact-graph.service";

import { EntityImpactGraphResolver } from "./entity-impact-graph.resolver";

const sampleUser: AuthenticatedUser = {
  id: "user-1",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  orgId: "org-1",
  roleIds: ["role-1"],
  permissions: ["dashboards.read"]
};

describe("EntityImpactGraphResolver", () => {
  const service = {
    getEntityImpactGraph: jest.fn()
  } as unknown as EntityImpactGraphService;

  const resolver = new EntityImpactGraphResolver(service);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses orgId from context and maps input semantics", async () => {
    service.getEntityImpactGraph = jest.fn().mockResolvedValue({
      nodes: [{ id: "A", name: "A", category: "person", value: 1, symbolSize: 10 }],
      links: [{ source: "A", target: "B", value: 2, linkType: "co-occurrence" }],
      categories: [{ name: "person" }]
    });

    const startDate = new Date("2026-01-01T00:00:00.000Z");
    const endDate = new Date("2026-01-15T00:00:00.000Z");

    const result = await resolver.getEntityImpactGraph(
      { user: sampleUser } as any,
      {
        startDate,
        endDate,
        minConfidence: 0.8,
        minCorrelation: 0.42,
        minCoOccurrence: 3,
        maxNodes: 50,
        categories: ["person", "stock"]
      }
    );

    expect(service.getEntityImpactGraph).toHaveBeenCalledWith({
      orgId: "org-1",
      startDate,
      endDate,
      minEntityConfidence: 0.8,
      minCoOccurrence: 3,
      minCorrelation: 0.42,
      maxNodes: 50,
      categories: ["person", "stock"]
    });

    expect(result.nodes).toEqual([
      {
        id: "A",
        name: "A",
        category: "person",
        type: "person",
        value: 1
      }
    ]);
    expect(result.links).toEqual([
      {
        source: "A",
        target: "B",
        value: 2,
        type: "co-occurrence"
      }
    ]);
    expect(result.metadata.totalNodes).toBe(1);
    expect(result.metadata.totalLinks).toBe(1);
  });

  it("applies safe defaults when input is omitted", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-15T00:00:00.000Z"));

    service.getEntityImpactGraph = jest.fn().mockResolvedValue({
      nodes: [],
      links: [],
      categories: []
    });

    await resolver.getEntityImpactGraph({ user: sampleUser } as any, undefined);

    const endDate = new Date("2026-01-15T00:00:00.000Z");
    const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    expect(service.getEntityImpactGraph).toHaveBeenCalledWith({
      orgId: "org-1",
      startDate,
      endDate,
      minEntityConfidence: 0.5,
      minCoOccurrence: 2,
      minCorrelation: 0.3,
      maxNodes: 100,
      categories: ["person", "organization", "stock", "commodity"]
    });

    jest.useRealTimers();
  });

  it("rejects unauthenticated requests", async () => {
    await expect(resolver.getEntityImpactGraph({} as any, undefined)).rejects.toThrow("Unauthenticated");
  });
});
