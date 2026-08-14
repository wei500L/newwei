import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { type JsonSchema7Type, zodToJsonSchema } from "zod-to-json-schema";

import { extractFirstJson } from "../../common/llm-json";
import { QueuePermanentError } from "../queue/queue.error-handling";

import { LiteLlmService } from "./litellm.service";
import { NewsExtractionProviderId } from "./news-extraction-settings.service";
import { CleanedNewsSchema, type CleanedNews } from "./news-pipeline.schema";
import { type NewsPromptConfig } from "./news-prompt-config.service";
import {
  type EnrichmentPromptInput,
  NewsPromptBuilder,
  type JsonSchemaResponseFormat,
} from "./news-prompt.builder";

export interface NewsStageLlmMetadata {
  provider: NewsExtractionProviderId;
  model: string | null;
  promptVersion: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  requestedModel?: string | null;
  fallbackUsed?: boolean;
}

export interface NewsStageContext {
  orgId: string;
  jobId: string;
}

const EntityExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
});

const SentimentExtractionSchema = z.object({
  sentiment_label: z.enum(["positive", "neutral", "negative"]),
});

const KgRelationExtractionSchema = z.object({
  kg_relations: CleanedNewsSchema.shape.kg_relations.default([]),
});

const entityResponseFormat = buildResponseFormat(
  "news_entity_extraction_response",
  EntityExtractionSchema,
);
const sentimentResponseFormat = buildResponseFormat(
  "news_sentiment_extraction_response",
  SentimentExtractionSchema,
);
const kgResponseFormat = buildResponseFormat(
  "news_kg_extraction_response",
  KgRelationExtractionSchema,
);

function buildResponseFormat(
  name: string,
  schema: z.ZodTypeAny,
): JsonSchemaResponseFormat {
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema: zodToJsonSchema(schema, {
        $refStrategy: "none",
      }) as JsonSchema7Type,
    },
  };
}

@Injectable()
export class NewsExtractionStageService {
  constructor(
    private readonly liteLlm: LiteLlmService,
    private readonly promptBuilder: NewsPromptBuilder,
  ) {}

  async cleanWithLlm(
    context: NewsStageContext,
    promptConfig: NewsPromptConfig,
    input: {
      systemPrompt: string;
      denoisePrompt: string;
      userPrompt: string;
      completionTimeoutMs: number;
    },
  ): Promise<{
    cleaned: CleanedNews;
    llm: NewsStageLlmMetadata;
  }> {
    const response = await this.liteLlm.acompletion({
      orgId: context.orgId,
      messages: [
        {
          role: "system",
          content: input.systemPrompt,
        },
        {
          role: "user",
          content: input.denoisePrompt,
        },
        {
          role: "user",
          content: input.userPrompt,
        },
      ],
      response_format: this.promptBuilder.buildResponseFormat(),
      metadata: {
        jobId: context.jobId,
        source: "news-pipeline",
        feature: "clean",
      },
      timeoutMs: input.completionTimeoutMs,
    });

    return {
      cleaned: CleanedNewsSchema.parse(
        this.parseStageResponse(
          response.choices[0]?.message?.content,
          CleanedNewsSchema,
        ),
      ) as CleanedNews,
      llm: this.toStageLlmMetadata(
        response,
        promptConfig.version,
        NewsExtractionProviderId.llm,
      ),
    };
  }

  async extractEntities(
    context: NewsStageContext,
    promptConfig: NewsPromptConfig,
    provider: NewsExtractionProviderId,
    input: EnrichmentPromptInput,
  ): Promise<{
    entities: CleanedNews["entities"];
    llm: NewsStageLlmMetadata | null;
  }> {
    if (provider !== NewsExtractionProviderId.llm) {
      throw new Error(`Unsupported entity provider: ${provider}`);
    }

    const response = await this.liteLlm.acompletion({
      orgId: context.orgId,
      messages: [
        {
          role: "system",
          content: promptConfig.entitySystemPromptTemplate,
        },
        {
          role: "user",
          content: this.promptBuilder.buildEntityPrompt(promptConfig, input),
        },
      ],
      temperature: 0,
      top_p: 1,
      max_tokens: 600,
      response_format: entityResponseFormat,
      metadata: {
        jobId: context.jobId,
        source: "news-pipeline",
        feature: "extract_entities",
      },
    });

    const parsed = this.parseStageResponse(
      response.choices[0]?.message?.content,
      EntityExtractionSchema,
    );
    return {
      entities: parsed.entities ?? [],
      llm: this.toStageLlmMetadata(response, promptConfig.version, provider),
    };
  }

