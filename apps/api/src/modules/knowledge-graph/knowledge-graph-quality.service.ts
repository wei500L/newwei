import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import { LiteLlmService } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";

import type { KnowledgeGraphSettings } from "./knowledge-graph-settings.service";

const logger = createLogger({ name: "knowledge-graph-quality" });

interface KgEntityRef {
  name: string;
  type: string;
}

export interface KgRelationForIngestion {
  subject: KgEntityRef;
  predicate: string;
  object: KgEntityRef;
  confidence: number;
  properties?: Record<string, unknown>;
  evidence?: string | null;
  validation?: Record<string, unknown>;
}

const RelationValidationSchema = z.object({
  verdict: z.enum(["yes", "no", "uncertain"]),
  confidence: z.number().min(0).max(1)
});

type RelationValidation = z.infer<typeof RelationValidationSchema>;

const RELATION_VALIDATION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "kg_relation_validation",
    schema: zodToJsonSchema(RelationValidationSchema, {
      $refStrategy: "none"
    }) as JsonSchema7Type
  }
};

@Injectable()
export class KnowledgeGraphQualityService {
  constructor(private readonly liteLlm: LiteLlmService) {}

  async prepareRelationsForIngestion(input: {
    orgId: string;
    articleId: string;
    title?: string | null;
    summary?: string | null;
    language?: string | null;
    kgRelations: unknown;
    settings: KnowledgeGraphSettings;
    maxRelationsPerArticle: number;
  }): Promise<{
    relations: KgRelationForIngestion[];
    minConfidenceApplied: number;
    validatedRelations: number;
    filteredRelations: number;
  }> {
    const normalized = this.normalizeRelations(input.kgRelations);
    if (normalized.length === 0) {
      return {
        relations: [],
        minConfidenceApplied: input.settings.minEdgeConfidence,
        validatedRelations: 0,
        filteredRelations: 0
      };
    }

    const minConfidenceApplied = this.computeMinConfidenceThreshold(
      normalized.map((relation) => relation.confidence),
      input.settings
    );

    const enriched = normalized.slice();
    let validatedRelations = 0;

    if (input.settings.multiModelValidationEnabled) {
      const models = await this.resolveValidationModels(input.settings);
      const modelCount = this.clampInt(input.settings.multiModelValidationModelCount, 2, 3, 3);
      const selectedModels = models.slice(0, modelCount);

      if (selectedModels.length >= 2 && input.settings.multiModelValidationMaxRelationsPerArticle > 0) {
        const candidates = enriched
          .filter((relation) => relation.confidence >= Math.max(0, minConfidenceApplied - 0.1))
          .sort((a, b) => a.confidence - b.confidence)
          .slice(0, input.settings.multiModelValidationMaxRelationsPerArticle);

        for (const relation of candidates) {
          const validated = await this.validateRelation({
            orgId: input.orgId,
            articleId: input.articleId,
            title: input.title,
            summary: input.summary,
            language: input.language,
            relation,
            models: selectedModels
          });
          if (validated) {
            relation.confidence = validated.adjustedConfidence;
            relation.validation = validated.validation;
            validatedRelations += 1;
          }
        }
      }
    }

    const filtered = enriched
      .filter((relation) => relation.confidence >= minConfidenceApplied)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, Math.max(0, input.maxRelationsPerArticle));

