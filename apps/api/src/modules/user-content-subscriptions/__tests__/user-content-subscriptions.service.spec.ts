import { ProcessedItemModel } from '@modular/mongo';
import { ContentSubscriptionKind } from '@prisma/client';

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
});
