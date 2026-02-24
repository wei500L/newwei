export type SearchField = "topic" | "region" | "sentiment" | "source";

interface SuggestionRequestPlanInput {
  currentSeq: number;
  prefix: string;
  hasFieldContext: boolean;
}

interface SuggestionRequestPlan {
  shouldFetch: boolean;
  nextSeq: number;
}

const MIN_PREFIX_WITHOUT_FIELD_CONTEXT = 2;

export function resolveSuggestionRequestPlan({
  currentSeq,
  prefix,
  hasFieldContext,
}: SuggestionRequestPlanInput): SuggestionRequestPlan {
  const minPrefixLength = hasFieldContext ? 0 : MIN_PREFIX_WITHOUT_FIELD_CONTEXT;
  if (prefix.length < minPrefixLength) {
    return {
      shouldFetch: false,
      nextSeq: currentSeq + 1,
    };
  }

  return {
    shouldFetch: true,
    nextSeq: currentSeq,
  };
}
