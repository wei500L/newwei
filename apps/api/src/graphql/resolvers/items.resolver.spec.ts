import { BadRequestException } from "@nestjs/common";
import DataLoader from "dataloader";

import { ItemsOrderBy, ItemsRankingMode } from "../dto/item.input";

import { ItemsResolver } from "./items.resolver";

jest.mock(
  "@modular/vector-client",
  () => ({
    VectorBadResponseError: class VectorBadResponseError extends Error {},
    VectorClient: class VectorClient {
      search = jest.fn();
      upsert = jest.fn();
    },
    VectorServiceUnavailableError: class VectorServiceUnavailableError extends Error {},
    VectorUnauthorizedError: class VectorUnauthorizedError extends Error {},
  }),
  { virtual: true }
);

const createEmptyReadModelLoader = () =>
  new DataLoader(async (keys: readonly string[]) => keys.map(() => null));

const makeInfo = (fields: string[]) =>
  ({
    fieldNodes: [
      {
        selectionSet: {
          selections: fields.map((field) => ({
            kind: "Field",
            name: { value: field }
          }))
        }
      }
    ],
    fragments: {}
  }) as any;

describe("ItemsResolver.processed", () => {
  const resolver = new ItemsResolver({} as any);

  const baseProcessed = {
    id: "processed-1",
    itemMetaId: "meta-1",
    status: "completed",
    tags: [],
    createdAt: new Date()
  };

  it("normalizes result when stored as JSON string", async () => {
    const loader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        ...baseProcessed,
        result: JSON.stringify({ title: "Hello" })
      }))
    );

    const result = await resolver.processed(
      { metaId: "meta-1" } as any,
      makeInfo(["result", "resultJson"]),
      createEmptyReadModelLoader() as any,
      createEmptyReadModelLoader() as any,
      loader as any,
      loader as any
    );
    expect(result?.result).toBeDefined();
    expect(JSON.parse(result!.result!)).toMatchObject({ title: "Hello" });
    expect(result?.resultJson).toMatchObject({ title: "Hello" });
  });

  it("returns stable JSON string when result is an object", async () => {
    const loader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        ...baseProcessed,
        result: { title: "Object Result", topics: ["t1"] }
      }))
    );

    const result = await resolver.processed(
      { metaId: "meta-1" } as any,
      makeInfo(["result", "resultJson"]),
      createEmptyReadModelLoader() as any,
      createEmptyReadModelLoader() as any,
      loader as any,
      loader as any
    );
    expect(JSON.parse(result!.result!)).toMatchObject({ title: "Object Result", topics: ["t1"] });
    expect(result?.resultJson).toMatchObject({ title: "Object Result", topics: ["t1"] });
  });

  it("returns undefined when result is invalid JSON", async () => {
    const loader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        ...baseProcessed,
        result: "{not-json"
      }))
    );

    const result = await resolver.processed(
      { metaId: "meta-1" } as any,
      makeInfo(["result", "resultJson"]),
      createEmptyReadModelLoader() as any,
      createEmptyReadModelLoader() as any,
      loader as any,
      loader as any
    );
    expect(result?.result).toBeUndefined();
    expect(result?.resultJson).toBeNull();
  });
});

