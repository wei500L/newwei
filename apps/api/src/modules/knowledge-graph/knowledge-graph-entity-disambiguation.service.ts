import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import { LiteLlmService } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";

const logger = createLogger({ name: "knowledge-graph-entity-disambiguation" });

export interface EntityDisambiguationCandidate {
  id: string;
  name: string;
  type: string;
}

const EntityDisambiguationSchema = z.object({
  entityId: z.string().nullable(),
  confidence: z.number().min(0).max(1)
});

type EntityDisambiguationResult = z.infer<typeof EntityDisambiguationSchema>;

const ENTITY_DISAMBIGUATION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "kg_entity_disambiguation",
    schema: zodToJsonSchema(EntityDisambiguationSchema, {
      $refStrategy: "none"
    }) as JsonSchema7Type
  }
};

@Injectable()
export class KnowledgeGraphEntityDisambiguationService {
  constructor(private readonly liteLlm: LiteLlmService) {}

  async chooseEntityId(input: {
    orgId: string;
    mention: { name: string; type: string };
    contextText: string;
    candidates: EntityDisambiguationCandidate[];
  }): Promise<{ entityId: string | null; confidence: number } | null> {
    const candidates = input.candidates.filter(
      (candidate) => candidate && candidate.id && candidate.name && candidate.type
    );
    if (candidates.length <= 1) {
      return { entityId: candidates[0]?.id ?? null, confidence: 1 };
    }

    const system = [
      "You are an entity linking system.",
      "Choose the best matching entity from the candidate list for the given mention, using the provided context.",
      'If none match, return {"entityId": null, "confidence": <0-1>}.',
      "Return a higher confidence only when the match is clear."
    ].join("\n");

    const user = [
      `Mention: ${input.mention.name} (${input.mention.type})`,
      "",
      "Context:",
      input.contextText,
      "",
      "Candidates (choose entityId):",
      ...candidates.map((candidate) => `- ${candidate.id}: ${candidate.name} (${candidate.type})`)
    ].join("\n");

    try {
      const response = await this.liteLlm.acompletion({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0,
        max_tokens: 160,
        response_format: ENTITY_DISAMBIGUATION_RESPONSE_FORMAT,
        timeoutMs: 45_000,
        metadata: {
          task: "kg_entity_disambiguation",
          orgId: input.orgId
        },
        maxRetries: 1
      });

      const content = response.choices[0]?.message?.content ?? null;
      const parsed = this.parseDisambiguation(content);
      if (!parsed) {
        return null;
      }

      const selectedId = parsed.entityId && candidates.some((candidate) => candidate.id === parsed.entityId)
        ? parsed.entityId
        : null;

      return { entityId: selectedId, confidence: parsed.confidence };
    } catch (error) {
      logger.warn(
        { err: error, orgId: input.orgId, mention: input.mention.name },
        "Entity disambiguation failed"
      );
      return null;
    }
  }

  private parseDisambiguation(content: string | null): EntityDisambiguationResult | null {
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
      const validated = EntityDisambiguationSchema.safeParse(parsed);
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
}

