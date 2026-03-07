export const NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE =
  'NEWS_SOURCE_RUNTIME_SECRET_REQUIRED';

export class NewsSourceRuntimeSecretRequiredError extends Error {
  readonly code = NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE;
  readonly sourceId: string;
  readonly requiredKeys: string[];

  constructor(input: {
    sourceId: string;
    requiredKeys: string[];
    message?: string;
  }) {
    super(
      input.message ?? `Runtime secret required for news source: ${input.sourceId}`,
    );
    this.name = 'NewsSourceRuntimeSecretRequiredError';
    this.sourceId = input.sourceId;
    this.requiredKeys = Array.from(
      new Set(
        input.requiredKeys
          .map((key) => key.trim())
          .filter((key) => key.length > 0),
      ),
    );
  }
}
