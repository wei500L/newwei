import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { NewsEventAssignmentMethod, NewsEventStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import type { NewsSignal, NewsSignalEntity } from "../news-signals/news-signal";
import { VectorClientService } from "../vector/vector-client.service";

import type { NewsEventSettings } from "./news-events-settings.service";

const logger = createLogger({ name: "news-events" });

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VECTOR_SEARCH_LIMIT = 50;
const DEFAULT_CANDIDATE_EVENTS_LIMIT = 30;

@Injectable()
export class NewsEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorClient: VectorClientService,
  ) {}

  async listEvents(
    orgId: string,
    options?: { limit?: number; windowDays?: number; status?: NewsEventStatus }
  ) {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const windowDays = Math.min(Math.max(options?.windowDays ?? 30, 1), 365);
    const since = new Date(Date.now() - windowDays * DAY_MS);

    return this.prisma.newsEvent.findMany({
      where: {
        orgId,
        ...(options?.status ? { status: options.status } : {}),
        lastAt: { gte: since }
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: limit,
      include: {
        _count: { select: { items: true } }
      }
    });
  }

  async getEvent(
    orgId: string,
    eventId: string,
    options?: { itemsLimit?: number; timelineLimit?: number }
  ) {
    const itemsLimit = Math.min(Math.max(options?.itemsLimit ?? 50, 1), 200);
    const timelineLimit = Math.min(Math.max(options?.timelineLimit ?? 200, 1), 2000);

    return this.prisma.newsEvent.findFirst({
      where: { orgId, id: eventId },
      include: {
        _count: { select: { items: true } },
        items: {
          orderBy: [{ createdAt: "desc" }],
          take: itemsLimit,
          include: {
            processedArticle: {
              include: {
                article: {
                  select: {
                    id: true,
                    url: true,
                    sourceLabel: true,
                    crawlAt: true
                  }
                }
              }
            }
          }
        },
        timeline: {
          orderBy: [{ bucketStart: "asc" }],
          take: timelineLimit
        }
      }
    });
  }

  async assignNewsSignalToEvent(orgId: string, signal: NewsSignal, settings: NewsEventSettings) {
    const existing = await this.prisma.newsEventItem.findUnique({
      where: {
        orgId_processedArticleId: {
          orgId,
          processedArticleId: signal.processedArticleId
        }
      },
      select: { id: true, eventId: true }
    });
    if (existing) {
      return { eventId: existing.eventId, created: false };
    }

    const timestamp = signal.timestamp;
    const language = this.normalizeOptionalString(signal.language);
    const primaryTopic = this.pickPrimaryTopic(signal.topics);
    const primaryEntity = this.pickPrimaryEntity(signal.entities);

    const assignment = await this.pickEventForSignal(orgId, signal, settings, {
      timestamp,
      language,
      primaryTopic,
      primaryEntity
    });

    return this.prisma.runInTransaction(async (tx) => {
      const eventId =
        assignment.eventId ??
        (
          await this.createEvent(tx, orgId, signal, settings, {
            timestamp,
            language,
            primaryTopic,
            primaryEntity
          })
        ).id;

      try {
        await tx.newsEventItem.create({
          data: {
            orgId,
            eventId,
            processedArticleId: signal.processedArticleId,
            processedItemId: this.normalizeOptionalString(signal.processedItemId),
            similarity: assignment.similarity ?? null,
            assignedBy: assignment.method
          }
        });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          return { eventId, created: false };
        }
        throw error;
      }

      if (assignment.eventId) {
        const current = await tx.newsEvent.findUnique({
          where: { id: eventId },
          select: { startAt: true, lastAt: true }
        });

        const startAt = current ? this.minDate(current.startAt, timestamp) : timestamp;
        const lastAt = current ? this.maxDate(current.lastAt, timestamp) : timestamp;

        await tx.newsEvent.update({
          where: { id: eventId },
          data: { startAt, lastAt }
        });
      }

      return { eventId, created: true };
    });
  }

  private async pickEventForSignal(
    orgId: string,
    signal: NewsSignal,
    settings: NewsEventSettings,
    derived: { timestamp: Date; language: string | null; primaryTopic: string | null; primaryEntity: string | null },
  ): Promise<{
    eventId?: string;
    similarity?: number | null;
    method: NewsEventAssignmentMethod;
  }> {
    const vector = await this.tryResolveSummaryEmbedding(signal.processedItemId);
    if (vector) {
      const matches = await this.vectorClient.searchBestEffort({
        orgId,
        embeddingModel: vector.model,
        vector: vector.embedding,
        limit: DEFAULT_VECTOR_SEARCH_LIMIT,
        minScore: settings.vectorMinScore,
        lookbackMs: settings.lookbackDays * DAY_MS
      });

      const matchIds = (matches ?? [])
        .map((match) => (typeof match.processedItemId === "string" ? match.processedItemId : ""))
        .filter((id) => id.length > 0 && id !== signal.processedItemId);

      if (matchIds.length > 0) {
        const memberships = await this.prisma.newsEventItem.findMany({
          where: { orgId, processedItemId: { in: matchIds } },
          select: { eventId: true, processedItemId: true }
        });

        const membershipEntries = memberships
          .map((row) => {
            const processedItemId = typeof row.processedItemId === "string" ? row.processedItemId.trim() : "";
            if (!processedItemId) {
              return null;
            }
            return [processedItemId, row.eventId] as const;
          })
          .filter((entry): entry is readonly [string, string] => Boolean(entry));
        const membershipByProcessedItemId = new Map<string, string>(membershipEntries);

        const scoreByEventId = new Map<string, number>();
        for (const match of matches ?? []) {
          const processedItemId = typeof match.processedItemId === "string" ? match.processedItemId : "";
          const score = typeof match.score === "number" ? match.score : null;
          const eventId = membershipByProcessedItemId.get(processedItemId);
          if (!eventId || score === null) {
            continue;
          }
          const existing = scoreByEventId.get(eventId);
          if (existing === undefined || score > existing) {
            scoreByEventId.set(eventId, score);
          }
        }

        if (scoreByEventId.size > 0) {
          const eventIds = Array.from(scoreByEventId.keys());
          const events = await this.prisma.newsEvent.findMany({
            where: { orgId, id: { in: eventIds }, status: NewsEventStatus.active },
            select: { id: true, language: true, startAt: true, lastAt: true }
          });
          const eventsById = new Map(events.map((event) => [event.id, event]));

          let best: { eventId: string; score: number } | null = null;
          for (const [eventId, rawScore] of scoreByEventId.entries()) {
            const event = eventsById.get(eventId);
            if (!event) {
              continue;
            }
            const adjusted = this.applyLanguagePenalty(rawScore, derived.language, event.language, settings);
            if (!best || adjusted > best.score) {
              best = { eventId, score: adjusted };
            }
          }

          if (best && best.score >= settings.vectorMinScore) {
            return {
              eventId: best.eventId,
              similarity: best.score,
              method: NewsEventAssignmentMethod.vector
            };
          }
        }
      }
    }

    const overlapCandidate = await this.pickEventByOverlap(orgId, derived, settings);
    if (overlapCandidate) {
      return overlapCandidate;
    }

    return { method: NewsEventAssignmentMethod.overlap };
  }

  private async pickEventByOverlap(
    orgId: string,
    derived: { timestamp: Date; language: string | null; primaryTopic: string | null; primaryEntity: string | null },
    settings: NewsEventSettings,
  ): Promise<{
    eventId?: string;
    similarity?: number | null;
    method: NewsEventAssignmentMethod;
  } | null> {
    const since = new Date(Date.now() - settings.lookbackDays * DAY_MS);
    const clauses: Prisma.NewsEventWhereInput[] = [];
    if (derived.primaryTopic) {
      clauses.push({ primaryTopic: derived.primaryTopic });
    }
    if (derived.primaryEntity) {
      clauses.push({ primaryEntity: derived.primaryEntity });
    }
    if (clauses.length === 0) {
      return null;
    }

    const candidates = await this.prisma.newsEvent.findMany({
      where: {
        orgId,
        status: NewsEventStatus.active,
        lastAt: { gte: since },
        OR: clauses
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: DEFAULT_CANDIDATE_EVENTS_LIMIT
    });

    let best: { id: string; score: number; startAt: Date; lastAt: Date } | null = null;
    for (const candidate of candidates) {
      const topicMatch =
        Boolean(derived.primaryTopic) &&
        Boolean(candidate.primaryTopic) &&
        candidate.primaryTopic === derived.primaryTopic;
      const entityMatch =
        Boolean(derived.primaryEntity) &&
        Boolean(candidate.primaryEntity) &&
        candidate.primaryEntity === derived.primaryEntity;

      const matches = (topicMatch ? 1 : 0) + (entityMatch ? 1 : 0);
      if (matches <= 0) {
        continue;
      }

      let score = matches / 2;
      score = this.applyLanguagePenalty(score, derived.language, candidate.language, settings);

      if (!best || score > best.score) {
        best = { id: candidate.id, score, startAt: candidate.startAt, lastAt: candidate.lastAt };
      }
    }

    if (!best) {
      return null;
    }
    return {
      eventId: best.id,
      similarity: best.score,
      method: NewsEventAssignmentMethod.overlap
    };
  }

  private async createEvent(
    tx: Prisma.TransactionClient,
    orgId: string,
    signal: NewsSignal,
    _settings: NewsEventSettings,
    derived: { timestamp: Date; language: string | null; primaryTopic: string | null; primaryEntity: string | null },
  ) {
    return tx.newsEvent.create({
      data: {
        orgId,
        status: NewsEventStatus.active,
        language: derived.language,
        primaryTopic: derived.primaryTopic,
        primaryEntity: derived.primaryEntity,
        title: signal.title,
        summary: signal.summary,
        startAt: derived.timestamp,
        lastAt: derived.timestamp,
        representativeProcessedArticleId: signal.processedArticleId,
        representativeProcessedItemId: this.normalizeOptionalString(signal.processedItemId)
      }
    });
  }

  private pickPrimaryTopic(topics: string[]): string | null {
    for (const topic of topics) {
      const normalized = this.normalizeOptionalString(topic);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private pickPrimaryEntity(entities: NewsSignalEntity[]): string | null {
    let fallback: string | null = null;
    let best: { name: string; confidence: number } | null = null;

    for (const entity of entities) {
      const normalizedName = this.normalizeOptionalString(entity.name);
      if (!normalizedName) {
        continue;
      }

      if (!fallback) {
        fallback = normalizedName;
      }

      const confidence = entity.confidence;
      if (confidence === null || !Number.isFinite(confidence)) {
        continue;
      }

      if (!best || confidence > best.confidence) {
        best = { name: normalizedName, confidence };
      }
    }

    return best?.name ?? fallback;
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async tryResolveSummaryEmbedding(processedItemId: string | null) {
    const normalized = this.normalizeOptionalString(processedItemId);
    if (!normalized) {
      return null;
    }
    try {
      const doc = await ProcessedItemModel.findById(normalized)
        .select({ summaryEmbedding: 1, summaryEmbeddingModel: 1 })
        .lean()
        .exec();
      const embedding = (doc as unknown as { summaryEmbedding?: unknown })?.summaryEmbedding;
      const model = (doc as unknown as { summaryEmbeddingModel?: unknown })?.summaryEmbeddingModel;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        return null;
      }
      const numeric = embedding.filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];
      if (numeric.length !== embedding.length) {
        return null;
      }
      const embeddingModel = typeof model === "string" ? model.trim() : "";
      if (!embeddingModel) {
        return null;
      }
      return { embedding: numeric, model: embeddingModel };
    } catch (error) {
      logger.warn({ error, processedItemId: normalized }, "Failed to load summary embedding from Mongo");
      return null;
    }
  }

  private applyLanguagePenalty(score: number, signalLanguage: string | null, eventLanguage: string | null, settings: NewsEventSettings) {
    if (!signalLanguage || !eventLanguage || signalLanguage === eventLanguage) {
      return score;
    }
    const penalty = Math.min(Math.max(settings.crossLanguagePenalty, 0), 1);
    return score * (1 - penalty);
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }

  private minDate(a: Date, b: Date) {
    return a.getTime() <= b.getTime() ? a : b;
  }

  private maxDate(a: Date, b: Date) {
    return a.getTime() >= b.getTime() ? a : b;
  }
}
