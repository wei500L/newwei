export class AnalysisStreamError extends Error {
  readonly partialSummary: string;

  constructor(message: string, partialSummary: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnalysisStreamError";
    this.partialSummary = partialSummary;
  }
}

export function getPartialSummaryFromError(error: unknown): string | undefined {
  if (error instanceof AnalysisStreamError) {
    return typeof error.partialSummary === "string" && error.partialSummary.length > 0
      ? error.partialSummary
      : undefined;
  }
  return undefined;
}
