import { describe, expect, it } from "vitest";

import {
  ITEMS_PAGE_SIZE_OPTIONS_STRINGS,
  MAX_ITEMS_PAGE_SIZE,
  clampItemsPageSize,
  getItemsLastPage,
  normalizeItemsPaginationChange
} from "../app/(app)/items/pagination";

describe("items pagination helpers", () => {
  it("clamps page size into [1, MAX]", () => {
    expect(clampItemsPageSize(0)).toBe(1);
    expect(clampItemsPageSize(1)).toBe(1);
    expect(clampItemsPageSize(MAX_ITEMS_PAGE_SIZE + 10)).toBe(MAX_ITEMS_PAGE_SIZE);
  });

  it("computes last page from totalCount and pageSize", () => {
    expect(getItemsLastPage(0, 10)).toBe(1);
    expect(getItemsLastPage(1, 10)).toBe(1);
    expect(getItemsLastPage(100, 50)).toBe(2);
    expect(getItemsLastPage(101, 50)).toBe(3);
  });

  it("resets to page 1 when pageSize changes", () => {
    expect(
      normalizeItemsPaginationChange({
        nextPage: 5,
        nextPageSize: 20,
        currentPageSize: 10,
        totalCount: 999
      })
    ).toEqual({ page: 1, pageSize: 20 });
  });

  it("clamps nextPage to lastPage when totalCount is known", () => {
    expect(
      normalizeItemsPaginationChange({
        nextPage: 999,
        currentPageSize: 10,
        totalCount: 42
      })
    ).toEqual({ page: 5, pageSize: 10 });
  });

  it("still normalizes when totalCount is unknown", () => {
    expect(
      normalizeItemsPaginationChange({
        nextPage: 0,
        nextPageSize: MAX_ITEMS_PAGE_SIZE + 10,
        currentPageSize: 10,
        totalCount: null
      })
    ).toEqual({ page: 1, pageSize: MAX_ITEMS_PAGE_SIZE });
  });

  it("pageSizeOptions always includes MAX as a string", () => {
    expect(ITEMS_PAGE_SIZE_OPTIONS_STRINGS).toContain(String(MAX_ITEMS_PAGE_SIZE));
  });
});