  async analyzeSentiment(
    context: NewsStageContext,
    promptConfig: NewsPromptConfig,
    provider: NewsExtractionProviderId,
    input: EnrichmentPromptInput,
  ): Promise<{
    sentimentLabel: NonNullable<CleanedNews["sentiment_label"]>;
    llm: NewsStageLlmMetadata | null;
  }> {
    if (provider !== NewsExtractionProviderId.llm) {
      throw new Error(`Unsupported sentiment provider: ${provider}`);
    }

    const response = await this.liteLlm.acompletion({
      orgId: context.orgId,
      messages: [
        {
          role: "system",
          content: promptConfig.sentimentSystemPromptTemplate,
        },
        {
          role: "user",
          content: this.promptBuilder.buildSentimentPrompt(promptConfig, input),
        },
      ],
      temperature: 0,
      top_p: 1,
      max_tokens: 180,
      response_format: sentimentResponseFormat,
      metadata: {
        jobId: context.jobId,
        source: "news-pipeline",
        feature: "extract_sentiment",
      },
    });

    const parsed = this.parseStageResponse(
      response.choices[0]?.message?.content,
      SentimentExtractionSchema,
    );
    return {
      sentimentLabel: parsed.sentiment_label,
      llm: this.toStageLlmMetadata(response, promptConfig.version, provider),
    };
  }

  async extractKgRelations(
    context: NewsStageContext,
    promptConfig: NewsPromptConfig,
    provider: NewsExtractionProviderId,
    input: EnrichmentPromptInput,
  ): Promise<{
    relations: CleanedNews["kg_relations"];
    llm: NewsStageLlmMetadata | null;
  }> {
    if (provider !== NewsExtractionProviderId.llm) {
      throw new Error(`Unsupported knowledge graph provider: ${provider}`);
    }

    const response = await this.liteLlm.acompletion({
      orgId: context.orgId,
      messages: [
        {
          role: "system",
          content: promptConfig.kgSystemPromptTemplate,
        },
        {
          role: "user",
          content: this.promptBuilder.buildKgPrompt(promptConfig, input),
        },
      ],
      temperature: 0,
      top_p: 1,
      max_tokens: 900,
      response_format: kgResponseFormat,
      metadata: {
        jobId: context.jobId,
        source: "news-pipeline",
        feature: "extract_kg",
      },
    });

    const parsed = this.parseStageResponse(
      response.choices[0]?.message?.content,
      KgRelationExtractionSchema,
    );
    return {
      relations: CleanedNewsSchema.shape.kg_relations.parse(
        parsed.kg_relations ?? [],
      ) as CleanedNews["kg_relations"],
      llm: this.toStageLlmMetadata(response, promptConfig.version, provider),
    };
  }

  private parseStageResponse<T>(
    content: string | null | undefined,
    schema: z.ZodSchema<T>,
  ): T {
    if (!content) {
      throw new QueuePermanentError("LiteLLM returned empty content");
    }
    const jsonText = extractFirstJson(content);
    if (!jsonText) {
      throw new QueuePermanentError("LiteLLM return was not valid JSON");
    }
    try {
      return schema.parse(JSON.parse(jsonText));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new QueuePermanentError("LiteLLM return was not valid JSON");
      }
      throw error;
    }
  }

  private toStageLlmMetadata(
    response: Awaited<ReturnType<LiteLlmService["acompletion"]>>,
    promptVersion: string,
    provider: NewsExtractionProviderId,
  ): NewsStageLlmMetadata {
    return {
      provider,
      model: response.model,
      promptVersion,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      costUsd: response.costUsd ?? null,
      latencyMs: response.latencyMs ?? null,
      requestedModel: response.requestedModel ?? null,
      fallbackUsed: response.fallbackUsed === true,
    };
  }
}
