jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { NewsEventSourcePolicyService } from "../news-event-source-policy.service";

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

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "news_event_source_policy:org-1" },
    });
    expect(cacheMock.set).toHaveBeenCalledWith(
      "newsEvents:sourcePolicy:org-1",
      policy,
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

    expect(result).toEqual({
      authoritativeDomains: ["reuters.com", "bloomberg.com"],
      authoritativeLabels: ["reuters", "associated press"],
      blogDomains: ["medium.com", "x.com"],
      blogLabels: ["newsletter", "creator"],
    });

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: "news_event_source_policy:org-1" },
      update: {
        value: result,
        updatedById: "actor-1",
        description: "News event source policy (org=org-1)",
      },
      create: {
        key: "news_event_source_policy:org-1",
        value: result,
        updatedById: "actor-1",
        description: "News event source policy (org=org-1)",
      },
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    expect(cacheMock.set).toHaveBeenCalledWith(
      "newsEvents:sourcePolicy:org-1",
      result,
      60,
    );
  });

  it("uses cached policy when available", async () => {
    cacheMock.get = jest.fn().mockResolvedValue({
      authoritativeDomains: ["reuters.com"],
      authoritativeLabels: ["reuters"],
      blogDomains: ["substack.com"],
      blogLabels: ["newsletter"],
    });

    const service = new NewsEventSourcePolicyService(
      prismaMock as any,
      cacheMock as any,
    );

    const policy = await service.getPolicy("org-1");

    expect(policy).toEqual({
      authoritativeDomains: ["reuters.com"],
      authoritativeLabels: ["reuters"],
      blogDomains: ["substack.com"],
      blogLabels: ["newsletter"],
    });
    expect(prismaMock.systemSetting.findUnique).not.toHaveBeenCalled();
  });
});
