jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { NewsEventSourcePolicyService } from "../news-event-source-policy.service";

const EMPTY_DELTA = {
  authoritativeDomainsAdd: [],
  authoritativeDomainsRemove: [],
  authoritativeLabelsAdd: [],
  authoritativeLabelsRemove: [],
  blogDomainsAdd: [],
  blogDomainsRemove: [],
  blogLabelsAdd: [],
  blogLabelsRemove: [],
};

describe("NewsEventSourcePolicyService", () => {
  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    auditLogOutbox: {
      create: jest.fn(),
    },
  };

  const cacheMock = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(() => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(null);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(null);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue(null);

    cacheMock.get = jest.fn().mockResolvedValue(null);
    cacheMock.set = jest.fn().mockResolvedValue(undefined);
    cacheMock.del = jest.fn().mockResolvedValue(undefined);
  });

  it("returns fallback policy when no record exists", async () => {
    const service = new NewsEventSourcePolicyService(
      prismaMock as any,
      cacheMock as any,
    );

    const policy = await service.getPolicy("org-1");

    expect(policy.authoritativeDomains).toContain("reuters.com");
    expect(policy.authoritativeLabels).toContain("associated press");
    expect(policy.blogDomains).toContain("substack.com");
    expect(policy.blogLabels).toContain("newsletter");

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "news_event_source_policy:org-1" },
      }),
    );
    expect(cacheMock.set).toHaveBeenCalledWith(
      "newsEvents:sourcePolicy:org-1",
      expect.objectContaining({
        version: 2,
        activeRevision: 0,
      }),
      60,
    );
  });

  it("normalizes and upserts policy lists", async () => {
    const service = new NewsEventSourcePolicyService(
      prismaMock as any,
      cacheMock as any,
    );

    const result = await service.updatePolicy("org-1", "actor-1", {
      authoritativeDomains: [
        " Reuters.COM ",
        "reuters.com",
        "WWW.BLOOMBERG.COM",
        "",
      ],
      authoritativeLabels: [" Reuters ", "Associated Press", ""],
      blogDomains: [" Medium.com ", "x.com", ""],
      blogLabels: ["Newsletter", "Creator", " newsletter "],
    });

    expect(result).toEqual(
      expect.objectContaining({
        authoritativeDomains: ["reuters.com", "bloomberg.com"],
        authoritativeLabels: ["reuters", "associated press"],
        blogDomains: ["medium.com", "x.com"],
        blogLabels: ["newsletter", "creator"],
        activeRevision: 1,
      }),
    );

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "news_event_source_policy:org-1" },
        update: expect.objectContaining({
          updatedById: "actor-1",
          description: "News event source policy (org=org-1)",
        }),
        create: expect.objectContaining({
          key: "news_event_source_policy:org-1",
          updatedById: "actor-1",
          description: "News event source policy (org=org-1)",
        }),
      }),
    );

    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    expect(cacheMock.set).toHaveBeenCalledWith(
      "newsEvents:sourcePolicy:org-1",
      expect.objectContaining({
        version: 2,
        activeRevision: 1,
      }),
      60,
    );
  });

  it("uses cached v2 policy state when available", async () => {
    cacheMock.get = jest.fn().mockResolvedValue({
      version: 2,
      activeRevision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      delta: {
        ...EMPTY_DELTA,
        authoritativeDomainsAdd: ["example.com"],
      },
      revisions: [],
    });

    const service = new NewsEventSourcePolicyService(
      prismaMock as any,
      cacheMock as any,
    );

    const policy = await service.getPolicy("org-1");

    expect(policy.authoritativeDomains).toContain("reuters.com");
    expect(policy.authoritativeDomains).toContain("example.com");
    expect(prismaMock.systemSetting.findUnique).not.toHaveBeenCalled();
  });

  it("ignores legacy cache payload and reloads state from database", async () => {
    cacheMock.get = jest.fn().mockResolvedValue({
      authoritativeDomains: ["legacy-only.com"],
      authoritativeLabels: ["legacy source"],
      blogDomains: [],
      blogLabels: [],
    });
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: {
        version: 2,
        activeRevision: 4,
        updatedAt: "2026-02-20T11:00:00.000Z",
        delta: {
          ...EMPTY_DELTA,
          authoritativeDomainsAdd: ["db-only.com"],
        },
        revisions: [],
      },
      updatedAt: new Date("2026-02-20T11:00:00.000Z"),
      updatedById: "actor-1",
    });

    const service = new NewsEventSourcePolicyService(
      prismaMock as any,
      cacheMock as any,
    );
    const policy = await service.getPolicy("org-1");

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(policy.authoritativeDomains).toContain("db-only.com");
    expect(policy.authoritativeDomains).not.toContain("legacy-only.com");
  });

  it("uses persisted updatedAt for preset cache and response", async () => {
    const persistedUpdatedAt = new Date("2026-02-20T12:34:56.789Z");
    prismaMock.systemSetting.upsert = jest
      .fn()
      .mockResolvedValue({ updatedAt: persistedUpdatedAt });

    const service = new NewsEventSourcePolicyService(
      prismaMock as any,
      cacheMock as any,
    );
    const result = await service.updatePolicyPreset("org-1", "actor-1", {
      authoritativeDomains: ["reuters.com"],
      authoritativeLabels: ["Reuters"],
      blogDomains: ["medium.com"],
      blogLabels: ["blog"],
    });

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "news_event_source_policy_preset:org-1" },
        select: { updatedAt: true },
      }),
    );
    expect(result.updatedAt).toBe(persistedUpdatedAt.toISOString());
    expect(cacheMock.set).toHaveBeenCalledWith(
      "newsEvents:sourcePolicyPreset:org-1",
      expect.objectContaining({
        updatedAt: persistedUpdatedAt.toISOString(),
      }),
      30,
    );
  });
});
