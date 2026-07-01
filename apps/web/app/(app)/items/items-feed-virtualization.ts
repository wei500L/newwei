export const ITEMS_FEED_VIRTUALIZATION_THRESHOLD = 20;

export function shouldVirtualizeItemsFeed(itemCount: number): boolean {
  return itemCount > ITEMS_FEED_VIRTUALIZATION_THRESHOLD;
}

export function shouldUpdateItemsFeedMetric(
  previousValue: number,
  nextValue: number,
): boolean {
  if (!Number.isFinite(nextValue)) {
    return false;
  }
  return Math.abs(previousValue - nextValue) > 1;
}

export function estimateItemsFeedRowSize(params: {
  density: string;
  isReaderPreset: boolean;
}): number {
  if (params.density === "compact") {
    return params.isReaderPreset ? 190 : 170;
  }
  return params.isReaderPreset ? 300 : 260;
}
