import { describe, expect, it } from "vitest";

import {
  mergeAlertEventLists,
  mergeItemsConnection,
  readAlertEventList,
  readItemsConnection,
} from "../lib/apollo-cache-policies";

describe("apollo cache policies", () => {
  it("reads a cached items page only when the requested page slice is complete", () => {
    const pageOne = mergeItemsConnection(
      undefined,
      {
        __typename: "ItemConnection",
        totalCount: 3,
        pageInfo: { page: 1 },
        edges: [{ cursor: "a" }, { cursor: "b" }],
      },
      { first: 2, page: 1 },
    );

    expect(readItemsConnection(pageOne, { first: 2, page: 1 })?.edges).toEqual([
      { cursor: "a" },
      { cursor: "b" },
    ]);
    expect(readItemsConnection(pageOne, { first: 2, page: 2 })).toBeUndefined();

    const pageTwo = mergeItemsConnection(
      pageOne,
      {
        __typename: "ItemConnection",
        totalCount: 3,
        pageInfo: { page: 2 },
        edges: [{ cursor: "c" }],
      },
      { first: 2, page: 2 },
    );

    expect(readItemsConnection(pageTwo, { first: 2, page: 2 })?.edges).toEqual([
      { cursor: "c" },
    ]);
  });

  it("dedupes and sorts alert events while limit reads require enough cached rows", () => {
    const merged = mergeAlertEventLists(
      [
        { id: "older", triggeredAt: "2026-01-01T00:00:00.000Z" },
        { id: "same", triggeredAt: "2026-01-02T00:00:00.000Z" },
      ],
      [
        { id: "newer", triggeredAt: "2026-01-03T00:00:00.000Z" },
        { id: "same", triggeredAt: "2026-01-04T00:00:00.000Z" },
      ],
    );

    expect(merged.map((event) => (event as { id: string }).id)).toEqual([
      "same",
      "newer",
      "older",
    ]);
    expect(readAlertEventList(merged, { limit: 2 })?.length).toBe(2);
    expect(readAlertEventList(merged.slice(0, 1), { limit: 2 })).toBeUndefined();
  });
});
