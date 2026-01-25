import { Prisma } from "@prisma/client";

import { RateLimitPolicyService } from "./rate-limit-policy.service";

const prismaMock = {
  rateLimitPolicy: {
    findMany: jest.fn(),
    findUnique: jest.fn()
  }
} as any;

const cacheMock = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn()
} as any;

describe("RateLimitPolicyService", () => {
  let service: RateLimitPolicyService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.rateLimitPolicy.findMany = jest.fn().mockResolvedValue([]);
    prismaMock.rateLimitPolicy.findUnique = jest.fn().mockResolvedValue(null);
    cacheMock.get = jest.fn().mockResolvedValue(null);
    cacheMock.set = jest.fn().mockResolvedValue(undefined);
    cacheMock.del = jest.fn().mockResolvedValue(undefined);
    service = new RateLimitPolicyService(prismaMock, cacheMock);
  });

  it("returns cached policy without hitting the database", async () => {
    const cachedPolicy = {
      feature: "crawl_task",
      userLimit: 2,
      ipLimit: 3,
      windowSeconds: 120,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    cacheMock.get = jest.fn().mockResolvedValue({ policy: cachedPolicy });

    const policy = await service.getPolicy("crawl_task");
    expect(policy).toEqual(cachedPolicy);
    expect(prismaMock.rateLimitPolicy.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to database when cache read fails", async () => {
    cacheMock.get = jest.fn(async () => {
      throw new Error("redis unavailable");
    });
    prismaMock.rateLimitPolicy.findUnique = jest.fn().mockResolvedValue({
      feature: "crawl_task",
      userLimit: 2,
      ipLimit: 3,
      windowSeconds: 120,
      enabled: true,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const policy = await service.getPolicy("crawl_task");
    expect(policy?.feature).toBe("crawl_task");
    expect(prismaMock.rateLimitPolicy.findUnique).toHaveBeenCalled();
    expect(cacheMock.set).toHaveBeenCalled();
  });

  it("returns null when the RateLimitPolicy table is missing", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("missing table", {
      code: "P2021",
      clientVersion: "test"
    });
    prismaMock.rateLimitPolicy.findUnique = jest.fn().mockRejectedValue(error);

    await expect(service.getPolicy("crawl_task")).resolves.toBeNull();
    expect(cacheMock.set).not.toHaveBeenCalled();
  });

  it("returns empty list when the RateLimitPolicy table is missing", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("missing table", {
      code: "P2021",
      clientVersion: "test"
    });
    prismaMock.rateLimitPolicy.findMany = jest.fn().mockRejectedValue(error);

    await expect(service.listPolicies()).resolves.toEqual([]);
  });

  it("returns null when the RateLimitPolicy schema is out of date (missing column)", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("missing column", {
      code: "P2022",
      clientVersion: "test"
    });
    prismaMock.rateLimitPolicy.findUnique = jest.fn().mockRejectedValue(error);

    await expect(service.getPolicy("crawl_task")).resolves.toBeNull();
  });
});
