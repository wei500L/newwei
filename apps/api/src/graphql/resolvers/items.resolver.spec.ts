import DataLoader from "dataloader";
import { BadRequestException } from "@nestjs/common";

import { ItemsResolver } from "./items.resolver";
import { ItemsOrderBy } from "../dto/item.input";

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

    const result = await resolver.processed({ metaId: "meta-1" } as any, loader as any);
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

    const result = await resolver.processed({ metaId: "meta-1" } as any, loader as any);
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

    const result = await resolver.processed({ metaId: "meta-1" } as any, loader as any);
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

    const result = await resolver.items({ user: { orgId: "org-1" } } as any, { first: 1 } as any);
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
      processedLoader as any,
      rawLoader as any
    );

    expect(publishedAt).toBe("2024-01-01T00:00:00.000Z");
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
      processedLoader as any,
      rawLoader as any
    );

    expect(publishedAt).toBe("2024-01-03T00:00:00.000Z");
  });
});

describe("ItemsResolver pagination", () => {
  it("rejects mixing cursor and page pagination", async () => {
    const resolver = new ItemsResolver({} as any);

    await expect(
      resolver.items(
        { user: { orgId: "org-1" } } as any,
        { first: 10, after: "cursor", page: 1 } as any
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
      { first: 10, page: 2, orderBy: ItemsOrderBy.CREATED_DESC } as any
    );

    expect(itemsService.list).toHaveBeenCalledWith(
      "org-1",
      2,
      10,
      undefined,
      undefined,
      "CREATED_DESC"
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
      { first: 10, page: 1, orderBy: ItemsOrderBy.PUBLISHED_DESC } as any
    );

    expect(itemsService.list).toHaveBeenCalledWith(
      "org-1",
      1,
      10,
      undefined,
      undefined,
      "PUBLISHED_DESC"
    );

    const cursor = result.edges[0]?.cursor;
    expect(cursor).toBeDefined();
    const decoded = JSON.parse(Buffer.from(cursor!, "base64").toString("utf8")) as {
      id: string;
      sortAt?: string;
    };
    expect(decoded).toMatchObject({ id: "meta-1", sortAt: sortAt.toISOString() });
  });
});
