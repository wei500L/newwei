import { Prisma, UserNewsBehaviorSignalType } from "@prisma/client";
import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import type { UserNewsBehaviorEventType } from "./dto/record-user-news-behavior.dto";
import {
  buildUserNewsBehaviorDayKey,
  buildUserNewsBehaviorHashKey,
  buildUserNewsBehaviorProfileCacheKey,
  USER_NEWS_BEHAVIOR_BANDS,
  USER_NEWS_BEHAVIOR_DIMENSIONS,
  USER_NEWS_BEHAVIOR_HASH_KINDS,
  USER_NEWS_BEHAVIOR_RETENTION_SECONDS,
  USER_NEWS_BEHAVIOR_PROFILE_CACHE_TTL_SECONDS,
  USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS,
  USER_NEWS_BEHAVIOR_V2_WINDOW_DAYS,
} from "./user-news-behavior.constants";

const POSITIVE_EVENT_WEIGHT_MAP: Partial<Record<UserNewsBehaviorEventType, number>> = {
  view: 1,
  click: 2,
  open_event: 3,
  open_item: 3,
  bookmark: 4,
  share: 4,
  engaged_read: 2,
  deep_read: 3,
  completed_read: 4,
};

const NEGATIVE_EVENT_WEIGHT_MAP: Partial<Record<UserNewsBehaviorEventType, number>> = {
  not_interested: 4,
  unsubscribe: 5,
};

const MAX_TERM_LENGTH = 96;
const MAX_ID_LENGTH = 128;
const MAX_TERMS_PER_DIMENSION = 8;
const LEGACY_FALLBACK_SCALE = 0.18;
const LEGACY_FALLBACK_ACTION_THRESHOLD = 2;
const SIMILARITY_NEIGHBOR_LIMIT = 50;
const SIMILARITY_CANDIDATE_LIMIT = 80;
const SIMILARITY_TOP_SIGNALS = 24;
const SIMILARITY_MIN_SHARED_SIGNALS = 3;
const SIMILARITY_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const SIMILARITY_LOCK_TTL_MS = 30_000;
const SIMILARITY_SCORE_HALF_LIFE_DAYS = 90;

const PERSISTED_SIGNAL_DIMENSIONS = [
  "sources",
  "topics",
  "entities",
  "items",
  "events",
  "domains",
] as const;

type UserNewsBehaviorScoreRecord = Record<string, number>;

type UserNewsBehaviorScoreDimensions = {
  [K in (typeof USER_NEWS_BEHAVIOR_DIMENSIONS)[number]]: UserNewsBehaviorScoreRecord;
};

export interface UserNewsBehaviorProfile {
  actions: UserNewsBehaviorScoreRecord;
  sources: UserNewsBehaviorScoreRecord;
  topics: UserNewsBehaviorScoreRecord;
  entities: UserNewsBehaviorScoreRecord;
  items: UserNewsBehaviorScoreRecord;
  events: UserNewsBehaviorScoreRecord;
  domains: UserNewsBehaviorScoreRecord;
  positive: UserNewsBehaviorScoreDimensions;
  negative: UserNewsBehaviorScoreDimensions;
  net: UserNewsBehaviorScoreDimensions;
  bands: {
    key: string;
    weight: number;
    positive: UserNewsBehaviorScoreDimensions;
    negative: UserNewsBehaviorScoreDimensions;
    net: UserNewsBehaviorScoreDimensions;
  }[];
  meta: {
    legacyFallbackUsed: boolean;
  };
}

export interface UserNewsSimilarityNeighbor {
  userId: string;
  similarity: number;
  sharedSignals: number;
}

export interface UserNewsCollaborativeProfile {
  sources: UserNewsBehaviorScoreRecord;
  topics: UserNewsBehaviorScoreRecord;
  entities: UserNewsBehaviorScoreRecord;
  items: UserNewsBehaviorScoreRecord;
  events: UserNewsBehaviorScoreRecord;
  domains: UserNewsBehaviorScoreRecord;
  neighbors: UserNewsSimilarityNeighbor[];
  degraded: boolean;
  computedAt: string | null;
}

