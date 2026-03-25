export interface NewsnowGridVirtualizationInput {
  activeDragId: string | null;
  gridWidth: number;
  isMobile: boolean;
  rowGroupCount: number;
}

export function shouldVirtualizeNewsnowGridRows(
  input: NewsnowGridVirtualizationInput,
): boolean {
  if (input.activeDragId) {
    return false;
  }

  if (input.rowGroupCount <= 4) {
    return false;
  }

  if (input.isMobile) {
    return true;
  }

  return input.gridWidth > 0;
}

export function shouldUpdateNewsnowGridMetric(
  previousValue: number,
  nextValue: number,
): boolean {
  if (!Number.isFinite(nextValue)) {
    return false;
  }

  return Math.abs(previousValue - nextValue) > 1;
}
