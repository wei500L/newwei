import { ProcessedItemModel } from '@modular/mongo';
import { createLogger } from '@modular/utils';
import {
  ContentSubscriptionKind,
  ContentSubscriptionSource,
  Prisma,
} from '@prisma/client';
import { Injectable } from '@nestjs/common';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';
import { LiteLlmService } from '../news-pipeline/litellm.service';
import {
  NewsClassificationSettingsService,
  type NewsClassificationTaxonomyNode,
} from '../news-pipeline/news-classification-settings.service';
import { UserNewsBehaviorService } from '../user-news-behavior/user-news-behavior.service';
import { USER_DIGEST_PREFERENCE_KEY } from '../user-digest/user-digest.constants';

const DAY_MS = 24 * 60 * 60 * 1000;
const CATALOG_WINDOW_DAYS = 90;
const CATALOG_MIN_COUNT = 2;
const CATALOG_SYNC_TTL_SECONDS = 6 * 60 * 60;
const CATALOG_SYNC_LOCK_TTL_MS = 15 * 60 * 1000;
const CATALOG_MAX_CANDIDATES_PER_KIND = 240;
const CATALOG_LIST_LIMIT = 200;
const EMBEDDING_BATCH_SIZE = 64;
const RECOMMENDATION_LIMIT = 12;
const RECOMMENDATION_CANDIDATE_LIMIT = 48;
const RELATED_TOPIC_LIMIT = 8;
const RELATED_TOPIC_CANDIDATE_LIMIT = 36;
const USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND = 50;
const USER_CONTENT_SUBSCRIPTION_MIGRATION_KEY = 'ai:content-subscription:migrated:v1';

const CONTENT_SUBSCRIPTION_KINDS = [
  ContentSubscriptionKind.topic,
  ContentSubscriptionKind.entity,
] as const;

interface CatalogCandidate {
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  count: number;
  lastSeenAt: Date;
  metadata?: Record<string, unknown>;
}

interface CatalogResolution {
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  taxonomyPath: string | null;
  taxonomyVersion: string | null;
  embeddingModel: string | null;
  embeddingVector: number[] | null;
  metadata?: Record<string, unknown> | null;
}

interface TaxonomyDescriptor {
  settingsVersion: string;
  nodes: NewsClassificationTaxonomyNode[];
  byPath: Map<string, NewsClassificationTaxonomyNode>;
  documents: { path: string; text: string }[];
}