describe("ItemsResolver time fields", () => {
  it("aliases ingestedAt to item createdAt in list query", async () => {
    const itemsService = {
      listWithCursor: jest.fn().mockResolvedValue({
        items: [
          {
            id: "meta-1",
            name: "Item 1",
            status: "active",
            createdAt: new Date("2024-01-01T00:00:00Z"),
            updatedAt: new Date("2024-01-02T00:00:00Z"),
            orgId: "org-1"
          }
        ],
        hasNextPage: false,
        totalCount: 1
      })
    };
    const resolver = new ItemsResolver(itemsService as any);

    const result = await resolver.items(
      { user: { orgId: "org-1" } } as any,
      { first: 1 } as any,
      {
        fieldNodes: [{ selectionSet: { selections: [] } }],
        fragments: {}
      } as any
    );
    expect(result.edges[0].node.ingestedAt).toEqual(result.edges[0].node.createdAt);
  });

  it("resolves publishedAt from processed.result.published_at", async () => {
    const resolver = new ItemsResolver({} as any);
    const processedLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "processed-1",
        itemMetaId: "meta-1",
        status: "completed",
        tags: [],
        result: { published_at: "2024-01-01T00:00:00Z" },
        createdAt: new Date()
      }))
    );
    const rawLoader = new DataLoader(async (keys: readonly string[]) => keys.map(() => null));

    const publishedAt = await resolver.publishedAt(
      { metaId: "meta-1" } as any,
      createEmptyReadModelLoader() as any,
      processedLoader as any,
      rawLoader as any
    );

    expect(publishedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("resolves publishedAt from processed.result.publishedAt", async () => {
    const resolver = new ItemsResolver({} as any);
    const processedLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "processed-1",
        itemMetaId: "meta-1",
        status: "completed",
        tags: [],
        result: { publishedAt: "2024-01-01T00:00:00Z" },
        createdAt: new Date()
      }))
    );
    const rawLoader = new DataLoader(async (keys: readonly string[]) => keys.map(() => null));

    const publishedAt = await resolver.publishedAt(
      { metaId: "meta-1" } as any,
      createEmptyReadModelLoader() as any,
      processedLoader as any,
      rawLoader as any
    );

    expect(publishedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("returns publishedAt from item meta when available", async () => {
    const resolver = new ItemsResolver({} as any);
    const processedLoader = new DataLoader(async (keys: readonly string[]) => keys.map(() => null));
    const rawLoader = new DataLoader(async (keys: readonly string[]) => keys.map(() => null));

    const publishedAt = await resolver.publishedAt(
      { metaId: "meta-1", publishedAt: "2024-02-01T12:34:56.000Z" } as any,
      createEmptyReadModelLoader() as any,
      processedLoader as any,
      rawLoader as any
    );

    expect(publishedAt).toBe("2024-02-01T12:34:56.000Z");
  });

  it("falls back publishedAt to raw payload when processed result missing", async () => {
    const resolver = new ItemsResolver({} as any);
    const processedLoader = new DataLoader(async (keys: readonly string[]) => keys.map(() => null));
    const rawLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "raw-1",
        itemMetaId: "meta-1",
        payload: { publishedAt: "2024-01-03T00:00:00Z" },
        createdAt: new Date(),
        updatedAt: new Date()
      }))
    );

    const publishedAt = await resolver.publishedAt(
      { metaId: "meta-1" } as any,
      createEmptyReadModelLoader() as any,
      processedLoader as any,
      rawLoader as any
    );

    expect(publishedAt).toBe("2024-01-03T00:00:00.000Z");
  });
});

