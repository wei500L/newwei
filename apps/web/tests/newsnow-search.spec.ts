import { describe, expect, it } from "vitest";

import { buildNewsnowSearchSources } from "../app/(app)/newsnow/lib/newsnow-search";
import type { MetadataResponse } from "../app/(app)/newsnow/hooks/use-news-sources";

const metadata: MetadataResponse = {
  sources: {
    canonical: {
      name: "主源",
      interval: 30_000,
      color: "blue",
      title: "Canonical Feed"
    },
    canonical_alias: {
      name: "主源别名",
      interval: 30_000,
      color: "blue",
      redirect: "canonical"
    },
    uncategorized: {
      name: "未分类源",
      interval: 30_000,
      color: "red"
    }
  },
  columns: {
    hottest: {
      name: "热门",
      sources: ["canonical"]
    }
  }
};

describe("newsnow searchable sources", () => {
  it("filters out redirect aliases from search results", () => {
    const results = buildNewsnowSearchSources(metadata, "");
    const ids = results.map((entry) => entry.id);

    expect(ids).toEqual(["canonical", "uncategorized"]);
    expect(ids).not.toContain("canonical_alias");
  });

  it("does not surface redirect alias even when alias keyword matches", () => {
    const results = buildNewsnowSearchSources(metadata, "别名");

    expect(results).toEqual([]);
  });

  it("falls back to 其他 when source is not assigned to any column", () => {
    const results = buildNewsnowSearchSources(metadata, "未分类");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "uncategorized",
      column: "其他"
    });
  });
});
