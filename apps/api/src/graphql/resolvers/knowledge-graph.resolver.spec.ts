import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { PERMISSIONS_KEY, PermissionsMode } from "../../common/decorators/permissions.decorator";

import { KnowledgeGraphResolver } from "./knowledge-graph.resolver";

const sampleUser: AuthenticatedUser = {
  id: "user-1",
  email: "analyst@example.com",
  firstName: "Analyst",
  lastName: "User",
  orgId: "org-1",
  roleIds: ["role-1"],
  permissions: ["dashboards.read", "items.read"]
};

describe("KnowledgeGraphResolver", () => {
  const settings = {
    getSettings: jest.fn()
  } as any;
  const graph = {
    getSubgraph: jest.fn(),
    listArticleEntityLinks: jest.fn(),
    listEdgeEvidence: jest.fn()
  } as any;
  const cache = {
    wrap: jest.fn()
  } as any;

  const resolver = new KnowledgeGraphResolver(settings, graph, cache);

  beforeEach(() => {
    jest.clearAllMocks();
    settings.getSettings.mockResolvedValue({
      enabled: true,
      cacheTtlSeconds: 0
    });
  });

  it("returns edge evidence rows for the current org", async () => {
    const createdAt = new Date("2026-04-10T09:00:00.000Z");
    const crawlAt = new Date("2026-04-10T08:00:00.000Z");
    graph.listEdgeEvidence.mockResolvedValue([
      {
        id: "evidence-1",
        confidence: 0.82,
        extractorVersion: "kg-v1",
        createdAt,
        evidence: {
          quote: "Acme supplies turbine parts to Contoso.",
          validation: { outcome: "supported" }
        },
        article: {
          id: "article-1",
          url: "https://example.com/acme",
          title: "Acme expands supply chain",
          summary: "A new supply agreement was announced.",
          language: "en",
          crawlAt
        }
      }
    ]);

    const result = await resolver.knowledgeGraphEdgeEvidence(
      { user: sampleUser } as any,
      "edge-1",
      100
    );

    expect(graph.listEdgeEvidence).toHaveBeenCalledWith("org-1", "edge-1", 100);
    expect(result).toEqual([
      {
        id: "evidence-1",
        confidence: 0.82,
        extractorVersion: "kg-v1",
        createdAt,
        evidence: {
          quote: "Acme supplies turbine parts to Contoso.",
          validation: { outcome: "supported" }
        },
        article: {
          id: "article-1",
          url: "https://example.com/acme",
          title: "Acme expands supply chain",
          summary: "A new supply agreement was announced.",
          language: "en",
          crawlAt
        }
      }
    ]);
  });

  it("returns an empty list when the knowledge graph is disabled", async () => {
    settings.getSettings.mockResolvedValue({
      enabled: false,
      cacheTtlSeconds: 0
    });

    const result = await resolver.knowledgeGraphEdgeEvidence(
      { user: sampleUser } as any,
      "edge-1",
      undefined
    );

    expect(graph.listEdgeEvidence).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("rejects unauthenticated edge evidence requests", async () => {
    await expect(
      resolver.knowledgeGraphEdgeEvidence({} as any, "edge-1", undefined)
    ).rejects.toThrow("Unauthenticated");
  });

  it("requires items.read for edge evidence access", () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, KnowledgeGraphResolver.prototype.knowledgeGraphEdgeEvidence)
    ).toEqual({
      permissions: ["items.read"],
      mode: PermissionsMode.Any
    });
  });
});
