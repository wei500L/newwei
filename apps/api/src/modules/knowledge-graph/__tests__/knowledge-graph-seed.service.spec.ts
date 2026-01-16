import { KnowledgeRecordSource } from "@prisma/client";

import { KnowledgeGraphSeedService } from "../knowledge-graph-seed.service";

describe("KnowledgeGraphSeedService", () => {
  it("ingests SW industries via akshare gateway", async () => {
    const akshare = {
      get: jest.fn(async (endpoint: string) => {
        if (endpoint === "/sw_index_third_info") {
          return [{ symbol: "850111.SI" }];
        }
        if (endpoint === "/sw_index_third_cons") {
          const stockCodeKey = "\u80a1\u7968\u4ee3\u7801";
          const stockNameKey = "\u80a1\u7968\u7b80\u79f0";
          const level1Key = "\u7533\u4e071\u7ea7";
          const level2Key = "\u7533\u4e072\u7ea7";
          const level3Key = "\u7533\u4e073\u7ea7";

          return {
            data: [
              {
                [stockCodeKey]: "600313.SH",
                [stockNameKey]: "Acme",
                [level1Key]: "Industry-1",
                [level2Key]: "Industry-2",
                [level3Key]: "Industry-3"
              }
            ]
          };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      })
    } as any;

    const graph = {
      ingestSeedRelations: jest.fn().mockResolvedValue({ edgesUpserted: 4 })
    } as any;

    const service = new KnowledgeGraphSeedService(akshare, graph);
    const result = await service.ingestSwThirdLevelIndustryBatch({
      orgId: "org-1",
      maxIndustries: 1
    });

    expect(result.processedIndustries).toBe(1);
    expect(graph.ingestSeedRelations).toHaveBeenCalledTimes(1);
    expect(graph.ingestSeedRelations).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        source: KnowledgeRecordSource.seed,
        relations: expect.arrayContaining([
          expect.objectContaining({ predicate: "has_ticker" }),
          expect.objectContaining({ predicate: "belongs_to_industry" })
        ])
      })
    );
  });
});

