/* eslint-disable @typescript-eslint/no-explicit-any */
import { CrawlSiteProfileService } from "./crawl-site-profile.service";

describe("CrawlSiteProfileService", () => {
  it("previews a draft profile against the provided URL while still returning active matches", async () => {
    const prisma = {
      crawlSiteProfile: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "profile-1",
            orgId: "org-1",
            name: "BBC Active",
            description: null,
            matchHost: "www.bbc.com",
            isActive: true,
            executionMode: "layered",
            version: 3,
            config: {
              seedDiscovery: {
                strategy: "seed_first",
              },
            },
            createdById: "user-1",
            updatedById: "user-1",
            publishedAt: new Date("2026-03-19T00:00:00.000Z"),
            createdAt: new Date("2026-03-18T00:00:00.000Z"),
            updatedAt: new Date("2026-03-19T00:00:00.000Z"),
          },
        ]),
      },
    } as any;

    const service = new CrawlSiteProfileService(prisma);
    const result = await service.previewProfileDraft("org-1", {
      url: "https://www.bbc.com/news/world-123",
      name: "Draft BBC",
      matchHost: "*.bbc.com",
      isActive: true,
      executionMode: "hybrid",
      config: {
        sourceTier: "tier1",
        llmAssist: {
          enabled: true,
        },
      },
    });

    expect(result.host).toBe("www.bbc.com");
    expect(result.draftMatches).toBe(true);
    expect(result.draft).toMatchObject({
      id: "draft",
      name: "Draft BBC",
      matchHost: "*.bbc.com",
      executionMode: "hybrid",
      config: expect.objectContaining({
        sourceTier: "tier1",
        llmAssist: expect.objectContaining({
          enabled: true,
        }),
      }),
    });
    expect(result.activeMatch).toMatchObject({
      id: "profile-1",
      name: "BBC Active",
      matchHost: "www.bbc.com",
    });
    expect(result.activeCandidates).toHaveLength(1);
  });
});
