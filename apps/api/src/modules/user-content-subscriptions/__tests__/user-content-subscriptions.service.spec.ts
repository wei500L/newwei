import { ProcessedItemModel } from '@modular/mongo';
import { ContentSubscriptionKind, Prisma } from '@prisma/client';

import { UserContentSubscriptionsService } from '../user-content-subscriptions.service';

describe('UserContentSubscriptionsService', () => {
  const monitors = {
    buildSubscriptionOwnershipMap: jest.fn().mockResolvedValue(new Map()),
    reconcileContentSubscriptionSync: jest.fn().mockResolvedValue(undefined),
  };

  afterEach(() => {
    jest.restoreAllMocks();
    monitors.buildSubscriptionOwnershipMap.mockClear();
    monitors.reconcileContentSubscriptionSync.mockClear();
  });

  it('falls back to top catalog items when behavior profile is empty', async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({ id: 'migrated' }),
      },
      userContentSubscription: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      contentSubscriptionCatalog: {
        findMany: jest.fn().mockResolvedValue([
          {
            kind: ContentSubscriptionKind.entity,
            normalizedValue: 'nvidia',
            displayValue: 'NVIDIA',
            count: 25,
            lastSeenAt: new Date('2026-03-06T00:00:00.000Z'),
            taxonomyPath: 'tech/semiconductor/supply-chain',
            metadata: null,
            embeddingVector: null,
          },
          {
            kind: ContentSubscriptionKind.topic,
            normalizedValue: 'ai chips',
            displayValue: 'AI chips',
            count: 18,
            lastSeenAt: new Date('2026-03-05T00:00:00.000Z'),
            taxonomyPath: 'tech/ai/model-release',
            metadata: null,
            embeddingVector: null,
          },
        ]),
      },
    };
    const cache = {
      wrap: jest.fn().mockResolvedValue({ syncedAt: '2026-03-06T00:00:00.000Z' }),
    };
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        taxonomyVersion: 'news-taxonomy-v1',
        taxonomy: [
          {
            path: 'tech/ai/model-release',
            displayName: 'AI Model Release',
            description: 'AI model launches and updates',
            legacyCategory: 'ai',
            keywords: ['ai'],
            synonyms: ['llm'],
          },
          {
            path: 'tech/semiconductor/supply-chain',
            displayName: 'Semiconductor Supply Chain',
            description: 'Chip manufacturing and supply chain',
            legacyCategory: 'tech',
            keywords: ['chip'],
            synonyms: ['semiconductor'],
          },
        ],
      }),
    };
    const liteLlm = {
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const behavior = {
      getProfile: jest.fn().mockResolvedValue({
        actions: {},
        sources: {},
        topics: {},
        entities: {},
        items: {},
        events: {},
        domains: {},
      }),
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      cache as any,
      settings as any,
      liteLlm as any,
      behavior as any,
      monitors as any,
    );

    const result = await service.listRecommendations('org-1', 'user-1', 5);

    expect(result.items.map((item) => item.displayValue)).toEqual(['NVIDIA', 'AI chips']);
    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(liteLlm.rerank).not.toHaveBeenCalled();
  });

  it('returns recommendations from the existing catalog snapshot when catalog sync refresh fails', async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({ id: 'migrated' }),
      },
      userContentSubscription: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      contentSubscriptionCatalog: {
        findMany: jest.fn().mockResolvedValue([
          {
            kind: ContentSubscriptionKind.entity,
            normalizedValue: 'nvidia',
            displayValue: 'NVIDIA',
            count: 25,
            lastSeenAt: new Date('2026-03-06T00:00:00.000Z'),
            taxonomyPath: 'tech/semiconductor/supply-chain',
            metadata: null,
            embeddingVector: null,
          },
        ]),
      },
    };
    const cache = {
      wrap: jest.fn().mockRejectedValue(new Error('catalog sync failed')),
    };
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        taxonomyVersion: 'news-taxonomy-v1',
        taxonomy: [],
      }),
    };
    const liteLlm = {
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const behavior = {
      getProfile: jest.fn().mockResolvedValue({
        actions: {},
        sources: {},
        topics: {},
        entities: {},
        items: {},
        events: {},
        domains: {},
      }),
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      cache as any,
      settings as any,
      liteLlm as any,
      behavior as any,
      monitors as any,
    );

    const result = await service.listRecommendations('org-1', 'user-1', 5);

    expect(cache.wrap).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.displayValue)).toEqual(['NVIDIA']);
    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(liteLlm.rerank).not.toHaveBeenCalled();
  });

  it('returns catalog entries from the existing snapshot when catalog sync refresh fails', async () => {
    const prisma = {
      contentSubscriptionCatalog: {
        findMany: jest.fn().mockResolvedValue([
          {
            kind: ContentSubscriptionKind.topic,
            normalizedValue: 'ai chips',
            displayValue: 'AI chips',
            count: 18,
            lastSeenAt: new Date('2026-03-05T00:00:00.000Z'),
            taxonomyPath: null,
            metadata: null,
          },
        ]),
      },
    };
    const cache = {
      wrap: jest.fn().mockRejectedValue(new Error('catalog sync failed')),
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      cache as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );
    jest.spyOn(service as any, 'getTaxonomyDescriptor').mockResolvedValue({
      settingsVersion: 'news-taxonomy-v1',
      nodes: [],
      byPath: new Map(),
      documents: [],
    });

    const result = await service.listCatalog('org-1', { limit: 10 });

    expect(cache.wrap).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.displayValue)).toEqual(['AI chips']);
  });

  it('normalizes invalid catalog limit before querying Prisma', async () => {
    const prisma = {
      contentSubscriptionCatalog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );
    jest.spyOn(service as any, 'ensureCatalogFresh').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getTaxonomyDescriptor').mockResolvedValue({
      settingsVersion: 'news-taxonomy-v1',
      nodes: [],
      byPath: new Map(),
      documents: [],
    });

    const result = await service.listCatalog('org-1', { limit: Number.NaN });

    expect(prisma.contentSubscriptionCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
    expect(result.limit).toBe(200);
  });

  it('filters uncategorized catalog entries when taxonomy sentinel is used', async () => {
    const prisma = {
      contentSubscriptionCatalog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );
    jest.spyOn(service as any, 'ensureCatalogFresh').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getTaxonomyDescriptor').mockResolvedValue({
      settingsVersion: 'news-taxonomy-v1',
      nodes: [],
      byPath: new Map(),
      documents: [],
    });

    await service.listCatalog('org-1', { taxonomyPath: '__uncategorized__' });

    expect(prisma.contentSubscriptionCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ taxonomyPath: null }),
      }),
    );
  });

  it('merges duplicate entity candidates from different entity types', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          displayValue: 'NVIDIA',
          entityType: 'organization',
          count: 1,
          lastSeenAt: new Date('2026-03-05T00:00:00.000Z'),
        },
        {
          displayValue: 'NVIDIA',
          entityType: 'company',
          count: 1,
          lastSeenAt: new Date('2026-03-06T00:00:00.000Z'),
        },
      ]),
    };
    jest.spyOn(ProcessedItemModel, 'aggregate').mockResolvedValue([]);
    const service = new UserContentSubscriptionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );

    const candidates = await (service as any).loadEntityCandidates('org-1');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: ContentSubscriptionKind.entity,
      normalizedValue: 'nvidia',
      displayValue: 'NVIDIA',
      count: 2,
    });
    expect(candidates[0].lastSeenAt.toISOString()).toBe('2026-03-06T00:00:00.000Z');

    const query = prisma.$queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] };
    const queryText = query.strings?.join(' ') ?? '';
    expect(queryText).toContain('GROUP BY e.canonicalName');
    expect(queryText).not.toContain('GROUP BY e.canonicalName, e.type');
  });

  it('merges fallback entity candidates after deduplicating normalized names', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(ProcessedItemModel, 'aggregate').mockResolvedValue([
      {
        _id: 'NVIDIA',
        entityType: 'organization',
        count: 1,
        lastSeenAt: new Date('2026-03-05T00:00:00.000Z'),
      },
      {
        _id: '  nvidia  ',
        entityType: 'company',
        count: 1,
        lastSeenAt: new Date('2026-03-06T00:00:00.000Z'),
      },
    ]);
    const service = new UserContentSubscriptionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );

    const candidates = await (service as any).loadEntityCandidates('org-1');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: ContentSubscriptionKind.entity,
      normalizedValue: 'nvidia',
      displayValue: 'NVIDIA',
      count: 2,
    });
  });

  it('maps embedding rows by index when catalog classification responses are out of order', async () => {
    const liteLlm = {
      embedding: jest
        .fn()
        .mockResolvedValueOnce({
          model: 'taxonomy-embedding-model',
          data: [
            { index: 1, embedding: [0, 6] },
            { index: 0, embedding: [4, 0] },
          ],
        })
        .mockResolvedValueOnce({
          model: 'catalog-embedding-model',
          data: [{ index: 1, embedding: [0, 9] }],
        }),
    };
    const service = new UserContentSubscriptionsService(
      {} as any,
      {} as any,
      {} as any,
      liteLlm as any,
      {} as any,
      monitors as any,
    );

    const results = await (service as any).classifyCatalogCandidates(
      'org-1',
      [
        {
          kind: ContentSubscriptionKind.topic,
          normalizedValue: 'ai chips',
          displayValue: 'AI chips',
          count: 8,
          lastSeenAt: new Date('2026-03-05T00:00:00.000Z'),
        },
        {
          kind: ContentSubscriptionKind.entity,
          normalizedValue: 'nvidia',
          displayValue: 'NVIDIA',
          count: 6,
          lastSeenAt: new Date('2026-03-06T00:00:00.000Z'),
          metadata: { entityType: 'company' },
        },
      ],
      {
        settingsVersion: 'news-taxonomy-v1',
        nodes: [
          {
            path: 'tech/ai/model-release',
            displayName: 'AI Model Release',
            description: 'AI launches and updates',
            legacyCategory: 'ai',
            keywords: ['ai'],
            synonyms: ['llm'],
          },
          {
            path: 'tech/semiconductor/supply-chain',
            displayName: 'Semiconductor Supply Chain',
            description: 'Chip manufacturing and supply chain',
            legacyCategory: 'tech',
            keywords: ['chip'],
            synonyms: ['semiconductor'],
          },
        ],
        byPath: new Map(),
        documents: [
          {
            path: 'tech/ai/model-release',
            text: 'taxonomy: ai model release',
          },
          {
            path: 'tech/semiconductor/supply-chain',
            text: 'taxonomy: semiconductor supply chain',
          },
        ],
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        kind: ContentSubscriptionKind.topic,
        normalizedValue: 'ai chips',
        taxonomyPath: 'tech/ai/model-release',
        embeddingModel: 'catalog-embedding-model',
        embeddingVector: null,
      }),
      expect.objectContaining({
        kind: ContentSubscriptionKind.entity,
        normalizedValue: 'nvidia',
        taxonomyPath: 'tech/semiconductor/supply-chain',
        embeddingModel: 'catalog-embedding-model',
        embeddingVector: [0, 1],
        metadata: { entityType: 'company' },
      }),
    ]);
  });

  it('replaces the catalog snapshot in a transaction without per-row upserts', async () => {
    const tx = {
      contentSubscriptionCatalog: {
        deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
      contentSubscriptionCatalog: {
        upsert: jest.fn(),
      },
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );
    const topicLastSeenAt = new Date('2026-03-06T00:00:00.000Z');
    const entityLastSeenAt = new Date('2026-03-07T00:00:00.000Z');

    jest.spyOn(service as any, 'loadTopicCandidates').mockResolvedValue([
      {
        kind: ContentSubscriptionKind.topic,
        normalizedValue: 'ai chips',
        displayValue: 'AI chips',
        count: 18,
        lastSeenAt: topicLastSeenAt,
      },
    ]);
    jest.spyOn(service as any, 'loadEntityCandidates').mockResolvedValue([
      {
        kind: ContentSubscriptionKind.entity,
        normalizedValue: 'nvidia',
        displayValue: 'NVIDIA',
        count: 25,
        lastSeenAt: entityLastSeenAt,
        metadata: { entityType: 'company' },
      },
    ]);
    jest.spyOn(service as any, 'getTaxonomyDescriptor').mockResolvedValue({
      settingsVersion: 'news-taxonomy-v1',
      nodes: [],
      byPath: new Map(),
      documents: [],
    });
    jest.spyOn(service as any, 'classifyCatalogCandidates').mockResolvedValue([
      {
        kind: ContentSubscriptionKind.topic,
        normalizedValue: 'ai chips',
        displayValue: 'AI chips',
        taxonomyPath: 'tech/ai/model-release',
        taxonomyVersion: 'news-taxonomy-v1',
        embeddingModel: 'text-embedding-3-small',
        embeddingVector: [0.1, 0.2],
        metadata: { source: 'taxonomy' },
      },
      {
        kind: ContentSubscriptionKind.entity,
        normalizedValue: 'nvidia',
        displayValue: 'NVIDIA',
        taxonomyPath: 'tech/semiconductor/supply-chain',
        taxonomyVersion: 'news-taxonomy-v1',
        embeddingModel: null,
        embeddingVector: null,
        metadata: { source: 'classifier' },
      },
    ]);

    await (service as any).syncCatalog('org-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.contentSubscriptionCatalog.deleteMany).toHaveBeenCalledWith({
      where: {
        orgId: 'org-1',
        kind: {
          in: [ContentSubscriptionKind.topic, ContentSubscriptionKind.entity],
        },
      },
    });
    expect(tx.contentSubscriptionCatalog.createMany).toHaveBeenCalledTimes(1);
    expect(tx.contentSubscriptionCatalog.createMany).toHaveBeenCalledWith({
      data: [
        {
          orgId: 'org-1',
          kind: ContentSubscriptionKind.entity,
          normalizedValue: 'nvidia',
          displayValue: 'NVIDIA',
          count: 25,
          lastSeenAt: entityLastSeenAt,
          taxonomyPath: 'tech/semiconductor/supply-chain',
          taxonomyVersion: 'news-taxonomy-v1',
          embeddingModel: null,
          embeddingVector: Prisma.JsonNull,
          metadata: { entityType: 'company' },
        },
        {
          orgId: 'org-1',
          kind: ContentSubscriptionKind.topic,
          normalizedValue: 'ai chips',
          displayValue: 'AI chips',
          count: 18,
          lastSeenAt: topicLastSeenAt,
          taxonomyPath: 'tech/ai/model-release',
          taxonomyVersion: 'news-taxonomy-v1',
          embeddingModel: 'text-embedding-3-small',
          embeddingVector: [0.1, 0.2],
          metadata: { source: 'taxonomy' },
        },
      ],
    });
    expect(prisma.contentSubscriptionCatalog.upsert).not.toHaveBeenCalled();
  });

  it('chunks snapshot persistence across multiple createMany calls', async () => {
    const tx = {
      contentSubscriptionCatalog: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 64 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
      contentSubscriptionCatalog: {
        upsert: jest.fn(),
      },
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );
    const candidates = Array.from({ length: 65 }, (_, index) => ({
      kind: ContentSubscriptionKind.topic,
      normalizedValue: `topic-${index}`,
      displayValue: `Topic ${index}`,
      count: 65 - index,
      lastSeenAt: new Date(`2026-03-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`),
    }));

    jest.spyOn(service as any, 'loadTopicCandidates').mockResolvedValue(candidates);
    jest.spyOn(service as any, 'loadEntityCandidates').mockResolvedValue([]);
    jest.spyOn(service as any, 'getTaxonomyDescriptor').mockResolvedValue({
      settingsVersion: 'news-taxonomy-v1',
      nodes: [],
      byPath: new Map(),
      documents: [],
    });
    jest.spyOn(service as any, 'classifyCatalogCandidates').mockImplementation(
      async (_orgId: string, rows: typeof candidates) =>
        rows.map((row) => ({
          kind: row.kind,
          normalizedValue: row.normalizedValue,
          displayValue: row.displayValue,
          taxonomyPath: null,
          taxonomyVersion: 'news-taxonomy-v1',
          embeddingModel: null,
          embeddingVector: null,
          metadata: null,
        })),
    );

    await (service as any).syncCatalog('org-1');

    expect(tx.contentSubscriptionCatalog.createMany).toHaveBeenCalledTimes(2);
    expect(tx.contentSubscriptionCatalog.createMany.mock.calls[0][0].data).toHaveLength(64);
    expect(tx.contentSubscriptionCatalog.createMany.mock.calls[1][0].data).toHaveLength(1);
    expect(prisma.contentSubscriptionCatalog.upsert).not.toHaveBeenCalled();
  });

  it('removes only managed catalog kinds when there are no candidates to persist', async () => {
    const tx = {
      contentSubscriptionCatalog: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
        createMany: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
      contentSubscriptionCatalog: {
        upsert: jest.fn(),
      },
    };
    const service = new UserContentSubscriptionsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitors as any,
    );
    const classifySpy = jest.spyOn(service as any, 'classifyCatalogCandidates');

    jest.spyOn(service as any, 'loadTopicCandidates').mockResolvedValue([]);
    jest.spyOn(service as any, 'loadEntityCandidates').mockResolvedValue([]);
    jest.spyOn(service as any, 'getTaxonomyDescriptor').mockResolvedValue({
      settingsVersion: 'news-taxonomy-v1',
      nodes: [],
      byPath: new Map(),
      documents: [],
    });

    await (service as any).syncCatalog('org-1');

    expect(classifySpy).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.contentSubscriptionCatalog.deleteMany).toHaveBeenCalledWith({
      where: {
        orgId: 'org-1',
        kind: {
          in: [ContentSubscriptionKind.topic, ContentSubscriptionKind.entity],
        },
      },
    });
    expect(tx.contentSubscriptionCatalog.createMany).not.toHaveBeenCalled();
    expect(prisma.contentSubscriptionCatalog.upsert).not.toHaveBeenCalled();
  });
});
