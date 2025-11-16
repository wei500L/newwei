import { Injectable } from "@nestjs/common";

export interface PromptInput {
  url: string;
  markdown: string;
  metadata?: Record<string, unknown>;
  keywords: string[];
  summaryHints: string[];
  language?: string;
  cacheHit: boolean;
}

export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
  };
}

@Injectable()
export class NewsPromptBuilder {
  buildSystemPrompt(language?: string) {
    const languageHint = language
      ? `All free-text fields should use ${language}.`
      : "";
    return [
      "You are part of a news normalization pipeline that outputs structured JSON.",
      "Strip navigation, footers, legal boilerplate, promos, and unrelated recommendations while keeping facts, quotes, figures, and emphasis.",
      "Summaries must be 200-300 Chinese characters describing who/what/when/where/why.",
      "Return 5-8 key_points as single-sentence bullets emphasizing chronology, numbers, and impact.",
      "Entities must include type (person/org/location/product/index/policy/other) and confidence 0-1.",
      "Set removed_noise_types to the categories you deleted (e.g., footer, nav, ads).",
      "quality_score is a decimal 0-1 reflecting completeness, readability, and de-noising success.",
      "Use null for fields you cannot infer, never omit required properties.",
      languageHint,
    ]
      .filter(Boolean)
      .join(" ");
  }

  buildUserPrompt(input: PromptInput) {
    const pieces: string[] = [
      `URL: ${input.url}`,
      `Cache hit: ${input.cacheHit ? "yes" : "no"}`,
      input.metadata ? `Metadata: ${JSON.stringify(input.metadata)}` : "",
      input.keywords.length > 0
        ? `Focus topics: ${input.keywords.join(", ")}`
        : "",
      input.summaryHints.length > 0
        ? `Summary hints: ${input.summaryHints.join("; ")}`
        : "",
      "",
      "Clean this markdown while keeping only the newsworthy sections:",
      input.markdown,
    ];
    return pieces.filter(Boolean).join("\n");
  }

  buildResponseFormat(): JsonSchemaResponseFormat {
    return {
      type: "json_schema",
      json_schema: {
        name: "clean_news_payload",
        schema: {
          type: "object",
          required: [
            "title",
            "summary",
            "key_points",
            "cleaned_markdown",
            "removed_noise_types",
            "quality_score",
          ],
          additionalProperties: false,
          properties: {
            title: {
              type: ["string", "null"],
              description: "Readable headline without site suffixes.",
            },
            author: {
              type: ["string", "null"],
            },
            source: {
              type: ["string", "null"],
              description: "Publisher or channel name.",
            },
            subtitle: { type: ["string", "null"] },
            published_at: {
              type: ["string", "null"],
              description: "ISO8601 timestamp.",
            },
            language: { type: ["string", "null"] },
            location: {
              type: ["string", "null"],
              description: "City/region if mentioned.",
            },
            category: { type: ["string", "null"] },
            summary: {
              type: ["string", "null"],
              description:
                "200-300 Chinese characters covering who/what/when/where/why.",
            },
            key_points: {
              type: "array",
              minItems: 5,
              maxItems: 8,
              items: { type: "string" },
              description: "Chronological bullet points with data/impact.",
            },
            topics: {
              type: "array",
              items: { type: "string" },
              description: "Key tags / sectors.",
            },
            entities: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "type", "confidence"],
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                },
              },
            },
            cleaned_markdown: {
              type: "string",
              description: "Noise-free markdown body.",
            },
            removed_noise_types: {
              type: "array",
              items: { type: "string" },
              description:
                "List of noise categories removed (e.g., footer, nav, ads).",
            },
            quality_score: {
              type: ["number", "null"],
              minimum: 0,
              maximum: 1,
            },
            llm_model: { type: ["string", "null"] },
            llm_prompt_version: { type: ["string", "null"] },
          },
        },
      },
    };
  }
}
