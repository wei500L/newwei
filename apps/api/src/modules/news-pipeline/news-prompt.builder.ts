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
    const languageHint = language ? `Use ${language} for the final output.` : "";
    return [
      "You are a news sanitation assistant embedded in an ingestion pipeline.",
      "Return concise JSON that keeps the article body faithful to the source while removing navigation bars, ads, footers, reactions, comment counts, share prompts, newsletter embeds, or unrelated recommendations.",
      "Normalize whitespace, keep paragraphs separated by double line breaks, and include bullet lists with '- ' prefixes.",
      "Preserve the article ordering, figure captions, block quotes, and inline code snippets.",
      "If the story lacks a clear body, return status='error' with an explanatory message instead of empty content.",
      languageHint
    ]
      .filter(Boolean)
      .join(" ");
  }

  buildUserPrompt(input: PromptInput) {
    const pieces: string[] = [
      `URL: ${input.url}`,
      `Cache hit: ${input.cacheHit ? "yes" : "no"}`,
      input.metadata ? `Metadata: ${JSON.stringify(input.metadata)}` : "",
      input.keywords.length > 0 ? `Focus topics: ${input.keywords.join(", ")}` : "",
      input.summaryHints.length > 0 ? `Summary hints: ${input.summaryHints.join("; ")}` : "",
      "",
      "Clean this markdown while keeping only the newsworthy sections:",
      input.markdown
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
          required: ["status", "title", "content", "source"],
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["ok", "error"],
              description: "Mark error when the article body cannot be extracted."
            },
            title: {
              type: "string",
              description: "Readable headline without site suffixes."
            },
            content: {
              type: "string",
              description: "Markdown body stripped of navigation, ads, paywall notices, share prompts, and comments."
            },
            publish_time: {
              type: ["string", "null"],
              description: "ISO8601 timestamp if available."
            },
            publish_timezone: {
              type: ["string", "null"]
            },
            author: {
              type: ["string", "null"]
            },
            source: {
              type: "object",
              required: ["url"],
              additionalProperties: false,
              properties: {
                url: { type: "string" },
                name: { type: ["string", "null"] },
                domain: { type: ["string", "null"] }
              }
            },
            summary: {
              type: ["string", "null"],
              description: "3-4 sentence abstract of the article."
            },
            highlights: {
              type: "array",
              items: { type: "string" },
              description: "Key bullet points, ordered by importance."
            },
            keywords: {
              type: "array",
              items: { type: "string" },
              description: "Important topical keywords."
            },
            sentiment: {
              type: ["string", "null"],
              description: "Optional tone classification such as neutral/positive/negative."
            },
            sections: {
              type: "array",
              items: {
                type: "object",
                required: ["body"],
                properties: {
                  heading: { type: ["string", "null"] },
                  body: { type: "string" }
                }
              }
            },
            metadata: {
              type: "object",
              description: "Optional structured hints such as tickers, geographies, languages.",
              additionalProperties: true
            },
            error: {
              type: ["string", "null"],
              description: "Populate when status=error."
            }
          }
        }
      }
    };
  }
}
