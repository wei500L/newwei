import type { NewsnowDomesticOpinionIndexResponse } from '../hooks/use-news-sources';

export function buildDomesticOpinionSparklinePath(
  values: number[],
  width: number,
  height: number,
): string {
  if (values.length === 0) {
    return '';
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

export function shouldShowDomesticOpinionPanel(input: {
  domesticOpinion?: NewsnowDomesticOpinionIndexResponse;
  isLoading?: boolean;
  isError?: boolean;
}): boolean {
  if (input.isLoading || input.isError) {
    return true;
  }
  return input.domesticOpinion !== undefined;
}

export function shouldSyncDomesticOpinionWithHottestAnalysis(input: {
  columnKey: string;
  hottestAnalysisGeneratedAt?: string | null;
  lastSyncedAnalysisGeneratedAt?: string | null;
}): boolean {
  if (input.columnKey !== 'hottest') {
    return false;
  }

  const hottestAnalysisGeneratedAt =
    typeof input.hottestAnalysisGeneratedAt === 'string'
      ? input.hottestAnalysisGeneratedAt.trim()
      : '';
  if (!hottestAnalysisGeneratedAt) {
    return false;
  }

  const lastSyncedAnalysisGeneratedAt =
    typeof input.lastSyncedAnalysisGeneratedAt === 'string'
      ? input.lastSyncedAnalysisGeneratedAt.trim()
      : '';

  return hottestAnalysisGeneratedAt !== lastSyncedAnalysisGeneratedAt;
}
