const ALLOWED_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

function normalizeSentimentValues(values?: string[] | null): Set<string> {
  const normalized = new Set<string>();

  if (!Array.isArray(values)) {
    return normalized;
  }

  values.forEach((value) => {
    const nextValue = value.trim().toLowerCase();
    if (ALLOWED_SENTIMENTS.includes(nextValue as (typeof ALLOWED_SENTIMENTS)[number])) {
      normalized.add(nextValue);
    }
  });

  return normalized;
}

export function resolveAvailableSentiments(
  facetSentiments?: string[] | null,
  selectedSentiments?: string[] | null,
): string[] {
  const combined = normalizeSentimentValues(facetSentiments);
  normalizeSentimentValues(selectedSentiments).forEach((value) => {
    combined.add(value);
  });

  return ALLOWED_SENTIMENTS.filter((value) => combined.has(value));
}
