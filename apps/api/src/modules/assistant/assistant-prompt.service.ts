import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import type { LiteLlmMessage } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";

export const AssistantQueryPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("news_negative_list"),
    topic: z.string().min(1),
    lookbackDays: z.number().int().min(1).max(90).optional(),
    limit: z.number().int().min(1).max(50).optional()
  }),
  z.object({
    kind: z.literal("correlation_gold_usd"),
    lookbackDays: z.number().int().min(7).max(3650).optional(),
    transform: z.enum(["return", "level"]).optional()
  }),
  z.object({
    kind: z.literal("correlation_two_series"),
    seriesA: z.string().min(1),
    seriesB: z.string().min(1),
    lookbackDays: z.number().int().min(7).max(3650).optional(),
    transform: z.enum(["return", "level"]).optional()
  }),
  z.object({
    kind: z.literal("unsupported"),
    reason: z.string().optional()
  })
]);

export type AssistantQueryPlan = z.infer<typeof AssistantQueryPlanSchema>;

const ASSISTANT_QUERY_PLAN_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  AssistantQueryPlanSchema,
  { $refStrategy: "none" }
);

const ASSISTANT_QUERY_PLAN_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "assistant_query_plan",
    schema: ASSISTANT_QUERY_PLAN_JSON_SCHEMA
  }
};

export const CorrelationFieldSelectionSchema = z.object({
  fieldA: z.string().min(1),
  fieldB: z.string().min(1)
});

export type CorrelationFieldSelection = z.infer<typeof CorrelationFieldSelectionSchema>;

const CORRELATION_FIELD_SELECTION_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  CorrelationFieldSelectionSchema,
  { $refStrategy: "none" }
);

const CORRELATION_FIELD_SELECTION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "assistant_correlation_field_selection",
    schema: CORRELATION_FIELD_SELECTION_JSON_SCHEMA
  }
};

export const CorrelationSeriesSelectionSchema = z.object({
  slugA: z.string().min(1),
  slugB: z.string().min(1)
});

export type CorrelationSeriesSelection = z.infer<typeof CorrelationSeriesSelectionSchema>;

const CORRELATION_SERIES_SELECTION_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  CorrelationSeriesSelectionSchema,
  { $refStrategy: "none" }
);

const CORRELATION_SERIES_SELECTION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "assistant_correlation_series_selection",
    schema: CORRELATION_SERIES_SELECTION_JSON_SCHEMA
  }
};

@Injectable()
export class AssistantPromptService {
  buildQueryPlannerRequest(message: string): { messages: LiteLlmMessage[]; responseFormat: JsonSchemaResponseFormat } {
    const system = [
      "You are a planner for a finance analysis assistant.",
      "Your job: classify the user request into one supported plan and extract parameters.",
      "Return ONLY valid JSON matching the provided schema.",
      "",
      "Supported kinds:",
      "- news_negative_list: list negative news about a topic for a recent time window.",
      "- correlation_two_series: analyze correlation between any two economic indicators.",
      "",
      "Rules:",
      "- If the user asks for negative news, use news_negative_list and extract the topic.",
      "- If the user asks about correlation between two indicators, use correlation_two_series and extract the two indicators.",
      "- Indicators can be natural language names (e.g., 'gold price', 'USD index') or explicit slugs (e.g., 'usd_index_history').",
      "- Otherwise, use unsupported."
    ].join("\n");

    const user = [
      "User request:",
      message
    ].join("\n");

    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      responseFormat: ASSISTANT_QUERY_PLAN_RESPONSE_FORMAT
    };
  }

  buildCorrelationSeriesSelectorRequest(input: {
    question: string;
    seriesA: {
      query: string;
      candidates: { slug: string; displayName: string; description?: string | null }[];
    };
    seriesB: {
      query: string;
      candidates: { slug: string; displayName: string; description?: string | null }[];
    };
  }): { messages: LiteLlmMessage[]; responseFormat: JsonSchemaResponseFormat } {
    const system = [
      "You are selecting the best economic time series slug for correlation analysis.",
      "Pick EXACTLY one slug for each series (slugA and slugB) from the provided candidates.",
      "Return ONLY valid JSON matching the schema.",
      "",
      "Guidance:",
      "- Prefer the candidate that best matches the user's wording and intent.",
      "- Prefer widely-used headline series over niche variants when ambiguous."
    ].join("\n");

    const userPayload = {
      question: input.question,
      seriesA: input.seriesA,
      seriesB: input.seriesB
    };

    const user = [
      "Candidates (JSON):",
      JSON.stringify(userPayload)
    ].join("\n");

    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      responseFormat: CORRELATION_SERIES_SELECTION_RESPONSE_FORMAT
    };
  }

  buildCorrelationFieldSelectorRequest(input: {
    seriesA: { slug: string; displayName?: string | null; fields: { name: string; count: number }[] };
    seriesB: { slug: string; displayName?: string | null; fields: { name: string; count: number }[] };
  }): { messages: LiteLlmMessage[]; responseFormat: JsonSchemaResponseFormat } {
    const system = [
      "You are selecting the best sourceField for two economic time series.",
      "Pick one field for each series from the provided candidates.",
      "Return ONLY valid JSON matching the schema.",
      "",
      "Guidance:",
      "- Prefer the primary level series (e.g., close/last) over open/high/low/change percent.",
      "- Prefer fields with higher sample counts."
    ].join("\n");

    const userPayload = {
      seriesA: input.seriesA,
      seriesB: input.seriesB
    };

    const user = [
      "Candidate fields (JSON):",
      JSON.stringify(userPayload)
    ].join("\n");

    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      responseFormat: CORRELATION_FIELD_SELECTION_RESPONSE_FORMAT
    };
  }

  buildNewsListRendererMessages(input: {
    question: string;
    startDate: string;
    endDate: string;
    items: {
      title?: string | null;
      summary?: string | null;
      source?: string | null;
      publishedAt?: string | null;
      url?: string | null;
      sentiment?: string | null;
      itemMetaId: string;
    }[];
  }): LiteLlmMessage[] {
    const system = [
      "You are a finance news analyst.",
      "Write the response in Simplified Chinese.",
      "Only use the provided items; do not invent facts or URLs.",
      "Keep the output concise and actionable."
    ].join("\n");

    const user = [
      `Question: ${input.question}`,
      `Time window: ${input.startDate} to ${input.endDate}`,
      "Items (JSON):",
      JSON.stringify(input.items)
    ].join("\n");

    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }

  buildCorrelationRendererMessages(input: {
    question: string;
    startDate: string;
    endDate: string;
    seriesA: { slug: string; displayName?: string | null; field: string; docUrl?: string | null };
    seriesB: { slug: string; displayName?: string | null; field: string; docUrl?: string | null };
    stats: { n: number; pearson?: number | null };
    references?: { label: string; value: string }[];
  }): LiteLlmMessage[] {
    const system = [
      "You are a quantitative finance analyst.",
      "Write the response in Simplified Chinese.",
      "Explain the correlation result and key caveats.",
      "Do not claim causality.",
      "Only use the provided statistics and metadata; do not invent numbers."
    ].join("\n");

    const userPayload = {
      question: input.question,
      timeWindow: { startDate: input.startDate, endDate: input.endDate },
      seriesA: input.seriesA,
      seriesB: input.seriesB,
      stats: input.stats,
      references: input.references ?? []
    };

    const user = [
      "Input (JSON):",
      JSON.stringify(userPayload)
    ].join("\n");

    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }
}
