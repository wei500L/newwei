import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import {
  PERMISSIONS_KEY,
  PermissionsMode,
} from "../../common/decorators/permissions.decorator";

import { EntityIntelligenceResolver } from "./entity-intelligence.resolver";

const sampleUser: AuthenticatedUser = {
  id: "user-1",
  email: "analyst@example.com",
  firstName: "Analyst",
  lastName: "User",
  orgId: "org-1",
  roleIds: ["role-1"],
  permissions: ["dashboards.read", "items.read"],
};

const entity = {
  id: "entity-1",
  canonicalName: "Acme Corp",
  type: "company",
  properties: { ticker: "ACME" },
};

describe("EntityIntelligenceResolver", () => {
  const settings = {
    getSettings: jest.fn(),
  } as any;
  const intelligence = {
    getCard: jest.fn(),
    getEvidence: jest.fn(),
    resolveEntityByName: jest.fn(),
  } as any;

  const resolver = new EntityIntelligenceResolver(settings, intelligence);

  beforeEach(() => {
    jest.clearAllMocks();
    settings.getSettings.mockResolvedValue({
      enabled: true,
    });
  });

  it("returns an entity intelligence card for the current org", async () => {
    const generatedAt = new Date("2026-05-31T08:00:00.000Z");
    intelligence.getCard.mockResolvedValue({
      entity,
      aliases: ["Acme"],
      metrics: {
        relationshipCount: 2,
        incomingEdgeCount: 1,
        outgoingEdgeCount: 1,
        mentionedArticleCount: 4,
        recentEventCount: 1,
        avgSentiment: 0.25,
        negativeRatio: 0.1,
        latestMentionAt: generatedAt,
      },
      relationships: [
        {
          direction: "outgoing",
          edge: {
            id: "edge-1",
            fromEntityId: "entity-1",
            toEntityId: "entity-2",
            type: "supplies",
            weight: 3,
            confidence: 0.88,
            properties: null,
          },
          neighbor: {
            id: "entity-2",
            canonicalName: "Contoso",
            type: "company",
            properties: null,
          },
          evidenceCount: 2,
          latestEvidenceAt: generatedAt,
        },
      ],
      sentimentSeries: [],
      neighborhood: {
        seed: entity,
        nodes: [entity],
        edges: [],
      },
      generatedAt,
    });

    const result = await resolver.entityIntelligenceCard(
      { user: sampleUser } as any,
      { entityId: "entity-1", windowDays: 30, relatedLimit: 12 }
    );

    expect(intelligence.getCard).toHaveBeenCalledWith({
      orgId: "org-1",
      entityId: "entity-1",
      windowDays: 30,
      relatedLimit: 12,
    });
    expect(result?.entity).toEqual({
      id: "entity-1",
      name: "Acme Corp",
      type: "company",
      properties: { ticker: "ACME" },
    });
    expect(result?.relationships[0]?.neighbor.name).toBe("Contoso");
  });

  it("returns null when knowledge graph is disabled", async () => {
    settings.getSettings.mockResolvedValue({ enabled: false });

    const result = await resolver.entityIntelligenceCard(
      { user: sampleUser } as any,
      { entityId: "entity-1" }
    );

    expect(intelligence.getCard).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("passes item visibility into evidence loading", async () => {
    intelligence.getEvidence.mockResolvedValue({
      restricted: false,
      events: [],
      articles: [],
      generatedAt: new Date("2026-05-31T08:00:00.000Z"),
    });

    await resolver.entityIntelligenceEvidence(
      { user: { ...sampleUser, permissions: ["dashboards.read"] } } as any,
      { entityId: "entity-1", windowDays: 30 }
    );

    expect(intelligence.getEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        entityId: "entity-1",
        canReadItems: false,
      })
    );
  });

  it("resolves an entity name to a knowledge graph node", async () => {
    intelligence.resolveEntityByName.mockResolvedValue(entity);

    const result = await resolver.knowledgeEntityByName(
      { user: sampleUser } as any,
      "Acme",
      "company"
    );

    expect(intelligence.resolveEntityByName).toHaveBeenCalledWith(
      "org-1",
      "Acme",
      "company"
    );
    expect(result?.id).toBe("entity-1");
  });

  it("requires dashboard access for the card query", () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        EntityIntelligenceResolver.prototype.entityIntelligenceCard
      )
    ).toEqual({
      permissions: ["dashboards.read"],
      mode: PermissionsMode.Any,
    });
  });
});
