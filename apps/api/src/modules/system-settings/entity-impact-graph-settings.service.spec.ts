import { EntityImpactGraphSettingsService } from "./entity-impact-graph-settings.service";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn(),
    upsert: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  },
  auditLogOutbox: {
    create: jest.fn()
  }
} as any;

describe("EntityImpactGraphSettingsService", () => {
  let cacheState: unknown | null;
  const cacheMock = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn()
  } as any;

  let service: EntityImpactGraphSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    cacheMock.get = jest.fn(async () => cacheState);
    cacheMock.set = jest.fn(async (_key: string, value: unknown) => {
      cacheState = value;
    });
    cacheMock.del = jest.fn(async () => {
      cacheState = null;
    });
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);

    service = new EntityImpactGraphSettingsService(prismaMock, cacheMock);
  });

  it("falls back to defaults when no settings exist", async () => {
    const settings = await service.getSettings("org-1");

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "entity_impact_graph_settings:org-1" }
    });
    expect(settings).toEqual({
      enabled: true,
      minEntityConfidence: 0.5,
      minCorrelation: 0.3,
      minCoOccurrence: 2,
      maxNodes: 100,
      categories: ["person", "organization", "stock", "commodity"],
      cacheTtlSeconds: 60
    });
    expect(cacheMock.set).toHaveBeenCalled();
  });

  it("prefers cached settings without querying the database", async () => {
    cacheState = {
      enabled: false,
      minEntityConfidence: 0.25,
      minCorrelation: 0.5,
      minCoOccurrence: 3,
      maxNodes: 50,
      categories: ["person", "stock"],
      cacheTtlSeconds: 120
    };

    const settings = await service.getSettings("org-1");

    expect(prismaMock.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(settings.enabled).toBe(false);
    expect(settings.categories).toEqual(["person", "stock"]);
  });

  it("updates settings per org and refreshes cache", async () => {
    const updated = await service.updateSettings("org-1", "admin-1", {
      enabled: true,
      minEntityConfidence: 2, // clamped to 1
      minCorrelation: -1, // clamped to 0
      minCoOccurrence: 0, // clamped to 1
      maxNodes: 9999, // clamped to 500
      categories: ["person", "stock", "person"],
      cacheTtlSeconds: 99999 // clamped to 3600
    });

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "entity_impact_graph_settings:org-1" }
      })
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          actorId: "admin-1",
          action: "entity_impact_graph_settings_update"
        })
      })
    );

    expect(updated).toEqual({
      enabled: true,
      minEntityConfidence: 1,
      minCorrelation: 0,
      minCoOccurrence: 1,
      maxNodes: 500,
      categories: ["person", "stock"],
      cacheTtlSeconds: 3600
    });

    const cached = await service.getSettings("org-1");
    expect(cached).toEqual(updated);
  });

  it("drops invalid categories and falls back to defaults when empty", async () => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: {
        enabled: true,
        categories: ["invalid", "also-invalid"]
      }
    });

    const settings = await service.getSettings("org-1");
    expect(settings.categories).toEqual(["person", "organization", "stock", "commodity"]);
  });
});

