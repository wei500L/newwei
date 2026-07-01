import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { NewsEventAssignmentMethod } from "@prisma/client";
import type { Queue } from "bullmq";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";

import { safeJsonParseFromText } from "../../common/llm-json";
import type { NewsSignal, NewsSignalEntity } from "../news-signals/news-signal";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import type { JsonSchemaResponseFormat } from "../news-pipeline/news-prompt.builder";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";
import { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";
import { ModelServiceSettingsService } from "../system-settings/model-service-settings.service";

import {
  NewsEventClusteringFailureService,
  type NewsEventClusteringFailureRecord,
} from "./news-event-clustering-failure.service";
import {
  NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE,
  type NewsEventClusteringRecoveryJobPayload,
} from "./news-event-clustering-recovery.constants";
import {
  NewsEventsService,
  type NewsEventAssignmentCandidate,
} from "./news-events.service";
import {
  NewsEventsSettingsService,
  type NewsEventSettings,
} from "./news-events-settings.service";

const logger = createLogger({ name: "news-event-clustering-recovery" });
const AUTO_BACKFILL_ACTOR_ID = "system:news-event-clustering-recovery";
const AUTO_BACKFILL_BATCH_SIZE = 25;
const AUTO_BACKFILL_RETRY_AFTER_MS = 15 * 60 * 1000;

const LLM_BACKFILL_DECISION_SCHEMA = z.object({
  action: z.enum(["assign_existing", "create_new"]),
  eventId: z.string().trim().min(1).max(64).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  reasoning: z.string().trim().max(500).nullable().optional(),
});

type LlmBackfillDecision = z.infer<typeof LLM_BACKFILL_DECISION_SCHEMA>;

const LLM_BACKFILL_DECISION_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  LLM_BACKFILL_DECISION_SCHEMA,
  { $refStrategy: "none" },
);

const LLM_BACKFILL_DECISION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "news_event_llm_backfill_decision_v1",
    schema: LLM_BACKFILL_DECISION_JSON_SCHEMA,
  },
};

@Injectable()
export class NewsEventClusteringRecoveryService {
  constructor(
    private readonly failures: NewsEventClusteringFailureService,
    private readonly settings: NewsEventsSettingsService,
    private readonly events: NewsEventsService,
    private readonly modelServiceSettings: ModelServiceSettingsService,
    private readonly llmGatewaySettings: LlmGatewaySettingsService,
    private readonly litellm: LiteLlmService,
    @Inject(NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE)
    private readonly queue: Queue<NewsEventClusteringRecoveryJobPayload>,
  ) {}

  async getReadiness() {
    const [modelService, llmConfig] = await Promise.all([
      this.modelServiceSettings.getPublicSettings(),
      this.llmGatewaySettings.getActiveConfig(),
    ]);
    const llmModel = this.normalizeOptionalString(
      llmConfig?.assistantModel ?? llmConfig?.model,
    );

    return {
      modelService: {
        ready: Boolean(
          modelService.enabled && modelService.baseUrl && modelService.hasToken,
        ),
        enabled: modelService.enabled,
        baseUrl: modelService.baseUrl,
        hasToken: modelService.hasToken,
      },
      llmBackfill: {
        ready: Boolean(llmConfig && llmModel),
        profileId: llmConfig?.profileId ?? null,
        profileName: llmConfig?.profileName ?? null,
        model: llmModel,
        apiSurface: llmConfig?.apiSurface ?? null,
      },
      recoveryAutomation: {
        enabled: true,
        intervalSeconds: 5 * 60,
        retryAfterSeconds: Math.floor(AUTO_BACKFILL_RETRY_AFTER_MS / 1000),
        batchSize: AUTO_BACKFILL_BATCH_SIZE,
        actorId: AUTO_BACKFILL_ACTOR_ID,
      },
    };
  }

  async enqueueLlmBackfill(orgId: string, actorId: string, groupId: string) {
    const readiness = await this.getReadiness();
    return this.enqueueLlmBackfillWithReadiness({
      orgId,
      actorId,
      groupId,
      readiness,
      trigger: "manual",
    });
  }