    return {
      relations: filtered,
      minConfidenceApplied,
      validatedRelations,
      filteredRelations: Math.max(0, enriched.length - filtered.length)
    };
  }

  private normalizeRelations(raw: unknown): KgRelationForIngestion[] {
    if (raw === null || raw === undefined) {
      return [];
    }
    if (typeof raw === "string") {
      try {
        return this.normalizeRelations(JSON.parse(raw));
      } catch {
        return [];
      }
    }

    if (!Array.isArray(raw)) {
      return [];
    }

    const normalized: KgRelationForIngestion[] = [];

    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const subject = this.parseEntityRef(record.subject);
      const object = this.parseEntityRef(record.object);
      const predicate = typeof record.predicate === "string" ? record.predicate.trim() : "";
      const confidence = this.toConfidence(record.confidence);
      const properties = this.toOptionalObject(record.properties);
      const evidence = typeof record.evidence === "string" ? record.evidence.trim() : null;

      if (!subject || !object || !predicate || confidence === null) {
        continue;
      }

      normalized.push({
        subject,
        object,
        predicate,
        confidence,
        properties,
        evidence: evidence && evidence.length > 0 ? evidence : null
      });
    }

    return normalized;
  }

  private parseEntityRef(value: unknown): KgEntityRef | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    if (!name || !type) {
      return null;
    }
    return { name, type };
  }

  private toConfidence(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  private toOptionalObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private computeMinConfidenceThreshold(confidences: number[], settings: KnowledgeGraphSettings) {
    const base = this.clampNumber(settings.minEdgeConfidence, 0, 1, 0.55);
    if (!settings.dynamicEdgeConfidenceEnabled) {
      return base;
    }
    const q = this.clampNumber(settings.dynamicEdgeConfidenceQuantile, 0, 1, 0.25);
    if (confidences.length === 0) {
      return base;
    }
    const sorted = confidences.slice().sort((a, b) => a - b);
    const index = Math.floor((sorted.length - 1) * q);
    const quantile = sorted[index];
    return Math.max(base, typeof quantile === "number" && Number.isFinite(quantile) ? quantile : base);
  }

  private async resolveValidationModels(settings: KnowledgeGraphSettings): Promise<string[]> {
    const configured = Array.isArray(settings.multiModelValidationModels)
      ? settings.multiModelValidationModels
          .map((model) => (typeof model === "string" ? model.trim() : ""))
          .filter((model) => model.length > 0)
      : [];

    if (configured.length > 0) {
      return Array.from(new Set(configured));
    }

    try {
      return await this.liteLlm.getCompletionModels();
    } catch (error) {
      logger.warn({ err: error }, "Failed to resolve validation models from LiteLLM config");
      return [];
    }
  }

  private async validateRelation(input: {
    orgId: string;
    articleId: string;
    title?: string | null;
    summary?: string | null;
    language?: string | null;
    relation: KgRelationForIngestion;
    models: string[];
  }): Promise<{ adjustedConfidence: number; validation: Record<string, unknown> } | null> {
    const system = [
      "You are a strict fact-checker for an extracted knowledge graph relation.",
      "Decide whether the relation is supported by the provided context.",
      "Return verdict:",
      '- "yes" only if the relation is clearly supported by the text.',
      '- "no" if the text contradicts the relation OR there is no support for it.',
      '- "uncertain" if the text is ambiguous or insufficient.',
      "Return a confidence between 0 and 1 for your verdict."
    ].join("\n");

    const contextParts = [
      input.title ? `Title: ${input.title}` : null,
      input.summary ? `Summary: ${input.summary}` : null,
      input.relation.evidence ? `Evidence quote: ${input.relation.evidence}` : null
    ].filter((part): part is string => Boolean(part));

    const user = [
      input.language ? `Language: ${input.language}` : null,
      contextParts.length > 0 ? contextParts.join("\n") : "Context: (none)",
      "",
      "Relation:",
      `Subject: ${input.relation.subject.name} (${input.relation.subject.type})`,
      `Predicate: ${input.relation.predicate}`,
      `Object: ${input.relation.object.name} (${input.relation.object.type})`
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    const modelResults = await Promise.allSettled(
      input.models.map(async (model) => {
        const response = await this.liteLlm.acompletion({
          orgId: input.orgId,
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0,
          max_tokens: 120,
          response_format: RELATION_VALIDATION_RESPONSE_FORMAT,
          timeoutMs: 45_000,
          metadata: {
            task: "kg_relation_validation",
            orgId: input.orgId,
            articleId: input.articleId
          },
          maxRetries: 1
        });

        const content = response.choices[0]?.message?.content ?? null;
        const parsed = this.parseValidation(content);
        if (!parsed) {
          throw new Error("Invalid validation response");
        }
        return {
          model: response.model,
          verdict: parsed.verdict,
          confidence: parsed.confidence
        };
      })
    );

    const results: ({ model: string; verdict: string; confidence: number } | { model: string; error: string })[] =
      modelResults.map((entry, index) => {
        const fallbackModel = input.models[index] ?? "unknown";
        if (entry.status === "fulfilled") {
          return entry.value;
        }
        return {
          model: fallbackModel,
          error: entry.reason instanceof Error ? entry.reason.message : "unknown error"
        };
      });

    const votes = { yes: 0, no: 0, uncertain: 0 };
    let decisive = 0;

    for (const entry of results) {
      if ("error" in entry) {
        continue;
      }
      if (entry.verdict === "yes") {
        votes.yes += 1;
        decisive += 1;
      } else if (entry.verdict === "no") {
        votes.no += 1;
        decisive += 1;
      } else {
        votes.uncertain += 1;
      }
    }

    const supportScore = decisive > 0 ? votes.yes / decisive : 0.5;
    const outcome =
      decisive >= 2 && votes.yes > votes.no
        ? "accept"
        : decisive >= 2 && votes.no > votes.yes
          ? "reject"
          : "uncertain";

    const originalConfidence = input.relation.confidence;
    const adjustedConfidence =
      outcome === "accept"
        ? this.clampNumber((originalConfidence + supportScore) / 2, 0, 1, originalConfidence)
        : this.clampNumber(originalConfidence * supportScore, 0, 1, originalConfidence);

    return {
      adjustedConfidence,
      validation: {
        validatedAt: new Date().toISOString(),
        models: input.models,
        results,
        votes,
        decisive,
        outcome,
        supportScore,
        originalConfidence,
        adjustedConfidence
      }
    };
  }

  private parseValidation(content: string | null): RelationValidation | null {
    if (!content) {
      return null;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return null;
    }

    const jsonText = this.extractJsonObject(trimmed);
    if (!jsonText) {
      return null;
    }

    try {
      const parsed = JSON.parse(jsonText);
      const validated = RelationValidationSchema.safeParse(parsed);
      return validated.success ? validated.data : null;
    } catch {
      return null;
    }
  }

  private extractJsonObject(text: string): string | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    return text.slice(start, end + 1);
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number) {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
    if (numeric === null) {
      return fallback;
    }
    if (numeric < min) {
      return min;
    }
    if (numeric > max) {
      return max;
    }
    return numeric;
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
    if (numeric === null) {
      return fallback;
    }
    const rounded = Math.round(numeric);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  }
}
