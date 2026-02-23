import dayjs from "@/lib/dayjs";

export type CursorBucketGranularity = "day" | "week" | "month" | "auto";

export const SPACETIME_GEO_ARTICLES_PAGE_SIZE = 30;
export const SPACETIME_GEO_ARTICLES_MAX_LIMIT = 80;

export const resolveBucketIntervalUnit = (
  granularity?: CursorBucketGranularity | null
) => {
  switch (granularity) {
    case "week":
      return "week" as const;
    case "month":
      return "month" as const;
    case "day":
    case "auto":
    default:
      return "day" as const;
  }
};

export const resolveBucketGranularityKey = (
  granularity?: CursorBucketGranularity | null
) => {
  switch (granularity) {
    case "week":
      return "weekly";
    case "month":
      return "monthly";
    case "day":
    case "auto":
    default:
      return "daily";
  }
};

export const inferBucketGranularityFromStarts = (
  bucketStarts: string[]
): Exclude<CursorBucketGranularity, "auto"> => {
  if (!Array.isArray(bucketStarts) || bucketStarts.length === 0) {
    return "day";
  }

  const uniqueMs = Array.from(
    new Set(
      bucketStarts
        .map((value) => dayjs(value).valueOf())
        .filter((value) => Number.isFinite(value))
    )
  ).sort((a, b) => a - b);

  if (uniqueMs.length < 4) {
    return "day";
  }

  const deltas: number[] = [];
  for (let index = 1; index < uniqueMs.length; index += 1) {
    const delta = uniqueMs[index]! - uniqueMs[index - 1]!;
    if (delta > 0) {
      deltas.push(delta);
    }
  }

  if (deltas.length < 3) {
    return "day";
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const hasDailyCadence = deltas.some((delta) => delta <= 1.5 * dayMs);
  if (hasDailyCadence) {
    return "day";
  }

  const evidenceThreshold = Math.max(2, Math.ceil(deltas.length * 0.6));
  const weeklyLikeCount = deltas.filter(
    (delta) => delta >= 6 * dayMs && delta <= 8 * dayMs
  ).length;
  if (weeklyLikeCount >= evidenceThreshold) {
    return "week";
  }

  const monthlyLikeCount = deltas.filter(
    (delta) => delta >= 27 * dayMs && delta <= 32 * dayMs
  ).length;
  if (monthlyLikeCount >= evidenceThreshold) {
    return "month";
  }

  return "day";
};

export const resolveBucketEndIso = (
  bucketStart: string,
  granularity?: CursorBucketGranularity | null
): string | null => {
  const parsed = dayjs(bucketStart);
  if (!parsed.isValid()) {
    return null;
  }
  return parsed.add(1, resolveBucketIntervalUnit(granularity)).toISOString();
};

interface ResolveTooltipBucketEndIsoArgs {
  bucketStart: string;
  cursorBucketStartIso?: string | null;
  cursorBucketEndIso?: string | null;
  granularity?: CursorBucketGranularity | null;
}

export const resolveTooltipBucketEndIso = ({
  bucketStart,
  cursorBucketStartIso,
  cursorBucketEndIso,
  granularity,
}: ResolveTooltipBucketEndIsoArgs): string | null => {
  const start = bucketStart.trim();
  if (!start) {
    return null;
  }
  const expectedEndIso = resolveBucketEndIso(start, granularity);
  const cursorStart = cursorBucketStartIso?.trim() ?? "";
  const explicitEnd = cursorBucketEndIso?.trim() ?? "";
  if (cursorStart && explicitEnd && start === cursorStart) {
    const explicit = dayjs(explicitEnd);
    if (explicit.isValid()) {
      if (!expectedEndIso) {
        return explicit.toISOString();
      }
      const expectedMs = dayjs(expectedEndIso).valueOf();
      const explicitMs = explicit.valueOf();
      const toleranceMs = 60 * 60 * 1000;
      if (Number.isFinite(expectedMs) && Math.abs(explicitMs - expectedMs) <= toleranceMs) {
        return explicit.toISOString();
      }
    }
  }
  return expectedEndIso;
};

export const resolveArticleLimit = (
  page: number,
  pageSize = SPACETIME_GEO_ARTICLES_PAGE_SIZE,
  maxLimit = SPACETIME_GEO_ARTICLES_MAX_LIMIT
) => {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  return Math.min(maxLimit, safePage * pageSize);
};

export const canLoadMoreArticles = (
  hasMore: boolean,
  currentLimit: number,
  maxLimit = SPACETIME_GEO_ARTICLES_MAX_LIMIT
) => hasMore && currentLimit < maxLimit;
