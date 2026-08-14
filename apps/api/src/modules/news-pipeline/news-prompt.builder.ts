import { Injectable } from "@nestjs/common";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import { CleanedNewsSchema } from "./news-pipeline.schema";
import { NewsPromptConfig } from "./news-prompt-config.service";

export const UNTRUSTED_ARTICLE_TAG = "untrusted_article";

export function wrapUntrustedArticle(content: string): string {
  const safe = content.replaceAll(`</${UNTRUSTED_ARTICLE_TAG}>`, `</ ${UNTRUSTED_ARTICLE_TAG}>`);
  return `<${UNTRUSTED_ARTICLE_TAG}>\n${safe}\n</${UNTRUSTED_ARTICLE_TAG}>`;
}

export interface PromptInput {
  url: string;
  markdown: string;
  metadata?: Record<string, unknown>;
  keywords: string[];
  summaryHints: string[];
  language?: string;
  cacheHit: boolean;
}

export interface EnrichmentPromptInput {
  title?: string | null;
  summary?: string | null;
  markdown: string;
  language?: string | null;
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

const DEFAULT_REMOVED_NOISE_TYPES = [
  "nav",
  "header",
  "footer",
  "sidebar",
  "ads",
  "promo",
  "subscription",
  "social",
  "related_links",
  "comments",
  "legal",
  "cookie_banner",
  "author_bio",
  "tag_cloud",
  "unrelated",
  "garbled_text",
  "scripts",
  "tracking",
  "other",
];

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

  buildDenoisePrompt(config: NewsPromptConfig) {
    return this.renderTemplate(config.denoisePromptTemplate, {
      noise_type_list: DEFAULT_REMOVED_NOISE_TYPES.join(", "),
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
      markdown: wrapUntrustedArticle(input.markdown),
    });

    return this.squashEmptyLines(rendered);
  }

  buildResponseFormat(): JsonSchemaResponseFormat {
    return CLEANED_NEWS_RESPONSE_FORMAT;
  }

  buildEntityPrompt(config: NewsPromptConfig, input: EnrichmentPromptInput) {
    return this.renderStagePrompt(config.entityUserPromptTemplate, input);
  }

  buildSentimentPrompt(config: NewsPromptConfig, input: EnrichmentPromptInput) {
    return this.renderStagePrompt(config.sentimentUserPromptTemplate, input);
  }

  buildKgPrompt(config: NewsPromptConfig, input: EnrichmentPromptInput) {
    return this.renderStagePrompt(config.kgUserPromptTemplate, input);
  }

  private renderTemplate(template: string, context: Record<string, string>) {
    return Object.entries(context).reduce((acc, [key, value]) => {
      const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
      return acc.replace(pattern, value ?? "");
    }, template);
  }

  private renderStagePrompt(
    template: string,
    input: EnrichmentPromptInput,
  ): string {
    const rendered = this.renderTemplate(template, {
      title: input.title ?? "",
      summary: input.summary ?? "",
      markdown: wrapUntrustedArticle(input.markdown),
      language: input.language ?? "",
    });
    return this.squashEmptyLines(rendered);
  }

  private squashEmptyLines(input: string) {
    return input
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line, idx, arr) => {
        const currentEmpty = line.trim().length === 0;
        const prevEmpty = idx > 0 && arr[idx - 1]!.trim().length === 0;
        return !(currentEmpty && prevEmpty);
      })
      .join("\n")
      .trim();
  }
}