describe("ItemsResolver preview fields", () => {
  it("resolves processedPreview with normalized arrays", async () => {
    const resolver = new ItemsResolver({} as any);
    const processedLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "processed-1",
        itemMetaId: "meta-1",
        status: "completed",
        tags: ["t1"],
        result: {
          title: "LLM headline",
          source: "Example",
          published_at: "2024-01-01T00:00:00Z",
          language: "zh-CN",
          summary: "Hello",
          content_type: "news_fact",
          sentiment_label: "Positive",
          topics: ["Topic A", "Topic A", "Topic B"],
          entities: [{ name: "Entity A" }, { name: "Entity A" }, "Entity B"],
          quality_score: 0.9,
          location: "US"
        },
        duplicateOf: null,
        duplicateSimilarity: 0.42,
        llm: { model: "gpt-test" },
        createdAt: new Date("2024-01-02T00:00:00Z"),
        updatedAt: new Date("2024-01-02T00:00:00Z")
      }))
    );

    const preview = await resolver.processedPreview(
      { metaId: "meta-1" } as any,
      createEmptyReadModelLoader() as any,
      processedLoader as any
    );
    expect(preview?.title).toBe("LLM headline");
    expect(preview?.language).toBe("zh-CN");
    expect(preview?.summary).toBe("Hello");
    expect(preview?.sentiment).toBe("Positive");
    expect(preview?.contentType).toBe("news_fact");
    expect(preview?.source).toBe("Example");
    expect(preview?.publishedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(preview?.topics).toEqual(["Topic A", "Topic B"]);
    expect(preview?.entities).toEqual(["Entity A", "Entity B"]);
    expect(preview?.qualityScore).toBe(0.9);
    expect(preview?.location).toBe("US");
    expect(preview?.duplicateSimilarity).toBe(0.42);
  });

  it("normalizes processedPreview when result uses mixed shapes", async () => {
    const resolver = new ItemsResolver({} as any);
    const processedLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "processed-1",
        itemMetaId: "meta-1",
        status: "completed",
        tags: [],
        result: {
          headline: "Fallback title",
          source_name: "Example",
          publishedAt: "2024-01-01T00:00:00Z",
          lang: "en",
          abstract: "Hello",
          contentType: "insight",
          sentimentLabel: "Positive",
          topics: [{ name: "Topic A" }, { label: "Topic B" }, "Topic C"],
          entities: ["Entity A", { name: "Entity B" }],
          quality_score: "0.75",
          region: "US"
        },
        duplicateOf: null,
        duplicateSimilarity: 0.42,
        llm: { model: "gpt-test" },
        createdAt: new Date("2024-01-02T00:00:00Z"),
        updatedAt: new Date("2024-01-02T00:00:00Z")
      }))
    );

    const preview = await resolver.processedPreview(
      { metaId: "meta-1" } as any,
      createEmptyReadModelLoader() as any,
      processedLoader as any
    );

    expect(preview?.title).toBe("Fallback title");
    expect(preview?.language).toBe("en");
    expect(preview?.summary).toBe("Hello");
    expect(preview?.sentiment).toBe("Positive");
    expect(preview?.contentType).toBe("analysis");
    expect(preview?.source).toBe("Example");
    expect(preview?.publishedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(preview?.topics).toEqual(["Topic A", "Topic B", "Topic C"]);
    expect(preview?.entities).toEqual(["Entity A", "Entity B"]);
    expect(preview?.qualityScore).toBe(0.75);
    expect(preview?.location).toBe("US");
  });

  it("resolves rawPreview from payload metadata", async () => {
    const resolver = new ItemsResolver({} as any);
    const rawLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "raw-1",
        itemMetaId: "meta-1",
        payload: {
          url: "https://example.com",
          sourceName: "Example Source",
          metadata: {
            thumbnailUrl: "https://example.com/thumb.png",
            summary: "Raw summary",
            sentiment: "neutral",
            region: "US",
            location: "New York",
            ticker: "AAPL",
            price: 123.45,
            changePercent: -1.23,
            history: [
              { timestamp: "2024-01-01", value: 1 },
              { time: "2024-01-02", value: "2.5" },
              { date: "2024-01-03", value: 3 },
              { timestamp: "", value: 4 }
            ]
          }
        },
        source: "api",
        createdAt: new Date("2024-01-02T00:00:00Z"),
        updatedAt: new Date("2024-01-02T00:00:00Z")
      }))
    );

    const preview = await resolver.rawPreview(
      { metaId: "meta-1" } as any,
      createEmptyReadModelLoader() as any,
      rawLoader as any
    );
    expect(preview).toMatchObject({
      url: "https://example.com",
      sourceName: "Example Source",
      thumbnail: "https://example.com/thumb.png",
      summary: "Raw summary",
      sentiment: "neutral",
      region: "US",
      location: "New York",
      ticker: "AAPL",
      price: 123.45,
      changePercent: -1.23
    });
    expect(preview?.history).toEqual([
      { timestamp: "2024-01-01", value: 1 },
      { timestamp: "2024-01-02", value: 2.5 },
      { timestamp: "2024-01-03", value: 3 }
    ]);
  });

  it("falls back rawPreview fields to payload root when metadata missing", async () => {
    const resolver = new ItemsResolver({} as any);
    const rawLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "raw-1",
        itemMetaId: "meta-1",
        payload: {
          url: "https://example.com",
          sourceName: "Example Source",
          thumbnail: "https://example.com/thumb.png",
          summary: "Raw summary",
          sentiment: "neutral",
          region: "US",
          location: "New York",
          ticker: "AAPL",
          price: "123.45",
          change_percent: "-1.23",
          history: [{ timestamp: "2024-01-01", value: "2.5" }]
        },
        source: "api",
        createdAt: new Date("2024-01-02T00:00:00Z"),
        updatedAt: new Date("2024-01-02T00:00:00Z")
      }))
    );

    const preview = await resolver.rawPreview(
      { metaId: "meta-1" } as any,
      createEmptyReadModelLoader() as any,
      rawLoader as any
    );
    expect(preview).toMatchObject({
      url: "https://example.com",
      sourceName: "Example Source",
      thumbnail: "https://example.com/thumb.png",
      summary: "Raw summary",
      sentiment: "neutral",
      region: "US",
      location: "New York",
      ticker: "AAPL",
      price: 123.45,
      changePercent: -1.23
    });
    expect(preview?.history).toEqual([{ timestamp: "2024-01-01", value: 2.5 }]);
  });

  it("falls back to the Mongo raw loader when the read model exists without a raw snapshot", async () => {
    // B9: hydration may persist a read model before the pipeline produced the
    // raw/processed documents. A read-model doc with a null snapshot must not
    // shadow the live Mongo data.
    const resolver = new ItemsResolver({} as any);
    const rawLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        id: "raw-1",
        itemMetaId: "meta-1",
        payload: {
          url: "https://example.com/fallback",
          sourceName: "Fallback Source"
        },
        source: "api",
        createdAt: new Date("2024-01-02T00:00:00Z"),
        updatedAt: new Date("2024-01-02T00:00:00Z")
      }))
    );
    const readModelLoader = new DataLoader(async (keys: readonly string[]) =>
      keys.map(() => ({
        itemMetaId: "meta-1",
        meta: {
          id: "meta-1",
          externalId: "ext-1",
          name: "Meta 1",
          status: "pending",
          mongoRef: null,
          createdAt: new Date("2024-01-01T00:00:00Z"),
          updatedAt: new Date("2024-01-01T00:00:00Z")
        },
        raw: null,
        processed: null
      }))
    );

    const preview = await resolver.rawPreview(
      { metaId: "meta-1" } as any,
      readModelLoader as any,
      rawLoader as any
    );
    expect(preview).toMatchObject({
      url: "https://example.com/fallback",
      sourceName: "Fallback Source"
    });
  });
});

