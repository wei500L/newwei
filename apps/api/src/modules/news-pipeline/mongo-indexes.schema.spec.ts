import {
  ItemReadModelModel,
  LlmRequestLogModel,
  NewsEventClusteringFailureModel,
  ProcessedItemModel,
  RawItemModel,
} from "@modular/mongo";
import type { Model } from "mongoose";

type IndexKey = Record<string, 1 | -1 | "text">;

function schemaIndexes(model: Model<unknown>) {
  return model.schema.indexes();
}

function hasIndex(model: Model<unknown>, key: IndexKey) {
  return schemaIndexes(model).some(([candidate]) => {
    const entries = Object.entries(candidate);
    const expected = Object.entries(key);
    return (
      entries.length === expected.length &&
      expected.every(([field, value], index) => {
        const entry = entries[index];
        return entry?.[0] === field && entry[1] === value;
      })
    );
  });
}

function findIndex(model: Model<unknown>, name: string) {
  return schemaIndexes(model).find(([, options]) => options?.name === name);
}

describe("Mongo hot-path indexes", () => {
  it("declares ProcessedItem search and war-map indexes without redundant single-field indexes", () => {
    expect(findIndex(ProcessedItemModel as Model<unknown>, "processed_item_org_status_search_text")).toEqual([
      expect.objectContaining({
        orgId: 1,
        status: 1,
        "result.title": "text",
        "result.summary": "text",
        "result.entities.name": "text",
        tags: "text",
      }),
      expect.objectContaining({
        default_language: "none",
      }),
    ]);
    expect(findIndex(ProcessedItemModel as Model<unknown>, "processed_item_war_map_location_recency")).toEqual([
      {
        orgId: 1,
        status: 1,
        hasLocation: 1,
        duplicateOf: 1,
        sortAt: -1,
        ingestedAt: -1,
        createdAt: -1,
      },
      expect.any(Object),
    ]);
    expect(hasIndex(ProcessedItemModel as Model<unknown>, { orgId: 1 })).toBe(false);
    expect(hasIndex(ProcessedItemModel as Model<unknown>, { itemMetaId: 1 })).toBe(false);
    expect(hasIndex(ProcessedItemModel as Model<unknown>, { sourceId: 1 })).toBe(false);
  });

  it("declares ItemReadModel prefix search indexes without a single orgId index", () => {
    expect(
      hasIndex(ItemReadModelModel as Model<unknown>, {
        orgId: 1,
        titleLower: 1,
        sortAt: -1,
        itemMetaId: -1,
      }),
    ).toBe(true);
    expect(
      hasIndex(ItemReadModelModel as Model<unknown>, {
        orgId: 1,
        externalIdLower: 1,
        sortAt: -1,
        itemMetaId: -1,
      }),
    ).toBe(true);
    expect(hasIndex(ItemReadModelModel as Model<unknown>, { orgId: 1 })).toBe(false);
  });

  it("declares RawItem itemMetaId recency index without a single itemMetaId index", () => {
    expect(hasIndex(RawItemModel as Model<unknown>, { itemMetaId: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(RawItemModel as Model<unknown>, { itemMetaId: 1 })).toBe(false);
  });

  it("declares the clustering failure auto-retry index", () => {
    expect(findIndex(NewsEventClusteringFailureModel as Model<unknown>, "news_event_failure_auto_retry")).toEqual([
      {
        status: 1,
        clusteringMode: 1,
        lastAttemptAt: 1,
        createdAt: 1,
      },
      expect.objectContaining({
        partialFilterExpression: { itemCount: { $gt: 0 } },
      }),
    ]);
  });

  it("keeps LLM request log compound indexes but removes redundant single-field indexes", () => {
    expect(hasIndex(LlmRequestLogModel as Model<unknown>, { orgId: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(LlmRequestLogModel as Model<unknown>, { orgId: 1, model: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(LlmRequestLogModel as Model<unknown>, { orgId: 1 })).toBe(false);
    expect(hasIndex(LlmRequestLogModel as Model<unknown>, { model: 1 })).toBe(false);
    expect(hasIndex(LlmRequestLogModel as Model<unknown>, { status: 1 })).toBe(false);
    expect(hasIndex(LlmRequestLogModel as Model<unknown>, { apiSurface: 1 })).toBe(false);
  });
});
