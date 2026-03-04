import { KnowledgeGraphSettingsService } from "../knowledge-graph-settings.service";

describe("KnowledgeGraphSettingsService", () => {
  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn()
    }
  } as any;

  const cacheMock = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn()
  } as any;

  let service: KnowledgeGraphSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn();
    cacheMock.get = jest.fn().mockResolvedValue(null);
    cacheMock.set = jest.fn().mockResolvedValue(undefined);
    cacheMock.del = jest.fn().mockResolvedValue(undefined);
    service = new KnowledgeGraphSettingsService(prismaMock, cacheMock);
  });

  it("auto-bootstraps enabled defaults when settings record is missing", async () => {
    prismaMock.systemSetting.upsert.mockImplementation(async (args: any) => ({
      value: args.create.value
    }));

    const settings = await service.getSettings("org-1");

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "knowledge_graph_settings:org-1" }
    });
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "knowledge_graph_settings:org-1" },
        create: expect.objectContaining({
          key: "knowledge_graph_settings:org-1",
          description: "Knowledge graph settings (org=org-1)"
        })
      })
    );
    expect(settings.enabled).toBe(true);
    expect(settings.ingestionEnabled).toBe(true);
  });

  it("loads existing record without bootstrap upsert", async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      value: {
        enabled: false,
        ingestionEnabled: false,
        maxBatchSize: 80,
        maxRelationsPerArticle: 5,
        minEdgeConfidence: 0.6,
        dynamicEdgeConfidenceEnabled: true,
        dynamicEdgeConfidenceQuantile: 0.3,
        multiModelValidationEnabled: false,
        multiModelValidationModels: [],
        multiModelValidationModelCount: 2,
        multiModelValidationMaxRelationsPerArticle: 3,
        entityDisambiguationEnabled: false,
        entityDisambiguationMaxCandidates: 5,
        cacheTtlSeconds: 90
      }
    });

    const settings = await service.getSettings("org-2");

    expect(prismaMock.systemSetting.upsert).not.toHaveBeenCalled();
    expect(settings.enabled).toBe(false);
    expect(settings.cacheTtlSeconds).toBe(90);
  });
});