export interface ContentSubscriptionItem {
  id: string;
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  taxonomyPath: string | null;
  taxonomyDisplayName: string | null;
  taxonomyLabels: string[];
  source: ContentSubscriptionSource;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ContentSubscriptionCatalogItem {
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  count: number;
  lastSeenAt: string;
  taxonomyPath: string | null;
  taxonomyDisplayName: string | null;
  taxonomyLabels: string[];
  metadata?: unknown;
  score?: number;
}

export interface ContentSubscriptionListResponse {
  limitPerKind: number;
  counts: Record<ContentSubscriptionKind, number>;
  items: ContentSubscriptionItem[];
  taxonomyVersion: string;
}

export interface ContentSubscriptionCatalogResponse {
  limit: number;
  taxonomyVersion: string;
  items: ContentSubscriptionCatalogItem[];
}

export interface ContentSubscriptionBatchResultItem {
  kind: ContentSubscriptionKind;
  normalizedValue: string;
  displayValue: string;
  taxonomyPath: string | null;
  taxonomyDisplayName: string | null;
  taxonomyLabels: string[];
  status: 'subscribed' | 'already_subscribed' | 'deleted' | 'not_found' | 'limit_reached';
}

export interface ContentSubscriptionBatchResponse {
  limitPerKind: number;
  counts: Record<ContentSubscriptionKind, number>;
  items: ContentSubscriptionBatchResultItem[];
}

@Injectable()
export class UserContentSubscriptionsService {
  private readonly logger = createLogger({ name: 'user-content-subscriptions' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly settings: NewsClassificationSettingsService,
    private readonly liteLlm: LiteLlmService,
    private readonly behavior: UserNewsBehaviorService,
  ) {}

  async listUserSubscriptions(
    orgId: string,
    userId: string,
  ): Promise<ContentSubscriptionListResponse> {
    await this.ensureLegacyMigration(orgId, userId);
    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const rows = await this.prisma.userContentSubscription.findMany({
      where: { orgId, userId },
      orderBy: [
        { taxonomyPath: 'asc' },
        { kind: 'asc' },
        { displayValue: 'asc' },
      ],
    });

    const counts: Record<ContentSubscriptionKind, number> = {
      [ContentSubscriptionKind.topic]: 0,
      [ContentSubscriptionKind.entity]: 0,
    };

    const items = rows.map((row) => {
      counts[row.kind] += 1;
      return this.mapSubscriptionRow(row, taxonomy.byPath);
    });

    return {
      limitPerKind: USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND,
      counts,
      items,
      taxonomyVersion: taxonomy.settingsVersion,
    };
  }

  async batchUpsertSubscriptions(
    orgId: string,
    userId: string,
    input: {
      subscriptions: {
        kind: ContentSubscriptionKind;
        value: string;
        source?: ContentSubscriptionSource;
      }[];
    },
  ): Promise<ContentSubscriptionBatchResponse> {
    await this.ensureLegacyMigration(orgId, userId);
    await this.ensureCatalogFresh(orgId);

    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const normalized = this.normalizeInputEntries(input.subscriptions ?? []);
    if (normalized.length === 0) {
      return this.buildBatchResponse([], {
        [ContentSubscriptionKind.topic]: await this.prisma.userContentSubscription.count({
          where: { orgId, userId, kind: ContentSubscriptionKind.topic },
        }),
        [ContentSubscriptionKind.entity]: await this.prisma.userContentSubscription.count({
          where: { orgId, userId, kind: ContentSubscriptionKind.entity },
        }),
      }, taxonomy.byPath);
    }

    const existingRows = await this.prisma.userContentSubscription.findMany({
      where: {
        orgId,
        userId,
        OR: normalized.map((entry) => ({
          kind: entry.kind,
          normalizedValue: entry.normalizedValue,
        })),
      },
    });
    const existingByKey = new Map(
      existingRows.map((row) => [this.subscriptionKey(row.kind, row.normalizedValue), row]),
    );

    const counts: Record<ContentSubscriptionKind, number> = {
      [ContentSubscriptionKind.topic]: await this.prisma.userContentSubscription.count({
        where: { orgId, userId, kind: ContentSubscriptionKind.topic },
      }),
      [ContentSubscriptionKind.entity]: await this.prisma.userContentSubscription.count({
        where: { orgId, userId, kind: ContentSubscriptionKind.entity },
      }),
    };

    const resolutions = await this.resolveCatalogEntries(orgId, normalized);
    const resolutionByKey = new Map(
      resolutions.map((entry) => [this.subscriptionKey(entry.kind, entry.normalizedValue), entry]),
    );

    const results: ContentSubscriptionBatchResultItem[] = [];
    for (const entry of normalized) {
      const key = this.subscriptionKey(entry.kind, entry.normalizedValue);
      const existing = existingByKey.get(key);
      const resolution = resolutionByKey.get(key) ?? this.toAdHocResolution(entry, taxonomy.settingsVersion);
      if (existing) {
        results.push(this.toBatchResult('already_subscribed', existing.kind, existing.normalizedValue, existing.displayValue, existing.taxonomyPath, taxonomy.byPath));
        continue;
      }
      if (counts[entry.kind] >= USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND) {
        results.push(this.toBatchResult('limit_reached', entry.kind, entry.normalizedValue, resolution.displayValue, resolution.taxonomyPath, taxonomy.byPath));
        continue;
      }

      const created = await this.prisma.userContentSubscription.create({
        data: {
          orgId,
          userId,
          kind: entry.kind,
          normalizedValue: entry.normalizedValue,
          displayValue: resolution.displayValue,
          taxonomyPath: resolution.taxonomyPath,
          taxonomyVersion: resolution.taxonomyVersion,
          source: entry.source ?? ContentSubscriptionSource.manual,
          metadata: toPrismaJsonValue(resolution.metadata ?? {}),
        },
      });
      counts[entry.kind] += 1;
      results.push(this.toBatchResult('subscribed', created.kind, created.normalizedValue, created.displayValue, created.taxonomyPath, taxonomy.byPath));
    }

    return this.buildBatchResponse(results, counts, taxonomy.byPath);
  }

  async batchDeleteSubscriptions(
    orgId: string,
    userId: string,
    input: {
      subscriptions: {
        kind: ContentSubscriptionKind;
        value: string;
      }[];
    },
  ): Promise<ContentSubscriptionBatchResponse> {
    await this.ensureLegacyMigration(orgId, userId);
    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const normalized = this.normalizeInputEntries(input.subscriptions ?? []);
    if (normalized.length === 0) {
      return this.buildBatchResponse([], {
        [ContentSubscriptionKind.topic]: await this.prisma.userContentSubscription.count({
          where: { orgId, userId, kind: ContentSubscriptionKind.topic },
        }),
        [ContentSubscriptionKind.entity]: await this.prisma.userContentSubscription.count({
          where: { orgId, userId, kind: ContentSubscriptionKind.entity },
        }),
      }, taxonomy.byPath);
    }

    const existingRows = await this.prisma.userContentSubscription.findMany({
      where: {
        orgId,
        userId,
        OR: normalized.map((entry) => ({
          kind: entry.kind,
          normalizedValue: entry.normalizedValue,
        })),
      },
    });
    const existingByKey = new Map(
      existingRows.map((row) => [this.subscriptionKey(row.kind, row.normalizedValue), row]),
    );

    if (existingRows.length > 0) {
      await this.prisma.userContentSubscription.deleteMany({
        where: {
          orgId,
          userId,
          OR: existingRows.map((row) => ({ id: row.id })),
        },
      });
    }

    const results = normalized.map((entry) => {
      const existing = existingByKey.get(this.subscriptionKey(entry.kind, entry.normalizedValue));
      return this.toBatchResult(
        existing ? 'deleted' : 'not_found',
        entry.kind,
        entry.normalizedValue,
        existing?.displayValue ?? entry.displayValue,
        existing?.taxonomyPath ?? null,
        taxonomy.byPath,
      );
    });

    const counts: Record<ContentSubscriptionKind, number> = {
      [ContentSubscriptionKind.topic]: await this.prisma.userContentSubscription.count({
        where: { orgId, userId, kind: ContentSubscriptionKind.topic },
      }),
      [ContentSubscriptionKind.entity]: await this.prisma.userContentSubscription.count({
        where: { orgId, userId, kind: ContentSubscriptionKind.entity },
      }),
    };

    return this.buildBatchResponse(results, counts, taxonomy.byPath);
  }

  async listCatalog(
    orgId: string,
    options?: {
      kind?: ContentSubscriptionKind;
      query?: string;
      taxonomyPath?: string;
      limit?: number;
    },
  ): Promise<ContentSubscriptionCatalogResponse> {
    await this.ensureCatalogFresh(orgId);
    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const since = new Date(Date.now() - CATALOG_WINDOW_DAYS * DAY_MS);
    const limit = Math.min(Math.max(options?.limit ?? CATALOG_LIST_LIMIT, 1), CATALOG_LIST_LIMIT);
    const where: Prisma.ContentSubscriptionCatalogWhereInput = {
      orgId,
      count: { gte: CATALOG_MIN_COUNT },
      lastSeenAt: { gte: since },
      ...(options?.kind ? { kind: options.kind } : {}),
      ...(options?.taxonomyPath
        ? { taxonomyPath: { startsWith: options.taxonomyPath.trim() } }
        : {}),
      ...(options?.query?.trim()
        ? {
            OR: [
              { displayValue: { contains: options.query.trim() } },
              { normalizedValue: { contains: this.normalizeValue(options.query).normalizedValue } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.contentSubscriptionCatalog.findMany({
      where,
      orderBy: [{ count: 'desc' }, { lastSeenAt: 'desc' }, { displayValue: 'asc' }],
      take: limit,
    });

    return {
      limit,
      taxonomyVersion: taxonomy.settingsVersion,
      items: rows.map((row) => this.mapCatalogRow(row, taxonomy.byPath)),
    };
  }

  async listRecommendations(
    orgId: string,
    userId: string,
    limit = RECOMMENDATION_LIMIT,
  ): Promise<ContentSubscriptionCatalogResponse> {
    await this.ensureLegacyMigration(orgId, userId);
    await this.ensureCatalogFresh(orgId);

    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const profile = await this.behavior.getProfile(orgId, userId);
    const subscribedRows = await this.prisma.userContentSubscription.findMany({
      where: { orgId, userId },
      select: { kind: true, normalizedValue: true },
    });
    const subscribed = new Set(
      subscribedRows.map((row) => this.subscriptionKey(row.kind, row.normalizedValue)),
    );

    const candidateRows = await this.prisma.contentSubscriptionCatalog.findMany({
      where: {
        orgId,
        count: { gte: CATALOG_MIN_COUNT },
        lastSeenAt: { gte: new Date(Date.now() - CATALOG_WINDOW_DAYS * DAY_MS) },
      },
      orderBy: [{ count: 'desc' }, { lastSeenAt: 'desc' }],
      take: RECOMMENDATION_CANDIDATE_LIMIT * 4,
    });

    const availableCandidates = candidateRows.filter(
      (row) => !subscribed.has(this.subscriptionKey(row.kind, row.normalizedValue)),
    );

    if (availableCandidates.length === 0) {
      return {
        limit,
        taxonomyVersion: taxonomy.settingsVersion,
        items: [],
      };
    }

    const fallbackTop = availableCandidates.slice(0, limit).map((row) => this.mapCatalogRow(row, taxonomy.byPath));
    const queryText = this.buildRecommendationQuery(profile);
    if (!queryText) {
      return {
        limit,
        taxonomyVersion: taxonomy.settingsVersion,
        items: fallbackTop,
      };
    }

    const embeddingRanked = await this.rankCatalogRowsByEmbedding(orgId, queryText, availableCandidates);
    if (embeddingRanked.length === 0) {
      return {
        limit,
        taxonomyVersion: taxonomy.settingsVersion,
        items: fallbackTop,
      };
    }

    const reranked = await this.tryRerankCatalogRows(orgId, queryText, embeddingRanked.slice(0, RECOMMENDATION_CANDIDATE_LIMIT));
    const ordered = (reranked.length > 0 ? reranked : embeddingRanked)
      .slice(0, limit)
      .map((entry) => this.mapCatalogRow(entry.row, taxonomy.byPath, entry.score));

    return {
      limit,
      taxonomyVersion: taxonomy.settingsVersion,
      items: ordered,
    };
  }

  async lookupCatalogEntries(
    orgId: string,
    entries: {
      kind: ContentSubscriptionKind;
      value: string;
    }[],
  ): Promise<ContentSubscriptionCatalogResponse> {
    await this.ensureCatalogFresh(orgId);
    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const normalized = this.normalizeInputEntries(entries);
    const resolved = await this.resolveCatalogEntries(orgId, normalized);

    return {
      limit: normalized.length,
      taxonomyVersion: taxonomy.settingsVersion,
      items: resolved.map((entry) => this.mapCatalogResolution(entry, taxonomy.byPath)),
    };
  }

  async listRelatedTopics(
    orgId: string,
    userId: string,
    topic: string,
    limit = RELATED_TOPIC_LIMIT,
  ): Promise<ContentSubscriptionCatalogResponse> {
    await this.ensureLegacyMigration(orgId, userId);
    await this.ensureCatalogFresh(orgId);

    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const normalizedTopic = this.normalizeValue(topic);
    if (!normalizedTopic.normalizedValue) {
      return {
        limit,
        taxonomyVersion: taxonomy.settingsVersion,
        items: [],
      };
    }

    const current = (
      await this.resolveCatalogEntries(orgId, [
        {
          kind: ContentSubscriptionKind.topic,
          normalizedValue: normalizedTopic.normalizedValue,
          displayValue: normalizedTopic.displayValue,
        },
      ])
    )[0];
    if (!current) {
      return {
        limit,
        taxonomyVersion: taxonomy.settingsVersion,
        items: [],
      };
    }

    const subscribedTopicRows = await this.prisma.userContentSubscription.findMany({
      where: { orgId, userId, kind: ContentSubscriptionKind.topic },
      select: { normalizedValue: true },
    });
    const subscribed = new Set(subscribedTopicRows.map((row) => row.normalizedValue));
    const where: Prisma.ContentSubscriptionCatalogWhereInput = {
      orgId,
      kind: ContentSubscriptionKind.topic,
      count: { gte: CATALOG_MIN_COUNT },
      lastSeenAt: { gte: new Date(Date.now() - CATALOG_WINDOW_DAYS * DAY_MS) },
      normalizedValue: { not: current.normalizedValue },
      ...(current.taxonomyPath
        ? { taxonomyPath: { startsWith: this.taxonomyBranchPrefix(current.taxonomyPath) } }
        : {}),
    };
    const candidates = await this.prisma.contentSubscriptionCatalog.findMany({
      where,
      orderBy: [{ count: 'desc' }, { lastSeenAt: 'desc' }],
      take: RELATED_TOPIC_CANDIDATE_LIMIT * 3,
    });
    const filtered = candidates.filter((row) => !subscribed.has(row.normalizedValue));
    if (filtered.length === 0) {
      return {
        limit,
        taxonomyVersion: taxonomy.settingsVersion,
        items: [],
      };
    }

    const queryText = [
      `related topic: ${current.displayValue}`,
      current.taxonomyPath ? `taxonomy: ${current.taxonomyPath}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const embeddingRanked = await this.rankCatalogRowsByVector(
      current.embeddingVector,
      filtered,
      RELATED_TOPIC_CANDIDATE_LIMIT,
    );
    const fallbackRanked = embeddingRanked.length > 0 ? embeddingRanked : filtered.slice(0, limit).map((row) => ({ row, score: row.count }));
    const reranked = await this.tryRerankCatalogRows(orgId, queryText, fallbackRanked.slice(0, RELATED_TOPIC_CANDIDATE_LIMIT));
    const ordered = (reranked.length > 0 ? reranked : fallbackRanked)
      .slice(0, limit)
      .map((entry) => this.mapCatalogRow(entry.row, taxonomy.byPath, entry.score));

    return {
      limit,
      taxonomyVersion: taxonomy.settingsVersion,
      items: ordered,
    };
  }

  async replaceSubscriptionsFromDigestPreference(
    orgId: string,
    userId: string,
    input: {
      focusTopics?: string[];
      focusEntities?: string[];
    },
  ) {
    await this.ensureLegacyMigration(orgId, userId);
    if (input.focusTopics !== undefined) {
      await this.replaceSubscriptionsByKind(
        orgId,
        userId,
        ContentSubscriptionKind.topic,
        input.focusTopics,
        ContentSubscriptionSource.legacy,
      );
    }
    if (input.focusEntities !== undefined) {
      await this.replaceSubscriptionsByKind(
        orgId,
        userId,
        ContentSubscriptionKind.entity,
        input.focusEntities,
        ContentSubscriptionSource.legacy,
      );
    }
  }

  async getDigestPreferenceValues(orgId: string, userId: string) {
    await this.ensureLegacyMigration(orgId, userId);
    const rows = await this.prisma.userContentSubscription.findMany({
      where: { orgId, userId },
      orderBy: [{ kind: 'asc' }, { displayValue: 'asc' }],
      select: { kind: true, displayValue: true },
    });

    return {
      focusTopics: rows
        .filter((row) => row.kind === ContentSubscriptionKind.topic)
        .map((row) => row.displayValue),
      focusEntities: rows
        .filter((row) => row.kind === ContentSubscriptionKind.entity)
        .map((row) => row.displayValue),
    };
  }

  private async ensureLegacyMigration(orgId: string, userId: string) {
    const marker = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: USER_CONTENT_SUBSCRIPTION_MIGRATION_KEY,
        },
      },
      select: { id: true },
    });
    if (marker) {
      return;
    }

    const legacy = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: USER_DIGEST_PREFERENCE_KEY,
        },
      },
      select: { value: true },
    });

    const record =
      legacy?.value && typeof legacy.value === 'object' && !Array.isArray(legacy.value)
        ? (legacy.value as Record<string, unknown>)
        : {};
    const focusTopics = this.normalizeStringArray(record.focusTopics, USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND);
    const focusEntities = this.normalizeStringArray(record.focusEntities, USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND);

    if (focusTopics.length > 0) {
      await this.replaceSubscriptionsByKind(
        orgId,
        userId,
        ContentSubscriptionKind.topic,
        focusTopics,
        ContentSubscriptionSource.legacy,
      );
    }
    if (focusEntities.length > 0) {
      await this.replaceSubscriptionsByKind(
        orgId,
        userId,
        ContentSubscriptionKind.entity,
        focusEntities,
        ContentSubscriptionSource.legacy,
      );
    }

    await this.prisma.userSetting.upsert({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: USER_CONTENT_SUBSCRIPTION_MIGRATION_KEY,
        },
      },
      update: {
        value: toPrismaJsonValue({ migratedAt: new Date().toISOString() }),
      },
      create: {
        orgId,
        userId,
        key: USER_CONTENT_SUBSCRIPTION_MIGRATION_KEY,
        value: toPrismaJsonValue({ migratedAt: new Date().toISOString() }),
      },
    });
  }

  private async replaceSubscriptionsByKind(
    orgId: string,
    userId: string,
    kind: ContentSubscriptionKind,
    values: string[],
    source: ContentSubscriptionSource,
  ) {
    await this.ensureCatalogFresh(orgId);
    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const normalized = this.normalizeInputEntries(
      values.map((value) => ({ kind, value, source })),
    ).slice(0, USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND);
    const nextKeys = new Set(normalized.map((entry) => entry.normalizedValue));
    const currentRows = await this.prisma.userContentSubscription.findMany({
      where: { orgId, userId, kind },
    });

    const deleteIds = currentRows
      .filter((row) => !nextKeys.has(row.normalizedValue))
      .map((row) => row.id);
    if (deleteIds.length > 0) {
      await this.prisma.userContentSubscription.deleteMany({
        where: { orgId, userId, id: { in: deleteIds } },
      });
    }

    const existingKeys = new Set(currentRows.map((row) => row.normalizedValue));
    const missing = normalized.filter((entry) => !existingKeys.has(entry.normalizedValue));
    if (missing.length === 0) {
      return;
    }

    const resolved = await this.resolveCatalogEntries(orgId, missing);
    const resolvedByKey = new Map(
      resolved.map((entry) => [this.subscriptionKey(entry.kind, entry.normalizedValue), entry]),
    );

    for (const entry of missing) {
      const resolution = resolvedByKey.get(this.subscriptionKey(entry.kind, entry.normalizedValue)) ?? this.toAdHocResolution(entry, taxonomy.settingsVersion);
      await this.prisma.userContentSubscription.create({
        data: {
          orgId,
          userId,
          kind,
          normalizedValue: entry.normalizedValue,
          displayValue: resolution.displayValue,
          taxonomyPath: resolution.taxonomyPath,
          taxonomyVersion: resolution.taxonomyVersion,
          source,
          metadata: toPrismaJsonValue(resolution.metadata ?? {}),
        },
      });
    }
  }

  private async ensureCatalogFresh(orgId: string) {
    const cacheKey = `content-subscription:catalog-sync:${orgId}`;
    await this.cache.wrap(
      cacheKey,
      CATALOG_SYNC_TTL_SECONDS,
      async () => {
        await this.syncCatalog(orgId);
        return { syncedAt: new Date().toISOString() };
      },
      {
        lockTtlMs: CATALOG_SYNC_LOCK_TTL_MS,
        retryDelayMs: 250,
        maxWaitMs: CATALOG_SYNC_LOCK_TTL_MS,
      },
    );
  }

  private async syncCatalog(orgId: string) {
    const [topicCandidates, entityCandidates, taxonomy] = await Promise.all([
      this.loadTopicCandidates(orgId),
      this.loadEntityCandidates(orgId),
      this.getTaxonomyDescriptor(orgId),
    ]);
    const merged = [...topicCandidates, ...entityCandidates]
      .sort((a, b) => b.count - a.count || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .slice(0, CATALOG_MAX_CANDIDATES_PER_KIND * 2);
    if (merged.length === 0) {
      await this.prisma.contentSubscriptionCatalog.deleteMany({ where: { orgId } });
      return;
    }

    const classified = await this.classifyCatalogCandidates(orgId, merged, taxonomy);
    const classifiedByKey = new Map(
      classified.map((entry) => [this.subscriptionKey(entry.kind, entry.normalizedValue), entry]),
    );
    const topicValues = merged
      .filter((candidate) => candidate.kind === ContentSubscriptionKind.topic)
      .map((candidate) => candidate.normalizedValue);
    const entityValues = merged
      .filter((candidate) => candidate.kind === ContentSubscriptionKind.entity)
      .map((candidate) => candidate.normalizedValue);

    for (const candidate of merged) {
      const key = this.subscriptionKey(candidate.kind, candidate.normalizedValue);
      const resolved = classifiedByKey.get(key) ?? this.toAdHocResolution(candidate, taxonomy.settingsVersion);
      await this.prisma.contentSubscriptionCatalog.upsert({
        where: {
          orgId_kind_normalizedValue: {
            orgId,
            kind: candidate.kind,
            normalizedValue: candidate.normalizedValue,
          },
        },
        update: {
          displayValue: candidate.displayValue,
          count: candidate.count,
          lastSeenAt: candidate.lastSeenAt,
          taxonomyPath: resolved.taxonomyPath,
          taxonomyVersion: resolved.taxonomyVersion,
          embeddingModel: resolved.embeddingModel,
          embeddingVector: resolved.embeddingVector ? toPrismaJsonValue(resolved.embeddingVector) : Prisma.JsonNull,
          metadata: toPrismaJsonValue(candidate.metadata ?? resolved.metadata ?? {}),
        },
        create: {
          orgId,
          kind: candidate.kind,
          normalizedValue: candidate.normalizedValue,
          displayValue: candidate.displayValue,
          count: candidate.count,
          lastSeenAt: candidate.lastSeenAt,
          taxonomyPath: resolved.taxonomyPath,
          taxonomyVersion: resolved.taxonomyVersion,
          embeddingModel: resolved.embeddingModel,
          embeddingVector: resolved.embeddingVector ? toPrismaJsonValue(resolved.embeddingVector) : Prisma.JsonNull,
          metadata: toPrismaJsonValue(candidate.metadata ?? resolved.metadata ?? {}),
        },
      });
    }

    const staleFilters: Prisma.ContentSubscriptionCatalogWhereInput[] = [
      { lastSeenAt: { lt: new Date(Date.now() - CATALOG_WINDOW_DAYS * DAY_MS) } },
    ];
    if (topicValues.length > 0) {
      staleFilters.push({
        kind: ContentSubscriptionKind.topic,
        normalizedValue: { notIn: topicValues },
      });
    } else {
      staleFilters.push({ kind: ContentSubscriptionKind.topic });
    }
    if (entityValues.length > 0) {
      staleFilters.push({
        kind: ContentSubscriptionKind.entity,
        normalizedValue: { notIn: entityValues },
      });
    } else {
      staleFilters.push({ kind: ContentSubscriptionKind.entity });
    }

    await this.prisma.contentSubscriptionCatalog.deleteMany({
      where: {
        orgId,
        OR: staleFilters,
      },
    });
  }

  private async resolveCatalogEntries(
    orgId: string,
    entries: Array<{
      kind: ContentSubscriptionKind;
      normalizedValue: string;
      displayValue: string;
      source?: ContentSubscriptionSource;
    }>,
  ) {
    const normalized = this.normalizeInputEntries(entries);
    if (normalized.length === 0) {
      return [] as CatalogResolution[];
    }

    const taxonomy = await this.getTaxonomyDescriptor(orgId);
    const rows = await this.prisma.contentSubscriptionCatalog.findMany({
      where: {
        orgId,
        OR: normalized.map((entry) => ({
          kind: entry.kind,
          normalizedValue: entry.normalizedValue,
        })),
      },
    });
    const existingByKey = new Map(
      rows.map((row) => [this.subscriptionKey(row.kind, row.normalizedValue), row]),
    );

    const missing = normalized.filter(
      (entry) => !existingByKey.has(this.subscriptionKey(entry.kind, entry.normalizedValue)),
    );
    const classifiedMissing =
      missing.length > 0
        ? await this.classifyCatalogCandidates(
            orgId,
            missing.map((entry) => ({
              kind: entry.kind,
              normalizedValue: entry.normalizedValue,
              displayValue: entry.displayValue,
              count: 0,
              lastSeenAt: new Date(),
            })),
            taxonomy,
          )
        : [];
    const missingByKey = new Map(
      classifiedMissing.map((entry) => [this.subscriptionKey(entry.kind, entry.normalizedValue), entry]),
    );

    return normalized.map((entry) => {
      const key = this.subscriptionKey(entry.kind, entry.normalizedValue);
      const existing = existingByKey.get(key);
      if (existing) {
        return {
          kind: existing.kind,
          normalizedValue: existing.normalizedValue,
          displayValue: existing.displayValue,
          taxonomyPath: existing.taxonomyPath ?? null,
          taxonomyVersion: existing.taxonomyVersion ?? taxonomy.settingsVersion,
          embeddingModel: existing.embeddingModel ?? null,
          embeddingVector: this.parseVector(existing.embeddingVector),
          metadata: this.parseRecord(existing.metadata),
        } satisfies CatalogResolution;
      }
      return missingByKey.get(key) ?? this.toAdHocResolution(entry, taxonomy.settingsVersion);
    });
  }

  private async classifyCatalogCandidates(
    orgId: string,
    candidates: CatalogCandidate[],
    taxonomy: TaxonomyDescriptor,
  ): Promise<CatalogResolution[]> {
    if (candidates.length === 0 || taxonomy.documents.length === 0) {
      return candidates.map((candidate) => this.toAdHocResolution(candidate, taxonomy.settingsVersion));
    }

    let taxonomyEmbeddings: { path: string; vector: number[] }[] = [];
    let embeddingModel: string | null = null;

    try {
      const taxonomyResponse = await this.liteLlm.embedding({
        orgId,
        input: taxonomy.documents.map((entry) => entry.text),
        metadata: {
          source: 'content-subscriptions',
          stage: 'taxonomy-catalog',
        },
      });
      embeddingModel = taxonomyResponse.model ?? null;
      taxonomyEmbeddings = taxonomy.documents
        .map((entry, index) => {
          const vector = taxonomyResponse.data?.find((row) => row.index === index)?.embedding;
          if (!Array.isArray(vector) || vector.length === 0) {
            return null;
          }
          return { path: entry.path, vector: this.normalizeVector(vector) };
        })
        .filter((entry): entry is { path: string; vector: number[] } => Boolean(entry));
    } catch (error) {
      this.logger.warn({ err: error, orgId }, 'Failed to embed taxonomy documents for content catalog classification');
      return candidates.map((candidate) => {
        const fallbackPath = this.classifyByKeyword(candidate.displayValue, taxonomy.nodes);
        return this.toAdHocResolution(candidate, taxonomy.settingsVersion, fallbackPath);
      });
    }

    const results: CatalogResolution[] = [];
    for (const chunk of this.chunkArray(candidates, EMBEDDING_BATCH_SIZE)) {
      try {
        const response = await this.liteLlm.embedding({
          orgId,
          model: embeddingModel ?? undefined,
          input: chunk.map((entry) => this.catalogEmbeddingText(entry)),
          metadata: {
            source: 'content-subscriptions',
            stage: 'catalog-item',
          },
        });
        const model = response.model ?? embeddingModel;
        for (const [index, candidate] of chunk.entries()) {
          const vector = response.data?.find((row) => row.index === index)?.embedding;
          const normalizedVector = Array.isArray(vector) ? this.normalizeVector(vector) : [];
          const bestPath =
            normalizedVector.length > 0
              ? this.pickBestTaxonomyPath(normalizedVector, taxonomyEmbeddings)
              : this.classifyByKeyword(candidate.displayValue, taxonomy.nodes);
          results.push({
            kind: candidate.kind,
            normalizedValue: candidate.normalizedValue,
            displayValue: candidate.displayValue,
            taxonomyPath: bestPath,
            taxonomyVersion: taxonomy.settingsVersion,
            embeddingModel: model ?? null,
            embeddingVector: normalizedVector.length > 0 ? normalizedVector : null,
            metadata: candidate.metadata,
          });
        }
      } catch (error) {
        this.logger.warn({ err: error, orgId }, 'Failed to embed content subscription catalog candidates');
        for (const candidate of chunk) {
          results.push(
            this.toAdHocResolution(
              candidate,
              taxonomy.settingsVersion,
              this.classifyByKeyword(candidate.displayValue, taxonomy.nodes),
            ),
          );
        }
      }
    }

    return results;
  }

  private async loadTopicCandidates(orgId: string): Promise<CatalogCandidate[]> {
    const since = new Date(Date.now() - CATALOG_WINDOW_DAYS * DAY_MS);
    const rows = await ProcessedItemModel.aggregate<{
      _id?: string | null;
      count: number;
      lastSeenAt: Date;
    }>([
      {
        $match: {
          orgId,
          status: 'completed',
          'result.topics.0': { $exists: true },
        },
      },
      {
        $project: {
          createdAt: 1,
          ingestedAt: 1,
          sortAt: 1,
          result: 1,
        },
      },
      {
        $addFields: {
          activityAt: {
            $ifNull: [
              '$sortAt',
              {
                $convert: {
                  input: '$result.published_at',
                  to: 'date',
                  onError: { $ifNull: ['$ingestedAt', '$createdAt'] },
                  onNull: { $ifNull: ['$ingestedAt', '$createdAt'] },
                },
              },
            ],
          },
        },
      },
      {
        $match: {
          activityAt: { $gte: since },
        },
      },
      {
        $unwind: '$result.topics',
      },
      {
        $group: {
          _id: '$result.topics',
          count: { $sum: 1 },
          lastSeenAt: { $max: '$activityAt' },
        },
      },
      {
        $sort: { count: -1, lastSeenAt: -1 },
      },
      {
        $limit: CATALOG_MAX_CANDIDATES_PER_KIND * 4,
      },
    ]);

    const merged = new Map<string, CatalogCandidate>();
    for (const row of rows) {
      const normalized = this.normalizeValue(row._id);
      if (!normalized.normalizedValue) {
        continue;
      }
      const key = this.subscriptionKey(ContentSubscriptionKind.topic, normalized.normalizedValue);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, {
          kind: ContentSubscriptionKind.topic,
          normalizedValue: normalized.normalizedValue,
          displayValue: normalized.displayValue,
          count: this.toPositiveInt(row.count),
          lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(),
        });
        continue;
      }
      current.count += this.toPositiveInt(row.count);
      if (row.lastSeenAt instanceof Date && row.lastSeenAt > current.lastSeenAt) {
        current.lastSeenAt = row.lastSeenAt;
      }
    }

    return Array.from(merged.values())
      .filter((entry) => entry.count >= CATALOG_MIN_COUNT)
      .sort((a, b) => b.count - a.count || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .slice(0, CATALOG_MAX_CANDIDATES_PER_KIND);
  }

  private async loadEntityCandidates(orgId: string): Promise<CatalogCandidate[]> {
    const since = new Date(Date.now() - CATALOG_WINDOW_DAYS * DAY_MS);
    const kgRows = await this.prisma.$queryRaw<
      Array<{
        displayValue: string;
        entityType: string | null;
        count: bigint | number;
        lastSeenAt: Date | null;
      }>
    >(Prisma.sql`
      SELECT
        e.canonicalName AS displayValue,
        e.type AS entityType,
        COUNT(*) AS count,
        MAX(COALESCE(a.publishedAt, a.crawlAt, a.createdAt)) AS lastSeenAt
      FROM ArticleEntityLink l
      INNER JOIN KnowledgeEntity e ON e.id = l.entityId
      INNER JOIN Article a ON a.id = l.articleId
      WHERE l.orgId = ${orgId}
        AND COALESCE(a.publishedAt, a.crawlAt, a.createdAt) >= ${since}
      GROUP BY e.canonicalName, e.type
      HAVING COUNT(*) >= ${CATALOG_MIN_COUNT}
      ORDER BY COUNT(*) DESC, MAX(COALESCE(a.publishedAt, a.crawlAt, a.createdAt)) DESC
      LIMIT ${CATALOG_MAX_CANDIDATES_PER_KIND}
    `);

    const merged = new Map<string, CatalogCandidate>();
    for (const row of kgRows) {
      const normalized = this.normalizeValue(row.displayValue);
      if (!normalized.normalizedValue) {
        continue;
      }
      merged.set(this.subscriptionKey(ContentSubscriptionKind.entity, normalized.normalizedValue), {
        kind: ContentSubscriptionKind.entity,
        normalizedValue: normalized.normalizedValue,
        displayValue: normalized.displayValue,
        count: this.toPositiveInt(row.count),
        lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(),
        metadata: row.entityType ? { entityType: row.entityType } : undefined,
      });
    }

    const fallbackRows = await ProcessedItemModel.aggregate<{
      _id?: {
        name?: string | null;
        type?: string | null;
      } | null;
      count: number;
      lastSeenAt: Date;
    }>([
      {
        $match: {
          orgId,
          status: 'completed',
          'result.entities.0': { $exists: true },
        },
      },
      {
        $project: {
          createdAt: 1,
          ingestedAt: 1,
          sortAt: 1,
          result: 1,
        },
      },
      {
        $addFields: {
          activityAt: {
            $ifNull: [
              '$sortAt',
              {
                $convert: {
                  input: '$result.published_at',
                  to: 'date',
                  onError: { $ifNull: ['$ingestedAt', '$createdAt'] },
                  onNull: { $ifNull: ['$ingestedAt', '$createdAt'] },
                },
              },
            ],
          },
        },
      },
      {
        $match: {
          activityAt: { $gte: since },
        },
      },
      {
        $unwind: '$result.entities',
      },
      {
        $group: {
          _id: {
            name: '$result.entities.name',
            type: '$result.entities.type',
          },
          count: { $sum: 1 },
          lastSeenAt: { $max: '$activityAt' },
        },
      },
      {
        $sort: { count: -1, lastSeenAt: -1 },
      },
      {
        $limit: CATALOG_MAX_CANDIDATES_PER_KIND * 4,
      },
    ]);

    for (const row of fallbackRows) {
      const normalized = this.normalizeValue(row._id?.name);
      if (!normalized.normalizedValue) {
        continue;
      }
      const key = this.subscriptionKey(ContentSubscriptionKind.entity, normalized.normalizedValue);
      if (merged.has(key)) {
        continue;
      }
      merged.set(key, {
        kind: ContentSubscriptionKind.entity,
        normalizedValue: normalized.normalizedValue,
        displayValue: normalized.displayValue,
        count: this.toPositiveInt(row.count),
        lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(),
        metadata: row._id?.type ? { entityType: row._id.type } : undefined,
      });
    }

    return Array.from(merged.values())
      .filter((entry) => entry.count >= CATALOG_MIN_COUNT)
      .sort((a, b) => b.count - a.count || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .slice(0, CATALOG_MAX_CANDIDATES_PER_KIND);
  }

  private async getTaxonomyDescriptor(orgId: string): Promise<TaxonomyDescriptor> {
    const settings = await this.settings.getSettings(orgId);
    const nodes = Array.isArray(settings.taxonomy) ? settings.taxonomy : [];
    return {
      settingsVersion: settings.taxonomyVersion,
      nodes,
      byPath: new Map(nodes.map((node) => [node.path, node])),
      documents: nodes.map((node) => ({ path: node.path, text: this.taxonomyDocument(node) })),
    };
  }

  private taxonomyDocument(node: NewsClassificationTaxonomyNode): string {
    const keywords = node.keywords.join(', ');
    const synonyms = node.synonyms.join(', ');
    return [
      `path=${node.path}`,
      `legacy=${node.legacyCategory}`,
      `name=${node.displayName}`,
      `description=${node.description}`,
      keywords ? `keywords=${keywords}` : '',
      synonyms ? `synonyms=${synonyms}` : '',
    ]
      .filter((entry) => entry.length > 0)
      .join('\n');
  }

  private mapSubscriptionRow(
    row: {
      id: string;
      kind: ContentSubscriptionKind;
      normalizedValue: string;
      displayValue: string;
      taxonomyPath: string | null;
      source: ContentSubscriptionSource;
      metadata: Prisma.JsonValue | null;
      createdAt: Date;
      updatedAt: Date;
    },
    taxonomyByPath: Map<string, NewsClassificationTaxonomyNode>,
  ): ContentSubscriptionItem {
    const taxonomyInfo = this.taxonomyInfo(row.taxonomyPath, taxonomyByPath);
    return {
      id: row.id,
      kind: row.kind,
      normalizedValue: row.normalizedValue,
      displayValue: row.displayValue,
      taxonomyPath: row.taxonomyPath ?? null,
      taxonomyDisplayName: taxonomyInfo.displayName,
      taxonomyLabels: taxonomyInfo.labels,
      source: row.source,
      metadata: this.parseRecord(row.metadata),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapCatalogRow(
    row: {
      kind: ContentSubscriptionKind;
      normalizedValue: string;
      displayValue: string;
      count: number;
      lastSeenAt: Date;
      taxonomyPath: string | null;
      metadata: Prisma.JsonValue | null;
    },
    taxonomyByPath: Map<string, NewsClassificationTaxonomyNode>,
    score?: number,
  ): ContentSubscriptionCatalogItem {
    const taxonomyInfo = this.taxonomyInfo(row.taxonomyPath, taxonomyByPath);
    return {
      kind: row.kind,
      normalizedValue: row.normalizedValue,
      displayValue: row.displayValue,
      count: row.count,
      lastSeenAt: row.lastSeenAt.toISOString(),
      taxonomyPath: row.taxonomyPath ?? null,
      taxonomyDisplayName: taxonomyInfo.displayName,
      taxonomyLabels: taxonomyInfo.labels,
      metadata: this.parseRecord(row.metadata),
      ...(typeof score === 'number' && Number.isFinite(score) ? { score } : {}),
    };
  }

  private mapCatalogResolution(
    row: CatalogResolution,
    taxonomyByPath: Map<string, NewsClassificationTaxonomyNode>,
    score?: number,
  ): ContentSubscriptionCatalogItem {
    const taxonomyInfo = this.taxonomyInfo(row.taxonomyPath, taxonomyByPath);
    return {
      kind: row.kind,
      normalizedValue: row.normalizedValue,
      displayValue: row.displayValue,
      count: 0,
      lastSeenAt: new Date().toISOString(),
      taxonomyPath: row.taxonomyPath,
      taxonomyDisplayName: taxonomyInfo.displayName,
      taxonomyLabels: taxonomyInfo.labels,
      metadata: row.metadata,
      ...(typeof score === 'number' && Number.isFinite(score) ? { score } : {}),
    };
  }

  private buildBatchResponse(
    items: ContentSubscriptionBatchResultItem[],
    counts: Record<ContentSubscriptionKind, number>,
    taxonomyByPath: Map<string, NewsClassificationTaxonomyNode>,
  ): ContentSubscriptionBatchResponse {
    return {
      limitPerKind: USER_CONTENT_SUBSCRIPTION_LIMIT_PER_KIND,
      counts,
      items: items.map((item) => ({
        ...item,
        taxonomyDisplayName: this.taxonomyInfo(item.taxonomyPath, taxonomyByPath).displayName,
        taxonomyLabels: this.taxonomyInfo(item.taxonomyPath, taxonomyByPath).labels,
      })),
    };
  }

  private toBatchResult(
    status: ContentSubscriptionBatchResultItem['status'],
    kind: ContentSubscriptionKind,
    normalizedValue: string,
    displayValue: string,
    taxonomyPath: string | null,
    taxonomyByPath: Map<string, NewsClassificationTaxonomyNode>,
  ): ContentSubscriptionBatchResultItem {
    const taxonomyInfo = this.taxonomyInfo(taxonomyPath, taxonomyByPath);
    return {
      kind,
      normalizedValue,
      displayValue,
      taxonomyPath,
      taxonomyDisplayName: taxonomyInfo.displayName,
      taxonomyLabels: taxonomyInfo.labels,
      status,
    };
  }

  private taxonomyInfo(
    taxonomyPath: string | null,
    taxonomyByPath: Map<string, NewsClassificationTaxonomyNode>,
  ) {
    if (!taxonomyPath) {
      return { displayName: null, labels: [] };
    }
    const node = taxonomyByPath.get(taxonomyPath);
    return {
      displayName: node?.displayName ?? taxonomyPath,
      labels: taxonomyPath.split('/').filter(Boolean),
    };
  }

  private buildRecommendationQuery(profile: Awaited<ReturnType<UserNewsBehaviorService['getProfile']>>) {
    const topicBits = this.topEntries(profile.topics, 8);
    const entityBits = this.topEntries(profile.entities, 8);
    const sourceBits = this.topEntries(profile.sources, 4);
    const domainBits = this.topEntries(profile.domains, 4);

    const parts = [
      topicBits.length > 0 ? `topics: ${topicBits.join(', ')}` : '',
      entityBits.length > 0 ? `entities: ${entityBits.join(', ')}` : '',
      sourceBits.length > 0 ? `sources: ${sourceBits.join(', ')}` : '',
      domainBits.length > 0 ? `domains: ${domainBits.join(', ')}` : '',
    ].filter(Boolean);

    return parts.join('\n');
  }

  private topEntries(record: Record<string, number>, limit: number) {
    return Object.entries(record ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(limit, 0))
      .map(([value, score]) => `${value} (${score})`);
  }

  private async rankCatalogRowsByEmbedding(
    orgId: string,
    queryText: string,
    rows: Array<{
      kind: ContentSubscriptionKind;
      normalizedValue: string;
      displayValue: string;
      count: number;
      lastSeenAt: Date;
      taxonomyPath: string | null;
      metadata: Prisma.JsonValue | null;
      embeddingVector: Prisma.JsonValue | null;
    }>,
  ) {
    try {
      const response = await this.liteLlm.embedding({
        orgId,
        input: queryText,
        metadata: {
          source: 'content-subscriptions',
          stage: 'recommendation-query',
        },
      });
      const vector = response.data?.[0]?.embedding;
      const normalized = Array.isArray(vector) ? this.normalizeVector(vector) : [];
      if (normalized.length === 0) {
        return [] as Array<{ row: (typeof rows)[number]; score: number }>;
      }
      return this.rankCatalogRowsByVector(normalized, rows, RECOMMENDATION_CANDIDATE_LIMIT);
    } catch (error) {
      this.logger.warn({ err: error, orgId }, 'Failed to embed recommendation query');
      return [];
    }
  }

  private async tryRerankCatalogRows(
    orgId: string,
    queryText: string,
    rows: Array<{
      row: {
        kind: ContentSubscriptionKind;
        normalizedValue: string;
        displayValue: string;
        count: number;
        lastSeenAt: Date;
        taxonomyPath: string | null;
        metadata: Prisma.JsonValue | null;
      };
      score: number;
    }>,
  ) {
    if (rows.length === 0) {
      return [] as typeof rows;
    }
    try {
      const documents = rows.map(({ row }) => this.catalogRerankDocument(row));
      const rerank = await this.liteLlm.rerank({
        orgId,
        query: queryText,
        documents,
        topN: Math.min(rows.length, RECOMMENDATION_CANDIDATE_LIMIT),
        metadata: {
          source: 'content-subscriptions',
          stage: 'rerank',
        },
      });
      const scored = (rerank.results ?? [])
        .map((entry) => {
          const row = rows[entry.index];
          if (!row || typeof entry.score !== 'number' || !Number.isFinite(entry.score)) {
            return null;
          }
          return { row: row.row, score: entry.score };
        })
        .filter((entry): entry is { row: (typeof rows)[number]['row']; score: number } => Boolean(entry));

      if (scored.length === 0) {
        return [];
      }

      const min = Math.min(...scored.map((entry) => entry.score));
      const max = Math.max(...scored.map((entry) => entry.score));
      return scored
        .map((entry) => ({
          row: entry.row,
          score: max === min ? 1 : (entry.score - min) / (max - min),
        }))
        .sort((a, b) => b.score - a.score || b.row.count - a.row.count);
    } catch (error) {
      this.logger.warn({ err: error, orgId }, 'Failed to rerank content subscription candidates');
      return [];
    }
  }

  private rankCatalogRowsByVector<TRow extends { embeddingVector: Prisma.JsonValue | null; count: number; lastSeenAt: Date }>(
    vector: number[] | null,
    rows: TRow[],
    limit: number,
  ) {
    if (!Array.isArray(vector) || vector.length === 0) {
      return [] as Array<{ row: TRow; score: number }>;
    }
    return rows
      .map((row) => {
        const candidate = this.parseVector(row.embeddingVector);
        if (!candidate || candidate.length !== vector.length) {
          return null;
        }
        return {
          row,
          score: this.dot(vector, candidate),
        };
      })
      .filter((entry): entry is { row: TRow; score: number } => Boolean(entry))
      .sort((a, b) => b.score - a.score || b.row.count - a.row.count || b.row.lastSeenAt.getTime() - a.row.lastSeenAt.getTime())
      .slice(0, limit);
  }

  private catalogEmbeddingText(candidate: CatalogCandidate) {
    return [
      `kind=${candidate.kind}`,
      `name=${candidate.displayValue}`,
      candidate.kind === ContentSubscriptionKind.entity && candidate.metadata?.entityType
        ? `entityType=${String(candidate.metadata.entityType)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private catalogRerankDocument(candidate: {
    kind: ContentSubscriptionKind;
    displayValue: string;
    count: number;
    taxonomyPath: string | null;
    metadata: Prisma.JsonValue | null;
  }) {
    const metadata = this.parseRecord(candidate.metadata);
    return [
      `kind=${candidate.kind}`,
      `name=${candidate.displayValue}`,
      candidate.taxonomyPath ? `taxonomy=${candidate.taxonomyPath}` : '',
      typeof metadata?.entityType === 'string' ? `entityType=${metadata.entityType}` : '',
      `count=${candidate.count}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private pickBestTaxonomyPath(
    vector: number[],
    taxonomyEmbeddings: Array<{ path: string; vector: number[] }>,
  ) {
    let bestPath: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of taxonomyEmbeddings) {
      if (candidate.vector.length !== vector.length) {
        continue;
      }
      const score = this.dot(vector, candidate.vector);
      if (score > bestScore) {
        bestScore = score;
        bestPath = candidate.path;
      }
    }
    return bestPath;
  }

  private classifyByKeyword(value: string, taxonomy: NewsClassificationTaxonomyNode[]) {
    const text = value.trim().toLowerCase();
    if (!text) {
      return null;
    }
    let bestPath: string | null = null;
    let bestScore = 0;
    for (const node of taxonomy) {
      const signals = [node.displayName, node.description, ...node.keywords, ...node.synonyms];
      let score = 0;
      for (const signal of signals) {
        const normalized = signal.trim().toLowerCase();
        if (!normalized) {
          continue;
        }
        if (text.includes(normalized) || normalized.includes(text)) {
          score += normalized === text ? 4 : 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestPath = node.path;
      }
    }
    return bestPath;
  }

  private normalizeInputEntries(
    entries: Array<{
      kind: ContentSubscriptionKind;
      value?: string;
      displayValue?: string;
      normalizedValue?: string;
      source?: ContentSubscriptionSource;
    }>,
  ) {
    const seen = new Set<string>();
    const normalized: Array<{
      kind: ContentSubscriptionKind;
      normalizedValue: string;
      displayValue: string;
      source?: ContentSubscriptionSource;
    }> = [];
    for (const entry of entries) {
      if (!CONTENT_SUBSCRIPTION_KINDS.includes(entry.kind)) {
        continue;
      }
      const value = this.normalizeValue(entry.value ?? entry.displayValue ?? entry.normalizedValue);
      if (!value.normalizedValue) {
        continue;
      }
      const key = this.subscriptionKey(entry.kind, value.normalizedValue);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({
        kind: entry.kind,
        normalizedValue: value.normalizedValue,
        displayValue: value.displayValue,
        source: entry.source,
      });
    }
    return normalized;
  }

  private normalizeValue(value: unknown) {
    if (typeof value !== 'string') {
      return { normalizedValue: '', displayValue: '' };
    }
    const displayValue = value.trim().replace(/\s+/g, ' ').slice(0, 128);
    return {
      displayValue,
      normalizedValue: displayValue.toLowerCase(),
    };
  }

  private normalizeStringArray(value: unknown, limit: number) {
    const items = Array.isArray(value) ? value : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of items) {
      const normalized = this.normalizeValue(entry);
      if (!normalized.normalizedValue || seen.has(normalized.normalizedValue)) {
        continue;
      }
      seen.add(normalized.normalizedValue);
      out.push(normalized.displayValue);
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  private subscriptionKey(kind: ContentSubscriptionKind, normalizedValue: string) {
    return `${kind}:${normalizedValue}`;
  }

  private taxonomyBranchPrefix(path: string) {
    const parts = path.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(0, 2).join('/') : path;
  }

  private toPositiveInt(value: number | bigint | null | undefined) {
    if (typeof value === 'bigint') {
      return value > 0n ? Number(value) : 0;
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
    return 0;
  }

  private toAdHocResolution(
    candidate: {
      kind: ContentSubscriptionKind;
      normalizedValue: string;
      displayValue: string;
      metadata?: Record<string, unknown>;
    },
    taxonomyVersion: string,
    taxonomyPath: string | null = null,
  ): CatalogResolution {
    return {
      kind: candidate.kind,
      normalizedValue: candidate.normalizedValue,
      displayValue: candidate.displayValue,
      taxonomyPath,
      taxonomyVersion,
      embeddingModel: null,
      embeddingVector: null,
      metadata: candidate.metadata,
    };
  }

  private parseVector(value: Prisma.JsonValue | null) {
    if (!Array.isArray(value)) {
      return null;
    }
    const normalized = value
      .map((entry) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : null))
      .filter((entry): entry is number => entry !== null);
    return normalized.length > 0 ? normalized : null;
  }

  private parseRecord(value: Prisma.JsonValue | null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private chunkArray<T>(values: T[], size: number) {
    const out: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
      out.push(values.slice(index, index + size));
    }
    return out;
  }

  private normalizeVector(vector: number[]) {
    const magnitude = Math.sqrt(vector.reduce((sum, entry) => sum + entry * entry, 0));
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      return [];
    }
    return vector.map((entry) => entry / magnitude);
  }

  private dot(a: number[], b: number[]) {
    const length = Math.min(a.length, b.length);
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      total += a[index]! * b[index]!;
    }
    return total;
  }
}