describe("ItemsResolver pagination", () => {
  it("rejects mixing cursor and page pagination", async () => {
    const resolver = new ItemsResolver({} as any);

    await expect(
      resolver.items(
        { user: { orgId: "org-1" } } as any,
        { first: 10, after: "cursor", page: 1 } as any,
        {
          fieldNodes: [{ selectionSet: { selections: [] } }],
          fragments: {}
        } as any
      )
    ).rejects.toThrow(BadRequestException);
  });

  it("uses page-based pagination and returns hasNextPage", async () => {
    const itemsService = {
      list: jest.fn().mockResolvedValue({
        items: [
          {
            id: "meta-1",
            name: "Item 1",
            status: "active",
            createdAt: new Date("2024-01-01T00:00:00Z"),
            updatedAt: new Date("2024-01-02T00:00:00Z"),
            orgId: "org-1"
          },
          {
            id: "meta-2",
            name: "Item 2",
            status: "active",
            createdAt: new Date("2024-01-03T00:00:00Z"),
            updatedAt: new Date("2024-01-04T00:00:00Z"),
            orgId: "org-1"
          }
        ],
        total: 25,
        page: 2,
        pageSize: 10
      }),
      listWithCursor: jest.fn()
    };

    const resolver = new ItemsResolver(itemsService as any);

    const result = await resolver.items(
      { user: { orgId: "org-1" } } as any,
      { first: 10, page: 2, orderBy: ItemsOrderBy.CREATED_DESC } as any,
      {
        fieldNodes: [{ selectionSet: { selections: [] } }],
        fragments: {}
      } as any
    );

    expect(itemsService.list).toHaveBeenCalledWith(
      "org-1",
      2,
      10,
      undefined,
      undefined,
      "CREATED_DESC",
      "RECENCY",
      undefined
    );
    expect(itemsService.listWithCursor).not.toHaveBeenCalled();
    expect(result.totalCount).toBe(25);
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.edges).toHaveLength(2);
  });

  it("encodes published sorting cursor with sortAt", async () => {
    const sortAt = new Date("2024-01-05T12:00:00Z");
    const itemsService = {
      list: jest.fn().mockResolvedValue({
        items: [
          {
            id: "meta-1",
            name: "Item 1",
            status: "active",
            createdAt: new Date("2024-01-01T00:00:00Z"),
            updatedAt: new Date("2024-01-02T00:00:00Z"),
            sortAt,
            orgId: "org-1"
          }
        ],
        total: 1,
        page: 1,
        pageSize: 10
      })
    };

    const resolver = new ItemsResolver(itemsService as any);

    const result = await resolver.items(
      { user: { orgId: "org-1" } } as any,
      { first: 10, page: 1, orderBy: ItemsOrderBy.PUBLISHED_DESC } as any,
      {
        fieldNodes: [{ selectionSet: { selections: [] } }],
        fragments: {}
      } as any
    );

    expect(itemsService.list).toHaveBeenCalledWith(
      "org-1",
      1,
      10,
      undefined,
      undefined,
      "PUBLISHED_DESC",
      "RECENCY",
      undefined
    );

    const cursor = result.edges[0]?.cursor;
    expect(cursor).toBeDefined();
    const decoded = JSON.parse(Buffer.from(cursor!, "base64").toString("utf8")) as {
      id: string;
      sortAt?: string;
    };
    expect(decoded).toMatchObject({ id: "meta-1", sortAt: sortAt.toISOString() });
  });

  it("defaults to relevance ranking when search is present", async () => {
    const itemsService = {
      list: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 10
      })
    };
    const resolver = new ItemsResolver(itemsService as any);

    await resolver.items(
      { user: { orgId: "org-1" } } as any,
      { first: 10, page: 1, search: "fed rate", orderBy: ItemsOrderBy.CREATED_DESC } as any,
      {
        fieldNodes: [{ selectionSet: { selections: [] } }],
        fragments: {}
      } as any
    );

    expect(itemsService.list).toHaveBeenCalledWith(
      "org-1",
      1,
      10,
      "fed rate",
      undefined,
      "CREATED_DESC",
      ItemsRankingMode.RELEVANCE,
      undefined
    );
  });

  it("skips cursor totalCount unless selected in the GraphQL query", async () => {
    const itemsService = {
      listWithCursor: jest.fn().mockResolvedValue({
        items: [],
        hasNextPage: false,
        totalCount: 0
      })
    };
    const resolver = new ItemsResolver(itemsService as any);

    await resolver.items(
      { user: { orgId: "org-1", id: "user-1" } } as any,
      { first: 10, orderBy: ItemsOrderBy.CREATED_DESC } as any,
      {
        fieldNodes: [
          {
            selectionSet: {
              selections: [{ kind: "Field", name: { value: "edges" } }]
            }
          }
        ],
        fragments: {}
      } as any
    );

    expect(itemsService.listWithCursor).toHaveBeenCalledWith(
      "org-1",
      10,
      undefined,
      undefined,
      undefined,
      "CREATED_DESC",
      "RECENCY",
      "user-1",
      false
    );
  });
});
