import { Injectable } from "@nestjs/common";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";
import { NewsPromptConfig } from "./news-prompt-config.service";
import { CleanedNewsSchema } from "./news-pipeline.schema";

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
    schema: JsonSchema7Type;
  };
}

const CLEANED_NEWS_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  CleanedNewsSchema,
  { $refStrategy: "none" },
);

const CLEANED_NEWS_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "clean_news_payload",
    schema: CLEANED_NEWS_JSON_SCHEMA,
  },
};

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
    return CLEANED_NEWS_RESPONSE_FORMAT;
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
