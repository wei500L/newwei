import { Injectable } from "@nestjs/common";
import { NewsPromptConfig } from "./news-prompt-config.service";

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
  buildSystemPrompt(config: NewsPromptConfig, language?: string) {
    const languageHint = language
      ? `All free-text fields should use ${language}.`
      : "";
    return this.renderTemplate(config.systemPromptTemplate, {
      language_hint: languageHint,
    });
  }

  buildUserPrompt(config: NewsPromptConfig, input: PromptInput) {
    const metadataSection =
      input.metadata && Object.keys(input.metadata).length > 0
        ? `Metadata: ${JSON.stringify(input.metadata)}`
        : "";
    const keywordsSection =
      input.keywords.length > 0
        ? `Focus topics: ${input.keywords.join(", ")}`
        : "";
    const summaryHintsSection =
      input.summaryHints.length > 0
        ? `Summary hints: ${input.summaryHints.join("; ")}`
        : "";

    const rendered = this.renderTemplate(config.userPromptTemplate, {
      url: input.url,
      cache_hit: input.cacheHit ? "yes" : "no",
      metadata_section: metadataSection,
      keywords_section: keywordsSection,
      summary_hints_section: summaryHintsSection,
      markdown: input.markdown,
    });

    return this.squashEmptyLines(rendered);
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

  private renderTemplate(template: string, context: Record<string, string>) {
    return Object.entries(context).reduce((acc, [key, value]) => {
      const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
      return acc.replace(pattern, value ?? "");
    }, template);
  }

  private squashEmptyLines(input: string) {
    return input
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line, idx, arr) => {
        const currentEmpty = line.trim().length === 0;
        const prevEmpty = idx > 0 && arr[idx - 1].trim().length === 0;
        return !(currentEmpty && prevEmpty);
      })
      .join("\n")
      .trim();
  }
}
