export interface NewsEventLike {
  representativeProcessedItemId?: string | null;
  items?: { processedItemId?: string | null }[] | null;
}

export function pickRepresentativeProcessedItemId(event?: NewsEventLike | null): string | null {
  const representative = typeof event?.representativeProcessedItemId === "string" ? event.representativeProcessedItemId.trim() : "";
  if (representative) {
    return representative;
  }

  for (const item of event?.items ?? []) {
    const candidate = typeof item?.processedItemId === "string" ? item.processedItemId.trim() : "";
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