  async enqueuePendingLlmBackfills(options?: {
    limit?: number;
    retryAfterMs?: number;
  }) {
    const readiness = await this.getReadiness();
    if (!readiness.llmBackfill.ready) {
      return {
        scanned: 0,
        queued: 0,
        skipped: 0,
        failed: 0,
        skippedNotReady: true,
      };
    }

    const candidates = await this.failures.listPendingAutoRetryCandidates({
      limit: options?.limit ?? AUTO_BACKFILL_BATCH_SIZE,
      retryAfterMs: options?.retryAfterMs ?? AUTO_BACKFILL_RETRY_AFTER_MS,
    });

    let queued = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await this.enqueueLlmBackfillWithReadiness({
          orgId: candidate.orgId,
          actorId: AUTO_BACKFILL_ACTOR_ID,
          groupId: candidate.groupId,
          readiness,
          trigger: "auto",
        });
        queued += 1;
      } catch (error) {
        if (error instanceof BadRequestException) {
          skipped += 1;
          continue;
        }
        failed += 1;
        logger.warn(
          {
            err: error,
            orgId: candidate.orgId,
            groupId: candidate.groupId,
          },
          "Failed to automatically enqueue news event clustering LLM backfill",
        );
      }
    }

    return {
      scanned: candidates.length,
      queued,
      skipped,
      failed,
      skippedNotReady: false,
    };
  }

  private async enqueueLlmBackfillWithReadiness(input: {
    orgId: string;
    actorId: string;
    groupId: string;
    readiness: Awaited<
      ReturnType<NewsEventClusteringRecoveryService["getReadiness"]>
    >;
    trigger: "manual" | "auto";
  }) {
    if (!input.readiness.llmBackfill.ready) {
      throw new BadRequestException(
        "LLM gateway completion profile is not ready for manual backfill",
      );
    }

    const failure = await this.failures.getFailureGroupOrThrow(
      input.orgId,
      input.groupId,
    );
    if (failure.status === "processing") {
      throw new BadRequestException("Failure group is already processing");
    }
    if (failure.status === "resolved" || failure.status === "ignored") {
      throw new BadRequestException("Failure group can no longer be recovered");
    }

    const traceId = ensureTraceId(getCurrentTraceId());
    const jobId = `news-event-llm-backfill:${input.groupId}:${randomUUID()}`;
    const queued = await this.failures.markLlmBackfillQueued({
      orgId: input.orgId,
      actorId: input.actorId,
      groupId: input.groupId,
      jobId,
      model: input.readiness.llmBackfill.model,
    });

    try {
      await this.queue.add(
        "llm_backfill",
        {
          jobType: "llm_backfill",
          orgId: input.orgId,
          actorId: input.actorId,
          groupId: input.groupId,
          traceId,
          trigger: input.trigger,
        },
        {
          jobId,
          removeOnComplete: true,
          attempts: 1,
        },
      );
    } catch (error) {
      await this.failures.markLlmBackfillFailed({
        orgId: input.orgId,
        groupId: input.groupId,
        processedCount: 0,
        totalCount: queued.progressTotalCount,
        errorMessage: this.getErrorMessage(
          error,
          "Failed to enqueue LLM backfill job",
        ),
        model: input.readiness.llmBackfill.model,
      });
      throw error;
    }

    await writeTaskLogBestEffort({
      queue: "news_event_clustering_recovery",
      jobId,
      orgId: input.orgId,
      stage: "llm_backfill_queue",
      status: "pending",
      data: {
        groupId: input.groupId,
        model: input.readiness.llmBackfill.model,
        itemCount: queued.progressTotalCount,
        trigger: input.trigger,
      },
    });

    return {
      groupId: input.groupId,
      status: "processing" as const,
      activeJobId: jobId,
      progressProcessedCount: 0,
      progressTotalCount: queued.progressTotalCount,
      lastRecoveryModel: input.readiness.llmBackfill.model,
      attemptCount: queued.attemptCount,
    };
  }

  async processJob(payload: NewsEventClusteringRecoveryJobPayload) {
    if (payload.jobType !== "llm_backfill") {
      return;
    }

    const readiness = await this.getReadiness();
    if (!readiness.llmBackfill.ready || !readiness.llmBackfill.model) {
      throw new Error("LLM gateway completion profile is not ready");
    }

    const failure = await this.failures.getFailureGroupOrThrow(
      payload.orgId,
      payload.groupId,
    );
    if (failure.status === "resolved" || failure.status === "ignored") {
      return;
    }

    const settings = await this.settings.getSettings(payload.orgId);
    const totalCount = failure.items.length;
    let processedCount = 0;
    let assignedCount = 0;
    let skippedCount = 0;
    const resolvedEventIds = new Set<string>();

    await writeTaskLogBestEffort({
      queue: "news_event_clustering_recovery",
      jobId: failure.activeJobId ?? payload.groupId,
      orgId: payload.orgId,
      stage: "llm_backfill",
      status: "processing",
      data: {
        groupId: payload.groupId,
        itemCount: totalCount,
        model: readiness.llmBackfill.model,
        trigger: payload.trigger ?? "manual",
      },
    });

    try {
      for (const item of failure.items) {
        const result = await this.recoverFailureItem({
          orgId: payload.orgId,
          item,
          settings,
          model: readiness.llmBackfill.model,
        });
        processedCount += 1;
        if (result.eventId) {
          resolvedEventIds.add(result.eventId);
        }
        if (result.created) {
          assignedCount += 1;
        } else {
          skippedCount += 1;
        }

        await this.failures.updateLlmBackfillProgress({
          orgId: payload.orgId,
          groupId: payload.groupId,
          processedCount,
          totalCount,
          jobId: failure.activeJobId ?? null,
          model: readiness.llmBackfill.model,
        });
      }

      const resolvedAt = await this.failures.markLlmBackfillResolved({
        orgId: payload.orgId,
        actorId: payload.actorId,
        groupId: payload.groupId,
        processedCount,
        totalCount,
        model: readiness.llmBackfill.model,
        resolvedEventIds: Array.from(resolvedEventIds.values()),
      });

      await writeTaskLogBestEffort({
        queue: "news_event_clustering_recovery",
        jobId: failure.activeJobId ?? payload.groupId,
        orgId: payload.orgId,
        stage: "llm_backfill",
        status: "completed",
        data: {
          groupId: payload.groupId,
          assignedCount,
          skippedCount,
          processedCount,
          totalCount,
          model: readiness.llmBackfill.model,
          trigger: payload.trigger ?? "manual",
          resolvedEventIds: Array.from(resolvedEventIds.values()).sort(),
          resolvedAt: resolvedAt.toISOString(),
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "LLM backfill failed";
      await this.failures.markLlmBackfillFailed({
        orgId: payload.orgId,
        groupId: payload.groupId,
        processedCount,
        totalCount,
        errorMessage: message,
        model: readiness.llmBackfill.model,
      });
      await writeTaskLogBestEffort({
        queue: "news_event_clustering_recovery",
        jobId: failure.activeJobId ?? payload.groupId,
        orgId: payload.orgId,
        stage: "llm_backfill",
        status: "failed",
        message,
        data: {
          groupId: payload.groupId,
          processedCount,
          totalCount,
          model: readiness.llmBackfill.model,
          trigger: payload.trigger ?? "manual",
        },
      });
      logger.warn(
        {
          err: error,
          orgId: payload.orgId,
          groupId: payload.groupId,
          processedCount,
          totalCount,
        },
        "News event clustering LLM backfill failed",
      );
      throw error;
    }
  }

  private async recoverFailureItem(input: {
    orgId: string;
    item: NewsEventClusteringFailureRecord["items"][number];
    settings: NewsEventSettings;
    model: string;
  }) {
    const signal = this.toSignal(input.item);
    const candidates = await this.events.listAssignmentCandidatesForSignal(
      input.orgId,
      signal,
      input.settings,
      { limit: 6 },
    );

    if (candidates.length === 0) {
      return this.events.assignNewsSignalToNewEvent(
        input.orgId,
        signal,
        input.settings,
        {
          assignedBy: NewsEventAssignmentMethod.manual,
        },
      );
    }

    const decision = await this.chooseEventWithLlm({
      orgId: input.orgId,
      signal,
      candidates,
      model: input.model,
    });
    if (decision.action === "create_new") {
      return this.events.assignNewsSignalToNewEvent(
        input.orgId,
        signal,
        input.settings,
        {
          assignedBy: NewsEventAssignmentMethod.manual,
        },
      );
    }

    const targetEventId = this.normalizeOptionalString(decision.eventId);
    if (!targetEventId) {
      throw new Error("LLM backfill response did not include an eventId");
    }
    const candidate = candidates.find(
      (entry) => entry.eventId === targetEventId,
    );
    if (!candidate) {
      throw new Error("LLM backfill selected an unknown event candidate");
    }

    return this.events.assignNewsSignalToSpecificEvent(
      input.orgId,
      candidate.eventId,
      signal,
      {
        similarity: candidate.score,
        assignedBy: NewsEventAssignmentMethod.manual,
      },
    );
  }

  private async chooseEventWithLlm(input: {
    orgId: string;
    signal: NewsSignal;
    candidates: NewsEventAssignmentCandidate[];
    model: string;
  }): Promise<LlmBackfillDecision> {
    const response = await this.litellm.acompletion({
      orgId: input.orgId,
      model: input.model,
      messages: [
        {
          role: "system",
          content: [
            "You are reviewing a failed news event clustering group.",
            "Choose exactly one action.",
            "Use assign_existing only when one candidate event clearly matches the article.",
            "Use create_new when none of the candidates are strong enough.",
            "Return JSON only.",
          ].join(" "),
        },
        {
          role: "user",
          content: this.buildUserPrompt(input.signal, input.candidates),
        },
      ],
      temperature: 0,
      top_p: 1,
      max_tokens: 350,
      response_format: LLM_BACKFILL_DECISION_RESPONSE_FORMAT,
      metadata: {
        feature: "news_event_clustering_llm_backfill",
        candidateCount: input.candidates.length,
        articleFingerprint: this.buildSignalFingerprint(input.signal),
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LiteLLM returned empty content for manual backfill");
    }

    const parsed = safeJsonParseFromText<unknown>(content);
    if (!parsed) {
      throw new Error("LiteLLM returned invalid JSON for manual backfill");
    }
    return LLM_BACKFILL_DECISION_SCHEMA.parse(parsed);
  }

  private buildUserPrompt(
    signal: NewsSignal,
    candidates: NewsEventAssignmentCandidate[],
  ) {
    return [
      "Article:",
      `- Title: ${signal.title ?? "-"}`,
      `- Summary: ${signal.summary ?? "-"}`,
      `- Language: ${signal.language ?? "-"}`,
      `- Timestamp: ${signal.timestamp.toISOString()}`,
      `- Topics: ${signal.topics.join(", ") || "-"}`,
      `- Entities: ${this.formatEntities(signal.entities)}`,
      "",
      "Candidate events:",
      ...candidates.flatMap((candidate, index) => [
        `${index + 1}. Event ${candidate.eventId}`,
        `   - Score: ${candidate.score.toFixed(3)} (${candidate.matchOrigin})`,
        `   - Title: ${candidate.title ?? "-"}`,
        `   - Summary: ${candidate.summary ?? "-"}`,
        `   - Language: ${candidate.language ?? "-"}`,
        `   - Primary topic: ${candidate.primaryTopic ?? "-"}`,
        `   - Primary entity: ${candidate.primaryEntity ?? "-"}`,
        `   - Last seen: ${candidate.lastAt.toISOString()}`,
        `   - Items: ${candidate.itemCount}`,
      ]),
      "",
      "Return JSON using this shape:",
      '{"action":"assign_existing"|"create_new","eventId":"<candidate event id or null>","confidence":0.0-1.0,"reasoning":"short explanation"}',
    ].join("\n");
  }

  private formatEntities(entities: NewsSignalEntity[]) {
    if (!Array.isArray(entities) || entities.length === 0) {
      return "-";
    }
    return entities
      .slice(0, 8)
      .map((entity) => {
        const name = this.normalizeOptionalString(entity.name) ?? "unknown";
        const type = this.normalizeOptionalString(entity.type) ?? "unknown";
        return `${name} (${type})`;
      })
      .join(", ");
  }

  private buildSignalFingerprint(signal: NewsSignal) {
    const hash = createHash("sha1");
    hash.update(signal.processedArticleId);
    hash.update("|");
    hash.update(signal.title ?? "");
    hash.update("|");
    hash.update(signal.summary ?? "");
    return hash.digest("hex").slice(0, 16);
  }

  private toSignal(
    item: NewsEventClusteringFailureRecord["items"][number],
  ): NewsSignal {
    const timestamp =
      item.publishedAt ?? item.crawlAt ?? item.processedAt ?? new Date();
    return {
      articleId: item.articleId,
      processedArticleId: item.processedArticleId,
      processedItemId: item.processedItemId,
      timestamp,
      language: item.language,
      title: item.title,
      summary: item.summary,
      topics: item.topics,
      entities: item.entities,
      sentiment: null,
      qualityScore: item.qualityScore,
      legacyCategory: item.category,
      categoryPath: item.categoryPath,
      categoryConfidence: item.categoryConfidence,
    };
  }

  private normalizeOptionalString(value: string | null | undefined) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private getErrorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
  }
}
