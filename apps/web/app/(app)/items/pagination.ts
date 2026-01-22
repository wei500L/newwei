export const MAX_ITEMS_PAGE_SIZE = 50;
export const DEFAULT_ITEMS_PAGE_SIZE = 10;

export const ITEMS_PAGE_SIZE_OPTIONS = Array.from(
  new Set([10, 20, MAX_ITEMS_PAGE_SIZE].filter((size) => size <= MAX_ITEMS_PAGE_SIZE))
).sort((a, b) => a - b);

export const ITEMS_PAGE_SIZE_OPTIONS_STRINGS = ITEMS_PAGE_SIZE_OPTIONS.map(String);

export function clampItemsPageSize(value: number) {
  return Math.min(Math.max(1, value), MAX_ITEMS_PAGE_SIZE);
}

export function getItemsLastPage(totalCount: number, pageSize: number) {
  const normalizedTotalCount =
    typeof totalCount === "number" && Number.isFinite(totalCount) && totalCount > 0 ? totalCount : 0;
  const normalizedPageSize = clampItemsPageSize(pageSize);
  return Math.max(1, Math.ceil(normalizedTotalCount / normalizedPageSize));
}

export function normalizeItemsPaginationChange(params: {
  nextPage: number;
  nextPageSize?: number;
  currentPageSize: number;
  totalCount?: number | null;
}) {
  const normalizedCurrentPageSize = clampItemsPageSize(params.currentPageSize);
  const normalizedPageSize = clampItemsPageSize(params.nextPageSize ?? normalizedCurrentPageSize);
  const pageSizeChanged = normalizedPageSize !== normalizedCurrentPageSize;
  const desiredPage = pageSizeChanged ? 1 : params.nextPage;
  const normalizedDesiredPage = Math.max(1, desiredPage);

  const totalCount = params.totalCount;
  if (typeof totalCount !== "number" || !Number.isFinite(totalCount)) {
    return { page: normalizedDesiredPage, pageSize: normalizedPageSize };
  }

  const lastPage = getItemsLastPage(totalCount, normalizedPageSize);
  return { page: Math.min(normalizedDesiredPage, lastPage), pageSize: normalizedPageSize };
}