@Injectable()
export class UserNewsBehaviorService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  async record(input: {
    orgId: string;
    userId: string;
    type: UserNewsBehaviorEventType;
    itemId?: string;
    eventId?: string;
    source?: string;
    topics?: string[];
    entities?: string[];
    url?: string;
  }) {
    const positiveWeight = POSITIVE_EVENT_WEIGHT_MAP[input.type] ?? 0;
    const negativeWeight = NEGATIVE_EVENT_WEIGHT_MAP[input.type] ?? 0;
    const itemId = this.normalizeId(input.itemId);
    const eventId = this.normalizeId(input.eventId);
    const domain = this.normalizeUrlDomain(input.url);
    const source = this.normalizeSourceSignal(input.source, domain);
    const topics = this.normalizeTerms(input.topics);
    const entities = this.normalizeTerms(input.entities);
    const today = this.formatDayKey(new Date());
    const dailyKey = buildUserNewsBehaviorDayKey({
      orgId: input.orgId,
      userId: input.userId,
      dayKey: today,
    });
    const aggregateDeltas: {
      signalType: UserNewsBehaviorSignalType;
      signalKey: string;
      delta: number;
    }[] = [];

    const ops: Promise<unknown>[] = [];

    if (positiveWeight > 0) {
      ops.push(
        this.cache.hincrby(
          dailyKey,
          this.buildBehaviorFieldKey("p", "actions", input.type),
          1,
        ),
      );
      if (source) {
        aggregateDeltas.push({
          signalType: UserNewsBehaviorSignalType.source,
          signalKey: source,
          delta: positiveWeight,
        });
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "sources", source),
            positiveWeight,
          ),
        );
      }
      if (itemId) {
        aggregateDeltas.push({
          signalType: UserNewsBehaviorSignalType.item,
          signalKey: itemId,
          delta: positiveWeight,
        });
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "items", itemId),
            positiveWeight,
          ),
        );
      }
      if (eventId) {
        aggregateDeltas.push({
          signalType: UserNewsBehaviorSignalType.event,
          signalKey: eventId,
          delta: positiveWeight,
        });
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "events", eventId),
            positiveWeight,
          ),
        );
      }
      if (domain) {
        aggregateDeltas.push({
          signalType: UserNewsBehaviorSignalType.domain,
          signalKey: domain,
          delta: positiveWeight,
        });
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "domains", domain),
            positiveWeight,
          ),
        );
      }
      for (const term of topics) {
        aggregateDeltas.push({
          signalType: UserNewsBehaviorSignalType.topic,
          signalKey: term,
          delta: positiveWeight,
        });
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "topics", term),
            positiveWeight,
          ),
        );
      }
      for (const term of entities) {
        aggregateDeltas.push({
          signalType: UserNewsBehaviorSignalType.entity,
          signalKey: term,
          delta: positiveWeight,
        });
        ops.push(
          this.cache.hincrby(
            dailyKey,
            this.buildBehaviorFieldKey("p", "entities", term),
            positiveWeight,
          ),
        );
      }
    }

    if (negativeWeight > 0) {
      ops.push(
        this.cache.hincrby(
          dailyKey,
          this.buildBehaviorFieldKey("n", "actions", input.type),
          1,
        ),
      );

      if (input.type === "not_interested") {
        if (itemId) {
          aggregateDeltas.push({
            signalType: UserNewsBehaviorSignalType.item,
            signalKey: itemId,
            delta: -negativeWeight,
          });
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "items", itemId),
              negativeWeight,
            ),
          );
        } else if (eventId) {
          aggregateDeltas.push({
            signalType: UserNewsBehaviorSignalType.event,
            signalKey: eventId,
            delta: -negativeWeight,
          });
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "events", eventId),
              negativeWeight,
            ),
          );
        } else if (source) {
          aggregateDeltas.push({
            signalType: UserNewsBehaviorSignalType.source,
            signalKey: source,
            delta: -negativeWeight,
          });
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "sources", source),
              negativeWeight,
            ),
          );
        } else if (topics[0]) {
          aggregateDeltas.push({
            signalType: UserNewsBehaviorSignalType.topic,
            signalKey: topics[0],
            delta: -negativeWeight,
          });
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "topics", topics[0]),
              negativeWeight,
            ),
          );
        } else if (entities[0]) {
          aggregateDeltas.push({
            signalType: UserNewsBehaviorSignalType.entity,
            signalKey: entities[0],
            delta: -negativeWeight,
          });
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "entities", entities[0]),
              negativeWeight,
            ),
          );
        }
      }

      if (input.type === "unsubscribe") {
        if (topics[0]) {
          aggregateDeltas.push({
            signalType: UserNewsBehaviorSignalType.topic,
            signalKey: topics[0],
            delta: -negativeWeight,
          });
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "topics", topics[0]),
              negativeWeight,
            ),
          );
        }
        if (entities[0]) {
          aggregateDeltas.push({
            signalType: UserNewsBehaviorSignalType.entity,
            signalKey: entities[0],
            delta: -negativeWeight,
          });
          ops.push(
            this.cache.hincrby(
              dailyKey,
              this.buildBehaviorFieldKey("n", "entities", entities[0]),
              negativeWeight,
            ),
          );
        }
      }
    }

    await Promise.all(ops);
    await Promise.all([
      this.cache.expire(dailyKey, USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS),
      this.cache.del(this.buildProfileCacheKey(input.orgId, input.userId)),
    ]);
    await this.persistAggregateDeltas(
      input.orgId,
      input.userId,
      aggregateDeltas,
    );

    return { recorded: true };
  }

  async getProfile(orgId: string, userId: string): Promise<UserNewsBehaviorProfile> {
    const cacheKey = this.buildProfileCacheKey(orgId, userId);
    const cached = await this.cache.get<UserNewsBehaviorProfile>(cacheKey);
    if (cached) {
      return cached;
    }

    const profile = await this.computeResolvedProfile(orgId, userId);
    await this.cache.set(cacheKey, profile, USER_NEWS_BEHAVIOR_PROFILE_CACHE_TTL_SECONDS);
    return profile;
  }

  async clearProfile(orgId: string, userId: string): Promise<{ cleared: true }> {
    const legacyKeys = USER_NEWS_BEHAVIOR_HASH_KINDS.map((kind) =>
      buildUserNewsBehaviorHashKey({ orgId, userId, kind }),
    );
    const v2Keys = this.buildRecentDayKeys(orgId, userId);
    await this.cache.delMany([
      ...legacyKeys,
      ...v2Keys,
      this.buildProfileCacheKey(orgId, userId),
    ]);
    await this.prisma.$transaction([
      this.prisma.userNewsBehaviorAggregate.deleteMany({
        where: { orgId, userId },
      }),
      this.prisma.userNewsSimilaritySnapshot.deleteMany({
        where: { orgId, userId },
      }),
    ]);
    return { cleared: true };
  }

  async getPersonalizationProfile(orgId: string, userId: string) {
    const profile = await this.getProfile(orgId, userId);
    return {
      positive: profile.positive,
      negative: profile.negative,
      net: profile.net,
      meta: profile.meta,
    };
  }

  async getCollaborativeProfile(
    orgId: string,
    userId: string,
  ): Promise<UserNewsCollaborativeProfile> {
    const snapshot = await this.getSimilaritySnapshot(orgId, userId);
    if (snapshot.neighbors.length === 0) {
      return {
        sources: {},
        topics: {},
        entities: {},
        items: {},
        events: {},
        domains: {},
        neighbors: [],
        degraded: snapshot.degraded,
        computedAt: snapshot.computedAt,
      };
    }

    const similarityByUserId = new Map(
      snapshot.neighbors.map((neighbor) => [neighbor.userId, neighbor.similarity] as const),
    );
    const rows = await this.prisma.userNewsBehaviorAggregate.findMany({
      where: {
        orgId,
        userId: { in: snapshot.neighbors.map((neighbor) => neighbor.userId) },
      },
      select: {
        userId: true,
        signalType: true,
        signalKey: true,
        score: true,
        lastInteractedAt: true,
      },
    });

    const collaborative = this.createEmptyScoreDimensions();
    for (const row of rows) {
      const similarity = similarityByUserId.get(row.userId) ?? 0;
      if (similarity <= 0 || row.score <= 0) {
        continue;
      }
      const dimension = this.mapSignalTypeToDimension(row.signalType);
      if (!dimension) {
        continue;
      }
      const decayedScore = this.toDecayedScore(row.score, row.lastInteractedAt);
      if (decayedScore <= 0) {
        continue;
      }
      collaborative[dimension][row.signalKey] =
        (collaborative[dimension][row.signalKey] ?? 0) +
        Number((decayedScore * similarity).toFixed(4));
    }

    return {
      sources: this.limitScoreRecord(collaborative.sources),
      topics: this.limitScoreRecord(collaborative.topics),
      entities: this.limitScoreRecord(collaborative.entities),
      items: this.limitScoreRecord(collaborative.items),
      events: this.limitScoreRecord(collaborative.events),
      domains: this.limitScoreRecord(collaborative.domains),
      neighbors: snapshot.neighbors,
      degraded: snapshot.degraded,
      computedAt: snapshot.computedAt,
    };
  }

  private async persistAggregateDeltas(
    orgId: string,
    userId: string,
    deltas: {
      signalType: UserNewsBehaviorSignalType;
      signalKey: string;
      delta: number;
    }[],
  ) {
    const merged = new Map<string, {
      signalType: UserNewsBehaviorSignalType;
      signalKey: string;
      delta: number;
    }>();
    for (const delta of deltas) {
      if (!delta.signalKey || Math.abs(delta.delta) <= 0.0001) {
        continue;
      }
      const key = `${delta.signalType}:${delta.signalKey}`;
      const existing = merged.get(key);
      if (existing) {
        existing.delta = Number((existing.delta + delta.delta).toFixed(4));
      } else {
        merged.set(key, { ...delta });
      }
    }
    if (merged.size === 0) {
      return;
    }

    const now = new Date();
    await this.prisma.$transaction(
      Array.from(merged.values()).map((delta) =>
        this.prisma.userNewsBehaviorAggregate.upsert({
          where: {
            orgId_userId_signalType_signalKey: {
              orgId,
              userId,
              signalType: delta.signalType,
              signalKey: delta.signalKey,
            },
          },
          create: {
            orgId,
            userId,
            signalType: delta.signalType,
            signalKey: delta.signalKey,
            score: delta.delta,
            lastInteractedAt: now,
          },
          update: {
            score: {
              increment: delta.delta,
            },
            lastInteractedAt: now,
          },
        }),
      ),
    );
    await this.markSimilaritySnapshotDirty(orgId, userId);
  }

  private async markSimilaritySnapshotDirty(orgId: string, userId: string) {
    await this.prisma.userNewsSimilaritySnapshot.upsert({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
      create: {
        orgId,
        userId,
        dirty: true,
      },
      update: {
        dirty: true,
      },
    });
  }

  private async ensurePersistentAggregateBackfill(orgId: string, userId: string) {
    const existingCount = await this.prisma.userNewsBehaviorAggregate.count({
      where: { orgId, userId },
    });
    if (existingCount > 0) {
      return;
    }

    const profile = await this.getProfile(orgId, userId);
    const now = new Date();
    const data = PERSISTED_SIGNAL_DIMENSIONS.flatMap((dimension) =>
      Object.entries(profile.net[dimension] ?? {})
        .filter(([, score]) => Math.abs(score) > 0.0001)
        .map(([signalKey, score]) => ({
          orgId,
          userId,
          signalType: this.mapDimensionToSignalType(dimension),
          signalKey,
          score: Number(score.toFixed(4)),
          lastInteractedAt: now,
        })),
    );
    if (data.length === 0) {
      return;
    }

    await this.prisma.userNewsBehaviorAggregate.createMany({
      data,
      skipDuplicates: true,
    });
    await this.markSimilaritySnapshotDirty(orgId, userId);
  }

  private async getSimilaritySnapshot(orgId: string, userId: string): Promise<{
    neighbors: UserNewsSimilarityNeighbor[];
    degraded: boolean;
    computedAt: string | null;
  }> {
    await this.ensurePersistentAggregateBackfill(orgId, userId);

    const existing = await this.prisma.userNewsSimilaritySnapshot.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
      select: {
        dirty: true,
        computedAt: true,
        neighbors: true,
      },
    });

    if (this.isSimilaritySnapshotFresh(existing)) {
      return {
        neighbors: this.parseSimilarityNeighbors(existing?.neighbors),
        degraded: false,
        computedAt: existing?.computedAt?.toISOString() ?? null,
      };
    }

    try {
      const refreshed = await this.refreshSimilaritySnapshot(orgId, userId);
      return {
        neighbors: refreshed.neighbors,
        degraded: false,
        computedAt: refreshed.computedAt,
      };
    } catch {
      return {
        neighbors: this.parseSimilarityNeighbors(existing?.neighbors),
        degraded: true,
        computedAt: existing?.computedAt?.toISOString() ?? null,
      };
    }
  }

  private isSimilaritySnapshotFresh(
    snapshot:
      | {
          dirty: boolean;
          computedAt: Date | null;
          neighbors: unknown;
        }
      | null
      | undefined,
  ) {
    if (!snapshot || snapshot.dirty || !(snapshot.computedAt instanceof Date)) {
      return false;
    }
    return Date.now() - snapshot.computedAt.getTime() <= SIMILARITY_SNAPSHOT_TTL_MS;
  }

  private async refreshSimilaritySnapshot(
    orgId: string,
    userId: string,
  ): Promise<{ neighbors: UserNewsSimilarityNeighbor[]; computedAt: string }> {
    const lockKey = `user-news-behavior:similarity:${orgId}:${userId}`;
    const locked = await this.cache.withLock(
      lockKey,
      SIMILARITY_LOCK_TTL_MS,
      async () => {
        const targetRows = await this.prisma.userNewsBehaviorAggregate.findMany({
          where: { orgId, userId },
          select: {
            signalType: true,
            signalKey: true,
            score: true,
            lastInteractedAt: true,
          },
        });

        const neighbors = await this.computeSimilarityNeighbors(
          orgId,
          userId,
          targetRows,
        );
        const computedAt = new Date();
        const serializedNeighbors = neighbors as unknown as Prisma.InputJsonValue;

        await this.prisma.userNewsSimilaritySnapshot.upsert({
          where: {
            orgId_userId: {
              orgId,
              userId,
            },
          },
          create: {
            orgId,
            userId,
            dirty: false,
            computedAt,
            neighbors: serializedNeighbors,
          },
          update: {
            dirty: false,
            computedAt,
            neighbors: serializedNeighbors,
          },
        });

        return {
          neighbors,
          computedAt: computedAt.toISOString(),
        };
      },
    );

    if (locked) {
      return locked;
    }

    const snapshot = await this.prisma.userNewsSimilaritySnapshot.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
      select: {
        dirty: true,
        computedAt: true,
        neighbors: true,
      },
    });
    if (this.isSimilaritySnapshotFresh(snapshot)) {
      return {
        neighbors: this.parseSimilarityNeighbors(snapshot?.neighbors),
        computedAt: snapshot?.computedAt?.toISOString() ?? new Date().toISOString(),
      };
    }

    const targetRows = await this.prisma.userNewsBehaviorAggregate.findMany({
      where: { orgId, userId },
      select: {
        signalType: true,
        signalKey: true,
        score: true,
        lastInteractedAt: true,
      },
    });
    const neighbors = await this.computeSimilarityNeighbors(orgId, userId, targetRows);
    return {
      neighbors,
      computedAt: new Date().toISOString(),
    };
  }

  private async computeSimilarityNeighbors(
    orgId: string,
    userId: string,
    targetRows: {
      signalType: UserNewsBehaviorSignalType;
      signalKey: string;
      score: number;
      lastInteractedAt: Date;
    }[],
  ): Promise<UserNewsSimilarityNeighbor[]> {
    const targetVector = new Map<string, number>();
    let targetNorm = 0;
    for (const row of targetRows) {
      const weighted = this.toDecayedScore(row.score, row.lastInteractedAt);
      if (Math.abs(weighted) <= 0.0001) {
        continue;
      }
      const key = `${row.signalType}:${row.signalKey}`;
      targetVector.set(key, weighted);
      targetNorm += weighted * weighted;
    }
    if (targetVector.size === 0 || targetNorm <= 0) {
      return [];
    }

    const topSignals = Array.from(targetVector.entries())
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, SIMILARITY_TOP_SIGNALS)
      .map(([key]) => {
        const [signalType, ...rest] = key.split(":");
        return {
          signalType: signalType as UserNewsBehaviorSignalType,
          signalKey: rest.join(":"),
        };
      });
    if (topSignals.length === 0) {
      return [];
    }

    const sharedRows = await this.prisma.userNewsBehaviorAggregate.findMany({
      where: {
        orgId,
        userId: { not: userId },
        OR: topSignals.map((signal) => ({
          signalType: signal.signalType,
          signalKey: signal.signalKey,
        })),
      },
      select: {
        userId: true,
        signalType: true,
        signalKey: true,
        score: true,
        lastInteractedAt: true,
      },
    });

    const previewByUserId = new Map<string, { sharedSignals: Set<string>; sharedDot: number }>();
    for (const row of sharedRows) {
      const key = `${row.signalType}:${row.signalKey}`;
      const targetValue = targetVector.get(key);
      if (targetValue === undefined) {
        continue;
      }
      const candidateValue = this.toDecayedScore(row.score, row.lastInteractedAt);
      if (Math.abs(candidateValue) <= 0.0001) {
        continue;
      }
      const preview = previewByUserId.get(row.userId) ?? {
        sharedSignals: new Set<string>(),
        sharedDot: 0,
      };
      preview.sharedSignals.add(key);
      preview.sharedDot += targetValue * candidateValue;
      previewByUserId.set(row.userId, preview);
    }

    const candidateUserIds = Array.from(previewByUserId.entries())
      .filter(([, preview]) => preview.sharedSignals.size >= SIMILARITY_MIN_SHARED_SIGNALS)
      .sort((left, right) => {
        if (right[1].sharedSignals.size !== left[1].sharedSignals.size) {
          return right[1].sharedSignals.size - left[1].sharedSignals.size;
        }
        return right[1].sharedDot - left[1].sharedDot;
      })
      .slice(0, SIMILARITY_CANDIDATE_LIMIT)
      .map(([candidateUserId]) => candidateUserId);
    if (candidateUserIds.length === 0) {
      return [];
    }

    const candidateRows = await this.prisma.userNewsBehaviorAggregate.findMany({
      where: {
        orgId,
        userId: { in: candidateUserIds },
      },
      select: {
        userId: true,
        signalType: true,
        signalKey: true,
        score: true,
        lastInteractedAt: true,
      },
    });

    const rowsByUserId = new Map<string, typeof candidateRows>();
    for (const row of candidateRows) {
      const bucket = rowsByUserId.get(row.userId) ?? [];
      bucket.push(row);
      rowsByUserId.set(row.userId, bucket);
    }

    const neighbors = candidateUserIds
      .map((candidateUserId) => {
        const rows = rowsByUserId.get(candidateUserId) ?? [];
        const preview = previewByUserId.get(candidateUserId);
        if (!preview || rows.length === 0) {
          return null;
        }
        let dot = 0;
        let candidateNorm = 0;
        for (const row of rows) {
          const candidateValue = this.toDecayedScore(row.score, row.lastInteractedAt);
          if (Math.abs(candidateValue) <= 0.0001) {
            continue;
          }
          candidateNorm += candidateValue * candidateValue;
          const key = `${row.signalType}:${row.signalKey}`;
          const targetValue = targetVector.get(key);
          if (targetValue !== undefined) {
            dot += targetValue * candidateValue;
          }
        }
        if (candidateNorm <= 0 || dot <= 0) {
          return null;
        }
        const similarity = dot / Math.sqrt(targetNorm * candidateNorm);
        if (!Number.isFinite(similarity) || similarity <= 0) {
          return null;
        }
        return {
          userId: candidateUserId,
          similarity: Number(similarity.toFixed(4)),
          sharedSignals: preview.sharedSignals.size,
        };
      })
      .filter((neighbor): neighbor is UserNewsSimilarityNeighbor => Boolean(neighbor))
      .sort((left, right) => {
        if (right.similarity !== left.similarity) {
          return right.similarity - left.similarity;
        }
        if (right.sharedSignals !== left.sharedSignals) {
          return right.sharedSignals - left.sharedSignals;
        }
        return left.userId.localeCompare(right.userId);
      })
      .slice(0, SIMILARITY_NEIGHBOR_LIMIT);

    return neighbors;
  }

  private parseSimilarityNeighbors(value: unknown): UserNewsSimilarityNeighbor[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const neighbors = value
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const userId = this.normalizeId(
          typeof record.userId === "string" ? record.userId : undefined,
        );
        const similarity =
          typeof record.similarity === "number" && Number.isFinite(record.similarity)
            ? Number(record.similarity.toFixed(4))
            : 0;
        const sharedSignals =
          typeof record.sharedSignals === "number" && Number.isFinite(record.sharedSignals)
            ? Math.max(0, Math.floor(record.sharedSignals))
            : 0;
        if (!userId || similarity <= 0 || sharedSignals < SIMILARITY_MIN_SHARED_SIGNALS) {
          return null;
        }
        return {
          userId,
          similarity,
          sharedSignals,
        };
      })
      .filter((neighbor): neighbor is UserNewsSimilarityNeighbor => Boolean(neighbor))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, SIMILARITY_NEIGHBOR_LIMIT);
    return neighbors;
  }

  private toDecayedScore(score: number, lastInteractedAt: Date): number {
    if (!Number.isFinite(score) || Math.abs(score) <= 0.0001) {
      return 0;
    }
    if (!(lastInteractedAt instanceof Date)) {
      return Number(score.toFixed(4));
    }
    const ageDays = Math.max(
      0,
      (Date.now() - lastInteractedAt.getTime()) / (24 * 60 * 60 * 1000),
    );
    const decay = Math.pow(0.5, ageDays / SIMILARITY_SCORE_HALF_LIFE_DAYS);
    return Number((score * decay).toFixed(4));
  }

  private mapDimensionToSignalType(
    dimension: (typeof PERSISTED_SIGNAL_DIMENSIONS)[number],
  ): UserNewsBehaviorSignalType {
    switch (dimension) {
      case "sources":
        return UserNewsBehaviorSignalType.source;
      case "topics":
        return UserNewsBehaviorSignalType.topic;
      case "entities":
        return UserNewsBehaviorSignalType.entity;
      case "items":
        return UserNewsBehaviorSignalType.item;
      case "events":
        return UserNewsBehaviorSignalType.event;
      case "domains":
        return UserNewsBehaviorSignalType.domain;
    }
  }

  private mapSignalTypeToDimension(
    signalType: UserNewsBehaviorSignalType,
  ): (typeof PERSISTED_SIGNAL_DIMENSIONS)[number] | null {
    switch (signalType) {
      case UserNewsBehaviorSignalType.source:
        return "sources";
      case UserNewsBehaviorSignalType.topic:
        return "topics";
      case UserNewsBehaviorSignalType.entity:
        return "entities";
      case UserNewsBehaviorSignalType.item:
        return "items";
      case UserNewsBehaviorSignalType.event:
        return "events";
      case UserNewsBehaviorSignalType.domain:
        return "domains";
      default:
        return null;
    }
  }

  private parseScoreRecord(
    record: Record<string, string>,
    normalizeKey: (value?: string) => string | null = (value) =>
      this.normalizeTerm(value),
  ): Record<string, number> {
    const normalized = Object.entries(record ?? {})
      .map(([key, rawValue]) => {
        const term = normalizeKey(key);
        if (!term) {
          return null;
        }
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return null;
        }
        return [term, parsed] as const;
      })
      .filter((entry): entry is readonly [string, number] => Boolean(entry))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 300);

    return Object.fromEntries(normalized);
  }

  private async computeResolvedProfile(
    orgId: string,
    userId: string,
  ): Promise<UserNewsBehaviorProfile> {
    const dayKeys = this.buildRecentDayKeys(orgId, userId);
    const rawDays = await Promise.all(dayKeys.map((key) => this.cache.hgetall(key)));
    const positive = this.createEmptyScoreDimensions();
    const negative = this.createEmptyScoreDimensions();
    const bandProfiles = USER_NEWS_BEHAVIOR_BANDS.map((band) => ({
      key: band.key,
      weight: band.weight,
      positive: this.createEmptyScoreDimensions(),
      negative: this.createEmptyScoreDimensions(),
    }));

    let positiveActionRawTotal = 0;

    rawDays.forEach((raw, dayOffset) => {
      const bandIndex = this.resolveBandIndex(dayOffset);
      if (bandIndex < 0) {
        return;
      }
      const bandProfile = bandProfiles[bandIndex];
      if (!bandProfile) {
        return;
      }
      const positiveRaw = this.createEmptyScoreDimensions();
      const negativeRaw = this.createEmptyScoreDimensions();

      for (const [field, rawValue] of Object.entries(raw ?? {})) {
        const parsed = this.parseBehaviorFieldKey(field);
        if (!parsed) {
          continue;
        }
        const score = Number(rawValue);
        if (!Number.isFinite(score) || score <= 0) {
          continue;
        }

        const target =
          parsed.polarity === "p"
            ? positiveRaw[parsed.dimension]
            : negativeRaw[parsed.dimension];
        target[parsed.term] = (target[parsed.term] ?? 0) + score;

        if (parsed.polarity === "p" && parsed.dimension === "actions") {
          positiveActionRawTotal += score;
        }
      }

      USER_NEWS_BEHAVIOR_DIMENSIONS.forEach((dimension) => {
        this.addBandScores(
          positive[dimension],
          bandProfile.positive[dimension],
          positiveRaw[dimension],
          bandProfile.weight,
          dimension,
        );
        this.addBandScores(
          negative[dimension],
          bandProfile.negative[dimension],
          negativeRaw[dimension],
          bandProfile.weight,
          dimension,
        );
      });
    });

    const fallback = await this.loadLegacyFallback(orgId, userId, positiveActionRawTotal);
    if (fallback) {
      USER_NEWS_BEHAVIOR_DIMENSIONS.forEach((dimension) => {
        this.mergeScores(positive[dimension], fallback[dimension]);
      });
    }

    const net = this.createEmptyScoreDimensions();
    USER_NEWS_BEHAVIOR_DIMENSIONS.forEach((dimension) => {
      net[dimension] = this.subtractScores(positive[dimension], negative[dimension]);
    });

    const profile: UserNewsBehaviorProfile = {
      actions: this.clampScores(net.actions),
      sources: this.clampScores(net.sources),
      topics: this.clampScores(net.topics),
      entities: this.clampScores(net.entities),
      items: this.clampScores(net.items),
      events: this.clampScores(net.events),
      domains: this.clampScores(net.domains),
      positive,
      negative,
      net,
      bands: bandProfiles.map((band) => ({
        key: band.key,
        weight: band.weight,
        positive: band.positive,
        negative: band.negative,
        net: {
          actions: this.subtractScores(band.positive.actions, band.negative.actions),
          sources: this.subtractScores(band.positive.sources, band.negative.sources),
          topics: this.subtractScores(band.positive.topics, band.negative.topics),
          entities: this.subtractScores(band.positive.entities, band.negative.entities),
          items: this.subtractScores(band.positive.items, band.negative.items),
          events: this.subtractScores(band.positive.events, band.negative.events),
          domains: this.subtractScores(band.positive.domains, band.negative.domains),
        },
      })),
      meta: {
        legacyFallbackUsed: Boolean(fallback),
      },
    };

    return profile;
  }

  private async loadLegacyFallback(
    orgId: string,
    userId: string,
    positiveActionRawTotal: number,
  ): Promise<UserNewsBehaviorScoreDimensions | null> {
    if (positiveActionRawTotal > LEGACY_FALLBACK_ACTION_THRESHOLD) {
      return null;
    }

    const [
      actionRaw,
      sourceRaw,
      topicRaw,
      entityRaw,
      itemRaw,
      eventRaw,
      domainRaw,
    ] = await Promise.all([
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "actions" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "sources" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "topics" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "entities" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "items" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "events" }),
      ),
      this.cache.hgetall(
        buildUserNewsBehaviorHashKey({ orgId, userId, kind: "domains" }),
      ),
    ]);

    const fallback: UserNewsBehaviorScoreDimensions = {
      actions: this.scaleLegacyScores(this.parseScoreRecord(actionRaw)),
      sources: this.scaleLegacyScores(this.parseScoreRecord(sourceRaw)),
      topics: this.scaleLegacyScores(this.parseScoreRecord(topicRaw)),
      entities: this.scaleLegacyScores(this.parseScoreRecord(entityRaw)),
      items: this.scaleLegacyScores(
        this.parseScoreRecord(itemRaw, (value) => this.normalizeId(value)),
      ),
      events: this.scaleLegacyScores(
        this.parseScoreRecord(eventRaw, (value) => this.normalizeId(value)),
      ),
      domains: this.scaleLegacyScores(this.parseScoreRecord(domainRaw)),
    };

    const hasFallback = USER_NEWS_BEHAVIOR_DIMENSIONS.some(
      (dimension) => Object.keys(fallback[dimension]).length > 0,
    );
    return hasFallback ? fallback : null;
  }

  private scaleLegacyScores(record: UserNewsBehaviorScoreRecord): UserNewsBehaviorScoreRecord {
    const out: UserNewsBehaviorScoreRecord = {};
    for (const [term, value] of Object.entries(record ?? {})) {
      const scaled = Number((Math.log1p(value) * LEGACY_FALLBACK_SCALE).toFixed(4));
      if (scaled <= 0) {
        continue;
      }
      out[term] = scaled;
    }
    return out;
  }

  private createEmptyScoreDimensions(): UserNewsBehaviorScoreDimensions {
    return {
      actions: {},
      sources: {},
      topics: {},
      entities: {},
      items: {},
      events: {},
      domains: {},
    };
  }

  private addBandScores(
    aggregate: UserNewsBehaviorScoreRecord,
    bandTarget: UserNewsBehaviorScoreRecord,
    raw: UserNewsBehaviorScoreRecord,
    weight: number,
    dimension: keyof UserNewsBehaviorScoreDimensions,
  ) {
    const normalizeKey =
      dimension === "items" || dimension === "events"
        ? (value?: string) => this.normalizeId(value)
        : (value?: string) => this.normalizeTerm(value);

    for (const [term, rawValue] of Object.entries(raw ?? {})) {
      const normalizedTerm = normalizeKey(term);
      if (!normalizedTerm || rawValue <= 0) {
        continue;
      }
      const score = Number((Math.log1p(rawValue) * weight).toFixed(4));
      if (score <= 0) {
        continue;
      }
      bandTarget[normalizedTerm] = (bandTarget[normalizedTerm] ?? 0) + score;
      aggregate[normalizedTerm] = (aggregate[normalizedTerm] ?? 0) + score;
    }
  }

  private mergeScores(
    target: UserNewsBehaviorScoreRecord,
    incoming: UserNewsBehaviorScoreRecord,
  ) {
    for (const [term, value] of Object.entries(incoming ?? {})) {
      target[term] = (target[term] ?? 0) + value;
    }
  }

  private subtractScores(
    positive: UserNewsBehaviorScoreRecord,
    negative: UserNewsBehaviorScoreRecord,
  ): UserNewsBehaviorScoreRecord {
    const out: UserNewsBehaviorScoreRecord = {};
    const keys = new Set([
      ...Object.keys(positive ?? {}),
      ...Object.keys(negative ?? {}),
    ]);
    for (const key of keys) {
      const value = Number(
        (((positive?.[key] ?? 0) - (negative?.[key] ?? 0))).toFixed(4),
      );
      if (Math.abs(value) <= 0.0001) {
        continue;
      }
      out[key] = value;
    }
    return this.limitScoreRecord(out);
  }

  private clampScores(record: UserNewsBehaviorScoreRecord): UserNewsBehaviorScoreRecord {
    const out: UserNewsBehaviorScoreRecord = {};
    for (const [term, value] of Object.entries(record ?? {})) {
      const clamped = Number(Math.max(0, value).toFixed(4));
      if (clamped <= 0) {
        continue;
      }
      out[term] = clamped;
    }
    return this.limitScoreRecord(out);
  }

  private limitScoreRecord(record: UserNewsBehaviorScoreRecord): UserNewsBehaviorScoreRecord {
    return Object.fromEntries(
      Object.entries(record ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 300),
    );
  }

  private buildRecentDayKeys(orgId: string, userId: string): string[] {
    const keys: string[] = [];
    const now = new Date();
    for (let dayOffset = 0; dayOffset < USER_NEWS_BEHAVIOR_V2_WINDOW_DAYS; dayOffset += 1) {
      const date = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - dayOffset,
      ));
      keys.push(
        buildUserNewsBehaviorDayKey({
          orgId,
          userId,
          dayKey: this.formatDayKey(date),
        }),
      );
    }
    return keys;
  }

  private formatDayKey(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  private resolveBandIndex(dayOffset: number): number {
    return USER_NEWS_BEHAVIOR_BANDS.findIndex(
      (band) =>
        dayOffset >= band.startDayOffset && dayOffset <= band.endDayOffset,
    );
  }

  private buildBehaviorFieldKey(
    polarity: "p" | "n",
    dimension: keyof UserNewsBehaviorScoreDimensions,
    term: string,
  ): string {
    return `${polarity}:${dimension}:${term}`;
  }

  private parseBehaviorFieldKey(field: string):
    | {
        polarity: "p" | "n";
        dimension: keyof UserNewsBehaviorScoreDimensions;
        term: string;
      }
    | null {
    const match = field.match(
      /^(p|n):(actions|sources|topics|entities|items|events|domains):(.+)$/,
    );
    if (!match) {
      return null;
    }
    const [, polarity, dimension, term] = match;
    if (!term) {
      return null;
    }
    return {
      polarity: polarity as "p" | "n",
      dimension: dimension as keyof UserNewsBehaviorScoreDimensions,
      term,
    };
  }

  private buildProfileCacheKey(orgId: string, userId: string) {
    return buildUserNewsBehaviorProfileCacheKey({ orgId, userId });
  }

  private normalizeTerms(values?: string[]): string[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const term = this.normalizeTerm(value);
      if (!term || seen.has(term)) {
        continue;
      }
      seen.add(term);
      out.push(term);
      if (out.length >= MAX_TERMS_PER_DIMENSION) {
        break;
      }
    }
    return out;
  }

  private normalizeId(value?: string): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim().slice(0, MAX_ID_LENGTH);
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeUrlDomain(value?: string): string | null {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname
        .trim()
        .toLowerCase()
        .replace(/^www\./, "");
      return this.normalizeTerm(hostname);
    } catch {
      return null;
    }
  }

  private normalizeSourceSignal(sourceValue?: string, domain?: string | null): string | null {
    const normalizedSource = this.normalizeTerm(sourceValue);
    if (normalizedSource && this.looksLikeStructuredSourceKey(normalizedSource)) {
      return normalizedSource;
    }
    if (domain) {
      return domain;
    }
    return normalizedSource;
  }

  private looksLikeStructuredSourceKey(value: string): boolean {
    if (!value || value.includes(" ")) {
      return false;
    }
    return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value);
  }

  private normalizeTerm(value?: string): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const compact = value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, MAX_TERM_LENGTH);
    return compact.length > 0 ? compact : null;
  }
}
