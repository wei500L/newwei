export class AssistantStreamError extends Error {
  public readonly partialSummary: string;

  constructor(message: string, partialSummary: string, options?: { cause?: Error }) {
    // Preserve the original message for logging and persistence.
    super(message, options);
    this.name = "AssistantStreamError";
    this.partialSummary = partialSummary;
  }
}

