import { ItemsElasticsearchService } from "./items-elasticsearch.service";

function createService(search = jest.fn()) {
  const service = new ItemsElasticsearchService({
    elasticsearchConfig: {
      enabled: false,
      node: undefined,
      requestTimeoutMs: 1_000,
      apiKey: undefined,
      username: undefined,
      password: undefined,
      itemsIndex: "items-index",
      itemsAlias: "items-alias",
    },
  } as any);
  (service as any).client = { search };
  (service as any).ensureIndex = jest.fn().mockResolvedValue(undefined);
  return { service, search };
}

describe("ItemsElasticsearchService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("searches literal keyword phrases with org and createdAt filters", async () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const { service, search } = createService(
      jest.fn().mockResolvedValue({
        hits: {
          hits: [
            {
              _score: 2,
              _source: { itemMetaId: "meta-1" },
              highlight: { title: ["NVIDIA"] },
            },
          ],
        },
      }),
    );

    const hits = await service.searchLiteralKeywords(
      "org-1",
      [" NVIDIA  ", "nvidia", "AI chips"],
      { createdAtGte: since, limit: 1_200 },
    );

    expect(search).toHaveBeenCalledTimes(1);
    const request = search.mock.calls[0]?.[0] as any;
    expect(request.index).toBe("items-alias");
    expect(request.size).toBe(1000);
    expect(request.query.bool.filter).toEqual([
      { term: { orgId: "org-1" } },
      { range: { createdAt: { gte: since.toISOString() } } },
    ]);
    expect(request.query.bool.minimum_should_match).toBe(1);
    expect(request.query.bool.should).toHaveLength(2);
    expect(request.query.bool.should[0].multi_match).toMatchObject({
      query: "NVIDIA",
      type: "phrase",
    });
    expect(request.query.bool.should[1].multi_match).toMatchObject({
      query: "AI chips",
      type: "phrase",
    });
    expect(hits).toEqual([
      { id: "meta-1", score: 2, highlights: { title: ["NVIDIA"] } },
    ]);
  });

  it("does not query Elasticsearch for empty literal keywords", async () => {
    const { service, search } = createService();

    const hits = await service.searchLiteralKeywords("org-1", [" ", ""], {
      limit: 10,
    });

    expect(hits).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
});
