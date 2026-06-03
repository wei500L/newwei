import { ActiveOrgRegistryService } from "./active-org-registry.service";

describe("ActiveOrgRegistryService", () => {
  const prisma = {
    org: {
      findMany: jest.fn(),
    },
  } as any;
  const cache = {
    wrap: jest.fn(),
    del: jest.fn(),
  } as any;

  let service: ActiveOrgRegistryService;

  beforeEach(() => {
    jest.resetAllMocks();
    cache.wrap.mockImplementation(
      async (_key: string, _ttl: number, loader: () => Promise<unknown>) =>
        await loader(),
    );
    cache.del.mockResolvedValue(undefined);
    prisma.org.findMany.mockResolvedValue([{ id: "org-1" }, { id: "org-2" }]);
    service = new ActiveOrgRegistryService(prisma, cache);
  });

  it("loads active orgs through cache", async () => {
    await expect(service.listActiveOrgs()).resolves.toEqual([
      { id: "org-1" },
      { id: "org-2" },
    ]);

    expect(cache.wrap).toHaveBeenCalledWith(
      "org:active:list:v1",
      15,
      expect.any(Function),
      expect.objectContaining({
        lockTtlMs: 2000,
        maxWaitMs: 500,
      }),
    );
    expect(prisma.org.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true },
      orderBy: { id: "asc" },
    });
  });

  it("returns ids and invalidates the shared cache key", async () => {
    await expect(service.listActiveOrgIds()).resolves.toEqual([
      "org-1",
      "org-2",
    ]);

    await service.invalidate();

    expect(cache.del).toHaveBeenCalledWith("org:active:list:v1");
  });
});
